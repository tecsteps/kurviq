// Browser-side persistence for scenes: the source of truth, works offline.
//
// The *active* scene keeps living in Excalidraw's regular localStorage keys
// (the app saves it as usual). We add:
//  - a metadata record in localStorage: which scene is active, and per scene
//    the Drive version it is based on, dirty flag, sync settings, conflicts
//  - snapshots of inactive scenes in IndexedDB (incl. image files, which
//    would quickly blow the localStorage quota)

import { clear, createStore, del, get, keys, set } from "idb-keyval";

import { boundedStore } from "./boundedStore";

import { mergeSpaceMeta, OWN_SPACE_KEY, pickSpace, SPACE_KEY, spaceSuffix, UNTITLED } from "./spaces";

// Kurviq: each space keeps its own scenes in the browser (see ./spaces.ts):
// "" the scenes made signed out, "a:<email>" an account's own scenes,
// "f:<fileId>" a scene someone shared. Spaces of older versions (one per
// repository, before Drive) are not opened any more; their data in the
// browser is left as it is.
export { SPACE_KEY };
export const currentSpace = (() => {
  try {
    const shared = localStorage.getItem(SPACE_KEY);
    const space = pickSpace(shared, localStorage.getItem(OWN_SPACE_KEY));
    if (shared && space !== shared) {
      localStorage.removeItem(SPACE_KEY);
    }
    return space;
  } catch {
    return "";
  }
})();

const metaKeyOf = (space: string) => `excalidraw-scenes${spaceSuffix(space)}`;
const snapshotStoreOf = (space: string) => createStore(`excalidraw-scenes-db${spaceSuffix(space)}`, "snapshots");
const agentStoreOf = (space: string) => createStore(`excalidraw-scenes-agent${spaceSuffix(space)}`, "data");

export const META_KEY = metaKeyOf(currentSpace);

/** the named scenes of a stored scene list (raw localStorage value), for listing them from another space */
export type HomeScene = { name: string; localOnly: boolean; inDrive: boolean };
export const scenesOfMeta = (raw: string | null): HomeScene[] => {
  try {
    const scenes = JSON.parse(raw || "{}")?.scenes;
    if (!scenes || typeof scenes !== "object") {
      return [];
    }
    return Object.entries(scenes as Record<string, Partial<SceneMeta> | null>)
      .filter(([name, meta]) => name !== UNTITLED && !!meta && typeof meta === "object")
      .map(([name, meta]) => ({ name, localOnly: !!meta!.localOnly, inDrive: !!meta!.baseMd5 }));
  } catch {
    return [];
  }
};

/** the user's own scenes (their account's space), seen from a shared folder's tab */
export const ownSceneList = (): HomeScene[] => {
  try {
    const own = localStorage.getItem(OWN_SPACE_KEY);
    return own === null ? [] : scenesOfMeta(localStorage.getItem(metaKeyOf(own)));
  } catch {
    return [];
  }
};
const snapshotStore = snapshotStoreOf(currentSpace);

