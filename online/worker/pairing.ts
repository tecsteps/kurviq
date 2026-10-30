// One Durable Object per agent pairing (= per browser that made an agent
// link). It plays the part of the local scenes server's live channel: the
// browser's Kurviq tabs are connected to it with a WebSocket, and the remote
// MCP's requests to "the scenes server" are answered here (app state,
// commands) or by the most suitable tab (/api/scenes…: the tab talks to
// GitHub with the user's connection).
//
// Stores nothing: the tabs' WebSockets (with their last state as attachment)
// are all there is, and they survive hibernation.

import { DurableObject } from "cloudflare:workers";

import { createReceiver, sendMessage } from "../../scenes-plugin/src/online/frames";

type TabState = {
  current?: string | null;
  dirty?: boolean;
  visible?: boolean;
  focusedAt?: number;
  drive?: boolean;
};

/**
 * How the agent got here (set by the Worker, X-Kurviq-Via): "oauth" = signed
 * in (the user allowed it in Kurviq), "link" = the old link with the key in
 * the URL, which is refused (the agent is told to sign in)
 */
type Via = "oauth" | "link";

/** the commit this Worker is built from (online/build-worker.mjs) */
declare const __KURVIQ_BUILD__: string;

type Attachment = { tab: string; connectedAt: number; state: TabState };

/** connected tabs per agent link (one person, a few tabs and devices) */
const MAX_TABS = 20;

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** the tab the command was sent to (its id: WebSocket objects aren't the same after hibernation) */
  tab: string;
};

const COMMAND_TIMEOUT_MS = 30_000;
/** edits (commits with pictures) and pictures may take longer */
const SLOW_COMMANDS = new Set(["scene-edit", "local-edit", "render", "deck-check", "convert", "upload", "upload-payload", "http"]);
const SLOW_TIMEOUT_MS = 75_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const legacyRefused = (app: string) =>
  `This agent uses the old Kurviq link (the key in the URL), which doesn't work any more. Connect with ${app}/mcp instead: the agent signs in once and the user allows it in Kurviq (e.g. claude mcp add --transport http kurviq ${app}/mcp). Ask the user to do this.`;

