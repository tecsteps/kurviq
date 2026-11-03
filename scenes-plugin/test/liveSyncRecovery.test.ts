import { presentationOf } from "../../scenes-mcp/presentation.mjs";
// Pin the recovery paths before splitting them. The engine's private entry
// points are called directly so these tests need no browser or live server.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorYield } from "../src/editorYield";
import * as liveMerge from "../src/online/liveMerge";
import * as liveProtocol from "../src/online/liveProtocol";

const mocks = vi.hoisted(() => ({
  addFont: vi.fn(),
  fonts: new Map<number, any>(),
  getUpload: vi.fn(),
  batchesOf: vi.fn(),
  deleteBatch: vi.fn(),
  encodeEvent: vi.fn(),
  fontHash: vi.fn(),
}));
// The upstream package has no built Node entry. Load the production module
// through TypeScript with only its browser/storage imports replaced.
const source = readFileSync(new URL("../src/online/liveSync.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replaceAll("import.meta.env", "({})"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const imports: Record<string, unknown> = {
  "../presentation": { presentationOf, serializeAsJSON: (...args: any[]) => JSON.stringify({ elements: args[0], appState: args[1], files: args[2] }) },
  "../agentGlow": { showAgentChange: vi.fn() },
  "@excalidraw/excalidraw": { CaptureUpdateAction: { NEVER: "never" }, restoreElements: vi.fn(), serializeAsJSON: vi.fn() },
  "@excalidraw/element": { hashString: vi.fn() },
  "idb-keyval": { createStore: vi.fn(), get: vi.fn(), set: vi.fn() },
  "../fonts": { addFont: mocks.addFont, customFonts: mocks.fonts, isCustomFontId: (id: number) => id >= 2000, withFonts: vi.fn() },
  "../uploads": { getUpload: mocks.getUpload },
  "./drive": { authPost: vi.fn(), connection: { getState: () => ({}) }, driveScenes: {}, liveSocketUrl: vi.fn(), signOutListeners: new Set() },
  "./frames": { createReceiver: vi.fn(), sendMessage: vi.fn() },
  "./liveCrypto": { decodeEvent: vi.fn(), encodeEvent: mocks.encodeEvent, importSceneKey: vi.fn() },
  "./liveMerge": liveMerge,
  "../editorYield": { editorYield },
  "./liveProtocol": { ...liveProtocol, fontHash: mocks.fontHash },
  "./liveQueue": {
    batchesOf: mocks.batchesOf, deleteBatch: mocks.deleteBatch, claimTab: vi.fn(), newTabId: vi.fn(), commandRecord: vi.fn(),
    forgetFile: vi.fn(), holdTab: vi.fn(), moveAccount: vi.fn(), nextCounter: vi.fn(), orphanQueues: vi.fn(), putBatch: vi.fn(), recordCommand: vi.fn(),
  },
};
const loaded = { exports: {} as Record<string, any> };
new Function("require", "module", "exports", compiled)((name: string) => { // NOSONAR S1523: compiles only repository-owned source with test-owned dependency mocks
  if (!(name in imports)) throw new Error(`Unexpected engine dependency: ${name}`);
  return imports[name];
}, loaded, loaded.exports);
const { LiveScene, liveSync } = loaded.exports;

const el = (id: string, props: Record<string, any> = {}) => ({ id, type: "rectangle", version: 1, versionNonce: 1, x: 0, y: 0, index: "a0", ...props });
const change = (value: any, props: Record<string, any> = {}) => ({ k: "el", id: value.id, value, base: { v: 1, n: 1 }, keys: ["x"], ...props });
const batch = (changes: any[] = [], props: Record<string, any> = {}) => ({ counter: 1, tab: "tab", state: "queued", live: true, changes, ...props });
const stamp = (value: any) => ({ v: value.version, n: value.versionNonce });
const settings = { viewBackgroundColor: "#fff", gridSize: 20, gridStep: 5, gridModeEnabled: false };
const event = (k: string, id: string, value: any, props: Record<string, any> = {}) => ({ k, id, value, ...props });

const fixture = (initial: any[] = [], options: Record<string, any> = {}) => {
  const elements = new Map(initial.map((value) => [value.id, value]));
  const files: Record<string, any> = {};
  let app = { ...settings };
  const gesture = new Set<string>();
  const calls: string[] = [];
  const host = { renamed: vi.fn() };
  const apply = vi.fn((next: any) => {
    calls.push("apply");
    for (const value of next.elements ?? []) elements.set(value.id, value);
    for (const file of next.files ?? []) files[file.id] = file;
    if (next.settings) app = next.settings;
  });
  const agentChange = vi.fn();
  const scene: any = new LiveScene({
    fileId: "file", name: "Scene", sub: "account", headless: false, host: () => host,
    tab: { tab: "tab", release: vi.fn() },
    surface: { elements: () => [...elements.values()], files: () => files, settings: () => app, gesture: () => gesture, apply, edit: apply, destroy: vi.fn(), agentChange },
    ...options,
  });
  Object.assign(scene, { phase: "ready", role: "edit", enabled: true, baseLoaded: true, key: {} });
  scene.changed = vi.fn(() => calls.push("changed"));
  scene.pump = vi.fn(() => calls.push("pump"));
  scene.persist = vi.fn(async () => { calls.push("persist"); });
  scene.persistBaseSoon = vi.fn();
  scene.flush = vi.fn(async () => { calls.push("flush"); });
  scene.makeOfflineCopy = vi.fn(async () => { calls.push("copy"); return true; });
  scene.draftAssets = vi.fn();
  scene.decode = vi.fn(async (wire: any) => { calls.push(`decode:${wire.id}`); return wire.value; });
  scene.sendBatch = vi.fn(async () => { calls.push("send"); });
  return { scene, elements, files, gesture, apply, agentChange, calls, host, app: () => app };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  vi.clearAllMocks();
  mocks.fonts.clear();
  mocks.addFont.mockResolvedValue(undefined);
  mocks.getUpload.mockResolvedValue(null);
  mocks.batchesOf.mockResolvedValue([]);
  mocks.deleteBatch.mockResolvedValue(undefined);
  mocks.fontHash.mockImplementation(async (font) => `hash-${font.id}`);
  mocks.encodeEvent.mockImplementation(async (_key, k, id, value, base) => ({ k, id, value, base }));
  vi.spyOn(liveSync, "signedOutHandled").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reconcile: recovery before replacing local work", () => {
  it("keeps queued and peer edits, accepts remote changes, and queues only new local edits", async () => {
    const before = el("changed");
    const mine = el("changed", { version: 3, x: 10 });
    const remote = el("remote", { version: 4, x: 20 });
    const f = fixture([mine, el("remote"), el("queued", { x: 5 }), el("peer", { x: 8 }), el("gone"), el("new", { x: 6 }), el("same")]);
    f.scene.localBase = new Map([["changed", before], ["remote", el("remote")], ["gone", el("gone")]]);
    f.scene.confirmed = new Map([["changed", before], ["remote", remote], ["queued", el("queued")], ["peer", el("peer")], ["added", el("added")], ["same", el("same")], ["dead", el("dead", { isDeleted: true })]]);
    f.scene.batches = [batch([change(el("queued", { x: 5 }))])];
    f.scene.othersPending.set("other", new Set(["peer"]));
    await f.scene.reconcile([]);
    expect(f.elements.get("remote")).toEqual(remote);
    expect(f.elements.get("queued")?.x).toBe(5);
    expect(f.elements.get("peer")?.x).toBe(8);
    expect(f.elements.get("gone")?.isDeleted).toBe(true);
    expect(f.elements.has("added")).toBe(true);
    expect(f.elements.has("dead")).toBe(false);
    expect([...f.scene.draft.keys()]).toEqual(["changed", "new"]);
    expect(f.scene.draft.get("changed").live).toBe(false);
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
    expect(f.scene.flush).toHaveBeenCalledOnce();
    expect(f.scene.localBase).toBeNull();
  });

  it.each([true, false])("protects clashes and stale batches when copy success is %s", async (copied) => {
    const mine = el("a", { version: 3, x: 2 });
    const theirs = el("a", { version: 2, x: 1 });
    const f = fixture([mine]);
    f.scene.localBase = new Map([["a", el("a")]]);
    f.scene.confirmed.set("a", theirs);
    const old = batch([], { counter: 9 });
    f.scene.batches = [old];
    f.scene.makeOfflineCopy.mockImplementation(async () => { f.calls.push("copy"); return copied; });
    await f.scene.reconcile([old]);
    expect(f.scene.makeOfflineCopy).toHaveBeenCalledWith("Changes kept in this browser were too old to send");
    expect(f.elements.get("a")).toEqual(copied ? theirs : mine);
    expect(f.scene.skipped).toEqual(copied ? [9] : []);
    expect(f.scene.parked.has(9)).toBe(!copied);
    expect(f.scene.protectedIds.has("a")).toBe(!copied);
    expect(mocks.deleteBatch).toHaveBeenCalledTimes(copied ? 1 : 0);
    if (copied) expect(f.calls.indexOf("copy")).toBeLessThan(f.calls.indexOf("apply"));
    else expect(f.apply).not.toHaveBeenCalled();
  });

  it.each([true, false])("separates signed-out edits only after copy success %s", async (copied) => {
    const f = fixture([el("a", { version: 3, x: 2 })], { signedOutEdits: true });
    f.scene.localBase = new Map([["a", el("a")]]);
    f.scene.confirmed.set("a", el("a"));
    f.scene.makeOfflineCopy.mockResolvedValue(copied);
    await f.scene.reconcile([]);
    expect(f.scene.makeOfflineCopy).toHaveBeenCalledWith("Changes made while you were signed out");
    expect(f.elements.get("a")?.x).toBe(copied ? 0 : 2);
    expect(f.scene.protectedIds.has("a")).toBe(!copied);
    expect(f.scene.signedOutEdits).toBe(!copied);
    expect(liveSync.signedOutHandled).toHaveBeenCalledTimes(copied ? 1 : 0);
    expect(f.scene.draft.size).toBe(0);
  });

  it("returns after a stale connection or a rejected recovery write without deleting queued work", async () => {
    const f = fixture([el("a")]);
    const old = batch([]);
    f.scene.batches = [old];
    f.scene.makeOfflineCopy.mockImplementation(async () => { f.scene.detached = true; return true; });
    await f.scene.reconcile([old]);
    expect(f.scene.batches).toEqual([old]);
    expect(f.apply).not.toHaveBeenCalled();
    f.scene.detached = false;
    f.scene.makeOfflineCopy.mockRejectedValue(new Error("disk"));
    await expect(f.scene.reconcile([old])).rejects.toThrow("disk");
    expect(mocks.deleteBatch).not.toHaveBeenCalled();
  });

  it.each([{ role: "read" }, { viewOnly: true }])("discards unqueued changes for viewers: %j", async (mode) => {
    const f = fixture([el("a", { version: 4, x: 8 })], mode);
    Object.assign(f.scene, mode);
    f.scene.localBase = new Map([["a", el("a")]]);
    f.scene.confirmed.set("a", el("a", { version: 2, x: 3 }));
    await f.scene.reconcile([]);
    expect(f.elements.get("a")?.x).toBe(3);
    expect(f.scene.draft.size).toBe(0);
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
  });

  it.each(["same stamp", "older", "remembered stamp", "no base", "same content"])("recognizes an unchanged local copy: %s", async (kind) => {
    const mine = el("a", { version: 5, x: 8 });
    const theirs = el("a", { version: 2, x: 3 });
    const f = fixture([mine]);
    f.scene.localBase = new Map([["a", el("a", { x: -1 })]]);
    if (kind === "same stamp") { mine.version = 2; }
    if (kind === "older") { mine.version = 1; }
    if (kind === "remembered stamp") f.scene.rememberStamp(mine);
    if (kind === "no base") f.scene.localBase = null;
    if (kind === "same content") f.scene.localBase.set("a", { ...mine });
    f.scene.confirmed.set("a", theirs);
    await f.scene.reconcile([]);
    expect(f.elements.get("a")).toEqual(theirs);
    expect(f.scene.draft.size).toBe(0);
  });

  it("overlays only queued headless changes including assets before making a recovery copy", async () => {
    const f = fixture([], { headless: true });
    const font = { id: 2000, faces: [] };
    f.scene.confirmed.set("a", el("a"));
    f.scene.confirmedSettings = { value: settings, stamp: null };
    f.scene.batches = [batch([
      change(el("a", { x: 4 })), change({ id: "f", dataURL: "data:f" }, { k: "file" }),
      change({ ...settings, gridSize: 40 }, { k: "set", id: "settings" }), change(font, { k: "font", id: "h", fontId: 2001 }),
    ]), batch([change(el("ignored"))], { counter: 2, state: "acked" })];
    mocks.addFont.mockRejectedValue(new Error("font unavailable"));
    await f.scene.reconcile([]);
    expect(f.elements.get("a")?.x).toBe(4);
    expect(f.elements.has("ignored")).toBe(false);
    expect(f.files.f.dataURL).toBe("data:f");
    expect(f.app().gridSize).toBe(40);
    expect(mocks.addFont).toHaveBeenCalledWith({ ...font, id: 2001 });
    expect(f.scene.known.get("a")).toEqual(stamp(el("a")));
  });

  it.each([false, true])("applies confirmed settings unless settings are pending: %s", async (pending) => {
    const f = fixture();
    f.scene.confirmedSettings = { value: { ...settings, gridSize: 50 }, stamp: { v: 3, n: 4 } };
    if (pending) f.scene.draft.set("set:settings", { k: "set", id: "settings", value: settings });
    await f.scene.reconcile([]);
    expect(f.app().gridSize).toBe(pending ? 20 : 50);
    expect(f.scene.synced.get("set:settings").stamp).toEqual({ v: 3, n: 4 });
  });
});

