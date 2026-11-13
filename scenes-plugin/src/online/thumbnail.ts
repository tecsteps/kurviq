// Draws a scene's preview for Google Drive (contentHints.thumbnail) with
// Excalidraw's own exporter, in the tab that saves: the whole scene, or a
// deck's first slide, on the scene's background. Browser only; what to draw
// and the encoding rules are in contentHints.ts.

import { Fonts, exportToCanvas, getNonDeletedElements, restoreElements } from "@excalidraw/excalidraw";

import { registerSceneFonts } from "../fonts";

import { THUMBNAIL_MAX_BYTES, base64Length, thumbnailScale, toBase64Url } from "./contentHints";

import type { Thumbnail, ThumbnailTarget } from "./contentHints";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

const encode = (canvas: HTMLCanvasElement, mimeType: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the preview"))), mimeType, quality),
  );

const base64Of = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return toBase64Url(btoa(binary));
};

const smaller = (canvas: HTMLCanvasElement) => {
  const half = document.createElement("canvas");
  half.width = Math.max(1, Math.round(canvas.width / 2));
  half.height = Math.max(1, Math.round(canvas.height / 2));
  half.getContext("2d")?.drawImage(canvas, 0, 0, half.width, half.height);
  return half;
};

/** PNG; if that is above Drive's limit (photos), JPEG, then smaller until it fits */
const fitted = async (canvas: HTMLCanvasElement): Promise<Thumbnail | null> => {
  const png = await encode(canvas, "image/png");
  if (base64Length(png.size) <= THUMBNAIL_MAX_BYTES) {
    return { image: await base64Of(png), mimeType: "image/png" };
  }
  let current = canvas;
  for (let attempt = 0; attempt < 4; attempt++) {
    const jpeg = await encode(current, "image/jpeg", 0.8); // NOSONAR S9382: each attempt depends on the previous size
    if (base64Length(jpeg.size) <= THUMBNAIL_MAX_BYTES) {
      return { image: await base64Of(jpeg), mimeType: "image/jpeg" }; // NOSONAR S9382: returns: runs once, when the size fits
    }
    current = smaller(current);
  }
  return null;
};

/** the preview of a scene file's content, or null when nothing can be drawn */
export const renderThumbnail = async (data: any, target: ThumbnailTarget): Promise<Thumbnail | null> => {
  await registerSceneFonts(data);
  const elements = getNonDeletedElements(restoreElements(data.elements ?? [], null, { repairBindings: true })) as NonDeletedExcalidrawElement[];
  const frame = target.frameId ? elements.find((element) => element.id === target.frameId) : undefined;
  const shown = frame ? elements.filter((element) => element.id === frame.id || element.frameId === frame.id) : elements;
  if (!shown.length) {
    return null;
  }
  await Fonts.loadElementsFonts(shown).catch(() => []);
  const canvas = await exportToCanvas({
    elements: shown,
    files: (data.files ?? {}) as BinaryFiles,
    appState: {
      exportBackground: true,
      viewBackgroundColor: data.appState?.viewBackgroundColor ?? "#ffffff",
      exportWithDarkMode: false,
    },
    exportPadding: frame ? 0 : 16,
    ...(frame ? { exportingFrame: frame as any } : {}),
    getDimensions: (width: number, height: number) => {
      const scale = thumbnailScale(width, height);
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
    },
  });
  return fitted(canvas);
};
