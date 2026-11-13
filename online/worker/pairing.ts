// One Durable Object per agent pairing (= per browser that made an agent
// link). It plays the part of the local scenes server's live channel: the
// browser's Kurviq tabs are connected to it with a WebSocket, and the remote
// MCP's requests to "the scenes server" are answered here (app state,
// commands) or by the most suitable tab (/api/scenes…: the tab reads and
// saves in Google Drive with the user's sign-in).
//
// Stores no data: the tabs' WebSockets (with their last state as attachment)
// are all there is, and they survive hibernation. The only thing written is
// the id of each agent sign-in code that was redeemed, until the code expires
// (a minute), so that no code is redeemed twice (./oauth.ts).

import { DurableObject } from "cloudflare:workers";

import { createReceiver, sendMessage } from "../../scenes-plugin/src/online/frames";

type TabState = {
  current?: string | null;
  dirty?: boolean;
  visible?: boolean;
  focusedAt?: number;
  drive?: boolean;
};

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
/** edits (saves with pictures) and pictures may take longer */
const SLOW_COMMANDS = new Set(["scene-edit", "local-edit", "render", "deck-check", "convert", "upload", "upload-payload", "http"]);
const SLOW_TIMEOUT_MS = 75_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export class Pairing extends DurableObject {
  private readonly pending = new Map<string, Pending>();
  private readonly receivers = new WeakMap<WebSocket, (raw: string) => any>();
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

  /** the tab agents talk to: the visible, most recently focused one (or the one showing `scene`) */
  private activeTab(scene?: string | null) {
    const rank = (tab: Attachment) => [tab.state.visible ? 1 : 0, tab.state.focusedAt || 0, tab.connectedAt];
    const pick = (onlyScene?: string | null) => {
      let best: (Attachment & { ws: WebSocket }) | null = null;
      for (const tab of this.allTabs()) {
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
    return httpError(
      409,
      `Kurviq is not open in the user's browser. The agent works through the user's open Kurviq tab: ask the user to open ${this.appUrl} (in the browser where they allowed this agent) and keep the tab open.`,
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
      try {
        // with this build: a tab running an older version says so instead of half-working
        sendMessage(ws, { type: "command", id, command, build: __KURVIQ_BUILD__ });
      } catch {
        // the socket is closing already: no answer will come
        this.settle(id, httpError(409, "The Kurviq tab was closed before it got the command. Try again (another open tab takes it)."));
      }
    });
  }

  /** ends a waiting command with an error (its timer too) */
  private settle(id: string, error: Error) {
    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private appState() {
    const tab = this.activeTab();
    return {
      connected: !!tab,
      tabs: this.allTabs().length,
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

  private async flushTabs(body: string) {
    const { name } = JSON.parse(body || "{}");
    const showing = this.allTabs().filter((tab) => tab.state.current === name);
    const targets = showing.length ? showing : [this.activeTab()].filter((tab) => !!tab);
    const results = [];
    for (const tab of targets) {
      try {
        results.push(await this.send(tab!.ws, { type: "flush", name }, 15_000)); // NOSONAR S9382: in order on purpose (flush tabs in order to preserve request and result order)
      } catch (error: any) {
        results.push({ error: error.message });
      }
    }
    return json(200, { tabs: targets.length, results });
  }

  private async api(request: Request, url: URL): Promise<Response> {
    const bodyless = ["GET", "HEAD"].includes(request.method);
    const body = bodyless ? "" : await request.text();
    if (url.pathname === "/oauth/code" && request.method === "POST") {
      return this.redeemCode(body);
    }
    if (url.pathname === "/api/app/state") {
      return json(200, this.appState());
    }
    if (url.pathname === "/api/app/command" && request.method === "POST") {
      const command = JSON.parse(body || "{}");
      // no headless Excalidraw here: the agent's own work runs in the user's tab too
      delete command.agentSide;
      const tab = this.activeTab(command.targetScene);
      if (!tab) {
        throw this.notOpen();
      }
      return json(200, { ok: true, result: await this.send(tab.ws, command) });
    }
    if (url.pathname === "/api/app/flush" && request.method === "POST") {
      return this.flushTabs(body);
    }
    if (url.pathname.startsWith("/api/scenes")) {
      return this.sceneApi(request, url, body);
    }
    return json(404, { error: "Not found" });
  }

  /**
   * An agent sign-in code is redeemed (POST { id, exp }): 200 the first time,
   * 409 after that. The id is kept until the code expires; then it is no use
   * anyway (./oauth.ts checks the expiry first).
   */
  private async redeemCode(body: string) {
    const { id, exp } = JSON.parse(body || "{}") as { id?: unknown; exp?: unknown };
    if (typeof id !== "string" || !/^[\w-]{16,64}$/.test(id) || typeof exp !== "number") {
      return json(400, { error: "id, exp" });
    }
    const now = Date.now();
    // expired ids go first (a handful at most: codes live a minute)
    const used = await this.ctx.storage.list<number>({ prefix: "code:" });
    const expired = [...used].filter(([, until]) => until <= now).map(([key]) => key);
    if (expired.length) {
      await this.ctx.storage.delete(expired);
    }
    if (used.has(`code:${id}`) && !expired.includes(`code:${id}`)) {
      return json(409, { error: "already redeemed" });
    }
    await this.ctx.storage.put(`code:${id}`, exp);
    return json(200, { ok: true });
  }

  private async sceneApi(request: Request, url: URL, body: string): Promise<Response> {
    const tab = this.activeTab();
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

  /** tell the other tabs of this browser that an agent saved a scene (they sync) */
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

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) { // NOSONAR S7503: preserves the Durable Object handler promise and rejection contract
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
      ws.serializeAttachment({ ...info, state: { ...message.state } } satisfies Attachment);
    } else if (message.type === "result") {
      const entry = this.pending.get(String(message.id));
      // only the tab the command went to may answer it
      if (entry?.tab !== (ws.deserializeAttachment() as Attachment).tab) {
        return;
      }
      if (message.ok) {
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        entry.resolve(message.result);
      } else {
        this.settle(String(message.id), httpError(422, message.error || "Command failed in the Kurviq tab"));
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) { // NOSONAR S7503: preserves the Durable Object handler promise and rejection contract
    // the commands that tab was working on get no answer: the agent hears it now, not after the timeout
    const tab = (ws.deserializeAttachment() as Attachment | null)?.tab;
    // (a Map may lose entries while it is iterated: settle removes the one at hand)
    for (const [id, entry] of this.pending) {
      if (entry.tab === tab) {
        this.settle(id, httpError(409, "The Kurviq tab was closed (or reloaded) while it worked on this. Check the scene with read_scene and try again."));
      }
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {}
  }

  async webSocketError() {
    // No recovery is needed here; the close handler handles connection cleanup.
  }
}
