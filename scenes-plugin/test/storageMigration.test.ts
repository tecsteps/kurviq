import "fake-indexeddb/auto";

import { beforeAll, describe, expect, it } from "vitest";

// a minimal localStorage (the test runs in node)
const data = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => void data.set(key, String(value)),
  removeItem: (key: string) => void data.delete(key),
};

let storage: typeof import("../src/storage");
beforeAll(async () => {
  storage = await import("../src/storage");
});

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

describe("scene metadata: baseSha / remoteSha → baseMd5 / remoteMd5", () => {
  it("moves the old names to the new ones and writes them back", () => {
    data.set(
      storage.META_KEY,
      JSON.stringify({
        current: "plan",
        baseline: 1,
        autoSync: true,
        scenes: {
          plan: { baseSha: A, remoteSha: B, dirty: true, conflict: { remoteSha: B, clashes: ["x"], v: 3 } },
          fresh: { baseSha: null, dirty: true },
          gone: { baseSha: A, remoteSha: null, dirty: false },
        },
        pendingDeletes: { old: A },
      }),
    );
    const meta = storage.loadMeta();
    expect(meta.scenes.plan).toEqual({ baseMd5: A, remoteMd5: B, dirty: true, conflict: { remoteMd5: B, clashes: ["x"], v: 3 } });
    expect(meta.scenes.fresh).toEqual({ baseMd5: null, dirty: true });
    expect(meta.scenes.gone).toEqual({ baseMd5: A, remoteMd5: null, dirty: false });
    expect(meta.scenes.fresh.legacy).toBeUndefined();
    expect(meta.pendingDeletes).toEqual({ old: A });
    expect(meta.current).toBe("plan");

    // written back: the stored record has only the new names
    const stored = data.get(storage.META_KEY)!;
    expect(stored).not.toMatch(/baseSha|remoteSha/);
    expect(JSON.parse(stored).scenes.plan.baseMd5).toBe(A);
  });

  it("keeps new names as they are and does not write when nothing is old", () => {
    const record = JSON.stringify({ current: null, baseline: null, autoSync: true, scenes: { a: { baseMd5: A, remoteMd5: A, dirty: false } }, pendingDeletes: {} });
    data.set(storage.META_KEY, record);
    const meta = { scenes: JSON.parse(record).scenes };
    expect(storage.migrateMeta(meta)).toBe(false);
    expect(storage.loadMeta().scenes.a).toEqual({ baseMd5: A, remoteMd5: A, dirty: false });
    expect(data.get(storage.META_KEY)).toBe(record);
  });

  it("prefers a new name that is already there over a leftover old one", () => {
    const meta = { scenes: { a: { baseMd5: B, baseSha: A, dirty: false } } };
    expect(storage.migrateMeta(meta)).toBe(true);
    expect(meta.scenes.a).toEqual({ baseMd5: B, dirty: false });
  });

  it("still marks pre-sync-engine records (no base at all) as legacy", () => {
    data.set(storage.META_KEY, JSON.stringify({ current: null, scenes: { a: { dirty: true } }, pendingDeletes: {} }));
    expect(storage.loadMeta().scenes.a).toEqual({ baseMd5: null, dirty: true, legacy: true });
  });
});
