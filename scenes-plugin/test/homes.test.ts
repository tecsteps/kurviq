// Scene homes (src/homes): the interface's contract, kept by the browser home
// and the Drive home (docs/homes/CONCEPT.md).
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/online/drive", () => ({ driveScenes: {}, readMovedNote: vi.fn(), writeMovedNote: vi.fn() }));

const { browserHomeOf } = await import("../src/homes/browser");
const { asHomeError, driveHomeOf } = await import("../src/homes/drive");

import type { SceneHome } from "../src/homes/types";

const json = (name: string, ids: string[]) => JSON.stringify({ type: "excalidraw", elements: ids.map((id) => ({ id })), appState: { name } });

/** what every home has to do the same way (the contract in docs/homes/CONCEPT.md) */
const contract = (label: string, make: () => SceneHome) => {
  describe(`${label}: the SceneHome contract`, () => {
    it("save new (base none), load, list", async () => {
      const home = make();
      const saved = await home.save("Plan", json("Plan", ["a"]), "none");
      expect(saved.changed).toBe(true);
      const loaded = await home.load("Plan");
      expect(loaded).toEqual({ json: json("Plan", ["a"]), version: saved.version });
      expect((await home.list()).scenes.map((scene) => [scene.name, scene.version])).toEqual([["Plan", saved.version]]);
    });

    it("a save on an old base is refused with 409 and the home's version", async () => {
      const home = make();
      const first = await home.save("Plan", json("Plan", ["a"]), "none");
      const second = await home.save("Plan", json("Plan", ["a", "b"]), first.version);
      await expect(home.save("Plan", json("Plan", ["c"]), first.version)).rejects.toMatchObject({ status: 409, remoteVersion: second.version });
      await expect(home.save("Plan", json("Plan", ["c"]), "none")).rejects.toMatchObject({ status: 409 });
    });

    it("the same content again is no change; load of a missing scene is 404", async () => {
      const home = make();
      const first = await home.save("Plan", json("Plan", ["a"]), "none");
      expect(await home.save("Plan", json("Plan", ["a"]), first.version)).toEqual({ version: first.version, changed: false });
      await expect(home.load("Nope")).rejects.toMatchObject({ status: 404 });
    });

    it("remove only the known version; rename keeps the version, refuses a taken name", async () => {
      const home = make();
      const plan = await home.save("Plan", json("Plan", ["a"]), "none");
      await home.save("Other", json("Other", ["o"]), "none");
      await expect(home.rename("Plan", "Other")).rejects.toMatchObject({ status: 409, exists: true });
      const renamed = await home.rename("Plan", "Plan 2");
      expect(renamed.version).toBe(plan.version);
      await expect(home.remove("Plan 2", "stale")).rejects.toMatchObject({ status: 409 });
      await home.remove("Plan 2", plan.version);
      await expect(home.load("Plan 2")).rejects.toMatchObject({ status: 404 });
    });
  });
};

// ---------------------------------------------------------------------------
// the browser home over a store like the controller's
// ---------------------------------------------------------------------------

const memoryStore = () => {
  const scenes = new Map<string, string>();
  return {
    scenes,
    names: () => [...scenes.keys()],
    read: async (name: string) => scenes.get(name) ?? null,
    write: async (name: string, content: string) => void scenes.set(name, content),
    remove: async (name: string) => void scenes.delete(name),
    rename: async (from: string, to: string) => {
      scenes.set(to, scenes.get(from)!);
      scenes.delete(from);
    },
  };
};

contract("this browser", () => browserHomeOf(memoryStore()));

