// Renders a scene (or part of it) to PNG with Excalidraw's own exporter, so
// agents can look at scenes without any browser automation.

import { registerSceneFonts } from "./fonts";
import { scenesController } from "./controller";
import { fillFiles } from "./leanFiles";
import {
  Fonts,
  exportToBlob,
  exportToCanvas,
  elementsOverlappingBBox,
  getCommonBounds,
  getNonDeletedElements,
  restoreElements,
} from "@excalidraw/excalidraw";

import { withTemplate } from "./cowork";
import { pickSlides } from "./pdfExport";
import { elementStep, getSlides, slideTitle } from "./slides";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export type RenderCommand = {
  type: "render";
  /** scene to render; omitted = the scene open in this tab (incl. unsaved edits) */
  scene?: { elements: any[]; files?: BinaryFiles; appState?: any };
  /** focus on these elements (plus everything overlapping their area) */
  elementIds?: string[];
  /** focus on a scene-coordinate region */
  region?: { x: number; y: number; width: number; height: number };
  /** margin around elementIds (scene px), default 80 */
  padding?: number;
  /** longest side of the PNG in px, default 1500 */
  maxSize?: number;
  /** the scene's name: its slides get their template copies, {deck} is filled in */
  deck?: string;
  /** render just this slide (1-based number in deck order, or the frame id), cropped like in a presentation */
  slide?: number | string;
  /** with slide: what the audience sees after this many clicks (default: everything) */
  step?: number;
  /** contact sheet of these slides ("all", "2-5", [1, 3]) in one image */
  sheet?: "all" | string | Array<number | string>;
  /** with sheet: one tile per click step of each slide */
  steps?: boolean;
};

const MAX_TILES = 48;

/** all (or some) slides in one image, as the audience sees them */
const renderSheet = async (
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles,
  background: string,
  command: RenderCommand,
) => {
  const slides = getSlides(elements);
  const frames = pickSlides(elements, command.sheet, { includeSkipped: true });
  const byId = new Map(elements.map((el) => [el.id, el]));
  const tiles: Array<{ frame: (typeof frames)[number]; step?: number; label: string }> = [];
  for (const frame of frames) {
    const number = slides.indexOf(frame) + 1;
    const children = elements.filter((el) => el.frameId === frame.id);
    const last = Math.max(0, ...children.map((el) => elementStep(el, byId)));
    const title = `${number} · ${slideTitle(frame, number - 1)}`;
    if (command.steps && last > 0) {
      for (let step = 0; step <= last; step++) {
        tiles.push({ frame, step, label: `${title} · click ${step}/${last}` });
      }
    } else {
      tiles.push({ frame, step: command.step, label: command.step !== undefined ? `${title} · click ${command.step}` : title });
    }
  }
  if (tiles.length > MAX_TILES) {
    throw new Error(`${tiles.length} tiles: too many for one image (max ${MAX_TILES}); pick fewer slides`);
  }
  const width = Math.min(4000, Math.max(600, command.maxSize ?? 2000));
  const cols = Math.min(tiles.length, tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4);
  const gap = 16;
  const labelHeight = 26;
  const tileWidth = Math.floor((width - gap * (cols + 1)) / cols);
  const aspect = tiles[0].frame.height / tiles[0].frame.width;
  const tileHeight = Math.round(tileWidth * aspect);
  const rows = Math.ceil(tiles.length / cols);
  const sheet = document.createElement("canvas");
  sheet.width = width;
  sheet.height = rows * (tileHeight + labelHeight + gap) + gap;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#3a3a3a";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  await Fonts.loadElementsFonts(elements).catch(() => []);
  for (const [i, tile] of tiles.entries()) {
    const shown = elements.filter(
      (el) =>
        el.id === tile.frame.id ||
        (el.frameId === tile.frame.id && (tile.step === undefined || elementStep(el, byId) <= tile.step)),
    );
    const canvas = await exportToCanvas({
      elements: shown,
      files,
      appState: { exportBackground: true, viewBackgroundColor: background, exportWithDarkMode: false },
      exportPadding: 0,
      exportingFrame: tile.frame as any,
      getDimensions: (w: number, h: number) => ({ width: tileWidth, height: (tileWidth * h) / w, scale: tileWidth / w }),
    });
    const x = gap + (i % cols) * (tileWidth + gap);
    const y = gap + Math.floor(i / cols) * (tileHeight + labelHeight + gap);
    ctx.drawImage(canvas, x, y, tileWidth, tileHeight);
    ctx.fillStyle = "#f1f1f1";
    ctx.font = "15px sans-serif";
    ctx.fillText(tile.label.length > 70 ? `${tile.label.slice(0, 67)}…` : tile.label, x, y + tileHeight + 19, tileWidth);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    sheet.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/png"),
  );
  return {
    png: await blobToBase64(blob),
    tiles: tiles.map((tile) => tile.label),
    elementsTotal: elements.length,
  };
};

type Bounds = [number, number, number, number];

