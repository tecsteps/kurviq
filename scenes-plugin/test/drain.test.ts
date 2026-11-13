// The retired live sync's scene objects (online/worker/scene.ts, drain.ts):
// what one still holds is saved to Drive (a new version, or a copy when
// Drive moved on), then everything is deleted; nothing else is served.
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

const drive = vi.hoisted(() => ({
  file: { status: 200, data: {} as any },
  uploads: [] as any[],
  patches: [] as any[],
  creates: [] as any[],
}));

vi.mock("../../online/worker/driveApi", () => ({
  SCENE_EXTENSION: ".excalidraw",
  getFile: async () => drive.file,
  patchFile: async (_env: unknown, _token: string, fileId: string, metadata: unknown) => {
    drive.patches.push({ fileId, metadata });
    return { status: 200, data: {}, text: "" };
  },
  uploadVersion: async (_env: unknown, token: string, fileId: string, metadata: unknown, bytes: Uint8Array) => {
    drive.uploads.push({ token, fileId, metadata, json: JSON.parse(new TextDecoder().decode(bytes)) });
    return { status: 200, data: { id: fileId, headRevisionId: "r2" }, text: "" };
  },
  multipartBody: (metadata: unknown, bytes: Uint8Array) => ({ body: { metadata, json: JSON.parse(new TextDecoder().decode(bytes)) }, contentType: "multipart/related" }),
  driveCall: async (url: string, _token: string, init: any) => {
    drive.creates.push({ url, ...init.body });
    return { status: 200, data: { id: "copy" }, text: "" };
  },
  driveUrls: () => ({ api: "https://drive.test/drive/v3", upload: "https://drive.test/upload/drive/v3" }),
  problemOf: (answer: { status: number }) => (answer.status === 403 ? "access" : "other"),
}));

import { SceneRoom } from "../../online/worker/scene";
import { buildSceneFile, decryptEntries, latestEntries } from "../../online/worker/drain";
import { importSceneKey, keyIdOf, keyProperty, newKey, toBase64 } from "../src/online/sceneKey";

const FILE = "file-aaaaaaaaaaaa";

/** the old object's SQLite (ctx.storage) on node:sqlite, with deleteAll and the alarm */
const fakeCtx = () => {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = 5;
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = db.prepare(query).all(...(bindings as any[]));
      return { toArray: () => rows };
    },
  };
  const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((row) => String(row.name));
  return {
    db,
    tables,
    alarm: () => alarm,
    ctx: {
      getWebSockets: () => [],
      storage: {
        sql,
        setAlarm: async (at: number) => {
          alarm = at;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
        deleteAll: async () => {
          for (const table of tables()) {
            db.exec(`DROP TABLE "${table}"`);
          }
        },
        list: async () => new Map(),
      },
    },
  };
};

/** an element as the old object kept it: readable part + its content encrypted with the scene key */
const entryOf = async (key: Awaited<ReturnType<typeof importSceneKey>>, el: any) => {
  const { id, version, versionNonce, isDeleted, index, ...content } = el;
  const iv = new Uint8Array(12).fill(7);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${FILE}:el:${id}:${key.keyId}`) }, key.key, new TextEncoder().encode(JSON.stringify(content))),
  );
  const c = new Uint8Array(12 + cipher.length);
  c.set(iv);
  c.set(cipher, 12);
  return {
    k: "el",
    id,
    c: toBase64(c),
    r: { id, type: el.type, version, versionNonce, isDeleted: !!isDeleted, index, boundIds: [], containerId: null, startId: null, endId: null, frameId: null, groupIds: [], fileId: null, fontFamily: null },
  };
};

const rect = (id: string, x: number, index: string) => ({ id, type: "rectangle", x, y: 0, width: 10, height: 10, version: 2, versionNonce: 3, index });

/** an old scene object: its working copy (a), a pending change (b), a stored token row */
const oldObject = async ({ pending = true } = {}) => {
  const raw = newKey();
  const keyId = await keyIdOf(raw);
  const key = await importSceneKey(raw, keyId, FILE);
  const fake = fakeCtx();
  fake.db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE batches (seq INTEGER PRIMARY KEY, tab TEXT, counter INTEGER, author TEXT, via TEXT, live INTEGER, at INTEGER, state TEXT, data TEXT);
    CREATE TABLE chunks (seq INTEGER, part INTEGER, data TEXT, PRIMARY KEY (seq, part));
    CREATE TABLE snapshot (part INTEGER PRIMARY KEY, data TEXT);
    CREATE TABLE tokens (author TEXT PRIMARY KEY, sealed TEXT, expires INTEGER);
  `);
  fake.db.prepare("INSERT INTO meta VALUES ('fileId', ?)").run(FILE);
  fake.db.prepare("INSERT INTO meta VALUES ('lastSaved', ?)").run(JSON.stringify({ revision: "r1", md5: "m1", at: 1 }));
  fake.db.prepare("INSERT INTO snapshot VALUES (0, ?)").run(JSON.stringify([await entryOf(key, rect("a", 0, "a0"))]));
  if (pending) {
    fake.db.prepare("INSERT INTO batches VALUES (1, 't', 1, 'sub-1', 'user', 1, ?, 'pending', ?)").run(Date.now(), JSON.stringify({ entries: [await entryOf(key, rect("b", 50, "a1"))] }));
  }
  fake.db.prepare("INSERT INTO tokens VALUES ('sub-1', 'sealed', ?)").run(Date.now() + 3_600_000);
  drive.file = { status: 200, data: { id: FILE, name: "Plan.excalidraw", parents: ["folder"], headRevisionId: "r1", appProperties: { kurviqKey: keyProperty(keyId, FILE, raw), kurviqSync: "do-1" } } };
  const room = new SceneRoom(fake.ctx as any, {} as any);
  return { room, fake, key };
};

