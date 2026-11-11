import "fake-indexeddb/auto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asLocalOnly,
  freeName,
  mergeSpaceMeta,
  ownSpaceOf,
  ownSpaceTarget,
  pickSpace,
  spaceAccountOf,
  spaceMoves,
} from "../src/spaces";

import type { ScenesMeta } from "../src/storage";

// a minimal localStorage (the test runs in node)
const data = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => void data.set(key, String(value)),
  removeItem: (key: string) => void data.delete(key),
};

const UNTITLED = "\u0000untitled";
const MD5 = "0123456789abcdef0123456789abcdef";

const meta = (scenes: ScenesMeta["scenes"], current: string | null = null): ScenesMeta => ({
  current,
  baseline: 7,
  autoSync: true,
  scenes,
  pendingDeletes: {},
});

describe("spaces: which scenes a tab works with", () => {
  it("names an account's space by its email, lowercased", () => {
    expect(ownSpaceOf(" Fabian.Wesner@Example.COM ")).toBe("a:fabian.wesner@example.com");
    expect(spaceAccountOf("a:fabian@example.com")).toBe("fabian@example.com");
    expect(spaceAccountOf("")).toBeNull();
    expect(spaceAccountOf("f:abcdefghijklmnop")).toBeNull();
  });

  it("picks an open shared scene first, then the account's own scenes, else the signed-out ones", () => {
    expect(pickSpace("f:abcdefghijklmnop", "a:x@example.com")).toBe("f:abcdefghijklmnop");
    expect(pickSpace("d:abcdefghijklmnop", "a:x@example.com")).toBe("d:abcdefghijklmnop");
    expect(pickSpace(null, "a:x@example.com")).toBe("a:x@example.com");
    expect(pickSpace(null, null)).toBe("");
    // invalid values (old repository spaces, garbage) count as unset
    expect(pickSpace("owner/repo", "a:x@example.com")).toBe("a:x@example.com");
    expect(pickSpace(null, "a:no-at-sign")).toBe("");
    expect(pickSpace(null, "a:x@example.com/../y")).toBe("");
  });

  it("moves a signed-in tab to the account's space, and only then", () => {
    expect(ownSpaceTarget("", "b@example.com", null)).toBe("a:b@example.com");
    expect(ownSpaceTarget("a:a@example.com", "B@example.com", null)).toBe("a:b@example.com");
    expect(ownSpaceTarget("a:b@example.com", "b@example.com", null)).toBeNull();
    // signed out or the sign-in expired: the tab stays (sign-out on purpose is handled apart)
    expect(ownSpaceTarget("a:a@example.com", null, null)).toBeNull();
    expect(ownSpaceTarget("", null, null)).toBeNull();
    // a shared scene's space works with any account
    expect(ownSpaceTarget("f:abcdefghijklmnop", "b@example.com", null)).toBeNull();
    // and so does a shared folder's
    expect(ownSpaceTarget("d:abcdefghijklmnop", "b@example.com", null)).toBeNull();
  });

  it("sends the scenes of before spaces per account to their account, whoever signs in", () => {
    expect(ownSpaceTarget("", null, "a@example.com")).toBe("a:a@example.com");
    expect(spaceMoves("", "a:a@example.com", "a@example.com")).toEqual([{ from: "", to: "a:a@example.com", keepSync: true }]);
    expect(spaceMoves("", "a:b@example.com", "a@example.com")).toEqual([{ from: "", to: "a:a@example.com", keepSync: true }]);
  });

  it("gives scenes made signed out to the account signing in, never one account's scenes to another", () => {
    expect(spaceMoves("", "a:b@example.com", null)).toEqual([{ from: "", to: "a:b@example.com", keepSync: false }]);
    expect(spaceMoves("a:a@example.com", "a:b@example.com", null)).toEqual([]);
    expect(spaceMoves("a:a@example.com", "", null)).toEqual([]);
  });

  it("finds free names", () => {
    const taken = new Set(["Plan", "Plan (2)"]);
    expect(freeName("Plan", (name) => taken.has(name))).toBe("Plan (3)");
    expect(freeName("Other", (name) => taken.has(name))).toBe("Other");
    const long = "x".repeat(100);
    expect(freeName(long, (name) => name === long)).toBe(`${"x".repeat(96)} (2)`);
  });

  it("drops another Drive's sync state", () => {
    const local = asLocalOnly({
      baseMd5: MD5,
      remoteMd5: MD5,
      dirty: true,
      conflict: { remoteMd5: MD5, clashes: [] },
      keptLocal: true,
      live: { fileId: "f1" },
      moveOnSignIn: true,
    });
    expect(local).toEqual({ baseMd5: null, dirty: true, localOnly: true, moveOnSignIn: true });
  });
});

