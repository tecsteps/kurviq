// The scene's admission and Drive orchestration, with the runtime and network at their boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../../online/worker/auth", () => ({
  sceneTokenExpiry: (token: string) => Number(token.split(".")[1]) || 0,
  accessFromRefresh: vi.fn(), devGate: vi.fn(), unsealSceneToken: vi.fn(), watchSecret: vi.fn(),
}));
vi.mock("../../online/worker/driveApi", () => ({
  getFile: vi.fn(), listRevisions: vi.fn(), downloadFile: vi.fn(), patchFile: vi.fn(), driveCall: vi.fn(),
  driveUrls: () => ({ api: "https://drive.test" }),
  problemOf: (answer: { problem?: string }) => answer.problem ?? "access",
  isTransient: (problem: string) => problem === "unreachable" || problem === "rate-limited",
  uploadVersion: vi.fn(),
}));
vi.mock("../../online/worker/serverMerge", () => ({
  keyOf: (entry: { k: string; id: string }) => entry.k === "el" ? entry.id : `${entry.k}:${entry.id}`,
  randomNonce: () => 17,
  wireOf: (entry: unknown) => entry,
  subjectsOfFile: vi.fn(),
  buildSceneFile: vi.fn(), encryptContent: vi.fn(), importSceneKey: vi.fn(), indexBetween: vi.fn(),
  md5Hex: vi.fn(), plainOf: vi.fn(), sameContent: vi.fn(), validElement: vi.fn(),
}));

import { SceneRoom } from "../../online/worker/scene";
import { downloadFile, getFile, listRevisions } from "../../online/worker/driveApi";
import { subjectsOfFile } from "../../online/worker/serverMerge";
import { LIMITS, MAX_VERSIONS_PER_ROUND, REPLAY_HORIZON_MS } from "../src/online/liveProtocol";

const NOW = 1_800_000_000_000;
const socket = () => ({ readyState: 1, serializeAttachment: vi.fn() });
const attachment = () => ({ sub: "alice", pseudonym: "Alice", role: "edit", tab: "tab", token: `sealed.${NOW + 1000}`, keyId: "key", head: { revision: "base", md5: "md5", at: 123 } });
const asset = (id = "image") => ({ k: "file", id, c: "cipher", v: 1, n: 1, seq: 0, a: null });
const font = (id: string, fontId: number) => ({ ...asset(id), k: "font", fontId });
const readable = (id = "element") => ({ id, type: "rectangle", version: 7, versionNonce: 9, isDeleted: false, index: null, boundIds: [], groupIds: [], containerId: null, startId: null, endId: null, frameId: null, fileId: null, fontFamily: null });
const message = () => ({ counter: 1, made: NOW, events: [{ k: "file", id: "image", c: "cipher", base: null }] });
const batch = (author = "alice") => ({ seq: 2, tab: "tab", counter: 1, author, pseudonym: author, via: "user", entries: [asset()], touches: [], bytes: 1 });