export type SceneMeta = {
  /** Immediate reload recovery for app state fields filtered by Excalidraw. */
  kurviqPresentation?: boolean;
  kurviqPresentationAt?: number;
  /** version in Drive (MD5 of the content) the local copy is based on; null = never saved there */
  baseMd5: string | null;
  /** last seen version in Drive (null = not in Drive), for status while offline */
  remoteMd5?: string | null;
  /** local changes not pushed yet (for the active scene this is live state) */
  dirty: boolean;
  /** per-scene override of the global auto-sync switch */
  autoSync?: boolean;
  /**
   * kept only in this browser: never pushed or pulled (a copy that is in
   * Drive already stays there unchanged); syncing can be turned on later
   */
  localOnly?: boolean;
  /** both sides changed the same elements: waits for the user */
  conflict?: {
    remoteMd5: string;
    clashes: string[];
    /** merge algorithm that found it (older ones are re-checked) */
    v?: number;
  };
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
  /** the retired live sync's mark (metadata of older versions; ignored) */
  live?: { fileId: string };
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

/**
 * Metadata written before the Drive versions were renamed (baseSha →
 * baseMd5, remoteSha → remoteMd5, conflict.remoteSha → conflict.remoteMd5):
 * moved to the new names in place, so the scenes keep their sync state.
 * Returns whether anything changed (the caller writes it back).
 */
const migrateSceneMeta = (scene: Record<string, any>) => {
  let changed = false;
  if ("baseSha" in scene) {
    if (scene.baseMd5 === undefined) {
      scene.baseMd5 = scene.baseSha;
    }
    delete scene.baseSha;
    changed = true;
  }
  if ("remoteSha" in scene) {
    if (scene.remoteMd5 === undefined) {
      scene.remoteMd5 = scene.remoteSha;
    }
    delete scene.remoteSha;
    changed = true;
  }
  if (scene.conflict && typeof scene.conflict === "object" && "remoteSha" in scene.conflict) {
    if (scene.conflict.remoteMd5 === undefined) {
      scene.conflict.remoteMd5 = scene.conflict.remoteSha;
    }
    delete scene.conflict.remoteSha;
    changed = true;
  }
  return changed;
};

export const migrateMeta = (meta: { scenes?: Record<string, unknown> }) => {
  let changed = false;
  for (const scene of Object.values(meta.scenes ?? {}) as Record<string, any>[]) {
    if (!scene || typeof scene !== "object") {
      continue;
    }
    if (migrateSceneMeta(scene)) changed = true;
  }
  return changed;
};

/**
 * A record of names → values without a prototype: a scene named
 * "constructor" or "toString" is just a name (no inherited property answers
 * for it)
 */
const byName = <T>(entries: Record<string, T> | undefined | null): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, entries ?? {});

export const loadMeta = (key = META_KEY): ScenesMeta => {
  const fallback: ScenesMeta = {
    current: null,
    baseline: null,
    autoSync: true,
    scenes: byName<SceneMeta>({}),
    pendingDeletes: byName<string>({}),
  };
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const meta: ScenesMeta = { ...fallback, ...parsed, scenes: byName(parsed.scenes), pendingDeletes: byName(parsed.pendingDeletes) };
      let dropped = false;
      for (const [name, scene] of Object.entries(meta.scenes)) {
        if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
          delete meta.scenes[name];
          dropped = true;
        }
      }
      const migrated = migrateMeta(meta);
      if (migrated || dropped) {
        saveMeta(meta, key);
      }
      for (const scene of Object.values(meta.scenes)) {
        scene.baseMd5 ??= null; // (records of the first versions had none)
      }
      return meta;
    }
  } catch (error) {
    console.error(error);
  }
  return fallback;
};

/** store the scene metadata (a full storage: logged, the tab keeps working with what it has) */
export const saveMeta = (meta: ScenesMeta, key = META_KEY) => {
  try {
    writeMeta(meta, key);
  } catch (error) {
    console.error(error);
  }
};

/** store the scene metadata; throws if the browser refuses (e.g. its storage is full) */
const writeMeta = (meta: ScenesMeta, key: string) => {
  localStorage.setItem(key, JSON.stringify(meta));
};

const snapshotKey = (name: string | null) => name ?? UNTITLED;

export const getSnapshot = (name: string | null) =>
  get<Snapshot>(snapshotKey(name), snapshotStore);

export const setSnapshot = (name: string | null, snapshot: Snapshot) =>
  set(snapshotKey(name), snapshot, snapshotStore);

export const deleteSnapshot = (name: string | null) =>
  del(snapshotKey(name), snapshotStore);

// -----------------------------------------------------------------------------
// agent support data: kept in the browser too, so the server side stays
// stateless
// -----------------------------------------------------------------------------

const agentStore = agentStoreOf(currentSpace);

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

/** create_view checkpoints (agent drafts) and live revisions; the oldest are dropped */
const MAX_CHECKPOINTS = 200;
/** a live scene's revisions ("live-rev:<fileId>:…") are whole scenes, pictures included: a few per scene */
const MAX_LIVE_REVISIONS = 12;
const checkpointKey = (id: string) => `checkpoint:${id}`;
/** the checkpoints' keys and times: pruning never loads the checkpoints themselves (each can be many MB) */
const CHECKPOINT_INDEX = "checkpoint-index";

export const getCheckpoint = (id: string) =>
  get<{ at: number; data: unknown }>(checkpointKey(id), agentStore).then((entry) => entry?.data ?? null);