describe("mergeSpaceMeta", () => {
  it("into a new space with sync state: everything as it was", () => {
    const source = meta({ plan: { baseMd5: MD5, remoteMd5: MD5, dirty: false } }, "plan");
    source.pendingDeletes = { gone: MD5 };
    const { meta: merged, renames } = mergeSpaceMeta(null, source, true);
    expect(merged.scenes).toEqual(source.scenes);
    expect(merged.pendingDeletes).toEqual({ gone: MD5 });
    expect(merged.current).toBe("plan");
    expect([...renames]).toEqual([["plan", "plan"]]);
  });

  it("into an account's scenes: local only, renamed where the name is taken, the open one stays open", () => {
    const target = meta({ plan: { baseMd5: MD5, dirty: false }, [UNTITLED]: { baseMd5: null, dirty: true } }, "plan");
    const source = meta(
      {
        plan: { baseMd5: null, dirty: true, localOnly: true, moveOnSignIn: true },
        sketch: { baseMd5: MD5, dirty: false },
        [UNTITLED]: { baseMd5: null, dirty: true },
      },
      "sketch",
    );
    const { meta: merged, renames } = mergeSpaceMeta(target, source, false);
    expect(merged.scenes.plan).toEqual({ baseMd5: MD5, dirty: false });
    expect(merged.scenes["plan (2)"]).toEqual({ baseMd5: null, dirty: true, localOnly: true, moveOnSignIn: true });
    expect(merged.scenes.sketch).toEqual({ baseMd5: null, dirty: false, localOnly: true });
    expect(merged.scenes.Untitled).toEqual({ baseMd5: null, dirty: true, localOnly: true });
    expect(merged.scenes[UNTITLED]).toEqual({ baseMd5: null, dirty: true });
    expect(Object.fromEntries(renames)).toEqual({ plan: "plan (2)", sketch: "sketch", [UNTITLED]: "Untitled" });
    expect(merged.current).toBe("sketch");
    expect(merged.baseline).toBeNull();
  });

  it("keeps the target's open scene when nothing open moves", () => {
    const target = meta({ plan: { baseMd5: MD5, dirty: false } }, "plan");
    const { meta: merged } = mergeSpaceMeta(target, meta({ other: { baseMd5: null, dirty: true } }), false);
    expect(merged.current).toBe("plan");
    expect(merged.baseline).toBe(7);
  });

  it("a renamed scene loses its sync state even when keeping sync (in Drive it has the old name)", () => {
    const target = meta({ plan: { baseMd5: MD5, dirty: false } });
    const { meta: merged } = mergeSpaceMeta(target, meta({ plan: { baseMd5: MD5, remoteMd5: MD5, dirty: false } }), true);
    expect(merged.scenes["plan (2)"]).toEqual({ baseMd5: null, dirty: false, localOnly: true });
  });
});

