// Element-level three-way merge of scene versions.
//
// Elements have stable ids, so for each element we compare its content on
// both sides with the common base version (scenes-mcp/elementContent.mjs:
// content, not version stamps).
//   only mine changed   -> mine        only theirs changed -> theirs
//   both, same result   -> either      both, different     -> CLASH (mine kept
//                                                             provisionally)
// A missing element counts as deleted.

import { syncInvalidIndices } from "@excalidraw/element";

import { sameContent } from "../../scenes-mcp/elementContent.mjs";

export { changedFields } from "../../scenes-mcp/elementContent.mjs";

type El = { id: string; version: number; versionNonce: number; index?: string | null; [key: string]: any };

/** bump when the merge logic changes: conflicts found by older ones are re-checked */
export const MERGE_VERSION = 2;

export const live = (elements: readonly El[] | undefined) =>
  new Map((elements || []).filter((el) => !el.isDeleted).map((el) => [el.id, el]));

const changed = (base: El | undefined, other: El | undefined) => !sameContent(base, other);

/** how to settle clashing elements: take my version or Drive's */
export type ClashChoice = "mine" | "theirs";

export type MergeResult = {
  elements: El[];
  /** element ids changed differently on both sides */
  clashes: string[];
  /** counts, for the activity log */
  fromMine: number;
  fromTheirs: number;
};

/**
 * The z-order (index) is not content (sameContent ignores it), so an element
 * only moved to the front or back counts as unchanged and the other side's
 * copy is picked. The side that changed the order against the base keeps
 * its order (mine when both did).
 */
const keptOrder = (pick: El, base: El | undefined, mine: El | undefined, theirs: El | undefined): El => {
  if (!base || !mine || !theirs) {
    return pick;
  }
  let index = pick.index;
  if (mine.index !== base.index) {
    index = mine.index;
  } else if (theirs.index !== base.index) {
    index = theirs.index;
  }
  return index === pick.index ? pick : { ...pick, index };
};

/** the scene settings merged three-way (scene JSON's appState): background and grid */
const SETTINGS = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"] as const;

/**
 * Background and grid of a merged scene: mine if I changed it since the
 * base, else theirs (Drive's change is kept, like an element's). Without a
 * known base, mine.
 */
export const mergeSceneSettings = (base: Record<string, any> | undefined | null, mine: Record<string, any> | undefined, theirs: Record<string, any> | undefined) => {
  const settings: Record<string, unknown> = {};
  for (const key of SETTINGS) {
    const changedHere = !base || JSON.stringify(mine?.[key]) !== JSON.stringify(base[key]);
    const value = changedHere ? mine?.[key] : theirs?.[key];
    if (value !== undefined) {
      settings[key] = value;
    }
  }
  return settings;
};

export const mergeElements = (
  base: readonly El[] | undefined,
  mine: readonly El[],
  theirs: readonly El[],
  /** decisions for clashing element ids (others stay clashes) */
  choices: Record<string, ClashChoice> = {},
): MergeResult => {
  const [b, m, t] = [live(base), live(mine), live(theirs)];
  const ids = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  const result: El[] = [];
  const clashes: string[] = [];
  let fromMine = 0;
  let fromTheirs = 0;

  for (const id of ids) {
    const [be, me, te] = [b.get(id), m.get(id), t.get(id)];
    const mineChanged = changed(be, me);
    const theirsChanged = changed(be, te);
    let pick: El | undefined;
    if (!mineChanged) {
      pick = te;
      theirsChanged && fromTheirs++;
    } else if (!theirsChanged) {
      pick = me;
      fromMine++;
    } else if (sameContent(me, te)) {
      pick = me;
    } else if (choices[id]) {
      pick = choices[id] === "mine" ? me : te; // undefined = deleted on that side
    } else {
      pick = me ?? te; // keep mine provisionally (a deleted-vs-edited clash keeps the edit)
      clashes.push(id);
    }
    if (pick) {
      result.push(keptOrder(pick, be, me, te));
    }
  }

  // z-order: fractional indices are ASCII-ordered strings
  result.sort((x, y) => {
    if ((x.index ?? "") < (y.index ?? "")) return -1;
    if ((x.index ?? "") > (y.index ?? "")) return 1;
    return 0;
  });
  syncInvalidIndices(result as any);
  return { elements: result, clashes, fromMine, fromTheirs };
};

/**
 * Settle clashes without asking, like live collaboration does: per element
 * the newer edit wins (`updated` timestamp; on a tie Drive's). An edit beats
 * a delete, so nobody's work silently disappears.
 */
export const newestWins = (
  mine: readonly El[],
  theirs: readonly El[],
  clashes: readonly string[],
): Record<string, ClashChoice> => {
  const [m, t] = [live(mine), live(theirs)];
  const choices: Record<string, ClashChoice> = {};
  for (const id of clashes) {
    const [me, te] = [m.get(id), t.get(id)];
    if (!me) {
      choices[id] = "theirs";
    } else if (!te) {
      choices[id] = "mine";
    } else {
      choices[id] = ((me as any).updated ?? 0) > ((te as any).updated ?? 0) ? "mine" : "theirs";
    }
  }
  return choices;
};