// Skip the runtime constructor: these tests pin the handlers, not SQLite's schema setup.
const room = () => {
  const r = Object.create(SceneRoom.prototype) as any;
  const metadata = new Map<string, any>([["keyId", "key"], ["verifyWanted", "1"]]);
  Object.assign(r, {
    env: {}, state: new Map(), snap: new Map(), pending: [], discarded: new Map(), indices: new Map(),
    alive: 0, sceneBytes: 0, loaded: true, seqNow: 0, lastAccess: null,
    ctx: { storage: { transactionSync: vi.fn((fn: () => unknown) => fn()) } },
    meta: vi.fn((key: string) => metadata.get(key) ?? null),
    metaJson: vi.fn((key: string, fallback: unknown) => metadata.get(key) ?? fallback),
    setMeta: vi.fn((key: string, value: unknown) => metadata.set(key, value)),
    num: vi.fn(() => 0), q: vi.fn(() => []), lifecycle: vi.fn(() => ({ state: "active", epoch: 1 })),
    seeded: vi.fn(() => true), isRevoked: vi.fn(() => false), knownCounters: vi.fn(() => ({ mark: 0, extra: [] })),
    rateOk: vi.fn(() => true), validEvent: vi.fn(() => true), referenceProblem: vi.fn(() => null),
    pendingBytes: vi.fn(() => 0), bytesInUse: vi.fn(() => 0), setState: vi.fn(),
    refuse: vi.fn(), send: vi.fn(), broadcast: vi.fn(), schedule: vi.fn(), unblock: vi.fn(),
    storeBatch: vi.fn(), foldCounters: vi.fn(), checkpointSeq: vi.fn(), storeToken: vi.fn(),
    stamped: vi.fn(() => ({ stamped: true })), recordLosers: vi.fn(), autoAcceptDependency: vi.fn(),
    driveRecord: vi.fn(async () => null), lastSaved: vi.fn(() => ({ revision: "base", md5: "md5", at: 100 })),
    seedReceipts: vi.fn(() => null), writeSnapshot: vi.fn(), rebuildState: vi.fn(), readySockets: vi.fn(() => []),
    welcomeState: vi.fn(() => ({ type: "welcome" })), load: vi.fn(), expireLeases: vi.fn(),
    accessFor: vi.fn(async () => ({ token: "token" })), anyAccess: vi.fn(async () => null),
    keyFrom: vi.fn(async () => ({ key: true })), confirmed: vi.fn(), moveWatch: vi.fn(async () => {}),
    toTrashNow: vi.fn(), deleted: vi.fn(), markBlocked: vi.fn(), retryLater: vi.fn(),
    setError: vi.fn(), requestToken: vi.fn(), lastAccessToken: vi.fn(() => null),
    setDriveName: vi.fn(), verifySeedRecord: vi.fn(async () => true), mergeOutside: vi.fn(async () => "ok"),
    upload: vi.fn(async () => "ok"), planGroup: vi.fn(() => null), broadcastStatus: vi.fn(),
    commitSave: vi.fn(), receiptsWith: vi.fn(() => ({ fallback: true })), finishSave: vi.fn(),
    audit: vi.fn(async () => true), repairUpload: vi.fn(async () => true), recoverSaves: vi.fn(async () => true),
    releaseAuditPins: vi.fn(async () => {}), pinRoom: vi.fn(async () => true), dcall: vi.fn(async () => ({ status: 200 })),
    diffAgainst: vi.fn(async () => []), outsideEntries: vi.fn(async () => [asset("outside")]),
    commitOutside: vi.fn(),
  });
  return { r, metadata };
};
const original = (r: any, name: string) => (SceneRoom.prototype as any)[name].bind(r);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.mocked(getFile).mockResolvedValue({ status: 200, data: { headRevisionId: "base", name: "scene" } });
  vi.mocked(listRevisions).mockResolvedValue([]);
  vi.mocked(downloadFile).mockResolvedValue({ status: 200, text: "{}" });
  vi.mocked(subjectsOfFile).mockResolvedValue(new Map());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("scene async callback contracts", () => {
  it.each(["webSocketClose", "webSocketError", "retention"])("rejects synchronous work failures from %s", async (name) => {
    const { r } = room(); const error = new Error("storage unavailable");
    r.afterLeave = vi.fn(() => { throw error; }); r.q.mockImplementation(() => { throw error; });
    const result = (r as any)[name]({ close: vi.fn() }, 1000);
    expect(result).toBeInstanceOf(Promise); await expect(result).rejects.toBe(error);
  });
});

