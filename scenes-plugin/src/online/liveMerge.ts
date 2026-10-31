// Live sync: the pure parts of the tab's engine (liveSync.ts) — which
// properties a change touched, rebasing it onto someone else's newer state,
// which elements belong together, receipts. No browser or editor APIs, so
// they are tested on their own (scenes-plugin/test).

import { sameContent } from "../../../scenes-mcp/elementContent.mjs";

import type { Base, Receipt } from "./liveProtocol";

type El = { id: string; version: number; versionNonce: number; [key: string]: any };

/**
 * stamps and render caches: not something a user changed. `status` is an image's loading state,
 * which each editor sets itself (with a new version) when it has loaded the picture
 */
const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "status"]);

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** properties whose value differs (order and z-index included: moving to front is a change) */
export const changedKeys = (before: Record<string, any> | null | undefined, after: Record<string, any>) => {
  if (!before) {
    return null; // new: everything is the user's
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !VOLATILE.has(key) && !same(before[key], after[key]));
};

/** same content, maybe another stamp */
export const sameState = (a: Record<string, any> | null | undefined, b: Record<string, any> | null | undefined) =>
  !a || !b ? !a && !b : changedKeys(a, b)!.length === 0;

export const stampOf = (el: { version: number; versionNonce: number }): Base => ({ v: el.version, n: el.versionNonce });

export const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

/**
 * A live collision: someone else's change (`current`) was accepted first.
 * The user's own properties (`keys`, changed against `base`) go on top of it;
 * where both changed the same property, the user's later change wins and the
 * other's value is reported (they may restore it).
 */
export const rebase = (current: El, mine: El, keys: string[] | null, base: El | null) => {
  if (keys === null) {
    // a new element that exists meanwhile (the same id): the user's version, on the current stamp
    return {
      el: { ...mine, version: current.version + 1, versionNonce: randomNonce() },
      overlaps: changedKeys(current, mine) ?? [],
    };
  }
  const el: El = { ...current };
  const overlaps: string[] = [];
  for (const key of keys) {
    if (base && !same(base[key], current[key]) && !same(mine[key], current[key])) {
      overlaps.push(key);
    }
    if (mine[key] === undefined) {
      delete el[key];
    } else {
      el[key] = mine[key];
    }
  }
  el.version = current.version + 1;
  el.versionNonce = randomNonce();
  return { el, overlaps };
};

/**
 * What an element "touches" (CONCEPT "What counts as touching"): itself, what
 * it refers to and what refers to it, every member of its groups, its image
 * and its font. Asset ids are prefixed so they never meet element ids.
 */
export const touchedBy = (el: El, membersOf: (groupId: string) => readonly string[] = () => []) => {
  const ids = new Set<string>([el.id]);
  for (const bound of Array.isArray(el.boundElements) ? el.boundElements : []) {
    if (bound?.id) {
      ids.add(String(bound.id));
    }
  }
  for (const ref of [el.containerId, el.startBinding?.elementId, el.endBinding?.elementId, el.frameId]) {
    if (ref) {
      ids.add(String(ref));
    }
  }
  for (const group of Array.isArray(el.groupIds) ? el.groupIds : []) {
    membersOf(group).forEach((id) => ids.add(id));
  }
  if (el.fileId) {
    ids.add(`file:${el.fileId}`);
  }
  if (typeof el.fontFamily === "number") {
    ids.add(`font:${el.fontFamily}`);
  }
  return ids;
};

/** group id -> member ids, over one or more states of the scene */
export const groupIndex = (...lists: Iterable<El>[]) => {
  const index = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const el of list) {
      for (const group of Array.isArray(el.groupIds) ? el.groupIds : []) {
        (index.get(group) ?? index.set(group, new Set()).get(group)!).add(el.id);
      }
    }
  }
  return (group: string) => [...(index.get(group) ?? [])];
};

/**
 * Connected groups of ids: `links` gives, per id, what it touches. Used for
 * "logical operations stay whole" and for which offline changes may still be
 * sent after a collision (only groups without a colliding element).
 */
