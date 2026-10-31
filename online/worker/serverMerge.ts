// Live sync, server side: what a scene's Durable Object (./scene.ts) does
// with scene content while it saves — decrypting events, building the
// Drive file, and telling what an outside app changed.
//
// The comparison here is the strict one the concept asks for (outside
// changes): actual content including order (`index`), images, fonts and
// settings; equal version stamps never count as equal content. The app's own
// merge (scenes-plugin/src/merge.ts with scenes-mcp/elementContent.mjs) keeps
// its looser rules; it is not used here.

import { generateKeyBetween } from "fractional-indexing";

import { aadOf, elementOf, eventKey, NAME_ID, readableOf, SETTINGS_ID } from "../../scenes-plugin/src/online/liveProtocol";
import type { EventKind, Readable, Receipt, WireEvent } from "../../scenes-plugin/src/online/liveProtocol";

/** one subject's state as the Durable Object keeps it (readable part, ciphertext, stamp, who and when) */
export type Entry = {
  k: EventKind;
  id: string;
  /** elements: the readable part, re-stamped */
  r?: Readable;
  /** base64(IV + ciphertext); "" for deletions the DO made itself */
  c: string;
  /** the DO's stamp (for elements the same as r.version / r.versionNonce) */
  v: number;
  n: number;
  /** fonts: the numeric font id */
  fontId?: number;
  /** pseudonym of the last author; "outside" for outside changes, null from a seed */
  a: string | null;
  /** the seq that produced it (0: seed) */
  seq: number;
  /** the tab and its batch counter that produced it (a tab's next batch may build on its own pending one) */
  t?: string;
  u?: number;
};

export const keyOf = (entry: { k: EventKind; id: string }) => eventKey(entry.k, entry.id);

/** an entry as tabs receive it */
export const wireOf = (entry: Entry, base: WireEvent["base"] = null): WireEvent => ({
  k: entry.k,
  id: entry.id,
  base,
  ...(entry.r ? { r: entry.r } : {}),
  c: entry.c,
  v: { v: entry.v, n: entry.n },
  ...(entry.fontId !== undefined ? { fontId: entry.fontId } : {}),
});

export const randomNonce = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

// -----------------------------------------------------------------------------
// bytes
// -----------------------------------------------------------------------------

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const fromBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Drive's md5Checksum of these bytes (workerd has MD5 in WebCrypto) */
export const md5Hex = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("MD5", bytes));

// -----------------------------------------------------------------------------
// the scene key (AES-GCM, per event: IV 12 bytes + ciphertext, aadOf as additional data)
// -----------------------------------------------------------------------------

export type SceneKey = { key: CryptoKey; keyId: string; fileId: string };

export const importSceneKey = async (base64: string, keyId: string, fileId: string): Promise<SceneKey> => ({
  key: await crypto.subtle.importKey("raw", fromBase64(base64), "AES-GCM", false, ["encrypt", "decrypt"]),
  keyId,
  fileId,
});

export const decryptContent = async (scene: SceneKey, k: EventKind, id: string, c: string): Promise<any> => {
  const bytes = fromBase64(c);
  if (bytes.length <= 12) {
    throw new Error("encrypted event too short");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(aadOf(scene.fileId, k, id, scene.keyId)) },
    scene.key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
};

export const encryptContent = async (scene: SceneKey, k: EventKind, id: string, value: unknown) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aadOf(scene.fileId, k, id, scene.keyId)) },
      scene.key,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv);
  out.set(cipher, 12);
  return toBase64(out);
};

/** an entry's plain value: the element (readable part on top, so the DO's stamp, index and font id hold), or the content */
export const plainOf = async (scene: SceneKey, entry: Entry): Promise<any> => {
  if (entry.k === "el") {
    const r = entry.r!;
    if (!entry.c) {
      return { id: r.id, type: r.type, version: r.version, versionNonce: r.versionNonce, isDeleted: true, index: r.index };
    }
    const element: any = elementOf(r, await decryptContent(scene, "el", entry.id, entry.c));
    if (r.fontFamily !== null && typeof element.fontFamily === "number") {
      element.fontFamily = r.fontFamily;
    }
    return withReadableReferences(element, r);
  }
  const value = await decryptContent(scene, entry.k, entry.id, entry.c);
  return entry.k === "font" && entry.fontId !== undefined ? { ...value, id: entry.fontId } : value;
};

/**
 * What is saved is what was checked: the references come from the readable
 * part (the encrypted copy only adds geometry, e.g. a binding's focus and gap)
 */