describe("scene batch admission", () => {
  it.each([
    ["role", (r: any, a: any) => { a.role = "read"; }],
    ["role", (r: any) => r.isRevoked.mockReturnValue(true)],
    ["lifecycle", (r: any) => r.lifecycle.mockReturnValue({ state: "trashed" })],
    ["unseeded", (r: any) => r.seeded.mockReturnValue(false)],
    ["key", (r: any, a: any) => { a.keyId = "other"; }],
    ["discarded", (r: any) => r.discarded.set("tab", new Set([1]))],
    ["limit", (r: any, a: any, m: any) => { m.counter = LIMITS.counterWindow + 1; }],
    ["invalid", (r: any, a: any, m: any) => { m.made = NOW + 300_001; }],
    ["old", (r: any, a: any, m: any) => { m.made = NOW - REPLAY_HORIZON_MS - 1; }],
    ["token", (r: any, a: any) => { a.token = `sealed.${NOW}`; }],
    ["limit", (r: any) => r.rateOk.mockReturnValue(false)],
    ["invalid", (r: any, a: any, m: any) => { m.events = []; }],
    ["limit", (r: any, a: any, m: any) => { m.events = Array(LIMITS.eventsPerBatch + 1).fill(m.events[0]); }],
    ["invalid", (r: any) => r.validEvent.mockReturnValue(false)],
    ["invalid", (r: any, a: any, m: any) => m.events.push(m.events[0])],
    ["collision", (r: any, a: any, m: any) => { m.events[0].base = { v: 1, n: 1 }; }],
    ["reference", (r: any) => r.referenceProblem.mockReturnValue({ target: "gone", detail: "missing" })],
    ["limit", (r: any) => r.pendingBytes.mockReturnValue(LIMITS.pendingBytes + 1)],
  ])("refuses %s before storing or acknowledging", (reason, setup) => {
    const { r } = room(); const a = attachment(); const m = message();
    setup(r, a, m); r.onBatch(socket(), a, m);
    expect(r.refuse.mock.calls[0][2]).toBe(reason);
    expect(r.storeBatch).not.toHaveBeenCalled(); expect(r.send).not.toHaveBeenCalled();
  });

  it("ignores an invalid counter and acknowledges a known batch without validating it again", () => {
    const { r } = room(); const ws = socket(); const a = attachment();
    r.onBatch(ws, a, { ...message(), counter: 0 }); expect(r.refuse).not.toHaveBeenCalled();
    r.knownCounters.mockReturnValue({ mark: 1, extra: [] }); r.pending = [batch()];
    r.onBatch(ws, a, message());
    expect(r.send).toHaveBeenCalledWith(ws, expect.objectContaining({ type: "ack", duplicate: true, seq: 2 }));
    expect(r.validEvent).not.toHaveBeenCalled();
  });

  it("stores before acknowledging, folds skip counters and stores the author's token", () => {
    const { r } = room(); const ws = socket();
    r.onBatch(ws, attachment(), { ...message(), skip: [1, 2, 0], via: "agent", command: "edit" });
    expect(r.refuse).not.toHaveBeenCalled(); expect(r.pending).toHaveLength(1);
    expect(r.storeBatch).toHaveBeenCalledWith(expect.objectContaining({ via: "agent", command: "edit", seq: 1 }));
    expect(r.foldCounters).toHaveBeenCalledWith("tab", [1]);
    expect(r.storeToken).toHaveBeenCalledWith("alice", attachment().token);
    expect(r.storeBatch.mock.invocationCallOrder[0]).toBeLessThan(r.send.mock.invocationCallOrder[0]);
    expect(r.send).toHaveBeenCalledWith(ws, expect.objectContaining({ type: "ack", stamps: { "file:image": { v: 1, n: 17 } } }));
    expect(r.broadcast).toHaveBeenCalled(); expect(r.schedule).toHaveBeenCalledWith("save", NOW + 60_000, true);
  });

  it("deduplicates existing assets and only checkpoints their counter", () => {
    const { r } = room(); r.state.set("file:image", asset());
    r.onBatch(socket(), attachment(), message());
    expect(r.pending).toHaveLength(0); expect(r.foldCounters).toHaveBeenCalledWith("tab", [1]);
    expect(r.checkpointSeq).toHaveBeenCalled(); expect(r.storeToken).not.toHaveBeenCalled();
  });

  it("remaps a conflicting font id and refuses when every font id is used", () => {
    const { r } = room(); const m = { ...message(), events: [{ ...font("new", 2000), base: null }] };
    r.state.set("font:old", font("old", 2000)); r.onBatch(socket(), attachment(), m);
    expect(r.pending[0].entries[0].fontId).toBe(2001);
    expect(r.send.mock.calls[0][1].fontIds).toEqual({ new: 2001 });
    const full = room().r;
    for (let id = 2000; id < 9000; id++) full.state.set(`font:${id}`, font(String(id), id));
    full.onBatch(socket(), attachment(), m);
    expect(full.refuse).toHaveBeenCalledWith(expect.anything(), 1, "font-id", [], "no free font id");
  });

  it("stamps readable entries, remaps their font and repairs fractional indices", () => {
    const { r } = room(); r.freeIndex = vi.fn(() => "a1"); r.state.set("font:old", font("old", 2000));
    const el = { k: "el", id: "element", c: "cipher", base: null, r: { ...readable(), fontFamily: 2000 } };
    r.onBatch(socket(), attachment(), { ...message(), events: [{ ...font("new", 2000), base: null }, el] });
    expect(r.pending[0].entries[1]).toMatchObject({ v: 7, n: 17, r: { version: 7, versionNonce: 17, fontFamily: 2001, index: "a1" } });
    expect(r.send.mock.calls[0][1]).toMatchObject({ repairs: { element: "a1" }, fontIds: { new: 2001 } });
  });

  it("allows a base produced by the tab's own pending batch, but refuses other stale bases", () => {
    const { r } = room(); r.freeIndex = vi.fn(() => "a1");
    const current = { ...asset("element"), k: "el", v: 8, n: 11, t: "tab", u: 2, r: readable() };
    const m = { ...message(), base: 2, events: [{ k: "el", id: "element", c: "cipher", base: { v: 1, n: 1 }, r: readable() }] };
    r.state.set("element", current); r.onBatch(socket(), attachment(), m);
    expect(r.refuse).not.toHaveBeenCalled(); expect(r.pending[0].entries[0].v).toBe(9);
    const stale = room().r; stale.state.set("element", current); stale.onBatch(socket(), attachment(), { ...m, base: 3 });
    expect(stale.refuse).toHaveBeenCalledWith(expect.anything(), 1, "collision", [current], undefined);
  });

  it.each(["elements", "sceneBytes", "pendingBatches", "accountPendingBytes", "touches"])("enforces the result limit: %s", (kind) => {
    const { r } = room();
    if (kind === "elements") r.alive = LIMITS.elements + 1;
    if (kind === "sceneBytes") { r.sceneBytes = LIMITS.sceneBytes + 1; r.bytesInUse.mockReturnValue(LIMITS.sceneBytes + 1); }
    if (kind === "pendingBatches") r.pending = Array(20_000).fill(batch());
    if (kind === "accountPendingBytes") r.pendingBytes.mockImplementation((sub?: string) => sub ? LIMITS.accountPendingBytes + 1 : 0);
    if (kind === "touches") r.pendingBytes.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(LIMITS.accountPendingBytes + 1);
    r.onBatch(socket(), attachment(), message());
    expect(r.refuse).toHaveBeenCalledWith(expect.anything(), 1, "limit", [], kind === "touches" ? "accountPendingBytes" : kind);
    expect(r.storeBatch).not.toHaveBeenCalled();
  });

  it("propagates a storage failure, invalidates memory and never acknowledges it", () => {
    const { r } = room(); const error = new Error("disk full"); r.storeBatch.mockImplementation(() => { throw error; });
    expect(() => r.onBatch(socket(), attachment(), message())).toThrow(error);
    expect(r.loaded).toBe(false); expect(r.send).not.toHaveBeenCalled(); expect(r.pending).toHaveLength(0);
  });
});

