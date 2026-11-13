// The user's own database as a scene home (docs/homes/CONCEPT.md, "Adding
// the database home"): a scene is rows (./schema.sql), its version the
// scene's revision counter. `load` assembles the scene file from the rows
// (pictures and comments included), `save` writes a whole scene on a base
// revision; the open scene's changes stream element by element through the
// live session (./live.ts) instead.

import { commentsOf } from "../../../../scenes-mcp/sceneComments.mjs";

import type { HomeListing, MovedMark, SceneHome } from "../types";

import { asHomeError, homeError } from "./rows";
import { assembleScene, fileIndex, orderedElements, splitScene } from "./sceneJson";

import type { Role, SceneRow, SceneRows } from "./rows";
import type { SceneParts } from "./sceneJson";

export type DatabaseHome = SceneHome & {
  readonly kind: "database";
  /** the connection's id (the Supabase project ref) */
  readonly ref: string;
  /** a scene's row id by name (null: not there) */
  idOf(name: string): Promise<string | null>;
  /** a scene by its row id (the name it has now; moved: where to) */
  sceneById(id: string): Promise<SceneRow | null>;
  /** this person's role on a scene */
  roleOn(id: string): Promise<Role | null>;
  /** a scene's content by id (a link to it, a public scene) */
  loadById(id: string): Promise<{ json: string; version: string; name: string }>;
  setPublic(name: string, on: boolean): Promise<void>;
  /** the rows underneath (the live session streams through them) */
  readonly rows: SceneRows;
};

/** the elements' pictures that are in the index (the scene's pictures) */
const usedFileIds = (elements: readonly Record<string, any>[], index: Record<string, unknown>) =>
  [...new Set(elements.map((element) => element.fileId).filter((id): id is string => typeof id === "string" && id in index))];

/** what decides whether two versions of a scene are the same (pictures by id) */
const contentKey = (parts: { envelope: string; elements: readonly unknown[]; fileIds: readonly string[]; comments: readonly unknown[] }) =>
  JSON.stringify([parts.envelope, parts.elements, [...parts.fileIds].sort((a, b) => a.localeCompare(b)), commentsOf(parts.comments)]);

