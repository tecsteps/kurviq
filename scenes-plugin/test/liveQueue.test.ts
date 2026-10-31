import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { batchKey, batchesOf, deleteBatch, moveAccount, nextCounter, putBatch } from "../src/online/liveQueue";

import type { QueuedBatch } from "../src/online/liveQueue";

const batch = (sub: string, fileId: string, tab: string, counter: number): QueuedBatch => ({
  sub,
  fileId,
  tab,
  counter,
  made: Date.now(),
  live: true,
  via: "user",
  changes: [{ k: "el", id: `e${counter}`, value: { id: `e${counter}` }, base: null, keys: null }],
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
    expect((await batchesOf("alice")).length).toBe(4);
    expect((await batchesOf("bob")).map((entry) => entry.tab)).toEqual(["t9"]);
    expect((await batchesOf("alice", "f1")).length).toBe(3);
    expect((await batchesOf("alice", "f1", "t1")).map((entry) => entry.counter)).toEqual([1, 2]);
    // a prefix of an id is not the id
    await putBatch(batch("ali", "f1", "t1", 1));
    expect((await batchesOf("alice")).length).toBe(4);
    await deleteBatch(batch("alice", "f1", "t1", 1));
    expect((await batchesOf("alice", "f1", "t1")).map((entry) => entry.counter)).toEqual([2]);
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
    expect((await batchesOf("sub-c")).map((entry) => [entry.sub, entry.counter])).toEqual([["sub-c", 5]]);
    // its counters continue above the moved batch
    expect(await nextCounter("sub-c", "f", "t")).toBe(6);
  });
});