describe("scene seed admission", () => {
  const seedMessage = () => ({ scene: { revision: "base", md5: "md5", events: message().events } });
  it.each([
    ["role", (r: any, a: any) => { a.role = "read"; }],
    ["lifecycle", (r: any) => r.lifecycle.mockReturnValue({ state: "deleted" })],
    ["seeded", (r: any) => r.seeded.mockReturnValue(true)],
    ["key", (r: any, a: any) => { a.keyId = "wrong"; }],
    ["invalid", (r: any, a: any, m: any) => { m.scene.events = null; }],
    ["old", (r: any, a: any, m: any) => { m.scene.revision = "old"; }],
    ["invalid", (r: any) => r.validEvent.mockReturnValue(false)],
    ["invalid", (r: any, a: any, m: any) => m.scene.events.push(m.scene.events[0])],
  ])("refuses %s without writing a snapshot", async (reason, setup) => {
    const { r } = room(); r.seeded.mockReturnValue(false); const a = attachment(); const m = seedMessage(); setup(r, a, m);
    await r.onSeed(socket(), a, m);
    expect(r.send.mock.calls[0][1]).toMatchObject({ type: "seed-refused", reason });
    expect(r.writeSnapshot).not.toHaveBeenCalled();
  });

  it("refuses an oversized seed before fetching its Drive record", async () => {
    const { r } = room(); r.seeded.mockReturnValue(false); r.seedEntry = vi.fn(() => ({ ...asset(), c: { length: LIMITS.sceneBytes + 1 } }));
    await r.onSeed(socket(), attachment(), seedMessage());
    expect(r.send.mock.calls[0][1].reason).toBe("invalid"); expect(r.driveRecord).not.toHaveBeenCalled();
  });

  it("stops when its socket closes while the Drive record is being read", async () => {
    const { r } = room(); const ws = socket(); r.seeded.mockReturnValue(false);
    r.driveRecord.mockImplementation(async () => { ws.readyState = 3; return null; });
    await r.onSeed(ws, attachment(), seedMessage()); expect(r.writeSnapshot).not.toHaveBeenCalled();
    expect(r.send.mock.calls[0][1].reason).toBe("lifecycle");
  });

  it("rechecks after the Drive read and does not overwrite a concurrent seed", async () => {
    const { r } = room(); r.seeded.mockReturnValue(false);
    r.driveRecord.mockImplementation(async () => { r.seeded.mockReturnValue(true); return {}; });
    await r.onSeed(socket(), attachment(), seedMessage());
    expect(r.send.mock.calls[0][1].reason).toBe("seeded"); expect(r.writeSnapshot).not.toHaveBeenCalled();
  });

  it("commits receipts before notifying the seeder and waiting peers, preserving the saved time", async () => {
    const { r, metadata } = room(); r.seeded.mockReturnValue(false); const ws = socket(); const waiting = socket(); const other = socket();
    r.driveRecord.mockResolvedValue({ receipts: { tab: { mark: 2, extra: [4], at: 9 } }, onBehalf: [{ by: "A", for: "B", at: 8 }] });
    r.seedReceipts.mockReturnValue({ tab: { mark: 2, extra: [4], at: 9 } });
    r.readySockets.mockReturnValue([{ ws, att: { waiting: true } }, { ws: waiting, att: { waiting: true } }, { ws: other, att: { waiting: false } }]);
    await r.onSeed(ws, attachment(), seedMessage());
    expect(metadata.get("lastSaved")).toEqual({ revision: "base", md5: "md5", at: 100 });
    expect(metadata.get("seedCheck")).toBeNull(); expect(r.foldCounters).toHaveBeenCalledWith("tab", [4, 2], 2);
    expect(r.snap.size).toBe(1); expect(r.writeSnapshot.mock.invocationCallOrder[0]).toBeLessThan(r.send.mock.invocationCallOrder[0]);
    expect(r.send).toHaveBeenCalledTimes(2); expect(other.serializeAttachment).not.toHaveBeenCalled();
  });

  it("marks an unreadable record for a later check and uses the ticket time for a new revision", async () => {
    const { r, metadata } = room(); r.seeded.mockReturnValue(false); r.lastSaved.mockReturnValue({ revision: "old", at: 7 });
    await r.onSeed(socket(), attachment(), seedMessage());
    expect(metadata.get("lastSaved").at).toBe(123); expect(metadata.get("seedCheck")).toBe("1");
  });
});