export const databaseHomeOf = (rows: SceneRows, { ref, label }: { ref: string; label: string }): DatabaseHome => {
  /** pictures read or written in this tab (they never change: a picture's id is its content's hash) */
  const pictures = new Map<string, string>();
  let lastListing: HomeListing | null = null;

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw asHomeError(error, label);
    }
  };

  const existing = async (name: string) => {
    const scene = await rows.sceneByName(name);
    if (!scene) {
      throw homeError(404, `Scene not found in ${label}: ${name}`);
    }
    return scene;
  };

  const picture = async (sceneId: string, fileId: string, mimeType: string) => {
    const key = `${sceneId}/${fileId}`;
    const cached = pictures.get(key);
    if (cached) {
      return cached;
    }
    const dataURL = await rows.getFile(sceneId, fileId, mimeType);
    if (dataURL) {
      pictures.set(key, dataURL);
    }
    return dataURL;
  };

  /** the scene's current parts (pictures by id only) */
  const currentParts = async (scene: SceneRow) => {
    const [elementRows, meta, comments] = await Promise.all([rows.elements(scene.id), rows.meta(scene.id), rows.comments(scene.id)]);
    const elements = orderedElements(elementRows);
    const index = meta?.files ?? {};
    return {
      envelope: meta?.envelope ?? "",
      elements,
      index,
      fileIds: usedFileIds(elements, index),
      comments: commentsOf(comments.map((row) => row.data)),
    };
  };

  const assemble = async (scene: SceneRow) => {
    const parts = await currentParts(scene);
    const files: SceneParts["files"] = {};
    for (const fileId of parts.fileIds) {
      const entry = parts.index[fileId];
      const dataURL = await picture(scene.id, fileId, entry.mimeType); // NOSONAR S9382: one at a time on purpose (pictures can be large)
      if (dataURL) {
        files[fileId] = { id: fileId, mimeType: entry.mimeType, dataURL, ...(entry.created ? { created: entry.created } : {}) };
      }
    }
    return assembleScene(parts.envelope || null, parts.elements, files, parts.comments);
  };

  /** pictures of these parts that the database doesn't have yet are uploaded */
  const uploadPictures = async (sceneId: string, files: SceneParts["files"], known: Record<string, unknown>) => {
    for (const [fileId, file] of Object.entries(files)) {
      if (!(fileId in known) && typeof file?.dataURL === "string") {
        await rows.putFile(sceneId, fileId, file.dataURL, file.mimeType); // NOSONAR S9382: one at a time on purpose (pictures can be large)
        pictures.set(`${sceneId}/${fileId}`, file.dataURL);
      }
    }
  };

  const writeWhole = async (scene: SceneRow, parts: SceneParts, base: number | null) => {
    const current = await currentParts(scene);
    if (base !== null && base !== scene.revision) {
      throw homeError(409, `"${scene.name}" was changed in ${label} meanwhile`, { remoteVersion: String(scene.revision) });
    }
    const usedIds = usedFileIds(parts.elements.filter((element) => !element.isDeleted), parts.files);
    const incoming = { envelope: parts.envelope, elements: parts.elements.filter((element) => !element.isDeleted), fileIds: usedIds, comments: parts.comments };
    if (contentKey(incoming) === contentKey(current)) {
      return { version: String(scene.revision), changed: false };
    }
    await uploadPictures(scene.id, parts.files, current.index);
    const revision = await rows.saveScene(scene.id, base, {
      elements: parts.elements,
      envelope: parts.envelope,
      files: { ...current.index, ...fileIndex(parts.files) },
      comments: commentsOf(parts.comments),
    });
    return { version: String(revision), changed: true };
  };

  const home: DatabaseHome = {
    kind: "database",
    ref,
    label,
    rows,
    capabilities: {
      sync: "realtime",
      history: true,
      filesInline: false,
      commentsInline: false,
      presence: "realtime",
      sharing: "members",
      publicLinks: true,
      guests: true,
      moveMarker: true,
      needsSignIn: true,
    },

    list: async () => {
      try {
        const scenes = await rows.scenes();
        lastListing = {
          scenes: scenes.map((scene) => ({
            name: scene.name,
            version: String(scene.revision),
            updatedAt: scene.updated_at,
            id: scene.id,
            ...(scene.public === "view" ? { public: true } : {}),
          })),
          status: { online: true, lastFetchAt: new Date().toISOString(), lastError: null },
        };
        return lastListing;
      } catch (error) {
        const homeErr = asHomeError(error, label);
        if (homeErr.offline) {
          return { scenes: lastListing?.scenes ?? [], status: { online: false, lastFetchAt: lastListing?.status.lastFetchAt ?? null, lastError: homeErr.message } };
        }
        throw homeErr;
      }
    },

    load: (name, version) =>
      call(async () => {
        const scene = await existing(name);
        if (version !== undefined && version !== String(scene.revision)) {
          const old = (await rows.versions(scene.id)).find((entry) => String(entry.revision) === version);
          const kept = old ? await rows.version(scene.id, old.id) : null;
          if (!kept) {
            throw homeError(404, `This version of "${name}" is not kept in ${label}`);
          }
          return { json: kept.snapshot, version };
        }
        return { json: await assemble(scene), version: String(scene.revision) };
      }),

    save: (name, json, base) =>
      call(async () => {
        const parts = splitScene(json);
        let scene = await rows.sceneByName(name);
        if (base === "none" && scene) {
          throw homeError(409, `A scene named "${name}" already exists in ${label}`, { exists: true, remoteVersion: String(scene.revision) });
        }
        if (!scene && base !== undefined && base !== "none") {
          throw homeError(409, `"${name}" is not in ${label} any more`, { remoteVersion: null });
        }
        scene ??= await rows.createScene(name);
        return writeWhole(scene, parts, base === undefined || base === "none" ? null : Number(base));
      }),

    remove: (name, base) =>
      call(async () => {
        const scene = await existing(name);
        if (base && base !== String(scene.revision)) {
          throw homeError(409, `"${name}" was changed in ${label} meanwhile`, { remoteVersion: String(scene.revision) });
        }
        await rows.deleteScene(scene.id);
      }),

    rename: (from, to) =>
      call(async () => {
        const scene = await existing(from);
        if (await rows.sceneByName(to)) {
          throw homeError(409, `A scene named "${to}" already exists in ${label}`, { exists: true });
        }
        await rows.renameScene(scene.id, to);
        return { version: String(scene.revision) };
      }),

    history: (name) =>
      call(async () => {
        const scene = await existing(name);
        return (await rows.versions(scene.id)).map((entry) => ({
          id: entry.id,
          at: entry.created_at,
          author: entry.created_by,
          agent: false,
          version: String(entry.revision),
        }));
      }),

    loadVersion: (name, entry) =>
      call(async () => {
        const scene = await existing(name);
        const kept = await rows.version(scene.id, entry.id);
        if (!kept) {
          throw homeError(404, `This version of "${name}" is not kept in ${label}`);
        }
        return { json: kept.snapshot, version: String(kept.revision) };
      }),

    files: {
      put: (sceneId, fileId, dataURL, mimeType) =>
        call(async () => {
          await rows.putFile(sceneId, fileId, dataURL, mimeType);
          pictures.set(`${sceneId}/${fileId}`, dataURL);
        }),
      get: (sceneId, fileId) =>
        call(async () => {
          const meta = await rows.meta(sceneId);
          const entry = meta?.files[fileId];
          const dataURL = entry ? await picture(sceneId, fileId, entry.mimeType) : null;
          return entry && dataURL ? { dataURL, mimeType: entry.mimeType } : null;
        }),
    },

    comments: {
      list: (sceneId) => call(async () => commentsOf((await rows.comments(sceneId)).map((row) => row.data))),
      write: (sceneId, comment) =>
        call(async () => {
          await rows.putComments(sceneId, [comment]);
        }),
    },

    sharing: {
      fileOf: (name) =>
        call(async () => {
          const scene = await rows.sceneByName(name);
          if (!scene) {
            return null;
          }
          const role = await rows.roleOn(scene.id);
          return { id: scene.id, canShare: role === "owner" || role === "editor", owner: null };
        }),
    },

    markMoved: (name, mark: MovedMark) =>
      call(async () => {
        const scene = await existing(name);
        await rows.markMoved(scene.id, mark);
      }),

    movedTo: (id) =>
      call(async () => {
        const scene = await rows.sceneById(id);
        return scene?.moved_to ?? null;
      }),

    idOf: (name) => call(async () => (await rows.sceneByName(name))?.id ?? null),
    sceneById: (id) => call(() => rows.sceneById(id)),
    roleOn: (id) => call(() => rows.roleOn(id)),
    loadById: (id) =>
      call(async () => {
        const scene = await rows.sceneById(id);
        if (!scene || scene.moved_to) {
          throw homeError(404, `This scene is not in ${label}${scene?.moved_to ? " any more" : ""}`);
        }
        return { json: await assemble(scene), version: String(scene.revision), name: scene.name };
      }),
    setPublic: (name, on) =>
      call(async () => {
        const scene = await existing(name);
        await rows.setPublic(scene.id, on);
      }),
  };
  return home;
};
