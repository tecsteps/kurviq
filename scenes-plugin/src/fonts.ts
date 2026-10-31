// Custom fonts (Geist, JetBrains Mono, a company font …) next to
// Excalidraw's own, from Google Fonts or a font file.
//
// Excalidraw stores a text's font as a number. A custom font gets a number
// derived from its name (the same in every browser) and is registered where
// Excalidraw looks fonts up at runtime: the name ↔ number table, the font
// metrics, its font registry (the font picker, SVG and PDF export) and the
// document's fonts (the canvas). No upstream code changes.
//
// The font travels with the scene: a scene that uses one carries its data in
// a top-level "kurviqFonts" field (added when the scene is serialized, read
// when it is loaded), so it looks the same for teammates, in shared and
// public links, in PDFs and for agents. This browser also keeps every font
// it has seen in a small library (IndexedDB), so the font picker offers them
// in other scenes too.

import { FONT_FAMILY, Fonts } from "@excalidraw/excalidraw";
import { FONT_METADATA } from "@excalidraw/common";
import { ExcalidrawFontFace } from "@excalidraw/excalidraw/fonts/ExcalidrawFontFace";
import { createStore, entries, get, set } from "idb-keyval";

import { FAMILY_RE, MAX_FONT_BYTES, googleFaces, toDataUrl } from "../../scenes-mcp/googleFonts.mjs";

export type FontFaceData = {
  /** data URL of the font file (woff2 / woff / ttf / otf) */
  data: string;
  /** CSS unicode-range of this file, if it covers only part of the font */
  range?: string;
};

export type CustomFont = {
  family: string;
  id: number;
  faces: FontFaceData[];
  source: "google" | "file";
};

