// Browser-side persistence for scenes — the source of truth, works offline.
//
// The *active* scene keeps living in Excalidraw's regular localStorage keys
// (the app saves it as usual). We add:
//  - a metadata record in localStorage: which scene is active, and per scene
//    the Drive version it is based on, dirty flag, sync settings, conflicts
//  - snapshots of inactive scenes in IndexedDB (incl. image files, which
//    would quickly blow the localStorage quota)

import { createStore, del, delMany, entries, get, set } from "idb-keyval";

// Kurviq: each space keeps its own scenes in the browser. "" is the user's
// own scenes (their Kurviq folder in Google Drive); "f:<fileId>" is a scene
// someone shared (one Drive file). Older spaces (Drive accounts) are left.
export const SPACE_KEY = "kurviq-space";
export const currentSpace = (() => {
  try {
    const space = localStorage.getItem(SPACE_KEY) || "";
    if (space && !/^f:[\w-]{10,200}$/.test(space)) {
      localStorage.removeItem(SPACE_KEY);
      return "";
    }
    return space;
  } catch {
    return "";
  }
})();
/** suffix of this space's storage keys */
export const spaceSuffix = (space: string) => (space ? `@${space}` : "");

export const META_KEY = `excalidraw-scenes${spaceSuffix(currentSpace)}`;
const snapshotStore = createStore(`excalidraw-scenes-db${spaceSuffix(currentSpace)}`, "snapshots");

/** key used for the scene that has not been named / saved yet */
export const UNTITLED = "\u0000untitled";

export type SceneMeta = {
  /** version in Drive (MD5 of the content) the local copy is based on; null = never saved there */
  baseSha: string | null;
  /** last seen version in Drive (null = not in Drive) — for status while offline */
  remoteSha?: string | null;
  /** local changes not pushed yet (for the active scene this is live state) */
  dirty: boolean;
  /** per-scene override of the global auto-sync switch */
  autoSync?: boolean;
  /**
   * kept only in this browser: never pushed or pulled (a copy that is in
   * Drive already stays there unchanged); syncing can be turned on later
   */
  localOnly?: boolean;
  /** both sides changed the same elements — waits for the user */
  conflict?: {
    remoteSha: string;
    clashes: string[];
    /** merge algorithm that found it (older ones are re-checked) */
    v?: number;
  };
  /** pre-sync-engine metadata, resolved on the first remote listing */
  legacy?: boolean;
  /**
   * put in Drive by the user (no longer local only) and not there yet:
   * uploaded once even without local changes (a copy Drive has wins)
   */
  adopt?: boolean;
  /** made while signed out: offered (ticked) for Drive at the next sign-in */
  moveOnSignIn?: boolean;
  /** the user kept it in this browser when asked at sign-in: not offered again */
  keptLocal?: boolean;
  /** renamed locally, the rename in Drive is still pending (old name) */
  renamedFrom?: string;
  /**
   * saves through its Durable Object (live sync, the ticket said so): the
   * controller never pushes, pulls or merges it; its Drive file
   */
  live?: { fileId: string };
  /** legacy field */
  inRepo?: boolean;
};

export type ScenesMeta = {
  /** active scene; null = untitled */
  current: string | null;
  /** hash of the active scene's base version, to detect local changes */
  baseline: number | null;
  /** global auto-sync switch (default on) */
  autoSync: boolean;
  /** while signed in: new scenes start local only (default off: they go to Drive) */
  newLocalOnly?: boolean;
  /** same element changed on both sides: newest edit wins (default) or ask */
  clashes?: "newest" | "ask";
  scenes: Record<string, SceneMeta>;
  /**
   * deleted locally, the delete in Drive is still pending (offline):
   * name -> the Drive version that was deleted (only that one gets deleted)
   */
  pendingDeletes: Record<string, string>;
};

export type Snapshot = {
  /** serialized .excalidraw JSON (incl. files) */
  json: string;
  /** hash of the base version (to compute dirty) */
  baseline: number | null;
  dirty: boolean;
};

export const loadMeta = (): ScenesMeta => {
  const fallback: ScenesMeta = {
    current: null,
    baseline: null,
    autoSync: true,
    scenes: {},
    pendingDeletes: {},
  };
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) {
      const meta: ScenesMeta = { ...fallback, ...JSON.parse(raw) };
      for (const scene of Object.values(meta.scenes)) {
        if (scene.baseSha === undefined) {
          scene.baseSha = null;
          scene.legacy = true;
        }
      }
      return meta;
    }
  } catch (error) {
    console.error(error);
  }
  return fallback;
};

export const saveMeta = (meta: ScenesMeta) => {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (error) {
    console.error(error);
  }
};

const snapshotKey = (name: string | null) => name ?? UNTITLED;

export const getSnapshot = (name: string | null) =>
  get<Snapshot>(snapshotKey(name), snapshotStore);

export const setSnapshot = (name: string | null, snapshot: Snapshot) =>
  set(snapshotKey(name), snapshot, snapshotStore);

export const deleteSnapshot = (name: string | null) =>
  del(snapshotKey(name), snapshotStore);

// -----------------------------------------------------------------------------
// agent support data — kept in the browser too, so the server side stays
// stateless
// -----------------------------------------------------------------------------

const agentStore = createStore(`excalidraw-scenes-agent${spaceSuffix(currentSpace)}`, "data");

/** what the canvas looked like when an agent last read / edited it */
export type AgentBaseline = { at: string; action: string; elements: unknown[] };

const baselineKey = (name: string | null) => `baseline:${name ?? UNTITLED}`;

export const getAgentBaseline = (name: string | null) =>
  get<AgentBaseline>(baselineKey(name), agentStore);

export const setAgentBaseline = (name: string | null, baseline: AgentBaseline) =>
  set(baselineKey(name), baseline, agentStore);

export const deleteAgentBaseline = (name: string | null) =>
  del(baselineKey(name), agentStore);

export const moveAgentBaseline = async (from: string, to: string) => {
  const baseline = await getAgentBaseline(from);
  await deleteAgentBaseline(to);
  if (baseline) {
    await setAgentBaseline(to, baseline);
    await deleteAgentBaseline(from);
  }
};

/** create_view checkpoints (agent drafts); the oldest are dropped */
const MAX_CHECKPOINTS = 200;
const checkpointKey = (id: string) => `checkpoint:${id}`;

export const getCheckpoint = (id: string) =>
  get<{ at: number; data: unknown }>(checkpointKey(id), agentStore).then((entry) => entry?.data ?? null);

export const setCheckpoint = async (id: string, data: unknown) => {
  await set(checkpointKey(id), { at: Date.now(), data }, agentStore);
  const all = (await entries<string, { at: number }>(agentStore)).filter(([key]) =>
    String(key).startsWith("checkpoint:"),
  );
  if (all.length > MAX_CHECKPOINTS) {
    all.sort((a, b) => a[1].at - b[1].at);
    await delMany(
      all.slice(0, all.length - MAX_CHECKPOINTS).map(([key]) => key),
      agentStore,
    );
  }
};
