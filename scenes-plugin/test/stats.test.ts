// Usage statistics (online/worker/stats.ts): what counts as a page load and
// which entry, the HyperLogLog estimate, and the Stats object's writes to D1
// (never lost, never applied twice).
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { resetSchemaForTests } from "../../online/worker/database";
import { Stats, deviceOf, entryOf, hllEstimate, hllPosition, isPageLoad } from "../../online/worker/stats";

import { fakeD1 } from "./fakeD1";

beforeEach(() => resetSchemaForTests());

describe("what is counted", () => {
  const navigation = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://kurviq.com${path}`, {
      headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "User-Agent": "Mozilla/5.0 (Macintosh)", ...headers },
    });
  const html = new Response("<html>", { headers: { "Content-Type": "text/html" } });

  it("maps paths to entries", () => {
    expect(entryOf("/")).toBe("app");
    expect(entryOf("/my-plan")).toBe("app");
    expect(entryOf("/s/abc/Plan")).toBe("shared");
    expect(entryOf("/pub/talk")).toBe("shared");
    expect(entryOf("/features")).toBe("features");
    expect(entryOf("/imprint.html")).toBe("imprint");
    expect(entryOf("/about/")).toBe("about");
    expect(entryOf("/%E0%A4%A")).toBe("app");
  });

  it("counts navigations to pages, nothing else", () => {
    expect(isPageLoad(navigation("/"), html)).toBe(true);
    expect(isPageLoad(navigation("/", { "Sec-Fetch-Dest": "empty" }), html)).toBe(true);
    expect(isPageLoad(navigation("/", { "Sec-Purpose": "prefetch" }), html)).toBe(false);
    expect(isPageLoad(navigation("/", { "User-Agent": "Googlebot/2.1" }), html)).toBe(false);
    expect(isPageLoad(navigation("/", { "Sec-Fetch-Mode": "cors" }), html)).toBe(false);
    expect(isPageLoad(navigation("/"), new Response("{}", { headers: { "Content-Type": "application/json" } }))).toBe(false);
    expect(isPageLoad(navigation("/plan"), new Response(null, { status: 304 }))).toBe(true);
    expect(isPageLoad(navigation("/logo.png"), new Response(null, { status: 304 }))).toBe(false);
  });

  it("tells devices apart", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; SM-X710)")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop");
  });
});

describe("HyperLogLog", () => {
  it("finds register and rank", () => {
    const hash = new Uint8Array([0b1000_0000, 0, 0b0001_0000, 0, 0, 0, 0, 0]);
    // 4 bits of index (1000 = 8), then 15 zeros before the first one: rank 16
    expect(hllPosition(hash, 4)).toEqual({ index: 8, rank: 16 });
  });

  it("estimates within 3 %", async () => {
    // SHA-256 of distinct values, as the object's HMAC: the same in every run
    for (const n of [100, 5_000, 20_000]) {
      const registers = new Uint8Array(2 ** 12);
      for (let i = 0; i < n; i++) {
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`visitor ${i}`))); // NOSONAR S9382: in order on purpose (a simple loop of a test)
        const { index, rank } = hllPosition(hash, 12);
        registers[index] = Math.max(registers[index], rank);
      }
      expect(Math.abs(hllEstimate(registers) - n) / n).toBeLessThan(0.03);
    }
  });
});

/** the Durable Object's SQLite (ctx.storage.sql) on node:sqlite */
const fakeStorage = () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const values = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      const rows = db.prepare(query).all(...(values as any[]));
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  let alarm: number | null = null;
  return {
    sql,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
};

describe("the Stats object's writes to D1", () => {
  const setup = () => {
    const d1 = fakeD1();
    const stats = new Stats({ storage: fakeStorage() } as any, { FEEDBACK: d1 } as any);
    const add = (count: number) =>
      stats.fetch(new Request("https://stats/add", { method: "POST", body: JSON.stringify({ c: [["views", "app", count]] }) }));
    const flush = () => stats.fetch(new Request("https://stats/flush", { method: "POST" }));
    const total = () => d1.sqlite.prepare("SELECT SUM(value) AS n FROM stats_hourly WHERE metric = 'views'").get() as { n: number | null };
    return { d1, add, flush, total };
  };

  it("writes the counts once", async () => {
    const { add, flush, total } = setup();
    await add(3);
    await flush();
    await flush();
    expect(total().n).toBe(3);
  });

  it("keeps the counts when D1 fails, and writes them later", async () => {
    const { d1, add, flush, total } = setup();
    await add(3);
    await flush(); // makes the tables
    await add(2);
    d1.failNextBatch("before");
    await flush();
    expect(total().n).toBe(3);
    await flush();
    expect(total().n).toBe(5);
  });

  it("doesn't write twice when D1's answer was lost", async () => {
    const { d1, add, flush, total } = setup();
    await add(3);
    await flush();
    await add(2);
    d1.failNextBatch("after");
    await flush();
    expect(total().n).toBe(5);
    await add(1);
    await flush();
    expect(total().n).toBe(6);
  });
});
