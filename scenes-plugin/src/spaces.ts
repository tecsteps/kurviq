// Kurviq: which scenes a browser tab works with (its "space"). Each space
// keeps its own scenes in the browser (see ./storage.ts):
//  - ""             the scenes made while signed out (no account)
//  - "a:<email>"    one Google account's own scenes (its Kurviq folder in
//                   Drive): accounts never see each other's scenes, even in
//                   one browser
//  - "f:<fileId>"   a scene someone shared (one Drive file)
//  - "d:<folderId>" a folder someone shared (their Kurviq folder, read and
//                   written through Kurviq's server with the owner's sign-in)
// Pure helpers only (no storage access), so they can be tested.

import { isSceneName } from "../../scenes-mcp/sceneName.mjs";

import type { SceneMeta, ScenesMeta } from "./storage";

/** the space of a shared scene ("f:<fileId>") or folder ("d:<folderId>"), set while one is open */
export const SPACE_KEY = "kurviq-space";
/** the space of the user's own scenes ("a:<email>"; none = signed out) */
export const OWN_SPACE_KEY = "kurviq-own-space";
/** before spaces per account: the account the signed-out space ("") was synced with */
export const LEGACY_ACCOUNT_KEY = "kurviq-drive-account";

/** key used for the scene that has not been named / saved yet (also in ./storage.ts) */
const UNTITLED = "\u0000untitled";

const SHARED_RE = /^[fd]:[\w-]{10,200}$/;
const ACCOUNT_RE = /^a:[^\s@/]{1,200}@[^\s@/]{1,200}$/;

/** an account's id in spaces: its email, lowercased */
export const accountKey = (email: string) => email.trim().toLowerCase();

/** the space of an account's own scenes */
export const ownSpaceOf = (email: string) => `a:${accountKey(email)}`;

/** the account a space belongs to (null: the signed-out space or a shared scene's / folder's) */
export const spaceAccountOf = (space: string) => (ACCOUNT_RE.test(space) ? space.slice(2) : null);

/** a shared scene's or folder's space (it works with whoever is signed in) */
export const isSharedSpace = (space: string) => space.startsWith("f:") || space.startsWith("d:");

/** suffix of a space's storage keys */
export const spaceSuffix = (space: string) => (space ? `@${space}` : "");

/**
 * This tab's space from what is stored: an open shared scene wins, then the
 * account's own scenes, else the signed-out space. Invalid values (e.g. the
 * repository spaces of versions before Drive) count as unset.
 */
export const pickSpace = (shared: string | null, own: string | null) => {
  if (shared && SHARED_RE.test(shared)) {
    return shared;
  }
  if (own && ACCOUNT_RE.test(own)) {
    return own;
  }
  return "";
};

/**
 * Where this tab's own scenes must be, given who is signed in (null: stay).
 * Signed in: that account's space. Signed out (or the sign-in expired): the
 * tab stays, unless the signed-out space still holds an account's scenes from
 * before spaces per account (legacy), which go to that account's space. A
 * shared scene's or folder's space never moves (it is not an account's).
 */
export const ownSpaceTarget = (space: string, email: string | null, legacy: string | null): string | null => {
  if (isSharedSpace(space)) {
    return null;
  }
  if (email) {
    const own = ownSpaceOf(email);
    return own === space ? null : own;
  }
  if (space === "" && legacy) {
    return ownSpaceOf(legacy);
  }
  return null;
};

export type SpaceMove = { from: string; to: string; keepSync: boolean };

/**
 * Scenes that move along when the tab goes from one space to another. Only
 * the signed-out space gives scenes away: before spaces per account it held
 * the last account's scenes (legacy: they go to that account with their sync
 * state, whoever signs in now); else its scenes were made signed out and go
 * to the account signing in, local only, offered for Drive in the dialog
 * after sign-in. An account's scenes never move to another account.
 */
export const spaceMoves = (from: string, to: string, legacy: string | null): SpaceMove[] => {
  if (from !== "") {
    return [];
  }
  if (legacy) {
    return [{ from: "", to: ownSpaceOf(legacy), keepSync: true }];
  }
  if (!to) {
    return [];
  }
  return [{ from: "", to, keepSync: false }];
};

/**
 * A scene coming from another Drive (or none): kept in this browser only,
 * offered for Drive at sign-in. Its sync state was about another account's
 * Drive and is dropped.
 */
export const asLocalOnly = (meta: SceneMeta): SceneMeta => {
  const copy: SceneMeta = { ...meta, baseMd5: null, localOnly: true };
  for (const field of ["remoteMd5", "conflict", "renamedFrom", "adopt", "keptLocal", "live"] as const) {
    delete copy[field];
  }
  return copy;
};

/** a name not taken yet: "Plan", "Plan (2)", "Plan (3)", … (valid, max 100 characters) */
export const freeName = (name: string, taken: (name: string) => boolean) => {
  const base = isSceneName(name) ? name : "Untitled";
  if (!taken(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
};

/**
 * The metadata of `target` with the scenes of `source` added. Scenes whose
 * name `target` has already get a free name (and lose their sync state: in
 * Drive they live under the old name). The untitled scene stays untitled
 * unless `target` has one; then it gets the name "Untitled". renames maps
 * each moved scene's key (UNTITLED for the untitled one) to its new key.
 * The source's open scene becomes the open one: the user was looking at it.
 */
export const mergeSpaceMeta = (target: ScenesMeta | null, source: ScenesMeta, keepSync: boolean) => {
  const merged = mergeBase(target, source, keepSync);
  const renames = new Map<string, string>();
  const taken = (name: string) => name in merged.scenes || name in merged.pendingDeletes;
  for (const [name, meta] of Object.entries(source.scenes)) {
    if (name !== UNTITLED) {
      const to = freeName(name, taken);
      merged.scenes[to] = keepSync && to === name ? { ...meta } : asLocalOnly(meta);
      renames.set(name, to);
    }
  }
  const untitled = source.scenes[UNTITLED];
  if (untitled) {
    const to = merged.scenes[UNTITLED] ? freeName("Untitled", taken) : UNTITLED;
    merged.scenes[to] = to === UNTITLED ? { ...untitled } : { ...asLocalOnly(untitled), dirty: true };
    renames.set(UNTITLED, to);
  }
  const current = renames.get(source.current ?? UNTITLED);
  if (current !== undefined) {
    merged.current = current === UNTITLED ? null : current;
    merged.baseline = null;
  }
  return { meta: merged, renames };
};

/** what a merge starts from: a copy of `target`, or the source's settings without scenes */
const mergeBase = (target: ScenesMeta | null, source: ScenesMeta, keepSync: boolean): ScenesMeta => {
  if (target) {
    return { ...target, scenes: { ...target.scenes }, pendingDeletes: { ...target.pendingDeletes } };
  }
  return { ...source, scenes: {}, pendingDeletes: keepSync ? { ...source.pendingDeletes } : {}, current: null, baseline: null };
};
