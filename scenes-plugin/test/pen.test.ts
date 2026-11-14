// The pen's pure parts (online/penSync.ts), the scene key's payload
// encryption (online/sceneKey.ts) and the Worker's ticket decisions
// (online/worker/sceneRoutes.ts): who may do what, and a rate limit is never
// "no access".
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import {
  Assembler,
  MARK_STALE_MS,
  connectionDead,
  dropSocket,
  editingRefusal,
  markHolder,
  markText,
  parseMark,
  rememberSent,
  socketGone,
  splitBody,
  unsentElements,
  withIncoming,
} from "../src/online/penSync";
import { importSceneKey, keyIdOf, keyProperty, newKey, openPayload, parseKeyProperty, sealPayload } from "../src/online/sceneKey";
import { PEOPLE_COLORS, colorOf, fileProblem, roleOf } from "../../online/worker/sceneRoutes";

const el = (id: string, version: number, index: string, props: Record<string, unknown> = {}) => ({ id, version, versionNonce: version * 7, index, ...props });

describe("what the holder sends", () => {
  it("only elements whose state the others don't have yet", () => {
    const sent = new Map<string, string>();
    const first = [el("a", 1, "a0"), el("b", 1, "a1")];
    expect(unsentElements(first, sent).map((item) => item.id)).toEqual(["a", "b"]);
    rememberSent(sent, first);
    expect(unsentElements(first, sent)).toEqual([]);
    const moved = [el("a", 2, "a0", { x: 5 }), el("b", 1, "a1")];
    expect(unsentElements(moved, sent).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("a viewer's canvas", () => {
  it("takes the holder's state of each element, adds new ones, keeps the z-order", () => {
    const current = [el("a", 1, "a0"), el("b", 1, "a2")];
    const next = withIncoming(current, [el("b", 2, "a2", { x: 9 }), el("c", 1, "a1")])!;
    expect(next.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(next.find((item) => item.id === "b")).toMatchObject({ version: 2, x: 9 });
  });

  it("nothing new: nothing to apply", () => {
    const current = [el("a", 1, "a0")];
    expect(withIncoming(current, [el("a", 1, "a0")])).toBeNull();
  });

  it("deletions come as deleted elements", () => {
    const next = withIncoming([el("a", 1, "a0")], [el("a", 2, "a0", { isDeleted: true })])!;
    expect(next[0].isDeleted).toBe(true);
  });
});

describe("big payloads", () => {
  it("go in parts and come back whole, per sender and request, in any order", () => {
    const body = "x".repeat(1000) + "y".repeat(1000) + "z";
    const parts = splitBody(body, 1000);
    expect(parts).toHaveLength(3);
    const assembler = new Assembler();
    expect(assembler.add("anna:r1", 2, 3, parts[2], 0)).toBeNull();
    expect(assembler.add("ben:r1", 0, 3, "other", 0)).toBeNull();
    expect(assembler.add("anna:r1", 0, 3, parts[0], 0)).toBeNull();
    expect(assembler.add("anna:r1", 1, 3, parts[1], 0)).toBe(body);
    expect(splitBody("")).toEqual([""]);
    expect(assembler.add("x", 0, 1, "small", 0)).toBe("small");
  });

  it("an unfinished payload is dropped after two minutes", () => {
    const assembler = new Assembler();
    assembler.add("anna:r1", 0, 2, "a", 0);
    assembler.sweep(2 * 60_000 + 1);
    expect(assembler.add("anna:r1", 1, 2, "b", 2 * 60_000 + 2)).toBeNull();
  });
});

describe("the mark on the Drive file", () => {
  it("fits Drive's 124 bytes for key and value, and reads back", () => {
    const text = markText({ n: "A very long display name that goes on and on and on", t: 1_731_500_000_000, i: "tab-1234567890abcdef-more" });
    expect(new TextEncoder().encode(`kurviqPen${text}`).length).toBeLessThanOrEqual(124);
    expect(parseMark(text)).toMatchObject({ t: 1_731_500_000_000 });
    expect(parseMark("not json")).toBeNull();
    expect(parseMark(null)).toBeNull();
  });

  it("someone else's fresh mark makes this tab read only; a stale one or this tab's own doesn't", () => {
    const now = 10 * MARK_STALE_MS;
    const mark = { n: "Anna", t: now - 1000, i: "tab-a" };
    expect(markHolder(mark, "tab-b", now)).toBe("Anna");
    expect(markHolder(mark, "tab-a", now)).toBeNull();
    expect(markHolder({ ...mark, t: now - MARK_STALE_MS }, "tab-b", now)).toBeNull();
    expect(markHolder(null, "tab-b", now)).toBeNull();
  });
});

describe("the relay connection", () => {
  it("is dead only when nothing came in for a minute and nothing drains (progress, not a fixed time)", () => {
    expect(connectionDead(61_000, 0, 0, 0)).toBe(true);
    expect(connectionDead(59_000, 0, 0, 0)).toBe(false);
    // a big upload still moving keeps the connection
    expect(connectionDead(61_000, 0, 500, 900)).toBe(false);
    expect(connectionDead(61_000, 0, 900, 900)).toBe(true);
  });

  it("a closing socket counts as gone: its close handshake may never end while the network is down", () => {
    expect(socketGone(0)).toBe(false); // connecting
    expect(socketGone(1)).toBe(false); // open
    expect(socketGone(2)).toBe(true); // closing (the pen e2e's offline case hung here, "connected" and read only)
    expect(socketGone(3)).toBe(true);
  });

  it("a dropped socket is gone at once, without waiting for its close event, and sends no more events", () => {
    const gone = vi.fn();
    // a socket whose close handshake never ends: close() only starts it, onclose never comes
    const ws = { readyState: 1, onmessage: vi.fn() as unknown, onclose: vi.fn() as unknown, onerror: vi.fn() as unknown, close: vi.fn(() => (ws.readyState = 2)) };
    dropSocket(ws, gone);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onerror).toBeNull();
    const broken = { onmessage: null, onclose: null, onerror: null, close: () => { throw new Error("closed already"); } };
    dropSocket(broken, gone);
    expect(gone).toHaveBeenCalledTimes(2);
  });
});

describe("agents", () => {
  it("are told who is editing", () => {
    expect(editingRefusal("Anna")).toMatch(/^Anna is editing this scene/);
  });
});

describe("payload encryption with the scene key", () => {
  it("round trips, and refuses another kind, another scene or a changed body", async () => {
    const raw = newKey();
    const keyId = await keyIdOf(raw);
    const key = await importSceneKey(raw, keyId, "file-aaaaaaaaaa");
    const body = await sealPayload(key, "change", { els: [1, 2] });
    expect(await openPayload(key, "change", body)).toEqual({ els: [1, 2] });
    await expect(openPayload(key, "saved", body)).rejects.toThrow();
    await expect(openPayload(await importSceneKey(raw, keyId, "file-bbbbbbbbbb"), "change", body)).rejects.toThrow();
    const changed = `${body.slice(0, 20)}${body[20] === "A" ? "B" : "A"}${body.slice(21)}`;
    await expect(openPayload(key, "change", changed)).rejects.toThrow();
  });

  it("the key property names its file: a copy's key counts as another file's", async () => {
    const raw = newKey();
    const keyId = await keyIdOf(raw);
    expect(await parseKeyProperty(keyProperty(keyId, "file-aaaaaaaaaa", raw), "file-aaaaaaaaaa")).toMatchObject({ copy: false, key: raw });
    expect(await parseKeyProperty(keyProperty(keyId, "file-aaaaaaaaaa", raw), "file-bbbbbbbbbb")).toMatchObject({ copy: true });
    expect(await parseKeyProperty(keyProperty("wrongwrongwr", "file-aaaaaaaaaa", raw), "file-aaaaaaaaaa")).toBeNull();
  });
});

describe("the relay ticket (the Worker asks Drive)", () => {
  const ctx = () => ({ cookies: [], local: false, origin: null }) as any;
  const answer = (status: number, reason?: string) => ({ status, data: reason ? { error: { errors: [{ reason }] } } : null, text: "" });

  it("Drive's capabilities decide the role: edit, comment, else read", () => {
    expect(roleOf({ capabilities: { canEdit: true, canComment: true } })).toBe("edit");
    expect(roleOf({ capabilities: { canEdit: false, canComment: true } })).toBe("comment");
    expect(roleOf({ capabilities: {} })).toBe("read");
  });

  it("a Google rate limit or outage is 'try again', never 'no access'", () => {
    expect(fileProblem(ctx(), answer(429)).status).toBe(503);
    expect(fileProblem(ctx(), answer(403, "userRateLimitExceeded")).status).toBe(503);
    expect(fileProblem(ctx(), answer(0)).status).toBe(503);
    expect(fileProblem(ctx(), answer(401)).status).toBe(401);
    expect(fileProblem(ctx(), answer(403, "insufficientFilePermissions")).status).toBe(403);
    expect(fileProblem(ctx(), answer(404)).status).toBe(403);
  });

  it("the same person always gets the same color", () => {
    expect(colorOf("0000000a")).toBe(PEOPLE_COLORS[10 % PEOPLE_COLORS.length]);
    expect(colorOf("zz")).toBe(PEOPLE_COLORS[0]);
  });
});

describe("statistics of relay tickets", () => {
  it("count a ticket of kurviq.com's own pages as a relay session of its scene (nothing else)", async () => {
    const { routeStats } = await import("../../online/worker/stats");
    const batches: unknown[] = [];
    const env = {
      STATS_ENABLED: "on",
      STATS: {
        idFromName: () => "id",
        get: () => ({
          fetch: (_url: string, init: any) => {
            batches.push(JSON.parse(init.body));
            return Promise.resolve(new Response(null));
          },
        }),
      },
    } as any;
    const ctx = { waitUntil: (promise: Promise<unknown>) => promise } as any;
    const ticket = (origin: string, status = 200) =>
      routeStats(new Request("https://kurviq.com/relay/file-aaaaaaaaaa/ticket", { method: "POST", headers: { Origin: origin } }), new Response("{}", { status }), env, ctx);
    ticket("https://kurviq.com");
    ticket("http://draw.test");
    ticket("https://kurviq.com", 403);
    await Promise.resolve();
    expect(batches).toEqual([{ c: [["live_sessions", "all", 1]], s: ["file-aaaaaaaaaa"] }]);
  });
});
