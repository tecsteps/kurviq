// The retired live sync's last job (docs/relay/CONCEPT.md "Retiring live
// sync"): what an old scene object still holds (its encrypted working copy
// and the changes not yet in Drive) becomes one scene file again, so it can
// be saved to Drive before everything is deleted. Only the parts of the old
// server merge that this needs; the whole file goes with the follow-up
// release that removes the scene objects.

import { cleanComment, commentsOf, readableMatches } from "../../scenes-mcp/sceneComments.mjs";
import type { CommentReadable } from "../../scenes-mcp/sceneComments.mjs";
import { fromBase64 } from "../../scenes-plugin/src/online/sceneKey";
import type { SceneKey } from "../../scenes-plugin/src/online/sceneKey";

export type EventKind = "el" | "set" | "file" | "font" | "name" | "cmt";

/** what the old scene object could read of an element (all else was encrypted) */
export type Readable = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  boundIds: string[];
  containerId: string | null;
  startId: string | null;
  endId: string | null;
  frameId: string | null;
  groupIds: string[];
  fileId: string | null;
  fontFamily: number | null;
};

/** one subject's state as the old scene object kept it */
export type Entry = {
  k: EventKind;
  id: string;
  r?: Readable;
  /** base64(IV + ciphertext); "" for deletions the object made itself */
  c: string;
  fontId?: number;
  cr?: CommentReadable;
};

const keyOf = (entry: { k: EventKind; id: string }) => (entry.k === "el" ? entry.id : `${entry.k}:${entry.id}`);

const decryptContent = async (scene: SceneKey, k: EventKind, id: string, c: string): Promise<any> => {
  const bytes = fromBase64(c);
  if (bytes.length <= 12) {
    throw new Error("encrypted event too short");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(`${scene.fileId}:${k}:${id}:${scene.keyId}`) },
    scene.key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
};

/** what is saved is what was checked: the references come from the readable part */
const withReadableReferences = (element: any, r: Readable) => {
  const objectOf = (value: any) => (value && typeof value === "object" ? value : {});
  const binding = (value: any, id: string | null) => (id ? { ...objectOf(value), elementId: id } : null);
  if ("startBinding" in element || r.startId) {
    element.startBinding = binding(element.startBinding, r.startId);
  }
  if ("endBinding" in element || r.endId) {
    element.endBinding = binding(element.endBinding, r.endId);
  }
  element.containerId = r.containerId;
  element.frameId = r.frameId;
  element.groupIds = [...r.groupIds];
  if (r.fileId !== null || "fileId" in element) {
    element.fileId = r.fileId;
  }
  const listed = new Map<string, any>((Array.isArray(element.boundElements) ? element.boundElements : []).map((b: any) => [String(b?.id), b]));
  element.boundElements = r.boundIds.length ? r.boundIds.map((id) => listed.get(id) ?? { id, type: "arrow" }) : null;
  return element;
};

/** an entry's plain value (the readable part on top: the object's stamp, index and font id hold) */
export const plainOf = async (scene: SceneKey, entry: Entry): Promise<any> => {
  if (entry.k === "el") {
    const r = entry.r!;
    if (!entry.c) {
      return { id: r.id, type: r.type, isDeleted: true };
    }
    const content = await decryptContent(scene, "el", entry.id, entry.c);
    const element: any = { ...content, id: r.id, version: r.version, versionNonce: r.versionNonce, isDeleted: r.isDeleted, index: r.index };
    if (r.fontFamily !== null && typeof element.fontFamily === "number") {
      element.fontFamily = r.fontFamily;
    }
    return withReadableReferences(element, r);
  }
  const value = await decryptContent(scene, entry.k, entry.id, entry.c);
  if (entry.k === "cmt") {
    return value?.id === entry.id && readableMatches(value, entry.cr) ? cleanComment(value) : null;
  }
  return entry.k === "font" && entry.fontId !== undefined ? { ...value, id: entry.fontId } : value;
};

const validElement = (el: any) =>
  !!el &&
  typeof el === "object" &&
  typeof el.id === "string" &&
  typeof el.type === "string" &&
  (el.isDeleted || ["x", "y", "width", "height"].every((key) => typeof el[key] === "number" && Number.isFinite(el[key])));

