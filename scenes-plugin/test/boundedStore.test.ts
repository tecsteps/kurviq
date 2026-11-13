// The store that keeps its newest entries (src/boundedStore.ts): agents' checkpoints and uploads (U30).
import "fake-indexeddb/auto";

import { createStore, get, keys, set } from "idb-keyval";
import { describe, expect, it } from "vitest";

import { boundedStore } from "../src/boundedStore";

const sorted = (list: IDBValidKey[]) => list.map(String).sort((a, b) => a.localeCompare(b));

describe("a bounded store", () => {
  it("keeps the newest `max` entries and an index of their times", async () => {
    const store = createStore("bounded-test-1", "data");
    const bounded = boundedStore(store, { indexKey: "index", max: 3, isEntry: () => true });
    await Promise.all([1, 2, 3, 4, 5].map((n) => bounded.put(`k${n}`, { n }, n)));
    expect(sorted(await keys(store))).toEqual(["index", "k3", "k4", "k5"]);
    expect(await get("index", store)).toEqual({ k3: 3, k4: 4, k5: 5 });
  });

  it("counts entries stored before the index existed as the oldest (only its own kind of keys)", async () => {
    const store = createStore("bounded-test-2", "data");
    await set("entry:old", 1, store);
    await set("other", 2, store);
    const bounded = boundedStore(store, { indexKey: "index", max: 1, isEntry: (key) => key.startsWith("entry:") });
    await bounded.put("entry:new", 3, 10);
    expect(sorted(await keys(store))).toEqual(["entry:new", "index", "other"]);
  });

  it("drops more keys when asked (a live scene's revisions)", async () => {
    const store = createStore("bounded-test-3", "data");
    const bounded = boundedStore(store, {
      indexKey: "index",
      max: 10,
      isEntry: () => true,
      alsoDrop: (key, byAge) => (key.startsWith("rev:") ? byAge.filter((k) => k.startsWith("rev:")).slice(0, -2) : []),
    });
    for (const [n, key] of ["rev:1", "x", "rev:2", "rev:3"].entries()) {
      await bounded.put(key, n, n); // NOSONAR S9382: one after the other on purpose (their times order them)
    }
    expect(sorted(await keys(store))).toEqual(["index", "rev:2", "rev:3", "x"]);
  });
});
