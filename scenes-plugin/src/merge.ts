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

import { changedFields, sameContent } from "../../scenes-mcp/elementContent.mjs";

export { changedFields };

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
      result.push(pick);
    }
  }

  // z-order: fractional indices are ASCII-ordered strings
  result.sort((x, y) => ((x.index ?? "") < (y.index ?? "") ? -1 : (x.index ?? "") > (y.index ?? "") ? 1 : 0));
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
    choices[id] = !me ? "theirs" : !te ? "mine" : ((me as any).updated ?? 0) > ((te as any).updated ?? 0) ? "mine" : "theirs";
  }
  return choices;
};
