// The relay of a Drive scene (online/worker/relayRoom.ts, relay.ts): who holds
// the pen, decided in memory one message at a time; payloads forwarded
// unread; nothing ever stored (the object never touches its storage).
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { IDLE_TAKEOVER_MS, MAX_BODY, MAX_TABS_PER_ACCOUNT, RelayRoom, SILENT_DROP_MS } from "../../online/worker/relayRoom";
import type { Out, RelayClaims } from "../../online/worker/relayRoom";
import { CLAIMS_HEADER, SceneRelay } from "../../online/worker/relay";

const anna: RelayClaims = { name: "Anna", color: "#7048e8", role: "edit", who: "a1" };
const ben: RelayClaims = { name: "Ben", color: "#1971c2", role: "edit", who: "b1" };
const carl: RelayClaims = { name: "Carl", color: "#0c8599", role: "read", who: "c1" };
const dora: RelayClaims = { name: "Dora", color: "#2f9e44", role: "comment", who: "d1", email: "dora@example.test" };

const to = (out: Out[] | null, id: string) => (out ?? []).filter((item) => item.to === id).map((item) => item.msg);
const last = (out: Out[] | null, id: string, t: string) => to(out, id).filter((msg) => msg.t === t).at(-1) as any;

/** a room with Anna, Ben (editors), Carl (reader), Dora (commenter); Anna holds the pen */
const room = (now = 0) => {
  const r = new RelayRoom();
  r.join("A", anna, now);
  r.join("B", ben, now);
  r.join("C", carl, now);
  r.join("D", dora, now);
  r.receive("A", { t: "claim" }, now);
  return r;
};

describe("the pen", () => {
  it("welcomes a newcomer and tells everyone who is there", () => {
    const r = new RelayRoom();
    const out = r.join("A", anna, 0);
    expect(last(out, "A", "welcome")).toEqual({ t: "welcome", you: "A", role: "edit" });
    expect(last(out, "A", "state")).toMatchObject({ holder: null, people: [{ id: "A", name: "Anna", role: "edit" }] });
  });

  it("two claims at the same moment: exactly one gets the pen", () => {
    const r = new RelayRoom();
    r.join("A", anna, 0);
    r.join("B", ben, 0);
    const first = r.receive("A", { t: "claim" }, 1);
    const second = r.receive("B", { t: "claim" }, 1);
    expect(r.holderId()).toBe("A");
    expect(last(first, "B", "state").holder).toMatchObject({ id: "A", name: "Anna" });
    expect(last(second, "B", "refused")).toEqual({ t: "refused", action: "claim", why: "held" });
  });

  it("readers and commenters never hold the pen", () => {
    const r = new RelayRoom();
    r.join("C", carl, 0);
    r.join("D", dora, 0);
    expect(last(r.receive("C", { t: "claim" }, 0), "C", "refused").why).toBe("not-editor");
    expect(last(r.receive("D", { t: "takeover" }, 0), "D", "refused").why).toBe("not-editor");
    expect(r.holderId()).toBeNull();
  });

  it("ask: the holder hears who asks; keep tells the asker; hand over moves the pen", () => {
    const r = room();
    const asked = r.receive("B", { t: "ask" }, 1);
    expect(last(asked, "A", "asked")).toEqual({ t: "asked", by: { id: "B", name: "Ben", color: "#1971c2", role: "edit" } });
    expect(last(asked, "A", "state").asking).toEqual(["B"]);
    expect(last(r.receive("A", { t: "decline", to: "B" }, 2), "B", "declined")).toEqual({ t: "declined", by: "Anna" });
    r.receive("B", { t: "ask" }, 3);
    const handed = r.receive("A", { t: "handover", to: "B" }, 4);
    expect(r.holderId()).toBe("B");
    expect(last(handed, "B", "granted")).toEqual({ t: "granted", from: "Anna" });
    expect(last(handed, "A", "state")).toMatchObject({ holder: { id: "B" }, asking: [] });
  });

  it("only the holder hands over, and only to an editor", () => {
    const r = room();
    expect(last(r.receive("B", { t: "handover", to: "B" }, 1), "B", "refused").action).toBe("handover");
    expect(last(r.receive("A", { t: "handover", to: "C" }, 1), "A", "refused").action).toBe("handover");
    expect(r.holderId()).toBe("A");
  });

  it("asking a free pen takes it", () => {
    const r = new RelayRoom();
    r.join("B", ben, 0);
    r.receive("B", { t: "ask" }, 0);
    expect(r.holderId()).toBe("B");
  });

  it("take over: refused while the holder is active, allowed after 5 idle minutes", () => {
    const r = room(0);
    expect(last(r.receive("B", { t: "takeover" }, IDLE_TAKEOVER_MS - 1), "B", "refused").why).toBe("not-idle");
    r.receive("A", { t: "active" }, 60_000);
    expect(r.receive("B", { t: "takeover" }, 60_000 + IDLE_TAKEOVER_MS - 1).some((out) => out.msg.t === "refused")).toBe(true);
    const taken = r.receive("B", { t: "takeover" }, 60_000 + IDLE_TAKEOVER_MS);
    expect(r.holderId()).toBe("B");
    expect(last(taken, "A", "taken")).toEqual({ t: "taken", by: "Ben" });
  });

  it("the holder turning idle is announced (others may take over)", () => {
    const r = room(0);
    expect(r.sweep(IDLE_TAKEOVER_MS - 1)).toEqual([]);
    const out = r.sweep(IDLE_TAKEOVER_MS);
    expect(last(out, "B", "state").idle).toBe(true);
    expect(r.sweep(IDLE_TAKEOVER_MS + 1)).toEqual([]);
  });

  it("the same account's other tab takes over at once", () => {
    const r = room(0);
    r.join("A2", { ...anna }, 0);
    r.receive("A2", { t: "takeover" }, 1);
    expect(r.holderId()).toBe("A2");
  });

  it("closing the holder's tab frees the pen at once; stop editing too", () => {
    const r = room();
    const out = r.leave("A", 1);
    expect(r.holderId()).toBeNull();
    expect(last(out, "B", "state").holder).toBeNull();
    r.receive("B", { t: "claim" }, 2);
    r.receive("B", { t: "release" }, 3);
    expect(r.holderId()).toBeNull();
  });

  it("a participant silent for 2 minutes is reported (and dropped by the object)", () => {
    const r = room(0);
    r.receive("B", { t: "ping" }, SILENT_DROP_MS - 10);
    expect(r.silent(SILENT_DROP_MS).sort((a, b) => a.localeCompare(b))).toEqual(["A", "C", "D"]);
    expect(r.receive("B", { t: "ping" }, SILENT_DROP_MS)).toEqual([{ to: "B", msg: { t: "pong" } }]);
  });

  it("limits the tabs of one account", () => {
    const r = new RelayRoom();
    for (let i = 0; i < MAX_TABS_PER_ACCOUNT; i++) {
      expect(r.join(`A${i}`, anna, 0)).not.toBeNull();
    }
    expect(r.join("A-too-many", anna, 0)).toBeNull();
  });
});