const post = async (room: SceneRoom, path: string, body: unknown) => (await room.fetch(new Request(`https://scene${path}`, { method: "POST", body: JSON.stringify(body) }))).json() as Promise<any>;

beforeEach(() => {
  drive.uploads = [];
  drive.patches = [];
  drive.creates = [];
});

describe("draining an old scene object", () => {
  it("saves the unsaved change as a new Drive version (live sync's mark removed), then deletes everything", async () => {
    const { room, fake } = await oldObject();
    const answer = await post(room, "/drain", { fileId: FILE, sub: "sub-1", token: "access" });
    expect(answer).toMatchObject({ state: "drained", saved: "version", left: 0 });
    expect(drive.uploads).toHaveLength(1);
    expect(drive.uploads[0].metadata).toEqual({ appProperties: { kurviqSync: null } });
    expect(drive.uploads[0].json.elements.map((el: any) => [el.id, el.x])).toEqual([["a", 0], ["b", 50]]);
    expect(fake.tables()).toEqual([]);
    expect(fake.alarm()).toBeNull();
  });

  it("Drive moved on since the object's last save: the result goes next to it as a copy, nothing is overwritten", async () => {
    const { room, fake } = await oldObject();
    drive.file.data.headRevisionId = "someone-elses";
    const answer = await post(room, "/drain", { fileId: FILE, sub: "sub-1", token: "access" });
    expect(answer).toMatchObject({ state: "drained", saved: "copy" });
    expect(drive.uploads).toEqual([]);
    expect(drive.creates[0].metadata).toMatchObject({ name: "Plan (unsaved live changes).excalidraw", parents: ["folder"] });
    expect(drive.patches).toEqual([{ fileId: FILE, metadata: { appProperties: { kurviqSync: null } } }]);
    expect(fake.tables()).toEqual([]);
  });

  it("nothing unsaved: only the mark goes, then everything", async () => {
    const { room, fake } = await oldObject({ pending: false });
    expect(await post(room, "/drain", { fileId: FILE, sub: "sub-1", token: "access" })).toMatchObject({ state: "empty", left: 0 });
    expect(drive.uploads).toEqual([]);
    expect(drive.patches).toHaveLength(1);
    expect(fake.tables()).toEqual([]);
  });

  it("no token that works: the unsaved change is kept and tried again daily", async () => {
    const { room, fake } = await oldObject();
    drive.file = { status: 403, data: null };
    expect(await post(room, "/drain", { fileId: FILE, sub: "sub-1", token: "access" })).toMatchObject({ state: "kept", reason: "access" });
    expect(fake.tables()).toContain("batches");
    await room.alarm();
    expect(fake.alarm()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("an object that never existed stays empty: no table is created", async () => {
    const fake = fakeCtx();
    const room = new SceneRoom(fake.ctx as any, {} as any);
    expect(await post(room, "/drain", { fileId: FILE })).toMatchObject({ state: "empty", left: 0 });
    expect(fake.tables()).toEqual([]);
  });

  it("sign out everywhere drops the account's stored token; everything else is refused", async () => {
    const { room, fake } = await oldObject();
    expect(await post(room, "/forget", { sub: "sub-1" })).toEqual({ ok: true });
    expect(fake.db.prepare("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 0 });
    const refused = await room.fetch(new Request("https://scene/live"));
    expect(refused.status).toBe(410);
  });
});

describe("the drained scene file", () => {
  it("is the working copy plus the pending changes in z-order, without what doesn't decrypt", async () => {
    const raw = newKey();
    const key = await importSceneKey(raw, await keyIdOf(raw), FILE);
    const a = await entryOf(key, rect("a", 0, "a1"));
    const b = await entryOf(key, rect("b", 5, "a0"));
    const bMoved = await entryOf(key, rect("b", 9, "a0"));
    const broken = { ...(await entryOf(key, rect("x", 1, "a2"))), c: toBase64(new Uint8Array(40)) };
    const { plain, bad } = await decryptEntries(key, latestEntries([a, b] as any, [[bMoved, broken] as any]));
    expect(bad).toBe(1);
    const file = JSON.parse(buildSceneFile(plain).json);
    expect(file.elements.map((el: any) => [el.id, el.x])).toEqual([["b", 9], ["a", 0]]);
    expect(file.appState.viewBackgroundColor).toBe("#ffffff");
  });
});