describe("scene access verification", () => {
  it("does nothing unless verification was requested", async () => {
    const { r, metadata } = room(); metadata.delete("verifyWanted"); await r.verifyAccess(); expect(getFile).not.toHaveBeenCalled();
  });
  it("checks the owner first, skips duplicate tokens and clears an unknown-access error on success", async () => {
    const { r, metadata } = room(); metadata.set("owner", "owner"); metadata.set("error", "access-unknown");
    r.q.mockReturnValue([{ author: "guest" }, { author: "owner" }]); r.accessFor.mockImplementation(async (sub: string) => ({ token: sub }));
    r.lastAccessToken.mockReturnValue({ sub: "guest", token: "last" });
    await r.verifyAccess({ sub: "guest", token: "one-time" });
    expect(r.accessFor).toHaveBeenCalledTimes(1); expect(getFile).toHaveBeenCalledWith(r.env, "owner", "");
    expect(r.confirmed).toHaveBeenCalledWith("owner"); expect(r.moveWatch).toHaveBeenCalledWith("owner", "owner");
    expect(metadata.get("verifyWanted")).toBeNull(); expect(r.setError).toHaveBeenCalledWith(null);
  });
  it("retries an unreachable credential before trying Drive", async () => {
    const { r } = room(); r.q.mockReturnValue([{ author: "alice" }]); r.accessFor.mockResolvedValue({ problem: "unreachable" });
    await r.verifyAccess(); expect(getFile).not.toHaveBeenCalled(); expect(r.schedule).toHaveBeenCalledWith("verify", NOW + 60_000);
  });
  it.each([[200, undefined, "trash"], [503, "unreachable", "retry"], [404, "access", "deleted"]])("handles status %s for the owner", async (status, problem, outcome) => {
    const { r, metadata } = room(); metadata.set("owner", "alice"); vi.mocked(getFile).mockResolvedValue({ status, problem, data: { trashed: true } } as any);
    await r.verifyAccess({ sub: "alice", token: "token" });
    if (outcome === "trash") expect(r.toTrashNow).toHaveBeenCalled();
    if (outcome === "retry") expect(r.schedule).toHaveBeenCalledWith("verify", NOW + 60_000);
    if (outcome === "deleted") expect(r.deleted).toHaveBeenCalled();
  });
  it("blocks an unshared author but keeps the scene when nobody can prove deletion", async () => {
    const { r } = room(); r.pending = [batch()]; r.lastAccess = { sub: "alice", token: "token" };
    vi.mocked(getFile).mockResolvedValue({ status: 404, problem: "access" } as any);
    await r.verifyAccess({ sub: "alice", token: "token" });
    expect(r.markBlocked).toHaveBeenCalledWith("alice", "access"); expect(r.lastAccess).toBeNull();
    expect(r.deleted).not.toHaveBeenCalled(); expect(r.setError).toHaveBeenCalledWith("access-unknown");
    expect(r.schedule).toHaveBeenLastCalledWith("verify", NOW + 15 * 60_000);
  });
});