/** the numbers of custom fonts (Excalidraw's own are below 20, its fallbacks at 100 and 998–1000) */
const ID_BASE = 2000;
const ID_RANGE = 7000;
const DATA_RE = /^data:(font\/(woff2|woff|ttf|otf|sfnt)|application\/(font-woff2?|x-font-ttf|x-font-otf|vnd\.ms-opentype|octet-stream));base64,[A-Za-z0-9+/=]+$/;
const RANGE_RE = /^[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?(\s*,\s*[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?)*$/;

/** Excalidraw's own font names: a custom font may not take one over */
const BUILT_IN = new Set(Object.keys(FONT_FAMILY).map((name) => name.toLowerCase()));

/** a font's number, from its name: the same everywhere */
export const fontIdFor = (family: string) => {
  let hash = 2166136261;
  for (const char of family.trim().toLowerCase()) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return ID_BASE + ((hash >>> 0) % ID_RANGE);
};

export const isCustomFontId = (id: unknown): id is number =>
  typeof id === "number" && id >= ID_BASE && id < ID_BASE + ID_RANGE;

// -----------------------------------------------------------------------------
// registry (this page)
// -----------------------------------------------------------------------------

const registered = new Map<number, CustomFont>();
const listeners = new Set<() => void>();
let version = 0;

export const customFonts = {
  list: () => [...registered.values()].sort((a, b) => a.family.localeCompare(b.family)),
  get: (id: number) => registered.get(id),
  byName: (family: string) => [...registered.values()].find((font) => font.family.toLowerCase() === family.trim().toLowerCase()),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  version: () => version,
};

/** a font's data is checked before anything uses it: it comes from scenes, files and the web */
const validFont = (font: any): font is CustomFont =>
  !!font &&
  typeof font.family === "string" &&
  FAMILY_RE.test(font.family) &&
  !BUILT_IN.has(font.family.toLowerCase()) &&
  // its number from its name, or another custom number live sync gave it (two fonts had the same one)
  isCustomFontId(font.id) &&
  Array.isArray(font.faces) &&
  font.faces.length > 0 &&
  font.faces.length <= 8 &&
  font.faces.every(
    (face: any) =>
      face &&
      typeof face.data === "string" &&
      face.data.length <= (MAX_FONT_BYTES * 4) / 3 + 100 &&
      DATA_RE.test(face.data) &&
      (face.range === undefined || (typeof face.range === "string" && RANGE_RE.test(face.range))),
  );

/** ascender / descender as the browser renders the font (instead of reading the font's tables) */
const measureMetrics = (family: string) => {
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = `1000px "${family}"`;
    const metrics = context.measureText("Hgjy");
    if (metrics.fontBoundingBoxAscent > 0) {
      return { ascender: Math.round(metrics.fontBoundingBoxAscent), descender: -Math.round(metrics.fontBoundingBoxDescent) };
    }
  }
  return { ascender: 950, descender: -250 };
};

const loading = new Map<number, Promise<void>>();

/** make a font usable in this page (once) */
export const registerFont = (input: CustomFont, { replace = false }: { replace?: boolean } = {}): Promise<void> => {
  if (!validFont(input)) {
    return Promise.reject(new Error("Not a usable font"));
  }
  // under a number not its name's (live sync reassigned it): registered under its own name "<family> <number>",
  // so it never takes the name of the font that has its original number
  const font = input.id === fontIdFor(input.family) ? input : fontWithId({ ...input, id: fontIdFor(input.family) }, input.id);
  const existing = registered.get(font.id);
  if (existing && !(replace && JSON.stringify(existing.faces) !== JSON.stringify(font.faces))) {
    return loading.get(font.id) ?? Promise.resolve();
  }
  if (existing) {
    // another font had this number in this browser: the scene's own wins (its text is measured with it)
    delete (FONT_FAMILY as Record<string, number>)[existing.family];
    registered.delete(font.id);
    loading.delete(font.id);
  }
  registered.set(font.id, font);
  const done = (async () => {
    // the browser's fonts first: measuring and the canvas need the real font
    const faces = font.faces.map(
      (face) => new FontFace(font.family, `url(${face.data})`, face.range ? { unicodeRange: face.range } : {}),
    );
    faces.forEach((face) => document.fonts.add(face));
    await Promise.all(faces.map((face) => face.load()));
    (FONT_FAMILY as Record<string, number>)[font.family] = font.id;
    FONT_METADATA[font.id] = { metrics: { unitsPerEm: 1000, ...measureMetrics(font.family), lineHeight: 1.25 } };
    // Excalidraw's registry: the font picker, and fonts embedded in SVG / PDF exports
    Fonts.registered.set(font.id as any, {
      metadata: FONT_METADATA[font.id],
      fontFaces: font.faces.map(
        (face) => new ExcalidrawFontFace(font.family, face.data, face.range ? { unicodeRange: face.range } : undefined),
      ),
    });
    version++;
    listeners.forEach((listener) => listener());
  })();
  loading.set(font.id, done);
  done.catch(() => {
    registered.delete(font.id);
    loading.delete(font.id);
  });
  return done;
};

/**
 * A font under the number live sync assigned it (its own clashed with
 * another font's in the scene): a copy named "<family> <number>", so the two
 * never share a name or a number on the canvas, in the font picker or in files.
 */
export const fontWithId = (font: CustomFont, id: number): CustomFont =>
  id === font.id ? font : { ...font, family: `${font.family.replace(/ \d+$/, "").slice(0, 52)} ${id}`, id };

// -----------------------------------------------------------------------------
// the browser's font library
// -----------------------------------------------------------------------------

const library = createStore("kurviq-fonts", "fonts");

/** the other Kurviq tabs of this browser hear about a new font (the agent may work through one of them) */
const tabs = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kurviq-fonts") : null;
tabs?.addEventListener("message", (event) => {
  if (typeof event.data === "string") {
    get<CustomFont>(event.data, library)
      .then((font) => font && registerFont(font))
      .catch(() => {});
  }
});

/** register a font and keep it for this browser's other scenes (and its other tabs) */
export const addFont = async (font: CustomFont, options: { replace?: boolean } = {}) => {
  const known = registered.has(font.id);
  await registerFont(font, options);
  await set(font.family.toLowerCase(), font, library).catch(() => {});
  if (!known) {
    tabs?.postMessage(font.family.toLowerCase());
  }
};

/** on start: every font this browser has seen */
export const loadFontLibrary = async () => {
  try {
    for (const [, font] of await entries<string, CustomFont>(library)) {
      registerFont(font).catch(() => {});
    }
  } catch {}
};

// -----------------------------------------------------------------------------
// fonts in scenes
// -----------------------------------------------------------------------------

/** the custom fonts a scene's elements use */
const usedIds = (elements: readonly any[]) => {
  const ids = new Set<number>();
  for (const el of elements) {
    if (!el?.isDeleted && isCustomFontId(el.fontFamily)) {
      ids.add(el.fontFamily);
    }
    const themeFont = el?.customData?.slides?.theme?.fontFamily;
    if (!el?.isDeleted && isCustomFontId(themeFont)) {
      ids.add(themeFont);
    }
  }
  return ids;
};

/**
 * A serialized scene (JSON.stringify(…, null, 2) of a scene object) plus the
 * custom fonts its elements use. Scenes without custom fonts stay as they are.
 */
export const withFonts = (json: string, elements: readonly any[]) => {
  const fonts = [...usedIds(elements)].map((id) => registered.get(id)).filter((font): font is CustomFont => !!font);
  if (!fonts.length || !json.endsWith("}")) {
    return json;
  }
  const field = JSON.stringify(fonts.map(({ family, id, faces, source }) => ({ family, id, faces, source })));
  return `${json.slice(0, json.lastIndexOf("}")).trimEnd()},\n  "kurviqFonts": ${field}\n}`;
};

/** two versions of a scene: the fonts of both (by number) */
export const mergeFontLists = (...lists: unknown[]) => {
  const merged = new Map<number, CustomFont>();
  for (const list of lists) {
    if (Array.isArray(list)) {
      list.filter(validFont).forEach((font) => merged.set(font.id, font));
    }
  }
  return merged.size ? [...merged.values()] : undefined;
};

/** a loaded scene's fonts become usable (and part of this browser's library) */
export const registerSceneFonts = (data: { kurviqFonts?: unknown } | null | undefined) => {
  const fonts = Array.isArray(data?.kurviqFonts) ? data!.kurviqFonts.filter(validFont) : [];
  return Promise.all(fonts.map((font) => addFont(font).catch(() => {})));
};

/** an agent may name a font ("Geist") instead of its number */
export const fontFamilyValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const builtIn = Object.entries(FONT_FAMILY).find(([name]) => name.toLowerCase() === value.trim().toLowerCase());
  return builtIn ? builtIn[1] : customFonts.byName(value)?.id ?? value;
};

