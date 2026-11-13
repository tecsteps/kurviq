// The Google Drive home: one file per scene in the user's "Kurviq" folder
// (../online/drive.ts), versions are the files' MD5s, the controller merges
// element by element. Others on the scene: the pen and its relay
// (../online/pen.ts, wired by ./live.ts).

import { driveScenes, readMovedNote, writeMovedNote } from "../online/drive";

import type { HomeError, HomeKind, MovedMark, SceneHome } from "./types";

/** Drive's errors name the version Drive has as remoteMd5: the home's word for it is remoteVersion */
export const asHomeError = (error: unknown): unknown => {
  if (error && typeof error === "object" && "remoteMd5" in error) {
    const homeError = error as HomeError & { remoteMd5?: string | null };
    homeError.remoteVersion = homeError.remoteMd5 ?? null;
  }
  return error;
};

const mapped = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw asHomeError(error);
  }
};

/** the Drive home over a Drive client with driveScenes' shape (a fake one in tests) */
const DRIVE_NOTES = { readMovedNote, writeMovedNote };

export const driveHomeOf = (scenes: Pick<typeof driveScenes, "list" | "load" | "save" | "remove" | "rename" | "history" | "loadAt" | "fileOf">, notes = DRIVE_NOTES): SceneHome => ({
  kind: "drive",
  label: "Google Drive",
  capabilities: {
    sync: "merge",
    history: true,
    filesInline: true,
    commentsInline: true,
    presence: "pen",
    sharing: "drive",
    publicLinks: true,
    guests: false,
    moveMarker: true,
    needsSignIn: true,
  },

  list: (refresh = false) =>
    mapped(async () => {
      const { scenes: files, remote } = await scenes.list(refresh);
      return {
        scenes: files.map((file) => ({ name: file.name, version: file.md5, updatedAt: file.updatedAt, ...(file.public ? { public: true } : {}), ...(file.fileId ? { id: file.fileId } : {}) })),
        status: { online: remote.online, lastFetchAt: remote.lastFetchAt, lastError: remote.lastError, readOnly: remote.readOnly ?? null },
      };
    }),

  load: (name, version) =>
    mapped(async () => {
      const { json, md5 } = await scenes.load(name, version);
      return { json, version: md5 };
    }),

  save: (name, json, base, source) =>
    mapped(async () => {
      const { md5, changed } = await scenes.save(name, json, base, source);
      return { version: md5, changed };
    }),

  remove: (name, base) =>
    mapped(async () => {
      await scenes.remove(name, base);
    }),

  rename: (from, to) =>
    mapped(async () => {
      const { md5 } = await scenes.rename(from, to);
      return { version: md5 };
    }),

  history: (name) =>
    mapped(async () =>
      (await scenes.history(name)).map((entry) => ({
        id: entry.driveRevision,
        at: entry.at,
        author: entry.author,
        agent: entry.agent,
        ...(entry.md5 ? { version: entry.md5 } : {}),
      })),
    ),

  loadVersion: (name, entry) =>
    mapped(async () => {
      const { json, md5 } = await scenes.loadAt(name, entry.id);
      return { json, version: md5 };
    }),

  sharing: { fileOf: (name) => mapped(() => scenes.fileOf(name)) },

  markMoved: (name, mark: MovedMark) =>
    mapped(async () => {
      const file = await scenes.fileOf(name);
      if (!file) {
        throw Object.assign(new Error(`Scene not found: ${name}`), { status: 404 });
      }
      await notes.writeMovedNote(file.id, mark.home, mark.link);
    }),

  movedTo: (fileId) =>
    mapped(async () => {
      const note = await notes.readMovedNote(fileId);
      return note ? { home: note.home as HomeKind, link: note.link, at: note.at ?? "" } : null;
    }),
});

export const driveHome = driveHomeOf(driveScenes);