describe("payloads", () => {
  it("the holder's changes go to everyone else, as they are", () => {
    const r = room();
    const out = r.receive("A", { t: "send", kind: "change", body: "cipher" }, 1);
    expect(out.map((item) => item.to).sort((a, b) => a.localeCompare(b))).toEqual(["B", "C", "D"]);
    expect(out[0].msg).toEqual({ t: "msg", kind: "change", from: { id: "A", name: "Anna", color: "#7048e8", role: "edit" }, body: "cipher" });
  });

  it("only the holder sends scene changes", () => {
    const r = room();
    expect(last(r.receive("B", { t: "send", kind: "change", body: "x" }, 1), "B", "refused").why).toBe("not-holder");
  });

  it("catch-up: asked of the holder, answered to the newcomer only, in parts", () => {
    const r = room();
    expect(r.receive("C", { t: "send", kind: "catchup-req", body: "x" }, 1).map((item) => item.to)).toEqual(["A"]);
    const out = r.receive("A", { t: "send", kind: "catchup", to: "C", body: "part", req: "r1", part: 0, parts: 2 }, 1);
    expect(out).toEqual([{ to: "C", msg: { t: "msg", kind: "catchup", from: { id: "A", name: "Anna", color: "#7048e8", role: "edit" }, body: "part", req: "r1", part: 0, parts: 2 } }]);
  });

  it("commenters' operations go to the holder with who they are (from the ticket); readers can't send any", () => {
    const r = room();
    const out = r.receive("D", { t: "send", kind: "ops", body: "c", req: "q1" }, 1);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe("A");
    expect(out[0].msg.from).toEqual({ id: "D", name: "Dora", color: "#2f9e44", role: "comment", key: "d1", email: "dora@example.test" });
    expect(last(r.receive("C", { t: "send", kind: "ops", body: "c" }, 1), "C", "refused").why).toBe("not-commenter");
    // the answer goes back to the commenter only
    expect(r.receive("A", { t: "send", kind: "result", to: "D", body: "ok", req: "q1" }, 2).map((item) => item.to)).toEqual(["D"]);
  });

  it("no holder: a commenter hears at once that nobody is editing", () => {
    const r = room();
    r.leave("A", 1);
    expect(r.receive("D", { t: "send", kind: "ops", body: "c", req: "q2" }, 2)).toEqual([{ to: "D", msg: { t: "no-editor", kind: "ops", req: "q2" } }]);
  });

  it("refuses bodies over the limit and unknown kinds", () => {
    const r = room();
    expect(last(r.receive("A", { t: "send", kind: "change", body: "x".repeat(MAX_BODY + 1) }, 1), "A", "refused").why).toBe("bad-message");
    expect(last(r.receive("A", { t: "send", kind: "secret", body: "x" }, 1), "A", "refused").why).toBe("bad-kind");
  });
});

