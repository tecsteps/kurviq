// The "this browser only" home: a scene kept only here (local only), in the
// scenes controller's own store (IndexedDB snapshots, ../storage.ts). It is
// the only copy, so there is nothing to sync; its version is the MD5 of the
// content (as in Drive), so a "Move to…" can still check it didn't change
// meanwhile.

import { md5 } from "../online/md5";

import type { HomeError, SceneHome } from "./types";

/** the scenes kept only in this browser (the controller implements it) */
export interface LocalSceneStore {
  /** the local-only scenes' names */
  names(): string[];
  /** a local-only scene's content (null: no such scene) */
  read(name: string): Promise<string | null>;
  /** store a local-only scene's content (a new one is created) */
  write(name: string, json: string): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const homeError = (status: number, message: string, extra: Partial<HomeError> = {}) =>
  Object.assign(new Error(message), { status, ...extra }) as HomeError;

export const browserHomeOf = (store: LocalSceneStore): SceneHome => {
  const versionOf = (json: string) => md5(new TextEncoder().encode(json));
  const existing = async (name: string) => {
    const json = await store.read(name);
    if (json === null) {
      throw homeError(404, `Scene not found: ${name}`);
    }
    return json;
  };
  return {
    kind: "browser",
    label: "This browser",
    capabilities: {
      sync: "none",
      history: false,
      filesInline: true,
      commentsInline: true,
      presence: "none",
      sharing: "none",
      publicLinks: false,
      guests: false,
      moveMarker: false,
      needsSignIn: false,
    },

    list: async () => {
      const names = store.names();
      const scenes = [];
      for (const name of names) {
        const json = await store.read(name); // NOSONAR S9382: one at a time on purpose (a scene can be many MB)
        if (json !== null) {
          scenes.push({ name, version: versionOf(json), updatedAt: null });
        }
      }
      return { scenes, status: { online: true, lastFetchAt: null, lastError: null } };
    },

    load: async (name, version) => {
      const json = await existing(name);
      if (version !== undefined && versionOf(json) !== version) {
        throw homeError(404, `This version of "${name}" is not kept in this browser`);
      }
      return { json, version: versionOf(json) };
    },

    save: async (name, json, base) => {
      const current = await store.read(name);
      if (base === "none" && current !== null) {
        throw homeError(409, `A scene named "${name}" already exists in this browser`, { exists: true, remoteVersion: versionOf(current) });
      }
      if (base !== undefined && base !== "none" && (current === null || versionOf(current) !== base)) {
        throw homeError(409, `"${name}" was changed in this browser in the meantime`, { remoteVersion: current === null ? null : versionOf(current) });
      }
      if (current === json) {
        return { version: versionOf(json), changed: false };
      }
      await store.write(name, json);
      return { version: versionOf(json), changed: true };
    },

    remove: async (name, base) => {
      const json = await existing(name);
      if (base && versionOf(json) !== base) {
        throw homeError(409, `"${name}" was changed in this browser in the meantime`, { remoteVersion: versionOf(json) });
      }
      await store.remove(name);
    },

    rename: async (from, to) => {
      const json = await existing(from);
      if ((await store.read(to)) !== null) {
        throw homeError(409, `A scene named "${to}" already exists in this browser`, { exists: true });
      }
      await store.rename(from, to);
      return { version: versionOf(json) };
    },
  };
};
