// "Move my browser scenes": the browser keeps scenes per site (http://draw.test
// and https://draw.test are two sites). The old site writes everything Kurviq
// keeps in the browser into one file; the new site reads it in. Both happen in
// the user's browser; nothing passes a server.
//
// What moves: every space's scene list (localStorage "excalidraw-scenes…"), its
// stored scenes (IndexedDB "excalidraw-scenes-db…", pictures and comments are
// inside them), the open scene (handed in as a snapshot: it lives in the
// editor's own keys), the font library, and Kurviq's settings. Never: sign-ins
// (sessions, tokens), the tab's open shared scene, agent helpers.

import type { ScenesMeta, Snapshot } from "./storage";

import { mergeSpaceMeta, UNTITLED } from "./spaces";

export const MOVE_FORMAT = "kurviq-browser-scenes";
const META_PREFIX = "excalidraw-scenes";
const FONTS = { db: "kurviq-fonts", store: "fonts" };

/** the browser storage the move reads and writes (injected, so it can be tested without a browser) */
export type MoveStorage = {
  localKeys: () => string[];
  getLocal: (key: string) => string | null;
  setLocal: (key: string, value: string) => void;
  entries: (db: string, store: string) => Promise<[string, unknown][]>;
  put: (db: string, store: string, entries: [string, unknown][]) => Promise<void>;
};

export type MoveFile = {
  format: typeof MOVE_FORMAT;
  version: 1;
  from: string;
  at: string;
  /** Kurviq's settings (only keys the new site doesn't have yet are taken) */
  settings: Record<string, string>;
  /** per space: its scene list and stored scenes */
  spaces: { metaKey: string; meta: ScenesMeta; snapshots: [string, Snapshot][] }[];
  fonts: [string, unknown][];
};

/** the open scene: its space's list key, name (null: untitled) and content */
export type OpenScene = { metaKey: string; name: string | null; snapshot: Snapshot };

/** settings that never move: sign-ins, the tab's open shared scene, live and pairing state */
const PRIVATE = /session|token|secret|pairing|refresh|^kurviq-live|^kurviq-space$/i;

const isMetaKey = (key: string) => key === META_PREFIX || key.startsWith(`${META_PREFIX}@`);
const isSetting = (key: string) => key.startsWith("kurviq-") && !PRIVATE.test(key);

/** the IndexedDB of a space's stored scenes, from its list's localStorage key */
export const snapshotDbOf = (metaKey: string) => `${META_PREFIX}-db${metaKey.slice(META_PREFIX.length)}`;

const parseMeta = (raw: string | null): ScenesMeta | null => {
  try {
    const meta = raw ? JSON.parse(raw) : null;
    return meta && typeof meta === "object" && meta.scenes && typeof meta.scenes === "object" ? meta : null;
  } catch {
    return null;
  }
};

/**
 * The untitled scene becomes a named one ("Untitled", or a free variant), and
 * the list names no open scene: on the new site the open scene is whatever its
 * editor shows, so a name here would hand that canvas the moved scene's name.
 */
const portable = (meta: ScenesMeta, snapshots: Map<string, Snapshot>) => {
  const scenes = { ...meta.scenes };
  const untitled = snapshots.get(UNTITLED);
  if (untitled) {
    let name = "Untitled";
    let n = 1;
    while (name in scenes) {
      n++;
      name = `Untitled ${n}`;
    }
    scenes[name] = { ...scenes[UNTITLED], baseMd5: null, localOnly: true, dirty: true } as ScenesMeta["scenes"][string];
    snapshots.set(name, { ...untitled, baseline: null, dirty: true });
    snapshots.delete(UNTITLED);
  }
  delete scenes[UNTITLED];
  // only scenes with stored content move (a list entry without content would open empty)
  for (const name of Object.keys(scenes)) {
    if (!snapshots.has(name)) {
      delete scenes[name];
    }
  }
  return { ...meta, scenes, current: null, baseline: null };
};

/** everything Kurviq keeps in this browser, as one file's content */
export const exportBrowserScenes = async (storage: MoveStorage, open: OpenScene | null, from: string): Promise<MoveFile> => {
  const keys = storage.localKeys();
  const settings: Record<string, string> = {};
  for (const key of keys.filter(isSetting)) {
    settings[key] = storage.getLocal(key) ?? "";
  }
  const spaces: MoveFile["spaces"] = [];
  for (const metaKey of keys.filter(isMetaKey).sort((a, b) => a.localeCompare(b))) {
    const meta = parseMeta(storage.getLocal(metaKey));
    if (!meta) {
      continue;
    }
    const stored = await storage.entries(snapshotDbOf(metaKey), "snapshots"); // NOSONAR S9382: one space at a time (snapshots can be many MB)
    const snapshots = new Map(stored as [string, Snapshot][]);
    if (open?.metaKey === metaKey) {
      snapshots.set(open.name ?? UNTITLED, open.snapshot);
    }
    const moved = portable(meta, snapshots);
    spaces.push({ metaKey, meta: moved, snapshots: [...snapshots].filter(([name]) => name in moved.scenes) });
  }
  return {
    format: MOVE_FORMAT,
    version: 1,
    from,
    at: new Date().toISOString(),
    settings,
    spaces,
    fonts: await storage.entries(FONTS.db, FONTS.store),
  };
};