const repairElement = (el: any, alive: Map<string, any>) => {
  for (const field of ["containerId", "frameId"]) {
    if (el[field] && !alive.has(el[field])) {
      el[field] = null;
    }
  }
  for (const field of ["startBinding", "endBinding"]) {
    if (el[field]?.elementId && !alive.has(el[field].elementId)) {
      el[field] = null;
    }
  }
  if (Array.isArray(el.boundElements)) {
    const kept = el.boundElements.filter((b: any) => alive.has(String(b?.id)));
    el.boundElements = kept.length ? kept : null;
  }
};

/** a reference to an element that is not in the file is cut (container, frame, bindings, bound elements) */
const repairReferences = (elements: any[]) => {
  const alive = new Map(elements.map((el) => [el.id, el]));
  for (const el of elements) {
    repairElement(el, alive);
  }
};

const byIndex = (a: any, b: any) => {
  const [x, y] = [String(a.index ?? ""), String(b.index ?? "")];
  if (x === y) {
    return 0;
  }
  return x < y ? -1 : 1;
};

const SETTINGS = { viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false, kurviqPresentation: false, kurviqPresentationAt: 0 };

type Plain = { k: EventKind; value: any };

/** the subjects' last states: the working copy, then each pending batch in order */
export const latestEntries = (snapshot: Entry[], batches: Entry[][]) => {
  const state = new Map<string, Entry>();
  for (const entry of snapshot) {
    state.set(keyOf(entry), entry);
  }
  for (const batch of batches) {
    for (const entry of batch) {
      state.set(keyOf(entry), entry);
    }
  }
  return state;
};

/** decrypted; an entry that doesn't decrypt (or isn't a valid element) is counted and left out */
export const decryptEntries = async (key: SceneKey, entries: Map<string, Entry>) => {
  const plain: Plain[] = [];
  let bad = 0;
  for (const entry of entries.values()) {
    try {
      const value = await plainOf(key, entry); // NOSONAR S9382: in order on purpose (keeps the subjects' order)
      if ((entry.k === "el" && !validElement(value)) || value === null) {
        throw new Error("invalid");
      }
      plain.push({ k: entry.k, value });
    } catch {
      bad++;
    }
  }
  return { plain, bad };
};

/** the subjects by kind */
const sorted = (plain: Plain[]) => {
  const out = { elements: [] as any[], files: new Map<string, any>(), fonts: new Map<number, any>(), comments: [] as unknown[], settings: null as any, name: null as string | null };
  for (const { k, value } of plain) {
    if (k === "el" && !value.isDeleted) {
      out.elements.push(value);
    } else if (k === "set") {
      out.settings = value;
    } else if (k === "name") {
      out.name = typeof value?.name === "string" ? value.name : null;
    } else if (k === "font" && typeof value?.id === "number") {
      out.fonts.set(value.id, value);
    } else if (k === "file" && value?.id) {
      out.files.set(value.id, value);
    } else if (k === "cmt") {
      out.comments.push(value);
    }
  }
  return out;
};

/** the scene file: live elements in z-order, settings, the images and fonts they use, comments; and its name */
export const buildSceneFile = (plain: Plain[]) => {
  const { elements, files, fonts, comments, settings, name } = sorted(plain);
  elements.sort(byIndex);
  repairReferences(elements);
  const used = (ids: Iterable<unknown>, all: Map<any, any>) => [...new Set(ids)].filter((id) => all.has(id)).map((id) => [id, all.get(id)]);
  const pick = (key: keyof typeof SETTINGS) => settings?.[key] ?? SETTINGS[key];
  const data: Record<string, unknown> = {
    type: "excalidraw",
    version: 2,
    source: "https://kurviq.com",
    elements,
    appState: Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, pick(key as keyof typeof SETTINGS)])),
    files: Object.fromEntries(used(elements.map((el) => el.fileId), files)),
  };
  const usedFonts = used(elements.map((el) => el.fontFamily), fonts).map(([id, font]) => ({ family: font.family, id, faces: font.faces, source: font.source }));
  if (usedFonts.length) {
    data.kurviqFonts = usedFonts;
  }
  const kept = commentsOf(comments);
  if (kept.length) {
    data.kurviqComments = kept;
  }
  return { json: JSON.stringify(data, null, 2), name };
};
