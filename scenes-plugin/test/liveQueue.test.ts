import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import {
  commandRecord,
  recordCommand,
  holdTab,
  orphanQueues,
  claimTab,
  batchKey,
  batchesOf,
  deleteBatch,
  moveAccount,
  nextCounter,
  putBatch,
} from "../src/online/liveQueue";

import type { QueuedBatch } from "../src/online/liveQueue";

const batch = (
  sub: string,
  fileId: string,
  tab: string,
  counter: number
): QueuedBatch => ({
  sub,
  fileId,
  tab,
  counter,
  made: Date.now(),
  live: true,
  via: "user",
  changes: [
    {
      k: "el",
      id: `e${counter}`,
      value: { id: `e${counter}` },
      base: null,
      keys: null,
    },
  ],
  state: "queued",
});

describe("the browser's queue", () => {
  it("is keyed by account, file, tab and counter", async () => {
    expect(batchKey(batch("s", "f", "t", 3))).toEqual(["s", "f", "t", 3]);
    await putBatch(batch("alice", "f1", "t1", 1));
    await putBatch(batch("alice", "f1", "t1", 2));
    await putBatch(batch("alice", "f1", "t2", 1));
    await putBatch(batch("alice", "f2", "t3", 1));
    await putBatch(batch("bob", "f1", "t9", 1));
    // another account's queue is never part of this one's
    expect(await batchesOf("alice")).toHaveLength(4);
    expect((await batchesOf("bob")).map((entry) => entry.tab)).toEqual(["t9"]);
    expect(await batchesOf("alice", "f1")).toHaveLength(3);
    expect(
      (await batchesOf("alice", "f1", "t1")).map((entry) => entry.counter)
    ).toEqual([1, 2]);
    // a prefix of an id is not the id
    await putBatch(batch("ali", "f1", "t1", 1));
    expect(await batchesOf("alice")).toHaveLength(4);
    await deleteBatch(batch("alice", "f1", "t1", 1));
    expect(
      (await batchesOf("alice", "f1", "t1")).map((entry) => entry.counter)
    ).toEqual([2]);
  });

  it("counters only grow, per tab", async () => {
    expect(await nextCounter("s", "f", "t")).toBe(1);
    expect(await nextCounter("s", "f", "t")).toBe(2);
    expect(await nextCounter("s", "f", "other")).toBe(1);
  });

  it("a stand-in account id moves over once the real one is known", async () => {
    await putBatch(batch("email:c@x", "f", "t", 5));
    await moveAccount("email:c@x", "sub-c");
    expect(await batchesOf("email:c@x")).toEqual([]);
    expect(
      (await batchesOf("sub-c")).map((entry) => [entry.sub, entry.counter])
    ).toEqual([["sub-c", 5]]);
    // its counters continue above the moved batch
    expect(await nextCounter("sub-c", "f", "t")).toBe(6);
  });
});

describe("queue concurrency and durability", () => {
  it("allocates distinct increasing counters concurrently", async () => {
    const values = await Promise.all(
      Array.from({ length: 30 }, () => nextCounter("parallel", "f", "t"))
    );
    expect(values.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1)
    );
  });
  it("rejects an aborted write and leaves no partial batch", async () => {
    const original = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof original>
      ) {
        const request = original.apply(this, args);
        this.transaction.abort();
        return request;
      });
    try {
      await expect(
        putBatch(batch("aborted", "f", "t", 1))
      ).rejects.toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(await batchesOf("aborted")).toEqual([]);
  });
  it("expires command records exactly at seven days and isolates accounts and files", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await recordCommand("commands", "f", "request", {
        at: now,
        revision: "rev",
      });
      expect(await commandRecord("other", "f", "request")).toBeUndefined();
      expect(
        await commandRecord("commands", "other", "request")
      ).toBeUndefined();
      clock.mockReturnValue(now + 7 * 86400000 - 1);
      expect(await commandRecord("commands", "f", "request")).toEqual({
        at: now,
        revision: "rev",
      });
      clock.mockReturnValue(now + 7 * 86400000);
      expect(await commandRecord("commands", "f", "request")).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  it("allows one lock holder and takes over its orphan queue after release", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: unknown) => Promise<void>
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            await callback({ name });
          } finally {
            held.delete(name);
          }
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
    try {
      await putBatch(batch("locks", "f", "orphan", 1));
      const first = await holdTab("f", "orphan");
      expect(first).not.toBeNull();
      expect(await holdTab("f", "orphan")).toBeNull();
      expect(await orphanQueues("locks")).toEqual([]);
      first!.release();
      await Promise.resolve();
      expect(await orphanQueues("locks")).toEqual([
        { fileId: "f", tab: "orphan" },
      ]);
      const next = await claimTab("locks", "f");
      expect(next.tab).toBe("orphan");
      next.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