describe("scene save rounds", () => {
  const savingRoom = () => { const h = room(); h.r.planGroup.mockReturnValueOnce([batch()]); return h; };
  it.each(["inactive", "unseeded", "recovery"])("stops before planning when %s", async (kind) => {
    const { r } = savingRoom();
    if (kind === "inactive") r.lifecycle.mockReturnValue({ state: "deleted" });
    if (kind === "unseeded") r.seeded.mockReturnValue(false);
    if (kind === "recovery") r.recoverSaves.mockResolvedValue(false);
    await r.saveRoundLocked(); expect(r.planGroup).not.toHaveBeenCalled(); expect(r.upload).not.toHaveBeenCalled();
  });
  it.each([
    ["credential retry", (r: any) => r.accessFor.mockResolvedValue({ problem: "unreachable" }), "google-unreachable"],
    ["file retry", () => vi.mocked(getFile).mockResolvedValue({ status: 503, problem: "unreachable" } as any), "unreachable"],
    ["missing key", (r: any) => r.keyFrom.mockResolvedValue(null), "key-missing"],
    ["seed record retry", (r: any, metadata: Map<string, unknown>) => { metadata.set("seedCheck", "1"); r.verifySeedRecord.mockResolvedValue(false); }, "google-unreachable"],
  ])("stops on %s", async (_name, setup, problem) => {
    const { r, metadata } = savingRoom(); setup(r, metadata); await r.saveRoundLocked();
    expect(r.retryLater).toHaveBeenCalledWith(problem); expect(r.upload).not.toHaveBeenCalled();
  });
  it.each([
    ["token", (r: any) => r.accessFor.mockResolvedValue({ problem: "token" }), "token"],
    ["not found", () => vi.mocked(getFile).mockResolvedValue({ status: 404, problem: "access" } as any), "access"],
    ["read only", () => vi.mocked(getFile).mockResolvedValue({ status: 200, data: { capabilities: { canEdit: false } } }), "access"],
  ])("skips the author after %s", async (_name, setup, reason) => {
    const { r } = savingRoom(); setup(r); await r.saveRoundLocked();
    expect(r.markBlocked).toHaveBeenCalledWith("alice", reason); expect(r.planGroup.mock.calls[1][0].has("alice")).toBe(true); expect(r.upload).not.toHaveBeenCalled();
  });
  it("trashes immediately when Drive confirms the trash", async () => {
    const { r } = savingRoom(); vi.mocked(getFile).mockResolvedValue({ status: 200, data: { trashed: true } });
    await r.saveRoundLocked(); expect(r.toTrashNow).toHaveBeenCalled(); expect(r.keyFrom).not.toHaveBeenCalled();
  });
  it.each(["ok", "retry", "busy"])("handles an outside revision: %s", async (kind) => {
    const { r } = savingRoom(); vi.mocked(getFile).mockResolvedValue({ status: 200, data: { headRevisionId: "foreign" } });
    if (kind === "retry") r.mergeOutside.mockResolvedValue("retry");
    if (kind === "busy") r.planGroup.mockReturnValue([batch()]);
    await r.saveRoundLocked(); expect(r.upload).not.toHaveBeenCalled();
    if (kind === "ok") expect(r.mergeOutside).toHaveBeenCalledTimes(1);
    if (kind === "retry") expect(r.retryLater).toHaveBeenCalledWith("google-unreachable");
    if (kind === "busy") { expect(r.mergeOutside).toHaveBeenCalledTimes(2); expect(r.retryLater).toHaveBeenCalledWith("outside-busy"); }
  });
  it.each(["retry", "replan", "blocked"])("handles an upload result: %s", async (kind) => {
    const { r } = savingRoom(); r.upload.mockResolvedValue(kind === "blocked" ? { blocked: "access" } : kind);
    await r.saveRoundLocked();
    if (kind === "retry") expect(r.broadcastStatus).not.toHaveBeenCalled();
    if (kind === "replan") expect(r.planGroup).toHaveBeenCalledTimes(2);
    if (kind === "blocked") expect(r.markBlocked).toHaveBeenCalledWith("alice", "access");
  });
  it("caps versions, clears transient errors and schedules the remaining work and watch stop", async () => {
    const { r, metadata } = room(); r.planGroup.mockReturnValue([batch()]); metadata.set("error", "drive-full"); metadata.set("watchStop", "1");
    await r.saveRoundLocked(); expect(r.upload).toHaveBeenCalledTimes(MAX_VERSIONS_PER_ROUND);
    expect(metadata.get("failures")).toBeNull(); expect(r.setError).toHaveBeenCalledWith(null);
    expect(r.schedule).toHaveBeenCalledWith("save", NOW + 100); expect(r.schedule).toHaveBeenCalledWith("watch-stop", NOW, true);
  });
});