/** a WebSocket pair as the runtime makes it: messages the object sends land in `sent` */
class FakeSocket {
  readonly sent: string[] = [];
  readonly handlers: Record<string, ((event: any) => void)[]> = {};
  accepted = false;
  closed = false;
  accept() {
    this.accepted = true;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, handler: (event: any) => void) {
    this.handlers[type] ??= [];
    this.handlers[type].push(handler);
  }
  emit(type: string, event: any = {}) {
    (this.handlers[type] ?? []).forEach((handler) => handler(event));
  }
}

describe("the relay object", () => {
  /** a ctx whose storage throws on any use: the relay must never touch it */
  const relay = () => {
    const storage = new Proxy({}, {
      get: (_target, key) => {
        throw new Error(`storage.${String(key)} used`);
      },
    });
    const ctx = { storage, acceptWebSocket: () => { throw new Error("hibernation used"); }, getWebSockets: () => { throw new Error("hibernation used"); } };
    return new SceneRelay(ctx as any, {} as any);
  };

  const connect = (object: SceneRelay, claims: RelayClaims) => {
    const server = new FakeSocket();
    const pair = { 0: new FakeSocket(), 1: server };
    const answers: any[] = [];
    vi.stubGlobal("WebSocketPair", function () {
      return pair;
    });
    vi.stubGlobal(
      "Response",
      class {
        constructor(
          public body: unknown,
          public init: any,
        ) {
          answers.push(this);
        }
      },
    );
    object.fetch(new Request("https://relay/live", { headers: { Upgrade: "websocket", [CLAIMS_HEADER]: JSON.stringify(claims) } }));
    vi.unstubAllGlobals();
    return { server, answer: answers[0] };
  };

  it("accepts the socket itself (no hibernation), keeps nothing in storage, and decides the pen", () => {
    const object = relay();
    const a = connect(object, anna);
    const b = connect(object, ben);
    expect(a.answer.init.status).toBe(101);
    expect(a.server.accepted && b.server.accepted).toBe(true);
    a.server.emit("message", { data: JSON.stringify({ t: "claim" }) });
    b.server.emit("message", { data: JSON.stringify({ t: "claim" }) });
    expect(b.server.sent.map((text) => JSON.parse(text)).find((msg) => msg.t === "refused")).toMatchObject({ action: "claim", why: "held" });
    // the holder's tab closes: the pen is free at once
    a.server.emit("close");
    const states = b.server.sent.map((text) => JSON.parse(text)).filter((msg) => msg.t === "state");
    expect(states.at(-1).holder).toBeNull();
    b.server.emit("close");
  });

  it("refuses a request without the Worker's checked claims", () => {
    const object = relay();
    const answer = object.fetch(new Request("https://relay/live", { headers: { Upgrade: "websocket" } }));
    expect(answer.status).toBe(403);
  });

  it("drops silent participants (the holder's pen with them)", () => {
    const object = relay();
    const a = connect(object, anna);
    const b = connect(object, ben);
    a.server.emit("message", { data: JSON.stringify({ t: "claim" }) });
    b.server.emit("message", { data: JSON.stringify({ t: "ping" }) });
    object.sweep(Date.now() + SILENT_DROP_MS + 1);
    expect(a.server.closed && b.server.closed).toBe(true);
  });

  it("has no storage calls and no hibernation in its source (criterion 2)", () => {
    for (const file of ["relay.ts", "relayRoom.ts"]) {
      const source = readFileSync(new URL(`../../online/worker/${file}`, import.meta.url), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
      expect(source).not.toMatch(/\bstorage\b|acceptWebSocket|getWebSockets|serializeAttachment|setAlarm|setWebSocketAutoResponse/);
    }
  });
});
