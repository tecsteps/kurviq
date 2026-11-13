// An in-memory database for the database home (src/homes/database/rows.ts
// SceneRows) with the rules of schema.sql: a revision per scene bumped by
// every content write, the newer element version wins, a whole save only on
// its base revision (P0409), unique live names (23505), moved scenes hidden.
import { isNewer } from "../src/homes/database/changes";

import type { CommentRow, Role, SceneRow, SceneRows } from "../src/homes/database/rows";
import type { ElementRow, FileEntry } from "../src/homes/database/sceneJson";

type Scene = SceneRow & {
  elements: Map<string, ElementRow>;
  meta: { envelope: string; files: Record<string, FileEntry>; rev: number } | null;
  comments: Map<string, CommentRow>;
  files: Map<string, string>;
  versions: { id: string; revision: number; snapshot: string; created_at: string }[];
};

const pgError = (code: string, message: string, details?: string) => Object.assign(new Error(message), { code, details, status: 400 });

export const fakeSceneRows = ({ role = "owner" as Role | null } = {}) => {
  const scenes = new Map<string, Scene>();
  let ids = 0;
  const live = () => [...scenes.values()].filter((scene) => !scene.moved_to);
  const scene = (id: string) => {
    const found = scenes.get(id);
    if (!found) {
      throw pgError("P0002", "Scene not found");
    }
    return found;
  };
  const row = ({ id, name, public: shared, revision, updated_at, moved_to }: Scene): SceneRow => ({ id, name, public: shared, revision, updated_at, ...(moved_to ? { moved_to } : {}) });
  const bump = (target: Scene) => {
    target.revision++;
    return target.revision;
  };
  const refuseUnlessEditor = () => {
    if (role !== "owner" && role !== "editor") {
      throw pgError("42501", 'new row violates row-level security policy for table "kurviq_elements"');
    }
  };
  const putElement = (target: Scene, element: Record<string, any>, pos: number, whole: boolean) => {
    const known = target.elements.get(element.id);
    const incoming = { version: element.version ?? 1, versionNonce: element.versionNonce ?? 0 };
    let data = element;
    if (known && !isNewer(incoming, { version: known.version, versionNonce: known.version_nonce })) {
      if (!whole || (JSON.stringify(known.data) === JSON.stringify(element) && known.pos === pos)) {
        return;
      }
      incoming.version = known.version + 1; // a whole save is taken anyway, as a newer version
      data = { ...element, version: incoming.version };
    }
    target.elements.set(element.id, { id: element.id, version: incoming.version, version_nonce: incoming.versionNonce, pos, data, rev: bump(target) });
  };
  const calls = {
    scenes: () => live().map(row),
    sceneByName: (name) => {
      const found = live().find((entry) => entry.name === name);
      return found ? row(found) : null;
    },
    sceneById: (id) => (scenes.has(id) ? row(scenes.get(id)!) : null),
    createScene: (name) => {
      refuseUnlessEditor();
      if (live().some((entry) => entry.name === name)) {
        throw pgError("23505", "duplicate key value violates unique constraint");
      }
      const id = `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
      const created: Scene = { id, name, public: "none", revision: 1, updated_at: "2026-11-13T10:00:00Z", elements: new Map(), meta: null, comments: new Map(), files: new Map(), versions: [] };
      scenes.set(id, created);
      return row(created);
    },
    renameScene: (id, to) => {
      if (live().some((entry) => entry.name === to)) {
        throw pgError("23505", "duplicate key value violates unique constraint");
      }
      scene(id).name = to;
    },
    deleteScene: (id) => {
      scene(id);
      scenes.delete(id);
    },
    setPublic: (id, on) => {
      scene(id).public = on ? "view" : "none";
    },
    markMoved: (id, mark) => {
      scene(id).moved_to = mark;
    },
    elements: (id, since) => [...scene(id).elements.values()].filter((element) => since === undefined || (element.rev ?? 0) > since).map((element) => structuredClone(element)),
    meta: (id) => structuredClone(scene(id).meta),
    comments: (id, since) => [...scene(id).comments.values()].filter((comment) => since === undefined || comment.rev > since).map((comment) => structuredClone(comment)),
    saveScene: (id, base, whole) => {
      refuseUnlessEditor();
      const target = scene(id);
      if (base !== null && base !== target.revision) {
        throw pgError("P0409", "The scene was changed meanwhile", String(target.revision));
      }
      const listed = new Set(whole.elements.map((element) => element.id));
      for (const known of target.elements.values()) {
        if (!listed.has(known.id) && !known.data.isDeleted) {
          putElement(target, { ...known.data, isDeleted: true, version: known.version + 1 }, known.pos, true);
        }
      }
      whole.elements.forEach((element, index) => putElement(target, structuredClone(element), index + 1, true));
      target.meta = { envelope: whole.envelope, files: { ...whole.files }, rev: bump(target) };
      for (const comment of whole.comments as Record<string, any>[]) {
        target.comments.set(comment.id, { id: comment.id, data: comment, rev: bump(target) });
      }
      return target.revision;
    },
    putElements: (id, elements) => {
      refuseUnlessEditor();
      const target = scene(id);
      for (const element of elements) {
        putElement(target, structuredClone(element), target.elements.get(element.id)?.pos ?? target.elements.size + 1, false);
      }
      return target.revision;
    },
    putComments: (id, comments) => {
      const target = scene(id);
      for (const comment of comments as Record<string, any>[]) {
        const known = target.comments.get(comment.id);
        if (!known || (known.data.u ?? 0) < comment.u) {
          target.comments.set(comment.id, { id: comment.id, data: comment, rev: bump(target) });
        }
      }
      return target.revision;
    },
    putMeta: (id, envelope, files) => {
      const target = scene(id);
      target.meta = { envelope: envelope ?? target.meta?.envelope ?? "{}", files: { ...target.meta?.files, ...files }, rev: bump(target) };
      return target.revision;
    },
    putFile: (id, fileId, dataURL) => {
      scene(id).files.set(fileId, dataURL);
    },
    getFile: (id, fileId) => scene(id).files.get(fileId) ?? null,
    versions: (id) => scene(id).versions.map(({ id: versionId, revision, created_at }) => ({ id: versionId, revision, name: null, created_by: null, created_at })),
    version: (id, versionId) => scene(id).versions.find((entry) => entry.id === versionId) ?? null,
    addVersion: (id, revision, snapshot) => {
      scene(id).versions.unshift({ id: `v${scene(id).versions.length + 1}`, revision, snapshot, created_at: "2026-11-13T11:00:00Z" });
    },
    roleOn: () => role,
  };
  // each call answers later, as the database does (a throw: a rejected promise)
  const rows = Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, (...args: unknown[]) => Promise.resolve().then(() => (call as (...params: unknown[]) => unknown)(...args))])) as unknown as SceneRows;
  return { rows, scenes };
};