// -----------------------------------------------------------------------------
// importing
// -----------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };

/** a font file the user picked */
export const fontFromFile = async (file: File, family: string): Promise<CustomFont> => {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error("Use a .woff2, .woff, .ttf or .otf file");
  }
  if (file.size > MAX_FONT_BYTES) {
    throw new Error(`The file is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`);
  }
  const name = family.trim();
  checkFamily(name);
  return { family: name, id: fontIdFor(name), faces: [{ data: toDataUrl(await file.arrayBuffer(), mime) }], source: "file" };
};

const checkFamily = (family: string) => {
  if (!FAMILY_RE.test(family)) {
    throw new Error("Name: letters, digits, spaces, . _ - (up to 60)");
  }
  if (BUILT_IN.has(family.toLowerCase())) {
    throw new Error(`"${family}" is one of Excalidraw's own fonts`);
  }
};

/**
 * A font from Google Fonts by name. Online through Kurviq's Worker (which
 * fetches and caches it, so visitors' browsers don't talk to Google); in the
 * local install straight from Google.
 */
export const fontFromGoogle = async (family: string, { online }: { online: boolean }): Promise<CustomFont> => {
  const name = family.trim();
  checkFamily(name);
  let faces: FontFaceData[];
  if (online) {
    const res = await fetch(`/api/fonts/google?family=${encodeURIComponent(name)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Google Fonts: ${res.status}`);
    }
    faces = body.faces;
  } else {
    const found = await googleFaces(name);
    if (!found) {
      throw new Error(`"${name}" is not on Google Fonts`);
    }
    faces = found;
  }
  const font: CustomFont = { family: name, id: fontIdFor(name), faces, source: "google" };
  if (!validFont(font)) {
    throw new Error(`"${name}" could not be loaded from Google Fonts`);
  }
  return font;
};