describe("presentation metadata in live settings", () => {
  it.each([true, false])("applies explicit %s from the room without consulting frames", async (flag) => {
    const f = fixture([el("a")]);
    const value = { ...settings, kurviqPresentation: flag, kurviqPresentationAt: 123 };
    await f.scene.takeStamped({ tab: "other", seq: 2, events: [event("set", "settings", value)] }, { toCanvas: true });
    expect(f.app()).toMatchObject({ kurviqPresentation: flag, kurviqPresentationAt: 123 });
  });
});

describe("takeStamped: streamed acknowledgements and protected canvas state", () => {
  it("recovers a lost ack with stamps, index repairs and font assignments without decoding", async () => {
    const f = fixture();
    const own = batch([change(el("a")), change({ id: 2000 }, { k: "font", id: "hash" })]);
    f.scene.batches = [own];
    f.scene.onAck = vi.fn(async () => { f.scene.confirmed.set("a", el("a", { fontFamily: 2000 })); });
    const events = [event("el", "a", null, { r: { version: 5, versionNonce: 6, index: "b0", fontFamily: 2001 } }), event("font", "hash", null, { fontId: 2001 }), event("set", "settings", null, { v: { v: 2, n: 3 } })];
    await f.scene.takeStamped({ tab: "tab", counter: 1, seq: 9, events }, { toCanvas: true });
    expect(f.scene.onAck).toHaveBeenCalledWith({ type: "ack", counter: 1, seq: 9, stamps: { a: { v: 5, n: 6 }, "font:hash": { v: 0, n: 0 }, "set:settings": { v: 2, n: 3 } }, repairs: { a: "b0" }, fontIds: { hash: 2001 } });
    expect(f.scene.confirmed.get("a").fontFamily).toBe(2001);
    expect(f.scene.decode).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("omits empty repair maps, and propagates a failed acknowledgement", async () => {
    const f = fixture();
    f.scene.batches = [batch([change(el("a"))])];
    f.scene.onAck = vi.fn().mockRejectedValue(new Error("ack write"));
    await expect(f.scene.takeStamped({ tab: "tab", counter: 1, seq: 2, events: [] }, { toCanvas: false })).rejects.toThrow("ack write");
    expect(f.scene.onAck).toHaveBeenCalledWith({ type: "ack", counter: 1, seq: 2, stamps: {} });
    expect(f.scene.decode).not.toHaveBeenCalled();
  });

  it("applies foreign assets in order, keeps pending/gesture elements, and reports agent changes", async () => {
    const f = fixture([el("pending"), el("gesture"), el("free")]);
    f.scene.draft.set("pending", { k: "el", id: "pending" });
    f.gesture.add("gesture");
    f.files.existing = { id: "existing" };
    const previous = el("free");
    f.scene.lastCanvas.set("free", previous);
    const events = [event("el", "pending", el("pending", { x: 1 })), event("el", "gesture", el("gesture", { x: 2 })), event("el", "free", el("free", { x: 3 })), event("el", "missing", null), event("set", "settings", { gridSize: 40 }), event("file", "existing", {}), event("file", "new", { id: "new", dataURL: "data:new" }), event("font", "font", { id: 2000, faces: [] }), event("name", "name", { name: "Renamed" })];
    await f.scene.takeStamped({ tab: "other", seq: 7, via: "agent", origin: "outside", events }, { toCanvas: true });
    expect(f.elements.get("pending")?.x).toBe(0);
    expect(f.elements.get("gesture")?.x).toBe(0);
    expect(f.elements.get("free")?.x).toBe(3);
    expect(f.scene.confirmed.get("pending").x).toBe(1);
    expect(f.scene.decode).toHaveBeenCalledWith(events[2], previous);
    expect(f.scene.decode).not.toHaveBeenCalledWith(events[5]);
    expect(f.calls.slice(0, 8)).toEqual(["decode:pending", "decode:gesture", "decode:free", "decode:missing", "decode:settings", "decode:new", "decode:font", "decode:name"]);
    expect(f.apply.mock.calls[0][0]).toEqual({ files: [{ id: "new", dataURL: "data:new" }] });
    expect(f.app()).toEqual({ viewBackgroundColor: "#ffffff", gridSize: 40, gridStep: 5, gridModeEnabled: false, kurviqPresentation: false, kurviqPresentationAt: 0 });
    expect(f.agentChange).toHaveBeenCalledWith(expect.any(Map), [el("free", { x: 3 })]);
    expect(f.host.renamed).toHaveBeenCalledWith("file", "Renamed");
  });

  it.each([false, true])("updates confirmed state but keeps pending settings (toCanvas=%s)", async (toCanvas) => {
    const f = fixture([el("a")]);
    f.scene.draft.set("set:settings", { k: "set", id: "settings" });
    await f.scene.takeStamped({ tab: "other", seq: 2, events: [event("el", "a", el("a", { x: 4 })), event("set", "settings", { gridSize: 40 })] }, { toCanvas });
    expect(f.scene.confirmed.get("a").x).toBe(4);
    expect(f.elements.get("a")?.x).toBe(toCanvas ? 4 : 0);
    expect(f.app().gridSize).toBe(20);
    expect(f.scene.confirmedSettings.value.gridSize).toBe(40);
    expect(f.agentChange).not.toHaveBeenCalled();
  });

  it("does not apply decoded results after detachment, and rejects decoding errors", async () => {
    const f = fixture([el("a")]);
    f.scene.decode.mockImplementation(async (wire: any) => { f.scene.detached = true; return wire.value; });
    const streamed = { tab: "other", seq: 2, events: [event("el", "a", el("a", { x: 4 })), event("file", "f", { id: "f" })] };
    await f.scene.takeStamped(streamed, { toCanvas: true });
    expect(f.scene.confirmed.get("a").x).toBe(4);
    expect(f.apply).not.toHaveBeenCalled();
    f.scene.detached = false;
    f.scene.decode.mockRejectedValue(new Error("bad ciphertext"));
    await expect(f.scene.takeStamped(streamed, { toCanvas: true })).rejects.toThrow("bad ciphertext");
    expect(f.apply).not.toHaveBeenCalled();
  });
});

describe("onRefused: retries, peer queues and safe recovery", () => {
  const refusal = (reason: string, detail?: string, current: any[] = []) => ({ type: "refused", counter: 1, reason, detail, current });
  const queued = (props: Record<string, any> = {}) => {
    const f = fixture([el("a")]);
    f.scene.batches = [batch([change(el("a"))], props)];
    f.scene.inFlight.set(1, { at: 1, ids: new Set(["a"]) });
    return f;
  };

  it("forgets only the in-flight marker for a batch no longer queued", async () => {
    const f = fixture();
    f.scene.inFlight.set(1, {});
    await f.scene.onRefused(refusal("collision"));
    expect(f.scene.inFlight.size).toBe(0);
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
  });
  it("keeps a token refusal in flight until renewal finishes and propagates renewal failure", async () => {
    const f = queued();
    let finish!: () => void;
    f.scene.renew = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const work = f.scene.onRefused(refusal("token"));
    expect(f.scene.inFlight.has(1)).toBe(true);
    expect(f.scene.pump).not.toHaveBeenCalled();
    finish();
    await work;
    expect(f.scene.inFlight.has(1)).toBe(false);
    expect(f.scene.pump).toHaveBeenCalledOnce();
    f.scene.renew.mockRejectedValue(new Error("renew"));
    await expect(f.scene.onRefused(refusal("token"))).rejects.toThrow("renew");
    expect(f.scene.inFlight.has(1)).toBe(true);
  });
  it.each([["unseeded", undefined], ["old", "not seeded"]])("reconnects for %s/%s", async (reason, detail) => {
    const f = queued();
    f.scene.dropConnection = vi.fn();
    await f.scene.onRefused(refusal(reason!, detail));
    expect(f.scene.inFlight.has(1)).toBe(false);
    expect(f.scene.dropConnection).toHaveBeenCalledOnce();
  });
  it.each([["font-id", "font-full"], ["key", "Waiting for the scene's key"], ["role", "You can only view this scene now: your changes stay in this browser"], ["lifecycle", "This scene can't be changed now"], ["limit", "Too big to save at once: split it up, or remove large pictures"]])("parks %s without losing the queue", async (reason, error) => {
    const f = queued();
    await f.scene.onRefused(refusal(reason));
    expect(f.scene.error).toBe(error);
    expect(f.scene.parked.has(1)).toBe(true);
    expect(f.scene.inFlight.has(1)).toBe(false);
    expect(f.scene.batches).toHaveLength(1);
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
    if (reason === "role") expect(f.scene.role).toBe("read");
  });
  it.each(["sceneBytes", "elements", "eventsPerBatch", "role"])("copies permanently refused headless queues: %s", async (kind) => {
    const f = fixture([], { headless: true });
    f.scene.batches = [batch([change(el("a"))]), batch([change(el("b"))], { counter: 2 }), batch([], { counter: 3, state: "acked" })];
    await f.scene.onRefused(refusal(kind === "role" ? "role" : "limit", kind === "role" ? undefined : kind));
    expect(f.scene.batches.map((b: any) => b.counter)).toEqual([3]);
    expect([...f.scene.givenUp.keys()]).toEqual([1, 2]);
    expect(f.scene.skipped).toEqual([1, 2]);
    expect(f.scene.error).toBeNull();
    expect(mocks.deleteBatch.mock.calls.map(([b]) => b.counter)).toEqual([1, 2]);
  });
  it.each(["failed", "stale"])("does not delete headless work after %s copy", async (mode) => {
    const f = fixture([], { headless: true });
    f.scene.batches = [batch([change(el("a"))])];
    f.scene.makeOfflineCopy.mockImplementation(async () => { f.scene.detached = mode === "stale"; return mode !== "failed"; });
    await f.scene.onRefused(refusal("role"));
    expect(f.scene.batches).toHaveLength(1);
    expect(mocks.deleteBatch).not.toHaveBeenCalled();
    expect(f.scene.parked.has(1)).toBe(true);
  });
  it.each(["batchesPerMinute", "pendingBatches", "pendingBytes", "accountPendingBytes"])("releases transient limit %s after 15 seconds", async (detail) => {
    const f = queued();
    await f.scene.onRefused(refusal("limit", detail));
    expect(f.scene.parked.has(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.scene.parked.has(1)).toBe(false);
    expect(f.scene.pump).toHaveBeenCalledOnce();
  });
  it.each(["collision", "reference"])("waits for another tab's queue before rebasing: %s", async (reason) => {
    const f = queued();
    f.scene.rebaseLive = vi.fn();
    f.scene.rebases.set(1, 2);
    mocks.batchesOf.mockResolvedValue([batch([change(el("a"))], { tab: "other" }), batch([change(el("ignored"))], { tab: "other", state: "acked" })]);
    await f.scene.onRefused(refusal(reason, reason === "reference" ? "a:containerId:target" : undefined, [event("el", "a", el("a", { x: 2 }))]));
    expect(f.scene.parked.has(1)).toBe(true);
    expect(f.scene.rebaseLive).not.toHaveBeenCalled();
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.scene.parked.has(1)).toBe(false);
    expect(f.scene.rebases.has(1)).toBe(false);
    expect(f.scene.pump).toHaveBeenCalledOnce();
  });
  it("falls back after a queue read failure and rebases live collisions up to three times", async () => {
    const f = queued();
    mocks.batchesOf.mockRejectedValue(new Error("idb"));
    f.scene.rebaseLive = vi.fn().mockResolvedValue(undefined);
    const current = [event("el", "a", el("a", { x: 3 })), event("set", "settings", { gridSize: 60 }), event("name", "name", { name: "New" })];
    await f.scene.onRefused(refusal("collision", undefined, current));
    expect(f.scene.rebaseLive).toHaveBeenCalledWith(f.scene.batches[0], new Map([["a", el("a", { x: 3 })]]), "collision", undefined);
    expect(f.scene.confirmedSettings.value.gridSize).toBe(60);
    expect(f.scene.synced.get("name:name").el.name).toBe("New");
    f.scene.rebases.set(1, 3);
    f.scene.dropColliding = vi.fn();
    await f.scene.onRefused(refusal("collision", undefined, current));
    expect(f.scene.rebaseLive).toHaveBeenCalledTimes(1);
    expect(f.scene.makeOfflineCopy).toHaveBeenCalledOnce();
    expect(f.scene.dropColliding).toHaveBeenCalledWith(f.scene.batches[0], new Set(["a", "set:settings", "name:name"]), false);
  });
  it.each(["discarded", "old", "invalid", "collision", "reference"])("preserves all work when offline recovery for %s fails", async (reason) => {
    const f = queued({ live: false });
    f.scene.makeOfflineCopy.mockResolvedValue(false);
    f.scene.dropColliding = vi.fn();
    await f.scene.onRefused(refusal(reason, "unknown: a,b"));
    expect(f.scene.parked.has(1)).toBe(true);
    expect(f.scene.protectedIds.has("a")).toBe(true);
    expect(f.scene.dropColliding).not.toHaveBeenCalled();
    expect(f.scene.batches).toHaveLength(1);
  });
  it.each([["a:containerId:b", ["a", "b"]], ["a:fontFamily:font#2000", ["a"]], ["unknown: a,b", ["a", "b"]]])("names the complete collision group for %s", async (detail, ids) => {
    const f = queued({ live: false });
    f.scene.dropColliding = vi.fn();
    await f.scene.onRefused(refusal("reference", detail as string));
    expect(f.scene.dropColliding).toHaveBeenCalledWith(f.scene.batches[0], new Set(ids), false);
  });
  it("stops on stale/decode errors before touching recovery decisions", async () => {
    const f = queued();
    f.scene.decode.mockImplementation(async () => { f.scene.detached = true; return el("a"); });
    await f.scene.onRefused(refusal("collision", undefined, [event("el", "a", el("a"))]));
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
    expect(mocks.batchesOf).not.toHaveBeenCalled();
    f.scene.detached = false;
    f.scene.decode.mockRejectedValue(new Error("decode"));
    await expect(f.scene.onRefused(refusal("collision", undefined, [event("el", "a", null)]))).rejects.toThrow("decode");
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
  });
});

describe("rebaseLive: assets, deletion and dependent changes", () => {
  it("rebases local keys and later edits without restoring remote properties, then persists before sending", async () => {
    const base = el("a", { color: "black" });
    const mine = el("a", { version: 2, x: 10, color: "black" });
    const later = el("a", { version: 3, x: 20, color: "black" });
    const draft = el("a", { version: 4, x: 20, y: 30, color: "black" });
    const theirs = el("a", { version: 5, x: 5, color: "blue" });
    const f = fixture([draft]);
    const first = batch([change(mine)]);
    const second = batch([change(later)], { counter: 2 });
    f.scene.batches = [first, second];
    f.scene.draft.set("a", { k: "el", id: "a", value: draft });
    f.scene.synced.set("a", { stamp: stamp(base), el: base });
    f.scene.inFlight.set(1, {});
    await f.scene.rebaseLive(first, new Map([["a", theirs]]), "collision");
    expect(first.changes[0].value).toMatchObject({ x: 10, color: "blue", version: 6 });
    expect(second.changes[0].value).toMatchObject({ x: 20, color: "blue" });
    expect(f.scene.draft.get("a").value).toMatchObject({ x: 20, y: 30, color: "blue" });
    expect(f.elements.get("a")).toMatchObject({ x: 20, y: 30, color: "blue" });
    expect(mocks.encodeEvent).toHaveBeenCalledWith({}, "el", "a", theirs, stamp(theirs));
    expect(first.rebased).toBe(true);
    expect(f.scene.inFlight.has(1)).toBe(false);
    expect(f.scene.persist.mock.calls.map(([b]: any[]) => b.counter)).toEqual([2, 1]);
    expect(f.calls.slice(-2)).toEqual(["persist", "send"]);
    expect(f.scene.sendBatch).toHaveBeenCalledWith(first, { losers: [expect.objectContaining({ id: "a", value: theirs })] });
  });

  it("sends every missing picture once, including uploads, without resending known or deleted assets", async () => {
    const f = fixture();
    f.files.one = { id: "one", dataURL: "data:one" };
    mocks.getUpload.mockImplementation(async (id) => id === "two" ? { id, mimeType: "image/png", dataURL: "data:two", created: 9 } : null);
    f.scene.confirmedFiles = new Set(["one", "known"]);
    const b = batch([change(el("a", { fileId: "one" })), change(el("b", { fileId: "two" })), change(el("c", { fileId: "known" })), change(el("d", { fileId: "deleted", isDeleted: true })), change(el("e", { fileId: "existing" })), change({ id: "existing" }, { k: "file", id: "existing" }), change(el("f", { fileId: "missing" }))]);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map(), "reference", "a:fileId:file:one");
    expect(b.changes.filter((c: any) => c.k === "file").map((c: any) => c.id)).toEqual(["two", "one", "existing"]);
    expect(mocks.getUpload.mock.calls.map(([id]) => id)).toEqual(["two", "missing"]);
    expect(f.scene.confirmedFiles.has("one")).toBe(false);
    expect(f.scene.confirmedFiles.has("known")).toBe(true);
  });
  it.each([false, true])("includes the missing custom font without duplicating an existing font event: %s", async (already) => {
    const f = fixture();
    const font = { id: 2000, family: "Custom", faces: [], source: "file" };
    mocks.fonts.set(2000, font);
    f.scene.confirmedFonts.set("hash-2000", 2000);
    const changes = [change(el("a", { fontFamily: 2000 }))];
    if (already) changes.push(change(font, { k: "font", id: "hash-2000" }));
    const b = batch(changes);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map(), "reference", "a:fontFamily:font#2000");
    expect(b.changes.filter((c: any) => c.k === "font")).toEqual([expect.objectContaining({ id: "hash-2000", value: font })]);
    expect(f.scene.confirmedFonts.has("hash-2000")).toBe(false);
  });
  it.each([true, false])("repairs another element's dangling reference only if it is alive: %s", async (alive) => {
    const f = fixture();
    const other = el("other", { containerId: "target", isDeleted: !alive });
    f.scene.confirmed.set("other", other);
    const b = batch([change(el("target", { isDeleted: true }))]);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map(), "reference", "other:containerId:target");
    const repair = b.changes.find((c: any) => c.id === "other");
    if (alive) expect(repair.value).toMatchObject({ containerId: null, version: 2 });
    else expect(repair).toBeUndefined();
  });
  it.each([false, true])("removes unknown elements, stopping only when the batch is empty: remaining=%s", async (remaining) => {
    const f = fixture([el("a", { version: 4 })]);
    const b = batch([change(el("a")), ...(remaining ? [change({ name: "New" }, { k: "name", id: "name" })] : [])]);
    f.scene.batches = [b];
    f.scene.synced.set("a", { el: el("a") });
    f.scene.inFlight.set(1, {});
    await f.scene.rebaseLive(b, new Map(), "collision", "unknown: a");
    expect(f.elements.get("a")).toMatchObject({ isDeleted: true, version: 5 });
    expect(f.scene.synced.has("a")).toBe(false);
    expect(f.scene.inFlight.has(1)).toBe(false);
    if (remaining) {
      expect(b.rebased).toBe(true);
      expect(f.scene.sendBatch).toHaveBeenCalledOnce();
    } else {
      expect(f.scene.skipped).toEqual([1]);
      expect(mocks.deleteBatch).toHaveBeenCalledWith(b);
      expect(f.scene.persist).not.toHaveBeenCalled();
      expect(f.scene.sendBatch).not.toHaveBeenCalled();
      expect(f.scene.pump).toHaveBeenCalledOnce();
    }
  });
  it("replays only each later settings delta and updates the name base", async () => {
    const f = fixture();
    const b = batch([change({ ...settings, gridSize: 40 }, { k: "set", id: "settings", keys: ["gridSize"], after: 0 }), change({ name: "Mine" }, { k: "name", id: "name", after: 0 })]);
    const later = batch([change({ ...settings, gridSize: 40, gridStep: 10 }, { k: "set", id: "settings" })], { counter: 2 });
    f.scene.batches = [b, later];
    f.scene.draft.set("set:settings", { k: "set", id: "settings", value: { ...settings, gridSize: 40, gridStep: 10, gridModeEnabled: true } });
    f.scene.synced.set("set:settings", { stamp: { v: 5, n: 6 }, el: { ...settings, viewBackgroundColor: "blue" } });
    f.scene.synced.set("name:name", { stamp: { v: 7, n: 8 }, el: { name: "Other" } });
    await f.scene.rebaseLive(b, new Map(), "collision");
    expect(b.changes[0]).toMatchObject({ base: { v: 5, n: 6 }, value: { gridSize: 40, viewBackgroundColor: "blue" } });
    expect(b.changes[0].after).toBeUndefined();
    expect(b.changes[1].base).toEqual({ v: 7, n: 8 });
    expect(b.changes[1].after).toBeUndefined();
    expect(later.changes[0].value).toMatchObject({ gridStep: 10, viewBackgroundColor: "blue" });
    expect(f.app()).toMatchObject({ gridSize: 40, gridStep: 10, gridModeEnabled: true, viewBackgroundColor: "blue" });
  });
  it("preserves a canvas with newer uncollected work, and does not send while offline", async () => {
    const f = fixture([el("a", { version: 9, x: 99 })]);
    f.scene.phase = "offline";
    const b = batch([change(el("a", { version: 2, x: 10 }))]);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map([["a", el("a", { version: 4 })]]), "collision");
    expect(f.elements.get("a")?.x).toBe(99);
    expect(f.scene.sendBatch).not.toHaveBeenCalled();
    expect(f.scene.persist).toHaveBeenCalledWith(b);
  });
  it.each(["upload", "font hash", "encoding", "persist"])("propagates %s failures before sending", async (failure) => {
    const f = fixture();
    const mine = el("a", { version: 2, x: 10, fileId: "f", fontFamily: 2000 });
    const b = batch([change(mine)]);
    f.scene.batches = [b];
    f.scene.synced.set("a", { el: el("a"), stamp: { v: 1, n: 1 } });
    let detail: string | undefined;
    if (failure === "upload") { mocks.getUpload.mockRejectedValue(new Error(failure)); detail = "a:fileId:file:f"; }
    if (failure === "font hash") { mocks.fonts.set(2000, { id: 2000 }); mocks.fontHash.mockRejectedValue(new Error(failure)); detail = "a:fontFamily:font#2000"; }
    if (failure === "encoding") mocks.encodeEvent.mockRejectedValue(new Error(failure));
    if (failure === "persist") f.scene.persist.mockRejectedValue(new Error(failure));
    await expect(f.scene.rebaseLive(b, new Map([["a", el("a", { version: 3, x: 5 })]]), detail ? "reference" : "collision", detail)).rejects.toThrow(failure);
    expect(f.scene.sendBatch).not.toHaveBeenCalled();
  });
});