export type MoveResult = { scenes: number; renamed: [string, string][]; fonts: number };

/** a file's content, checked: a move file of this format, or an error saying why not */
export const readMoveFile = (text: string): MoveFile => {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a Kurviq browser scenes file (not JSON).");
  }
  if (data?.format !== MOVE_FORMAT || data.version !== 1 || !Array.isArray(data.spaces) || !Array.isArray(data.fonts)) {
    throw new Error("This is not a Kurviq browser scenes file.");
  }
  for (const space of data.spaces) {
    if (typeof space?.metaKey !== "string" || !isMetaKey(space.metaKey) || !parseMeta(JSON.stringify(space.meta)) || !Array.isArray(space.snapshots)) {
      throw new Error("The file is damaged (a scene list is unreadable).");
    }
  }
  return data as MoveFile;
};

const importSpace = async (storage: MoveStorage, space: MoveFile["spaces"][number], result: MoveResult) => {
  const target = parseMeta(storage.getLocal(space.metaKey));
  const { meta, renames } = mergeSpaceMeta(target, space.meta, true);
  // the new site's open scene stays open (its content is in its editor)
  meta.current = target?.current ?? null;
  meta.baseline = target?.baseline ?? null;
  const snapshots = new Map(space.snapshots);
  const writes: [string, unknown][] = [];
  for (const [name, to] of renames) {
    const snapshot = snapshots.get(name);
    if (snapshot) {
      writes.push([to, to === name ? snapshot : { ...snapshot, baseline: null, dirty: true }]);
      if (to !== name) {
        result.renamed.push([name, to]);
      }
    }
  }
  // the scenes are written completely before the list names them
  await storage.put(snapshotDbOf(space.metaKey), "snapshots", writes);
  storage.setLocal(space.metaKey, JSON.stringify(meta));
  result.scenes += writes.length;
};

/**
 * Read a move file into this browser. Scenes the new site has a scene of that
 * name for already get a free name (nothing is overwritten); settings and
 * fonts are only added. The caller reloads the page right afterwards.
 */
export const importBrowserScenes = async (storage: MoveStorage, file: MoveFile): Promise<MoveResult> => {
  const result: MoveResult = { scenes: 0, renamed: [], fonts: 0 };
  for (const space of file.spaces) {
    await importSpace(storage, space, result); // NOSONAR S9382: one space at a time (snapshots can be many MB)
  }
  const known = new Set((await storage.entries(FONTS.db, FONTS.store)).map(([key]) => key));
  const fonts = file.fonts.filter(([key]) => !known.has(key));
  await storage.put(FONTS.db, FONTS.store, fonts);
  result.fonts = fonts.length;
  for (const [key, value] of Object.entries(file.settings ?? {})) {
    if (isSetting(key) && storage.getLocal(key) === null) {
      storage.setLocal(key, value);
    }
  }
  return result;
};

// -----------------------------------------------------------------------------
// the file: JSON with binary values (font files, pictures kept as bytes) tagged
// -----------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/** a stored value as plain JSON: bytes, Blobs and dates tagged with "$kq" */
export const encodeValue = async (value: unknown): Promise<unknown> => {
  if (value instanceof Uint8Array) {
    return { $kq: "u8", b64: toBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { $kq: "ab", b64: toBase64(new Uint8Array(value)) };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { $kq: "blob", type: value.type, b64: toBase64(new Uint8Array(await value.arrayBuffer())) };
  }
  if (value instanceof Date) {
    return { $kq: "date", at: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(encodeValue));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await encodeValue(inner)] as const));
    const plain = Object.fromEntries(entries);
    // an object of the user's that happens to have "$kq" stays itself
    return "$kq" in plain ? { $kq: "obj", value: plain } : plain;
  }
  return value;
};

const decodeTagged = (tagged: Record<string, any>): unknown => {
  switch (tagged.$kq) {
    case "u8":
      return fromBase64(tagged.b64);
    case "ab":
      return fromBase64(tagged.b64).buffer;
    case "blob":
      return new Blob([fromBase64(tagged.b64)], { type: tagged.type });
    case "date":
      return new Date(tagged.at);
    default:
      return Object.fromEntries(Object.entries(tagged.value ?? {}).map(([key, inner]) => [key, decodeValue(inner)]));
  }
};

/** the stored value back from encodeValue's JSON */
export const decodeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$kq === "string") {
      return decodeTagged(record);
    }
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, decodeValue(inner)]));
  }
  return value;
};

/** the move file's text */
export const moveFileText = async (file: MoveFile) => JSON.stringify(await encodeValue(file));

/** a move file's content from its text (checked) */
export const parseMoveFileText = (text: string) => {
  const checked = readMoveFile(text);
  return decodeValue(checked) as MoveFile;
};