const withReadableReferences = (element: any, r: Readable) => {
  const binding = (value: any, id: string | null) => (id ? { ...(value && typeof value === "object" ? value : {}), elementId: id } : null);
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

/**
 * The saved graph never dangles: a reference to an element that is not
 * alive in this file is cut (container, frame, bindings, bound elements);
 * bound elements get the type of what they name
 */
export const repairGraph = (plain: Map<string, { k: EventKind; value: any }>) => {
  const alive = new Map<string, any>();
  for (const { k, value } of plain.values()) {
    if (k === "el" && !value.isDeleted) {
      alive.set(value.id, value);
    }
  }
  let cut = 0;
  for (const el of alive.values()) {
    for (const field of ["containerId", "frameId"]) {
      if (el[field] && !alive.has(el[field])) {
        el[field] = null;
        cut++;
      }
    }
    for (const field of ["startBinding", "endBinding"]) {
      if (el[field]?.elementId && !alive.has(el[field].elementId)) {
        el[field] = null;
        cut++;
      }
    }
    if (Array.isArray(el.boundElements)) {
      const kept = el.boundElements
        .filter((b: any) => alive.has(String(b?.id)))
        .map((b: any) => ({ ...b, type: alive.get(String(b.id)).type === "text" ? "text" : "arrow" }));
      cut += el.boundElements.length - kept.length;
      el.boundElements = kept.length ? kept : null;
    }
  }
  return cut;
};

/** an element as Excalidraw needs it, at least (an invalid change never reaches Drive) */
export const validElement = (el: any) =>
  !!el &&
  typeof el === "object" &&
  typeof el.id === "string" &&
  typeof el.type === "string" &&
  (el.isDeleted || ["x", "y", "width", "height"].every((key) => typeof el[key] === "number" && Number.isFinite(el[key])));

// -----------------------------------------------------------------------------
// content comparison (outside changes)
// -----------------------------------------------------------------------------

/** stamps are no content; empty fields (null, [], missing) are the same; key order doesn't matter */
const STAMPS = new Set(["version", "versionNonce", "updated"]);

const canonical = (value: any, top = false): any => {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = value[key];
      if ((top && STAMPS.has(key)) || field === null || field === undefined || (Array.isArray(field) && !field.length)) {
        continue;
      }
      out[key] = canonical(field);
    }
    return out;
  }
  return value;
};

/** the same content of a subject on both sides (both missing counts as the same) */
export const sameContent = (k: EventKind, a: any, b: any) => {
  if (!a || !b) {
    return !a && !b;
  }
  if (k === "el" && (a.isDeleted || b.isDeleted)) {
    return !!a.isDeleted === !!b.isDeleted && (a.isDeleted || JSON.stringify(canonical(a, true)) === JSON.stringify(canonical(b, true)));
  }
  if (k === "file") {
    return a.dataURL === b.dataURL && a.mimeType === b.mimeType;
  }
  return JSON.stringify(canonical(a, k === "el")) === JSON.stringify(canonical(b, k === "el"));
};

// -----------------------------------------------------------------------------
// the Drive file
// -----------------------------------------------------------------------------

export const DEFAULT_SETTINGS = { viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false };

const byIndex = (a: any, b: any) => {
  const [x, y] = [a.index ?? "", b.index ?? ""];
  return x < y ? -1 : x > y ? 1 : 0;
};

export type FileMeta = {
  op: string;
  /** with the time each tab's receipt last changed (receipts expire after 30 days, also across reseeds) */
  receipts: Record<string, Receipt & { at?: number }>;
  authors: Record<string, string>;
  onBehalf: Array<{ by: string; for: string; at: number }>;
};

/**
 * The scene file Drive gets (PROTOCOL §6): the live elements in z-order,
 * the settings, the images and embedded fonts live elements use, and Kurviq's
 * record (operation id, receipts, authors, on-behalf list). Images and fonts
 * no element uses yet (sent ahead of the element that will use them) are kept
 * too: their batch is receipted as saved, so Drive must really have them.
 * Those only deleted elements use are left out, as Excalidraw does.
 */