// Additional boundaries that do not need a network round trip.
describe("recovery edge paths", () => {
  it("applies a reconciliation without copies or stale queue writes synchronously", async () => {
    const f = fixture([el("a")]);
    f.scene.confirmed.set("a", el("a", { version: 2, x: 4 }));
    const work = f.scene.reconcile([]);
    expect(f.elements.get("a")?.x).toBe(4);
    await work;
  });

  it("uses the collision reason for an offline copy without stale or signed-out work", async () => {
    const f = fixture([el("a", { version: 3, x: 2 })]);
    f.scene.localBase = new Map([["a", el("a")]]);
    f.scene.confirmed.set("a", el("a", { version: 2, x: 1 }));
    await f.scene.reconcile([]);
    expect(f.scene.makeOfflineCopy).toHaveBeenCalledWith("Changes made here while offline clashed with newer ones");
    expect(f.elements.get("a")?.x).toBe(1);
  });

  it("recognizes a server index repair without a local base entry", async () => {
    const f = fixture([el("a", { version: 8, index: "a0" })]);
    f.scene.localBase = new Map();
    f.scene.confirmed.set("a", el("a", { version: 2, index: "b0" }));
    await f.scene.reconcile([]);
    expect(f.elements.get("a")?.index).toBe("b0");
    expect(f.scene.makeOfflineCopy).not.toHaveBeenCalled();
  });

  it("uses the ordinary stream path when an own batch was already acknowledged", async () => {
    const f = fixture([el("a")]);
    f.scene.batches = [batch([], { state: "acked" })];
    f.scene.onAck = vi.fn();
    await f.scene.takeStamped({ tab: "tab", counter: 1, seq: 2, events: [event("el", "a", el("a", { x: 9 }))] }, { toCanvas: false });
    expect(f.scene.decode).toHaveBeenCalledOnce();
    expect(f.scene.onAck).not.toHaveBeenCalled();
    expect(f.scene.confirmed.get("a").x).toBe(9);
    expect(f.elements.get("a")?.x).toBe(0);
  });

  it("waits for a peer claim even when no queue can be read", async () => {
    const f = fixture();
    f.scene.batches = [batch([change(el("a"))])];
    f.scene.othersPending.set("other", new Set(["target"]));
    f.scene.rebaseLive = vi.fn();
    mocks.batchesOf.mockRejectedValue(new Error("storage"));
    await f.scene.onRefused({ type: "refused", counter: 1, reason: "reference", detail: "a:containerId:target", current: [] });
    expect(f.scene.parked.has(1)).toBe(true);
    expect(f.scene.rebaseLive).not.toHaveBeenCalled();
  });

  it("ignores same-tab and answered queues and null decoded elements during refusal recovery", async () => {
    const f = fixture();
    const b = batch([change(el("a"))]);
    f.scene.batches = [b];
    f.scene.rebaseLive = vi.fn();
    mocks.batchesOf.mockResolvedValue([batch([change(el("a"))]), batch([change(el("a"))], { tab: "other", state: "acked" })]);
    await f.scene.onRefused({ type: "refused", counter: 1, reason: "collision", current: [event("el", "a", null)] });
    expect(f.scene.rebaseLive).toHaveBeenCalledWith(b, new Map(), "collision", undefined);
    expect(f.scene.confirmed.size).toBe(0);
    expect(f.scene.parked.size).toBe(0);
  });

  it("does not delete batches if a recovery copy rejects", async () => {
    const f = fixture([], { headless: true });
    const b = batch([change(el("a"))]);
    f.scene.batches = [b];
    f.scene.makeOfflineCopy.mockRejectedValue(new Error("recovery"));
    await expect(f.scene.onRefused({ type: "refused", counter: 1, reason: "role", current: [] })).rejects.toThrow("recovery");
    expect(f.scene.batches).toEqual([b]);
    expect(mocks.deleteBatch).not.toHaveBeenCalled();
  });

  it("ignores missing fonts and unavailable referenced elements", async () => {
    const f = fixture();
    const b = batch([change(el("a", { fontFamily: 2000 }))]);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map(), "reference", "a:fontFamily:font#2000");
    expect(b.changes).toHaveLength(1);
    expect(mocks.fontHash).not.toHaveBeenCalled();
    await f.scene.rebaseLive(b, new Map(), "reference", "missing:containerId:target");
    expect(b.changes).toHaveLength(1);
  });

  it("cuts dangling references using confirmed state first and the canvas as fallback", async () => {
    const f = fixture([el("canvas"), el("dead", { isDeleted: true })]);
    f.scene.confirmed.set("confirmed", el("confirmed"));
    const b = batch([change(el("a", { containerId: "missing", frameId: "canvas", startBinding: { elementId: "confirmed" }, endBinding: { elementId: "dead" }, boundElements: [{ id: "confirmed", type: "arrow" }, { id: "missing", type: "arrow" }] }))]);
    f.scene.batches = [b];
    await f.scene.rebaseLive(b, new Map(), "reference", "a:containerId:missing");
    expect(b.changes[0].value).toMatchObject({ containerId: null, frameId: "canvas", startBinding: { elementId: "confirmed" }, endBinding: null, boundElements: [{ id: "confirmed", type: "arrow" }] });
    expect(mocks.encodeEvent).not.toHaveBeenCalled();
  });

  it("does not resurrect absent or already-deleted unknown elements", async () => {
    const f = fixture([el("deleted", { isDeleted: true })]);
    const b = batch([change(el("missing")), change(el("deleted"))]);
    f.scene.batches = [b];
    const note = vi.spyOn(f.scene, "note");
    await f.scene.rebaseLive(b, new Map(), "collision", "unknown: missing,deleted");
    expect(f.elements.has("missing")).toBe(false);
    expect(note).not.toHaveBeenCalled();
    expect(mocks.deleteBatch).toHaveBeenCalledWith(b);
  });

  it("uses all settings keys if key metadata is absent and retains the base when none is synced", async () => {
    const f = fixture();
    const b = batch([change(settings, { k: "set", id: "settings", keys: null }), change({ name: "Mine" }, { k: "name", id: "name", after: 0 })]);
    f.scene.batches = [b];
    f.scene.synced.set("set:settings", { el: settings, stamp: null });
    await f.scene.rebaseLive(b, new Map(), "collision");
    expect(b.changes[0].value).toEqual(settings);
    expect(b.changes[0].base).toEqual({ v: 1, n: 1 });
    expect(b.changes[1].base).toEqual({ v: 1, n: 1 });
    expect(b.changes[1].after).toBeUndefined();
    expect(f.apply).not.toHaveBeenCalled();
  });
});