export const components = (ids: Iterable<string>, links: (id: string) => Iterable<string>) => {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const add = (id: string) => {
    if (!parent.has(id)) {
      parent.set(id, id);
    }
  };
  const all = [...ids];
  all.forEach(add);
  for (const id of all) {
    for (const other of links(id)) {
      add(other);
      const [a, b] = [find(id), find(other)];
      if (a !== b) {
        parent.set(a, b);
      }
    }
  }
  const groups = new Map<string, Set<string>>();
  for (const id of all) {
    const root = find(id);
    (groups.get(root) ?? groups.set(root, new Set()).get(root)!).add(id);
  }
  return [...groups.values()];
};

/** is a tab's batch in Drive, per the receipt Drive's file carries for that tab */
export const inReceipt = (receipt: Receipt | undefined, counter: number) =>
  !!receipt && (counter <= receipt.mark || receipt.extra.includes(counter));

/** fractional indices order the scene (ASCII order; elements without one at the end, stable) */
export const byIndex = <T extends object>(elements: readonly T[]) =>
  elements
    .map((el, position) => ({ el, position }))
    .sort((a, b) => {
      const [x, y]: (string | null)[] = [(a.el as any).index ?? null, (b.el as any).index ?? null];
      if (x === y) {
        return a.position - b.position;
      }
      if (x === null) {
        return 1;
      }
      if (y === null) {
        return -1;
      }
      return x < y ? -1 : 1;
    })
    .map(({ el }) => el);

/**
 * References to elements that are gone (deleted or unknown): taken out, so
 * a change refused for a dangling reference can be sent again ("reference").
 */
export const withoutDanglingRefs = (el: El, exists: (id: string) => boolean): El => {
  const next: El = { ...el };
  if (next.frameId && !exists(next.frameId)) {
    next.frameId = null;
  }
  if (next.containerId && !exists(next.containerId)) {
    next.containerId = null;
  }
  for (const key of ["startBinding", "endBinding"] as const) {
    if (next[key]?.elementId && !exists(next[key].elementId)) {
      next[key] = null;
    }
  }
  if (Array.isArray(next.boundElements)) {
    next.boundElements = next.boundElements.filter((bound: any) => bound?.id && exists(String(bound.id)));
  }
  return next;
};

/**
 * A whole new state of the scene (an agent's save) against the live one:
 * the elements that differ, stamped above what the scene has, plus deletions
 * of those it no longer has. With `base` (the state the writer read), only
 * what the writer changed against it counts — elements others added or
 * changed meanwhile stay — and an element both changed is a clash (the
 * write is refused, like Drive's "changed in the meantime").
 */
export const liveDifference = (current: readonly El[], next: readonly El[], base?: readonly El[] | null) => {
  const byId = new Map(current.map((el) => [el.id, el]));
  const nextIds = new Set(next.map((el) => el.id));
  const before = base ? new Map(base.map((el) => [el.id, el])) : null;
  const changed: El[] = [];
  const clashes: string[] = [];
  const alive = (el: El | undefined) => (el && !el.isDeleted ? el : undefined);
  for (const el of next) {
    const now = byId.get(el.id);
    if (before) {
      const was = alive(before.get(el.id));
      if (was && contentEqual(was, el)) {
        continue; // not the writer's change
      }
      if (!contentEqual(alive(now) ?? null, was ?? null)) {
        if (!contentEqual(alive(now) ?? null, el)) {
          clashes.push(el.id);
        }
        continue;
      }
    }
    if (now && !!now.isDeleted === !!el.isDeleted && contentEqual(now, el)) {
      continue;
    }
    changed.push({ ...el, version: Math.max(now?.version ?? 0, el.version) + 1, versionNonce: randomNonce() });
  }
  for (const el of current) {
    if (el.isDeleted || nextIds.has(el.id)) {
      continue;
    }
    if (before) {
      const was = alive(before.get(el.id));
      if (!was) {
        continue; // added by someone else meanwhile: not the writer's to delete
      }
      if (!contentEqual(was, el)) {
        clashes.push(el.id); // the writer deleted what someone changed meanwhile
        continue;
      }
    }
    changed.push({ ...el, isDeleted: true, version: el.version + 1, versionNonce: randomNonce() });
  }
  return before ? Object.assign(changed, { clashes }) : Object.assign(changed, { clashes: [] as string[] });
};