describe("moveSpaceData", () => {
  let storage: typeof import("../src/storage");
  let idb: typeof import("idb-keyval");
  const snapshots = (space: string) => idb.createStore(`excalidraw-scenes-db${space ? `@${space}` : ""}`, "snapshots");
  const agent = (space: string) => idb.createStore(`excalidraw-scenes-agent${space ? `@${space}` : ""}`, "data");
  const metaKey = (space: string) => `excalidraw-scenes${space ? `@${space}` : ""}`;

  beforeAll(async () => {
    storage = await import("../src/storage");
    idb = await import("idb-keyval");
  });

  beforeEach(async () => {
    data.clear();
    for (const space of ["", "a:a@example.com", "a:b@example.com"]) {
      await idb.clear(snapshots(space));
      await idb.clear(agent(space));
    }
  });

  it("moves metadata, snapshots and agent data, then clears the source", async () => {
    data.set(metaKey(""), JSON.stringify(meta({ plan: { baseMd5: MD5, dirty: false } }, "plan")));
    await idb.set("plan", { json: "{plan}", baseline: 1, dirty: false }, snapshots(""));
    await idb.set("baseline:plan", { at: "x" }, agent(""));
    await idb.set("checkpoint:c1", { at: 1, data: 1 }, agent(""));
    await idb.set("checkpoint-index", { "checkpoint:c1": 1 }, agent(""));

    await storage.moveSpaceData("", "a:a@example.com", true);

    expect(data.has(metaKey(""))).toBe(false);
    expect(JSON.parse(data.get(metaKey("a:a@example.com"))!).scenes.plan).toEqual({ baseMd5: MD5, dirty: false });
    expect(await idb.get("plan", snapshots("a:a@example.com"))).toEqual({ json: "{plan}", baseline: 1, dirty: false });
    expect(await idb.get("baseline:plan", agent("a:a@example.com"))).toEqual({ at: "x" });
    expect(await idb.get("checkpoint-index", agent("a:a@example.com"))).toEqual({ "checkpoint:c1": 1 });
    expect(await idb.keys(snapshots(""))).toEqual([]);
    expect(await idb.keys(agent(""))).toEqual([]);
  });

  it("into an account's scenes: renames on collision, merges the checkpoint index, skips stale metadata", async () => {
    data.set(metaKey("a:b@example.com"), JSON.stringify(meta({ plan: { baseMd5: MD5, dirty: false } }, "plan")));
    await idb.set("plan", { json: "{b plan}", baseline: 1, dirty: false }, snapshots("a:b@example.com"));
    await idb.set("checkpoint-index", { "checkpoint:b": 2 }, agent("a:b@example.com"));
    data.set(
      metaKey(""),
      JSON.stringify(meta({ plan: { baseMd5: null, dirty: true }, stale: { baseMd5: null, dirty: false } }, "plan")),
    );
    await idb.set("plan", { json: "{guest plan}", baseline: null, dirty: true }, snapshots(""));
    await idb.set("baseline:plan", { at: "guest" }, agent(""));
    await idb.set("checkpoint-index", { "checkpoint:g": 1 }, agent(""));

    await storage.moveSpaceData("", "a:b@example.com", false);

    const merged = JSON.parse(data.get(metaKey("a:b@example.com"))!);
    expect(Object.keys(merged.scenes).sort((a, b) => a.localeCompare(b))).toEqual(["plan", "plan (2)"]);
    expect(merged.current).toBe("plan (2)");
    expect(await idb.get("plan", snapshots("a:b@example.com"))).toEqual({ json: "{b plan}", baseline: 1, dirty: false });
    expect(await idb.get("plan (2)", snapshots("a:b@example.com"))).toEqual({ json: "{guest plan}", baseline: null, dirty: true });
    expect(await idb.get("baseline:plan (2)", agent("a:b@example.com"))).toEqual({ at: "guest" });
    expect(await idb.get("checkpoint-index", agent("a:b@example.com"))).toEqual({ "checkpoint:b": 2, "checkpoint:g": 1 });
  });

  it("does nothing when the source space has no scenes", async () => {
    await storage.moveSpaceData("a:a@example.com", "a:b@example.com", false);
    expect(data.size).toBe(0);
  });
});