describe("synchronous recovery prefixes", () => {
  it("overlays a headless queue synchronously until a font must be registered", async () => {
    const f = fixture([], { headless: true });
    f.scene.batches = [batch([change(el("a", { x: 4 })), change({ id: "f", dataURL: "data:f" }, { k: "file" })])];
    const work = f.scene.reconcile([]);
    expect(f.elements.get("a")?.x).toBe(4);
    expect(f.files.f.dataURL).toBe("data:f");
    await work;
  });

  it("removes unknown elements before the first queue deletion finishes", async () => {
    const f = fixture([el("a")]);
    const b = batch([change(el("a"))]);
    f.scene.batches = [b];
    const work = f.scene.rebaseLive(b, new Map(), "collision", "unknown: a");
    expect(f.elements.get("a")?.isDeleted).toBe(true);
    expect(mocks.deleteBatch).toHaveBeenCalledWith(b);
    await work;
  });

  it("starts recovery immediately when a refusal has no events or peer-queue check", async () => {
    const f = fixture();
    f.scene.batches = [batch([change(el("a"))])];
    const work = f.scene.onRefused({ type: "refused", counter: 1, reason: "invalid", current: [] });
    expect(f.scene.makeOfflineCopy).toHaveBeenCalledOnce();
    await work;
  });
});