export class Pairing extends DurableObject {
  private pending = new Map<string, Pending>();
  private receivers = new WeakMap<WebSocket, (raw: string) => any>();
  private seq = 0;
  private appUrl = "https://kurviq.com";

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any);
    // keepalive pings are answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------------

  private allTabs() {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const info = ws.deserializeAttachment() as Attachment | null;
      return info && ws.readyState === WebSocket.OPEN ? [{ ws, ...info }] : [];
    });
  }

  /** the tabs that answer an agent that came this way */
  private tabs(via: Via) {
    return via === "oauth" ? this.allTabs() : [];
  }

  /** the tab agents talk to: the visible, most recently focused one (or the one showing `scene`) */
  private activeTab(via: Via, scene?: string | null) {
    const rank = (tab: Attachment) => [tab.state.visible ? 1 : 0, tab.state.focusedAt || 0, tab.connectedAt];
    const pick = (onlyScene?: string | null) => {
      let best: (Attachment & { ws: WebSocket }) | null = null;
      for (const tab of this.tabs(via)) {
        if (onlyScene !== undefined && (tab.state.current ?? null) !== onlyScene) {
          continue;
        }
        if (!best) {
          best = tab;
          continue;
        }
        const [a, b] = [rank(tab), rank(best)];
        if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0) {
          best = tab;
        }
      }
      return best;
    };
    return (scene !== undefined ? pick(scene) : null) ?? pick();
  }

  private notOpen() {
    if (this.allTabs().length) {
      return httpError(403, legacyRefused(this.appUrl));
    }
    return httpError(
      409,
      `Kurviq is not open in the user's browser. The agent works through the user's open Kurviq tab: ask the user to open ${this.appUrl} (in the browser this agent link was made in) and keep the tab open.`,
    );
  }

  private send(ws: WebSocket, command: any, timeoutMs?: number) {
    const id = String(++this.seq);
    const type = String(command?.type ?? "");
    const wait = timeoutMs ?? (SLOW_COMMANDS.has(type) ? SLOW_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          httpError(
            504,
            `The Kurviq tab did not answer within ${Math.round(wait / 1000)} s (${type || "command"}). It may be busy, or the browser may have paused it in the background. app_status shows what the tab is working on.`,
          ),
        );
      }, wait);
      this.pending.set(id, { resolve, reject, timer, tab: (ws.deserializeAttachment() as Attachment).tab });
      // with this build: a tab running an older version says so instead of half-working
      sendMessage(ws, { type: "command", id, command, build: __KURVIQ_BUILD__ });
    });
  }

  private appState(via: Via) {
    const tab = this.activeTab(via);
    return {
      connected: !!tab,
      ...(!tab && this.allTabs().length ? { refused: legacyRefused(this.appUrl) } : {}),
      tabs: this.tabs(via).length,
      activeTab: tab?.tab ?? null,
      ...(tab ? tab.state : { current: null, dirty: false }),
    };
  }

  // ---------------------------------------------------------------------------
  // http: WebSocket upgrades of tabs, and the scenes server API for the MCP
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // the app's address comes from the Worker's MCP side only, never from a tab's connection
    const appUrl = url.pathname === "/live" ? null : request.headers.get("X-Kurviq-App");
    if (appUrl) {
      this.appUrl = appUrl;
    }
    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket", { status: 426 });
      }
      if (this.allTabs().length >= MAX_TABS) {
        return new Response("Too many open Kurviq tabs for this agent link", { status: 429 });
      }
      const pair = new WebSocketPair();
      const tab = (url.searchParams.get("tab") || crypto.randomUUID()).slice(0, 40);
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ tab, connectedAt: Date.now(), state: {} } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    try {
      return await this.api(request, url);
    } catch (error: any) {
      return json(error.status || 500, { error: error.message });
    }
  }

  private async api(request: Request, url: URL): Promise<Response> {
    const via: Via = request.headers.get("X-Kurviq-Via") === "oauth" ? "oauth" : "link";
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    if (url.pathname === "/api/app/state") {
      return json(200, this.appState(via));
    }
    if (url.pathname === "/api/app/command" && request.method === "POST") {
      const command = JSON.parse(body || "{}");
      // no headless Excalidraw here: the agent's own work runs in the user's tab too
      delete command.agentSide;
      const tab = this.activeTab(via, command.targetScene);
      if (!tab) {
        throw this.notOpen();
      }
      return json(200, { ok: true, result: await this.send(tab.ws, command) });
    }
    if (url.pathname === "/api/app/flush" && request.method === "POST") {
      const { name } = JSON.parse(body || "{}");
      const showing = this.tabs(via).filter((tab) => tab.state.current === name);
      const targets = showing.length ? showing : [this.activeTab(via)].filter((tab) => !!tab);
      const results = [];
      for (const tab of targets) {
        try {
          results.push(await this.send(tab!.ws, { type: "flush", name }, 15_000));
        } catch (error: any) {
          results.push({ error: error.message });
        }
      }
      return json(200, { tabs: targets.length, results });
    }
    if (url.pathname === "/api/pdf") {
      return json(501, {
        error:
          "PDF export is not available through the Kurviq MCP. The user can export the deck as PDF in Kurviq: Slides sidebar → PDF.",
      });
    }
    if (url.pathname.startsWith("/api/scenes")) {
      const tab = this.activeTab(via);
      if (!tab) {
        throw this.notOpen();
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        if (key.startsWith("x-") || key === "content-type") {
          headers[key] = value;
        }
      });
      const answer = await this.send(tab.ws, {
        type: "http",
        request: { method: request.method, path: url.pathname + url.search, headers, body },
      });
      if (answer?.status >= 200 && answer.status < 300 && request.method !== "GET") {
        this.broadcast({ type: "scene-saved", source: "agent" }, tab.ws);
      }
      return new Response(answer?.body ?? "", { status: answer?.status ?? 500, headers: answer?.headers ?? {} });
    }
    return json(404, { error: "Not found" });
  }

  /** tell the other tabs of this browser that GitHub changed (they sync) */
  private broadcast(event: unknown, except?: WebSocket) {
    for (const tab of this.allTabs()) {
      if (tab.ws !== except) {
        sendMessage(tab.ws, event);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket events (also after hibernation)
  // ---------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") {
      return;
    }
    let receive = this.receivers.get(ws);
    if (!receive) {
      receive = createReceiver();
      this.receivers.set(ws, receive);
    }
    let message: any;
    try {
      message = receive(raw);
    } catch {
      // malformed or oversized: not a Kurviq tab
      this.receivers.delete(ws);
      try {
        ws.close(1008, "invalid message");
      } catch {}
      return;
    }
    if (!message) {
      return;
    }
    if (message.type === "state") {
      const info = ws.deserializeAttachment() as Attachment;
      ws.serializeAttachment({ ...info, state: { ...(message.state || {}) } } satisfies Attachment);
    } else if (message.type === "result") {
      const entry = this.pending.get(String(message.id));
      // only the tab the command went to may answer it
      if (!entry || entry.tab !== (ws.deserializeAttachment() as Attachment).tab) {
        return;
      }
      this.pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        entry.reject(httpError(422, message.error || "Command failed in the Kurviq tab"));
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {}
  }

  async webSocketError() {}
}