export const buildSceneFile = (plain: Map<string, { k: EventKind; value: any }>, meta: FileMeta) => {
  repairGraph(plain);
  const elements: any[] = [];
  const files: Record<string, unknown> = {};
  const fonts = new Map<number, any>();
  let settings: any = null;
  let name: string | null = null;
  for (const { k, value } of plain.values()) {
    if (k === "el" && !value.isDeleted) {
      elements.push(value);
    } else if (k === "set") {
      settings = value;
    } else if (k === "name") {
      name = typeof value?.name === "string" ? value.name : null;
    } else if (k === "font" && typeof value?.id === "number") {
      fonts.set(value.id, value);
    }
  }
  elements.sort(byIndex);
  const usedFonts = new Map<number, any>();
  const takeFont = (id: number) => {
    const { family, faces, source } = fonts.get(id);
    usedFonts.set(id, { family, id, faces, source });
  };
  const referencedFiles = new Set<string>();
  const referencedFonts = new Set<number>();
  for (const { k, value } of plain.values()) {
    if (k === "el") {
      value.fileId && referencedFiles.add(value.fileId);
      typeof value.fontFamily === "number" && referencedFonts.add(value.fontFamily);
    }
  }
  for (const el of elements) {
    const file = el.fileId ? plain.get(eventKey("file", el.fileId)) : undefined;
    if (file) {
      files[el.fileId] = file.value;
    }
    if (typeof el.fontFamily === "number" && fonts.has(el.fontFamily)) {
      takeFont(el.fontFamily);
    }
  }
  for (const { k, value } of plain.values()) {
    if (k === "file" && value?.id && !referencedFiles.has(value.id)) {
      files[value.id] = value;
    }
  }
  for (const id of fonts.keys()) {
    if (!referencedFonts.has(id)) {
      takeFont(id);
    }
  }
  const pick = (key: keyof typeof DEFAULT_SETTINGS) => settings?.[key] ?? DEFAULT_SETTINGS[key];
  const data: Record<string, unknown> = {
    type: "excalidraw",
    version: 2,
    source: "https://kurviq.com",
    elements,
    appState: {
      viewBackgroundColor: pick("viewBackgroundColor"),
      gridSize: pick("gridSize"),
      gridStep: pick("gridStep"),
      gridModeEnabled: pick("gridModeEnabled"),
    },
    files,
  };
  if (usedFonts.size) {
    data.kurviqFonts = [...usedFonts.values()];
  }
  data.kurviq = { v: 1, ...meta };
  return { json: JSON.stringify(data, null, 2), name };
};

/** a scene file from Drive → its subjects (eventKey → kind, id, plain value); fonts need their hash (async) */
export const subjectsOfFile = async (json: string, driveName: string | null, hashFont: (font: any) => Promise<string>) => {
  const data = JSON.parse(json);
  if (!data || typeof data !== "object" || !Array.isArray(data.elements)) {
    throw new Error("not a scene file");
  }
  const out = new Map<string, { k: EventKind; id: string; value: any }>();
  const elements = data.elements.filter((el: any) => validElement(el) && !el.isDeleted);
  // files from apps that don't keep fractional indices: the array order is the z-order
  if (elements.some((el: any) => typeof el.index !== "string")) {
    let previous: string | null = null;
    for (const el of elements) {
      el.index = generateKeyBetween(previous, null);
      previous = el.index;
    }
  }
  for (const el of elements) {
    out.set(eventKey("el", el.id), { k: "el", id: el.id, value: el });
  }
  const app = data.appState || {};
  out.set(eventKey("set", SETTINGS_ID), {
    k: "set",
    id: SETTINGS_ID,
    value: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, app[key] ?? (DEFAULT_SETTINGS as any)[key]])),
  });
  for (const [id, file] of Object.entries<any>(data.files && typeof data.files === "object" ? data.files : {})) {
    if (file && typeof file.dataURL === "string") {
      out.set(eventKey("file", id), { k: "file", id, value: { ...file, id } });
    }
  }
  for (const font of Array.isArray(data.kurviqFonts) ? data.kurviqFonts : []) {
    if (font && typeof font.id === "number" && Array.isArray(font.faces)) {
      const hash = await hashFont(font);
      out.set(eventKey("font", hash), { k: "font", id: hash, value: font });
    }
  }
  if (driveName) {
    out.set(eventKey("name", NAME_ID), { k: "name", id: NAME_ID, value: { name: driveName.replace(/\.excalidraw$/, "") } });
  }
  return out;
};

export { readableOf };

// -----------------------------------------------------------------------------
// element order: clashing fractional indices
// -----------------------------------------------------------------------------

/** a valid index strictly between `below` and `above` (either may be missing) */
export const indexBetween = (below: string | null, above: string | null) => {
  try {
    return generateKeyBetween(below, above && (!below || above > below) ? above : null);
  } catch {
    return null;
  }
};