// -----------------------------------------------------------------------------
// content, order included
// -----------------------------------------------------------------------------

const normalize = (value: unknown): unknown => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      const empty = field === null || field === undefined || (Array.isArray(field) && !field.length);
      if (!VOLATILE.has(key) && !empty) {
        out[key] = normalize(field);
      }
    }
    return out;
  }
  return value;
};

/**
 * Same content, z-order (index) included, never decided by the stamps: a
 * whole-scene write that only moves a layer, or keeps a stamp while changing
 * something, is a change. Empty fields and rounding noise are not.
 */
export const contentEqual = (a: El | null | undefined, b: El | null | undefined) =>
  !a || !b ? !a && !b : JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

// -----------------------------------------------------------------------------
// rebasing a chain of the user's changes (a batch and everything after it)
// -----------------------------------------------------------------------------

/**
 * The user's successive versions of an element (`chain`, oldest first, each
 * building on the one before, the first on `oldBase`) moved onto `newBase`
 * (the rebased first version): each step keeps only the properties it
 * changed itself, so later steps never bring back what the rebase took over
 * from someone else.
 */
export const reapplyChain = (oldBase: El, newBase: El, chain: El[]) => {
  const out: El[] = [];
  let [before, after] = [oldBase, newBase];
  for (const step of chain) {
    const keys = changedKeys(before, step) ?? [];
    const next: El = { ...after };
    for (const key of keys) {
      if (step[key] === undefined) {
        delete next[key];
      } else {
        next[key] = step[key];
      }
    }
    next.version = Math.max(step.version, after.version) + 1;
    next.versionNonce = randomNonce();
    out.push(next);
    [before, after] = [step, next];
  }
  return out;
};

// -----------------------------------------------------------------------------
// undo: who produced the value a property has now
// -----------------------------------------------------------------------------

type Author = "user" | "remote";

/**
 * Per element and property, the values it had and who set them (the last
 * few). Undo and redo may change a property only while its current value is
 * one the user produced; a value an undo brings back keeps its author, so the
 * next undo step knows it was someone else's.
 */
export class ValueAuthors {
  private values = new Map<string, Map<string, { v: string; a: Author }[]>>();

  constructor(private readonly keep = 20) {}

  private list(id: string, key: string) {
    let byKey = this.values.get(id);
    if (!byKey) {
      byKey = new Map();
      this.values.set(id, byKey);
    }
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    return list;
  }

  set(id: string, key: string, value: unknown, author: Author) {
    const list = this.list(id, key);
    list.push({ v: JSON.stringify(value ?? null), a: author });
    if (list.length > this.keep) {
      list.splice(0, list.length - this.keep);
    }
  }

  /** who set this value last (unknown: the user, e.g. the scene as it was loaded) */
  authorOf(id: string, key: string, value: unknown): Author {
    const v = JSON.stringify(value ?? null);
    const list = this.values.get(id)?.get(key) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].v === v) {
        return list[i].a;
      }
    }
    return "user";
  }

  /**
   * A history step changes `keys` of an element from `before` to `after`:
   * the keys it may change (the current value is the user's), the others
   * stay. Allowed values are recorded with the author they had before.
   */
  historyStep(id: string, before: Record<string, any>, after: Record<string, any>, keys: string[]) {
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const key of keys) {
      if (this.authorOf(id, key, before[key]) === "remote") {
        skipped.push(key);
      } else {
        allowed.push(key);
        this.set(id, key, after[key], this.authorOf(id, key, after[key]));
      }
    }
    return { allowed, skipped };
  }
}