it("sets aside only an unavailable picture and sends the user's text", async () => {
  const picture = el("broken", { type: "image", fileId: "absent", status: "error" });
  const text = el("text", { type: "text", text: "edited" });
  const f = fixture([picture, text]);
  f.scene.note = vi.fn();
  const b = batch([change(picture), change(text)]);
  f.scene.batches = [b];
  await f.scene.includeMissingFiles(b, undefined);
  expect(b.changes.map((item: any) => item.id)).toEqual(["text"]);
  expect(f.elements.get("broken")).toEqual(picture);
  expect(f.scene.note).toHaveBeenCalledWith(expect.stringContaining("delete it or ask the agent"));
  f.scene.send = vi.fn(() => true);
  await LiveScene.prototype.sendBatch.call(f.scene, b);
  expect(f.scene.send).toHaveBeenCalledWith(expect.objectContaining({ type: "batch", counter: 1 }));
  expect(f.scene.parked.size).toBe(0);
  await f.scene.onAck({ type: "ack", counter: 1, seq: 1, stamps: { text: { v: 2, n: 2 } } });
  expect(b.state).toBe("acked");
});

it("keeps an offline copy even when picture data is unavailable", async () => {
  const picture = el("broken", { type: "image", fileId: "absent", status: "pending" });
  const f = fixture([picture, el("text", { text: "keep me" })]);
  const saveCopy = vi.fn(async () => "Recovered");
  Object.assign(f.host, { saveCopy });
  f.scene.note = vi.fn();
  const withFonts = (imports["../fonts"] as any).withFonts;
  withFonts.mockImplementation((json: string) => json);
  expect(await LiveScene.prototype.makeOfflineCopy.call(f.scene, "Recovery")).toBe(true);
  const saved = JSON.parse(saveCopy.mock.calls[0][1]);
  expect(saved.elements.find((item: any) => item.id === "broken").status).toBe("error");
  expect(saved.elements.find((item: any) => item.id === "text").text).toBe("keep me");
  expect(picture.status).toBe("pending");
});
