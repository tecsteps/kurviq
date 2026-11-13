// The relay of one Drive scene (one Durable Object per Drive file id,
// docs/relay/CONCEPT.md): the open tabs' WebSockets and the pen
// (./relayRoom.ts), in memory only. It has no storage at all and doesn't use
// WebSocket hibernation (the sockets are accepted here, not by the runtime),
// so not even connection data is written anywhere; when the last tab
// leaves, the object is gone. It never sees a Google token or the scene's
// key: the tabs encrypt every payload end to end.
//
// The Worker checks the ticket (./relayRoutes.ts) and hands the checked
// claims in a header; this object is only reachable through the Worker.

import { DurableObject } from "cloudflare:workers";

import { RelayRoom, SILENT_DROP_MS } from "./relayRoom";
import type { Out, RelayClaims } from "./relayRoom";

export const CLAIMS_HEADER = "X-Kurviq-Relay";
/** how often silent participants and the holder's idle time are checked */
const SWEEP_MS = 20_000;

const validClaims = (value: any): value is RelayClaims =>
  !!value &&
  typeof value.name === "string" &&
  typeof value.color === "string" &&
  typeof value.who === "string" &&
  ["edit", "comment", "read"].includes(value.role);

export class SceneRelay extends DurableObject {
  private readonly room = new RelayRoom();
  private readonly sockets = new Map<string, WebSocket>();
  private timer: ReturnType<typeof setInterval> | null = null;

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    let claims: unknown;
    try {
      claims = JSON.parse(request.headers.get(CLAIMS_HEADER) ?? "");
    } catch {
      claims = null;
    }
    if (!validClaims(claims)) {
      return new Response("Invalid ticket", { status: 403 });
    }
    const id = crypto.randomUUID();
    const joined = this.room.join(id, claims, Date.now());
    if (!joined) {
      return new Response("Too many tabs on this scene", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(id, server);
    server.addEventListener("message", (event) => this.onMessage(id, event.data));
    server.addEventListener("close", () => this.onClose(id));
    server.addEventListener("error", () => this.onClose(id));
    this.deliver(joined);
    this.startSweeping();
    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(id: string, data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    this.deliver(this.room.receive(id, msg, Date.now()));
  }

  private onClose(id: string) {
    const socket = this.sockets.get(id);
    if (!socket) {
      return;
    }
    this.sockets.delete(id);
    try {
      socket.close(1000, "bye");
    } catch {}
    this.deliver(this.room.leave(id, Date.now()));
    if (!this.sockets.size) {
      this.stopSweeping();
    }
  }

  private deliver(out: Out[]) {
    // one serialization per distinct message (a state goes to everyone)
    const texts = new Map<Record<string, unknown>, string>();
    for (const { to, msg } of out) {
      const socket = this.sockets.get(to);
      if (!socket) {
        continue;
      }
      let text = texts.get(msg);
      if (text === undefined) {
        text = JSON.stringify(msg);
        texts.set(msg, text);
      }
      try {
        socket.send(text);
      } catch {
        this.onClose(to);
      }
    }
  }

  /** silent participants go (a holder's pen with them); the holder turning idle is announced */
  sweep(now = Date.now()) {
    for (const id of this.room.silent(now)) {
      this.onClose(id);
    }
    this.deliver(this.room.sweep(now));
  }

  private startSweeping() {
    this.timer ??= setInterval(() => this.sweep(), Math.min(SWEEP_MS, SILENT_DROP_MS / 4));
  }

  private stopSweeping() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