describe("the browser home", () => {
  it("is the only copy: no sync, no history, no sharing", () => {
    const home = browserHomeOf(memoryStore());
    expect(home.kind).toBe("browser");
    expect(home.capabilities).toMatchObject({ sync: "none", history: false, sharing: "none", presence: "none", needsSignIn: false });
    expect(home.history).toBeUndefined();
  });

  it("its versions are the content's MD5 (as Drive's)", async () => {
    const home = browserHomeOf(memoryStore());
    const { version } = await home.save("Plan", "{}", "none");
    expect(version).toBe("99914b932bd37a50b983c5e7c90ae93b");
    await expect(home.load("Plan", "other")).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// the Drive home over a fake Drive client (driveScenes' shape)
// ---------------------------------------------------------------------------

const fakeDriveScenes = () => {
  const files = new Map<string, { id: string; json: string; md5: string; revisions: Map<string, string> }>();
  let ids = 0;
  const md5Of = (text: string) => `md5-${text.length}-${[...text].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003, 7)}`;
  const failure = (status: number, message: string, extra = {}) => Object.assign(new Error(message), { status, ...extra });
  return {
    files,
    list: async () => ({
      scenes: [...files].map(([name, file]) => ({ name, md5: file.md5, updatedAt: "2026-11-13T10:00:00Z", fileId: file.id, public: name === "Public" })),
      remote: { online: true, lastFetchAt: "2026-11-13T10:00:00Z", lastError: null },
    }),
    load: async (name: string, checksum?: string) => {
      const file = files.get(name);
      if (!file) throw failure(404, "not found");
      return { json: checksum ? file.revisions.get(checksum)! : file.json, md5: checksum ?? file.md5 };
    },
    save: async (name: string, given: string, baseMd5?: string) => {
      const file = files.get(name);
      if ((baseMd5 === "none" && file) || (baseMd5 && baseMd5 !== "none" && baseMd5 !== file?.md5)) {
        throw failure(409, "changed meanwhile", { remoteMd5: file?.md5 ?? null });
      }
      const md5 = md5Of(given);
      if (file?.md5 === md5) return { md5, driveRevision: null, changed: false };
      const revisions = file?.revisions ?? new Map();
      revisions.set(md5, given);
      files.set(name, { id: file?.id ?? `id-${++ids}`, json: given, md5, revisions });
      return { md5, driveRevision: `rev-${revisions.size}`, changed: true };
    },
    remove: async (name: string, baseMd5?: string | null) => {
      const file = files.get(name);
      if (!file) throw failure(404, "not found");
      if (baseMd5 && baseMd5 !== file.md5) throw failure(409, "changed", { remoteMd5: file.md5 });
      files.delete(name);
      return { md5: null };
    },
    rename: async (from: string, to: string) => {
      const file = files.get(from);
      if (!file) throw failure(404, "not found");
      if (files.has(to)) throw failure(409, "exists", { exists: true });
      files.delete(from);
      files.set(to, file);
      return { md5: file.md5, driveRevision: null };
    },
    history: async (name: string) => [{ driveRevision: "rev-1", at: "2026-11-13T09:00:00Z", author: "Ann", agent: true, md5: files.get(name)!.md5 }],
    loadAt: async (name: string, revision: string) => ({ json: `${name}@${revision}`, md5: "old" }),
    fileOf: async (name: string) => (files.has(name) ? { id: files.get(name)!.id, canShare: true, owner: null } : null),
  };
};

contract("Google Drive", () => driveHomeOf(fakeDriveScenes() as any));

describe("the Drive home", () => {
  it("lists Drive's files with their ids, public flag and the connection state", async () => {
    const scenes = fakeDriveScenes();
    const home = driveHomeOf(scenes as any);
    await home.save("Public", "{}", "none");
    const listing = await home.list();
    expect(listing.scenes).toEqual([{ name: "Public", version: scenes.files.get("Public")!.md5, updatedAt: "2026-11-13T10:00:00Z", public: true, id: "id-1" }]);
    expect(listing.status).toEqual({ online: true, lastFetchAt: "2026-11-13T10:00:00Z", lastError: null, readOnly: null });
    expect(home.capabilities).toMatchObject({ sync: "merge", history: true, presence: "pen", sharing: "drive", moveMarker: true });
  });

  it("history entries carry Drive's revision as their id, and load through it", async () => {
    const home = driveHomeOf(fakeDriveScenes() as any);
    await home.save("Plan", "{}", "none");
    const [entry] = await home.history!("Plan");
    expect(entry).toMatchObject({ id: "rev-1", author: "Ann", agent: true });
    expect((await home.loadVersion!("Plan", entry)).json).toBe("Plan@rev-1");
  });

  it("the moved note goes on the scene's file, and is read back", async () => {
    const notes = { writeMovedNote: vi.fn(async () => {}), readMovedNote: vi.fn(async () => ({ home: "database", link: "https://kurviq.com/db/p/1", at: "2026-11-13T10:00:00Z" })) };
    const home = driveHomeOf(fakeDriveScenes() as any, notes as any);
    await home.save("Plan", "{}", "none");
    await home.markMoved!("Plan", { home: "database", link: "https://kurviq.com/db/p/1", at: "now" });
    expect(notes.writeMovedNote).toHaveBeenCalledWith("id-1", "database", "https://kurviq.com/db/p/1");
    expect(await home.movedTo!("id-1")).toEqual({ home: "database", link: "https://kurviq.com/db/p/1", at: "2026-11-13T10:00:00Z" });
    await expect(home.markMoved!("Nope", { home: "browser", link: "https://kurviq.com/x", at: "now" })).rejects.toMatchObject({ status: 404 });
  });

  it("Drive's remoteMd5 is the home's remoteVersion; other errors pass unchanged", () => {
    const conflict = asHomeError(Object.assign(new Error("changed"), { status: 409, remoteMd5: "abc" })) as any;
    expect(conflict.remoteVersion).toBe("abc");
    const offline = Object.assign(new Error("offline"), { status: 0, offline: true });
    expect(asHomeError(offline)).toBe(offline);
  });
});