describe("scene unfinished save recovery", () => {
  const row = (state = "audit") => ({ op: "op", author: "alice", state, base: "base", batches: "[2]", md5: "sum", meta: "{}" });
  const recoveringRoom = (state = "audit") => { const h = room(); h.r.q.mockReturnValue([row(state)]); return h; };
  it.each(["missing", "unreachable", "other", "one-time"])("selects recovery credentials: %s", async (kind) => {
    const { r, metadata } = recoveringRoom(); r.accessFor.mockResolvedValue({ problem: kind === "unreachable" ? "unreachable" : "token" });
    if (kind === "other") r.anyAccess.mockResolvedValue({ sub: "bob", token: "other" });
    const result = await original(r, "recoverSaves")(kind === "one-time" ? { sub: "bob", token: "one-time" } : undefined);
    expect(result).toBe(kind === "other" || kind === "one-time");
    if (kind === "missing") { expect(metadata.get("needCredential")).toBe("1"); expect(r.requestToken).toHaveBeenCalled(); }
    if (kind === "unreachable") expect(r.retryLater).toHaveBeenCalledWith("google-unreachable");
    if (result) expect(r.audit).toHaveBeenCalledWith("op", kind, expect.anything());
  });
  it.each(["file", "key", "revisions", "audit", "repair"])("stops an unfinished recovery on %s", async (kind) => {
    const { r } = recoveringRoom(kind === "revisions" ? "prepared" : kind === "repair" ? "repair" : "audit");
    if (kind === "file") vi.mocked(getFile).mockResolvedValue({ status: 503, problem: "unreachable" } as any);
    if (kind === "key") r.keyFrom.mockResolvedValue(null);
    if (kind === "revisions") vi.mocked(listRevisions).mockResolvedValue({ status: 503, problem: "unreachable" } as any);
    if (kind === "audit") r.audit.mockResolvedValue(false);
    if (kind === "repair") r.repairUpload.mockResolvedValue(false);
    expect(await original(r, "recoverSaves")()).toBe(false);
  });
  it("drops an upload without a matching checksum, then continues to the next saved operation", async () => {
    const { r } = room(); r.q.mockImplementation((query: string) => query.startsWith("SELECT *") ? [row("prepared"), { ...row(), op: "next" }] : []);
    vi.mocked(listRevisions).mockResolvedValue([{ id: "base" }, { id: "different", md5Checksum: "other" }] as any);
    expect(await original(r, "recoverSaves")()).toBe(true);
    expect(r.q).toHaveBeenCalledWith("DELETE FROM saves WHERE op = ?", "op"); expect(r.audit).toHaveBeenCalledOnce();
    expect(r.audit.mock.calls[0][0]).toBe("next");
  });
  it("commits the matching revision with the recorded receipts before auditing", async () => {
    const { r } = recoveringRoom("prepared"); r.pending = [batch()];
    r.q.mockReturnValue([{ ...row("prepared"), meta: JSON.stringify({ receipts: { tab: 9 }, onBehalf: ["saved"], repairOf: "repair" }) }]);
    vi.mocked(listRevisions).mockResolvedValue([{ id: "base" }, { id: "saved", md5Checksum: "sum" }] as any);
    expect(await original(r, "recoverSaves")()).toBe(true);
    expect(r.commitSave).toHaveBeenCalledWith("op", r.pending, expect.any(Map), { revision: "saved", md5: "sum" }, { tab: 9 }, ["saved"], "repair");
    expect(r.commitSave.mock.invocationCallOrder[0]).toBeLessThan(r.audit.mock.invocationCallOrder[0]);
  });
  it("propagates a malformed stored operation instead of silently finishing it", async () => {
    const { r } = recoveringRoom("prepared"); r.q.mockReturnValue([{ ...row("prepared"), batches: "bad-json" }]);
    vi.mocked(listRevisions).mockResolvedValue([{ id: "saved", md5Checksum: "sum" }] as any);
    await expect(original(r, "recoverSaves")()).rejects.toBeInstanceOf(SyntaxError); expect(r.finishSave).not.toHaveBeenCalled();
  });
});

