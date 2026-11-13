// What an agent's edit changed, against the scene it read: the elements that
// differ (stamped above the scene's own), deletions, and clashes with what the
// user changed meanwhile (cowork.ts keepUserChanges). Pure, no editor APIs.

type El = { id: string; version: number; versionNonce: number; [key: string]: any };

/**
 * stamps and render caches: not something a user changed. `status` is an image's loading state,
 * which each editor sets itself (with a new version) when it has loaded the picture
 */
const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "status"]);

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const randomNonce = () => Math.floor(Math.random() * 2 ** 31); // NOSONAR S2245: not security relevant (Excalidraw's versionNonce)

const alive = (el: El | undefined) => (el && !el.isDeleted ? el : undefined);

/**
 * With the writer's base: whether `el` is the writer's change. False when
 * the writer didn't change it, or when someone else changed it meanwhile
 * (a clash, noted in `clashes`, unless both made the same change).
 */
/** User intent excludes editor-maintained geometry and binding caches. */
const intent = (el: El | null | undefined) => {
  if (!el) return el;
  const value = { ...el };
  for (const key of ["boundElements", "lastCommittedPoint"]) delete value[key];
  for (const key of ["startBinding", "endBinding"]) {
    value[key] = el[key]?.elementId ?? null;
  }
  if (el.type === "arrow" || el.type === "line" || (el.type === "text" && el.autoResize !== false)) {
    delete value.width;
    delete value.height;
  }
  if (el.type === "text" && el.containerId) {
    delete value.x;
    delete value.y;
  }
  return value;
};

const intentFields = (a: El | null | undefined, b: El | null | undefined): string[] => {
  const first = normalize(intent(a) ?? {}) as Record<string, unknown>;
  const second = normalize(intent(b) ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(first), ...Object.keys(second)])].filter((key) => !same(first[key], second[key]));
};

const writerChanged = (el: El, now: El | undefined, before: Map<string, El>, clashes: string[]) => {
  const was = alive(before.get(el.id));
  if (was && intentFields(was, el).length === 0) {
    return false; // not the writer's change
  }
  if (intentFields(alive(now), was).length !== 0) {
    if (intentFields(alive(now), el).length !== 0) {
      clashes.push(el.id);
    }
    return false;
  }
  return true;
};

/** with the writer's base: whether the writer deleted `el` (false for a clash, noted in `clashes`) */
const writerDeleted = (el: El, before: Map<string, El>, clashes: string[]) => {
  const was = alive(before.get(el.id));
  if (!was) {
    return false; // added by someone else meanwhile: not the writer's to delete
  }
  if (intentFields(was, el).length !== 0) {
    clashes.push(el.id); // the writer deleted what someone changed meanwhile
    return false;
  }
  return true;
};

const appendDeletions = (
  current: readonly El[],
  nextIds: ReadonlySet<string>,
  before: Map<string, El> | null,
  clashes: string[],
  changed: El[],
  touched?: ReadonlySet<string>,
) => {
  for (const el of current) {
    if ((touched && !touched.has(el.id)) || el.isDeleted || nextIds.has(el.id)) {
      continue;
    }
    if (before && !writerDeleted(el, before, clashes)) {
      continue;
    }
    changed.push({ ...el, isDeleted: true, version: el.version + 1, versionNonce: randomNonce() });
  }
};

/**
 * A whole new state of the scene (an agent's save) against the current one:
 * the elements that differ, stamped above what the scene has, plus deletions
 * of those it no longer has. With `base` (the state the writer read), only
 * what the writer changed against it counts (elements others added or
 * changed meanwhile stay), and an element both changed is a clash (the
 * write is refused, like Drive's "changed in the meantime").
 */
export const editDifference = (current: readonly El[], next: readonly El[], base?: readonly El[] | null, overwrite = false, touched?: ReadonlySet<string>) => {
  const byId = new Map(current.map((el) => [el.id, el]));
  const nextIds = new Set(next.map((el) => el.id));
  const before = base ? new Map(base.map((el) => [el.id, el])) : null;
  const changed: El[] = [];
  const clashes: string[] = [];
  for (const el of next) {
    if (touched && !touched.has(el.id)) continue;
    const now = byId.get(el.id);
    if (before && !writerChanged(el, now, before, clashes)) {
      continue;
    }
    if (now && !!now.isDeleted === !!el.isDeleted && contentEqual(now, el)) {
      continue;
    }
    changed.push({ ...el, version: Math.max(now?.version ?? 0, el.version) + 1, versionNonce: randomNonce() });
  }
  appendDeletions(current, nextIds, before, clashes, changed, touched);
  const conflictFields = Object.fromEntries(clashes.map((id) => [id, intentFields(before?.get(id), byId.get(id))]));
  if (overwrite && clashes.length) {
    const forced = editDifference(current, next);
    const ids = new Set(clashes);
    changed.push(...forced.filter((el) => ids.has(el.id)));
  }
  return Object.assign(changed, { clashes: overwrite ? [] : clashes, conflictFields });
};

// -----------------------------------------------------------------------------
// content, order included
// -----------------------------------------------------------------------------

/** the default sort order: by UTF-16 code units */
const byCodeUnits = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

const normalize = (value: unknown): unknown => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(byCodeUnits)) {
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