/** checkpoints written one at a time in this tab, the oldest dropped (see ./boundedStore.ts) */
const checkpoints = boundedStore(agentStore, {
  indexKey: CHECKPOINT_INDEX,
  max: MAX_CHECKPOINTS,
  isEntry: (key) => key.startsWith("checkpoint:"),
  // a live scene's revisions: at most MAX_LIVE_REVISIONS of one scene
  alsoDrop: (key, byAge) => {
    const live = /^checkpoint:live-rev:([^:]+):/.exec(key);
    if (!live) {
      return [];
    }
    const own = byAge.filter((k) => k.startsWith(`checkpoint:live-rev:${live[1]}:`));
    return own.slice(0, Math.max(0, own.length - MAX_LIVE_REVISIONS));
  },
});

export const setCheckpoint = (id: string, data: unknown) => {
  const at = Date.now();
  return checkpoints.put(checkpointKey(id), { at, data }, at);
};

// -----------------------------------------------------------------------------
// moving scenes from one space to another (see ./spaces.ts: spaceMoves)
// -----------------------------------------------------------------------------

/** a moved scene's key in the agent store (its baseline is per scene name) */
const movedAgentKey = (key: string, renames: Map<string, string>) => {
  if (!key.startsWith("baseline:")) {
    return key;
  }
  return `baseline:${renames.get(key.slice("baseline:".length)) ?? key.slice("baseline:".length)}`;
};

type Store = ReturnType<typeof createStore>;

/** one stored value, copied to another key / store (if there is one) */
const copyEntry = async (key: string, to: string, fromStore: Store, toStore: Store) => {
  const value = await get(key, fromStore);
  if (value !== undefined) {
    await set(to, value, toStore);
  }
};

/** one agent store entry, into another space: a scene's baseline under its new name, checkpoint indexes merged */
const moveAgentEntry = async (key: string, renames: Map<string, string>, fromAgent: Store, toAgent: Store) => {
  if (key !== CHECKPOINT_INDEX) {
    return copyEntry(key, movedAgentKey(key, renames), fromAgent, toAgent);
  }
  const known = (await get<Record<string, number>>(key, toAgent)) ?? {};
  const moved = (await get<Record<string, number>>(key, fromAgent)) ?? {};
  await set(key, { ...known, ...moved }, toAgent);
};

/**
 * Move the scenes of space `from` into space `to` (the tab is not using
 * either: it reloads afterwards). Scenes `to` has a name for already get a
 * free name. The target is written completely before the source is cleared,
 * so an interruption loses nothing (at worst, scenes are there twice).
 * Returns the moved scenes' new names (see mergeSpaceMeta).
 */
export const moveSpaceData = async (from: string, to: string, keepSync: boolean) => {
  const fromKey = metaKeyOf(from);
  if (localStorage.getItem(fromKey) === null) {
    return new Map<string, string>();
  }
  const toKey = metaKeyOf(to);
  const target = localStorage.getItem(toKey) === null ? null : loadMeta(toKey);
  const source = loadMeta(fromKey);
  const fromSnapshots = snapshotStoreOf(from);
  const toSnapshots = snapshotStoreOf(to);
  if (target) {
    // into scenes that are there already: only scenes with content of their own (a tab
    // that still had the source open may have written back metadata of scenes moved before)
    const stored = new Set((await keys(fromSnapshots)).map(String));
    source.scenes = Object.fromEntries(Object.entries(source.scenes).filter(([name]) => stored.has(name)));
  }
  const { meta, renames } = mergeSpaceMeta(target, source, keepSync);

  for (const [name, renamed] of renames) {
    await copyEntry(name, renamed, fromSnapshots, toSnapshots); // NOSONAR S9382: one at a time on purpose (a snapshot can be many MB)
  }

  const fromAgent = agentStoreOf(from);
  const toAgent = agentStoreOf(to);
  for (const key of (await keys(fromAgent)).map(String)) {
    await moveAgentEntry(key, renames, fromAgent, toAgent); // NOSONAR S9382: one at a time on purpose (a checkpoint can be many MB)
  }

  // the source is cleared only once the target's scene list is stored (a full storage throws here)
  writeMeta(meta, toKey);
  localStorage.removeItem(fromKey);
  await clear(fromSnapshots);
  await clear(fromAgent);
  return renames;
};