describe("scene post-upload audit", () => {
  const revisions = [{ id: "base", keepForever: false }, { id: "foreign", keepForever: false }, { id: "ours", keepForever: false }];
  const auditingRoom = () => { const h = room(); h.r.q.mockReturnValue([{ op: "op", base: "base", rev: "ours", keys: '["file:written"]' }]); vi.mocked(listRevisions).mockResolvedValue(revisions as any); return h; };
  it("has no side effects when there is no audit row", async () => {
    const { r } = room(); expect(await original(r, "audit")("op", "token", {})).toBe(true); expect(r.releaseAuditPins).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "adjacent", "pin full", "pin transient", "pin permanent", "download transient", "download permanent", "invalid base", "no changes"])("handles audit edge: %s", async (kind) => {
    const { r } = auditingRoom();
    if (kind === "unavailable") vi.mocked(listRevisions).mockResolvedValue({ status: 503 } as any);
    if (kind === "adjacent") vi.mocked(listRevisions).mockResolvedValue([revisions[0], revisions[2]] as any);
    if (kind === "pin full") r.pinRoom.mockResolvedValue(false);
    if (kind.startsWith("pin ") && kind !== "pin full") r.dcall.mockResolvedValue({ status: 403, problem: kind === "pin transient" ? "unreachable" : "access" });
    if (kind.startsWith("download")) vi.mocked(downloadFile).mockResolvedValue({ status: 403, problem: kind === "download transient" ? "unreachable" : "access" } as any);
    if (kind === "invalid base") vi.mocked(subjectsOfFile).mockRejectedValue(new Error("invalid scene"));
    const result = await original(r, "audit")("op", "token", {});
    expect(result).toBe(!["unavailable", "pin transient", "download transient"].includes(kind));
    if (["adjacent", "invalid base", "no changes"].includes(kind)) expect(r.finishSave).toHaveBeenCalledWith("op");
    if (["pin full", "pin permanent", "download permanent"].includes(kind)) expect(r.setError).toHaveBeenCalledWith(kind === "pin full" ? "audit-pins-full" : "audit-failed");
    expect(r.commitOutside).not.toHaveBeenCalled();
  });
  it("records pins before downloading, filters already-written keys and commits a repair before uploading it", async () => {
    const { r, metadata } = auditingRoom(); const changes = [{ k: "file", id: "written" }, { k: "file", id: "outside" }]; r.diffAgainst.mockResolvedValue(changes);
    r.commitOutside.mockImplementation((entries: unknown, head: unknown, fn: () => void) => fn()); r.repairUpload.mockResolvedValue(false);
    expect(await original(r, "audit")("op", "token", {})).toBe(false);
    expect(metadata.get("auditPins")).toEqual(["base", "foreign"]); expect(r.outsideEntries).toHaveBeenCalledWith({}, [changes[1]]);
    expect(r.setMeta.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(downloadFile).mock.invocationCallOrder[0]);
    expect(r.q).toHaveBeenCalledWith("UPDATE saves SET state = 'repair' WHERE op = ?", "op");
    expect(r.commitOutside.mock.invocationCallOrder[0]).toBeLessThan(r.repairUpload.mock.invocationCallOrder[0]);
  });
});
