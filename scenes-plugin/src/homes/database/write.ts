// A database scene changed outside the canvas (an agent's edit of a scene
// that isn't open, a copy, a restore): only what changed goes to the
// database, element by element, as the live session does for the canvas. So
// others' changes made meanwhile to other elements stay (no whole-scene
// overwrite), and the same element: the newer version wins.

import { commentsOf } from "../../../../scenes-mcp/sceneComments.mjs";

import { changedComments, deletedVersion, isNewer, stamp } from "./changes";
import { fileIndex, splitScene } from "./sceneJson";

import type { SceneRows } from "./rows";

type Element = Record<string, any> & { id: string; version: number; versionNonce: number };

const sameContent = (a: Element, b: Element) => {
  const strip = ({ version, versionNonce, updated, ...rest }: Record<string, any>) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/**
 * The elements of `after` that differ from `before` (new versions where an
 * edit kept the old one), and those gone from it as deleted ones
 */
export const elementChanges = (before: readonly Element[], after: readonly Element[]) => {
  const old = new Map(before.map((element) => [element.id, element]));
  const changed: Element[] = [];
  for (const element of after) {
    const was = old.get(element.id);
    if (!was) {
      changed.push(element);
    } else if (stamp(was) !== stamp(element) || !sameContent(was, element)) {
      changed.push(isNewer(element, was) ? element : { ...element, version: was.version + 1 });
    }
  }
  const here = new Set(after.map((element) => element.id));
  const gone = before.filter((element) => !here.has(element.id) && !element.isDeleted).map(deletedVersion);
  return [...changed, ...gone];
};

/** write what changed from `beforeJson` (the version read from the database) to `afterJson`; the new revision (null: nothing changed) */
export const writeSceneChanges = async (rows: SceneRows, sceneId: string, beforeJson: string | null, afterJson: string) => {
  const before = beforeJson ? splitScene(beforeJson) : null;
  const after = splitScene(afterJson);
  let revision: number | null = null;
  const newFiles = Object.entries(after.files).filter(([fileId]) => !before?.files[fileId]);
  for (const [fileId, file] of newFiles) {
    await rows.putFile(sceneId, fileId, file.dataURL, file.mimeType); // NOSONAR S9382: one at a time on purpose (pictures can be large)
  }
  if (newFiles.length || before?.envelope !== after.envelope) {
    revision = await rows.putMeta(sceneId, before?.envelope === after.envelope ? null : after.envelope, fileIndex(Object.fromEntries(newFiles)));
  }
  const elements = elementChanges((before?.elements ?? []) as Element[], after.elements as Element[]);
  if (elements.length) {
    revision = await rows.putElements(sceneId, elements);
  }
  const known = new Map(commentsOf(before?.comments ?? []).map((comment: { id: string; u: number }) => [comment.id, comment.u]));
  const comments = changedComments(commentsOf(after.comments), known);
  if (comments.length) {
    revision = await rows.putComments(sceneId, comments);
  }
  return revision;
};