const round = (n: number) => Math.round(n);
const boundsToRect = ([x1, y1, x2, y2]: Bounds) => ({
  x: round(x1),
  y: round(y1),
  width: round(x2 - x1),
  height: round(y2 - y1),
});

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

/** containers bring their labels, labels bring their containers */
const withBoundText = <T extends ExcalidrawElement>(
  picked: readonly T[],
  all: readonly T[],
) => {
  const ids = new Set(picked.map((el) => el.id));
  for (const el of all) {
    const containerId = (el as any).containerId;
    if (containerId && ids.has(containerId)) {
      ids.add(el.id);
    }
    if (ids.has(el.id) && containerId) {
      ids.add(containerId);
    }
  }
  return all.filter((el) => ids.has(el.id));
};

export const renderScene = async (
  command: RenderCommand,
  open: () => {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
    background: string;
  },
  convert: (elements: any[]) => Promise<any[]>,
) => {
  await document.fonts.load("20px Excalifont").catch(() => {});

  let elements: readonly ExcalidrawElement[];
  let files: BinaryFiles;
  let background: string;
  if (command.scene) {
    // custom fonts first: the picture must show them
    await registerSceneFonts(command.scene as any);
    const raw = command.scene.elements || [];
    const needsConversion = raw.some(
      (el: any) => el?.label !== undefined || el?.version === undefined,
    );
    elements = needsConversion
      ? await convert(raw)
      : restoreElements(raw, null, { repairBindings: true });
    // a lean scene (from the agent's server) gets its images back from this tab
    files = await fillFiles(command.scene.files, scenesController.getApi()?.getFiles());
    background = command.scene.appState?.viewBackgroundColor || "#ffffff";
  } else {
    ({ elements, files, background } = open());
  }
  if (command.deck !== undefined) {
    elements = withTemplate([...elements], command.deck);
  }
  let visible: readonly NonDeletedExcalidrawElement[] =
    getNonDeletedElements(elements);
  elements = visible;
  if (!elements.length) {
    throw new Error("The scene is empty");
  }

  if (command.sheet !== undefined) {
    return renderSheet(visible, files, background, command);
  }

  let slide: NonDeletedExcalidrawElement | null = null;
  if (command.slide !== undefined) {
    const slides = getSlides(visible);
    const frames = visible.filter((el) => el.type === "frame");
    slide =
      typeof command.slide === "number"
        ? slides[command.slide - 1] ?? null
        : frames.find((el) => el.id === command.slide) ?? null;
    if (!slide) {
      throw new Error(
        typeof command.slide === "number"
          ? `No slide ${command.slide}: the deck has ${slides.length} slides`
          : `No frame with id "${command.slide}"`,
      );
    }
    const byId = new Map(visible.map((el) => [el.id, el]));
    const frameId = slide.id;
    visible = visible.filter(
      (el) =>
        el.id === frameId ||
        (el.frameId === frameId &&
          (command.step === undefined || elementStep(el, byId) <= command.step)),
    );
  }

  const sceneBounds = getCommonBounds(elements) as Bounds;
  let focus: Bounds | null = null;
  if (command.elementIds?.length) {
    const wanted = new Set(command.elementIds);
    const picked = withBoundText(
      elements.filter((el) => wanted.has(el.id)),
      elements,
    );
    if (!picked.length) {
      throw new Error("None of the given elementIds exist in the scene");
    }
    const pad = command.padding ?? 80;
    const [x1, y1, x2, y2] = getCommonBounds(picked) as Bounds;
    focus = [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
  } else if (command.region) {
    const { x, y, width, height } = command.region;
    focus = [x, y, x + width, y + height];
  }

  const shown = slide
    ? visible
    : focus
    ? withBoundText(
        elementsOverlappingBBox({
          elements: visible,
          bounds: focus,
          type: "overlap",
        }),
        visible,
      )
    : visible;
  if (!shown.length) {
    throw new Error("Nothing is drawn in that region");
  }

  const maxSize = Math.min(4000, Math.max(200, command.maxSize ?? 1500));
  let scale = 1;
  // the scene's fonts (and the characters used) must be loaded, or the
  // image shows fallback fonts the user's browser doesn't
  await Fonts.loadElementsFonts(shown).catch(() => []);
  const blob = await exportToBlob({
    elements: shown,
    files,
    appState: {
      exportBackground: true,
      viewBackgroundColor: background,
      exportWithDarkMode: false,
    },
    exportPadding: slide ? 0 : 20,
    ...(slide ? { exportingFrame: slide as any } : {}),
    mimeType: "image/png",
    getDimensions: (width: number, height: number) => {
      // never upscale more than 2x, never exceed maxSize
      scale = Math.min(2, maxSize / Math.max(width, height));
      return { width: width * scale, height: height * scale, scale };
    },
  });

  return {
    png: await blobToBase64(blob),
    scale: Math.round(scale * 1000) / 1000,
    renderedBounds: boundsToRect(getCommonBounds(shown) as Bounds),
    sceneBounds: boundsToRect(sceneBounds),
    elementsRendered: shown.length,
    elementsTotal: elements.length,
  };
};
