// validate_deck: everything an agent (or a careful human) would look for
// slide by slide, measured with Excalidraw itself — text that doesn't fit,
// elements cut off at the slide edge, overlapping text, unreadable colors,
// click steps that never hide, missing notes.

import { getFontString } from "@excalidraw/common";
import {
  getBoundTextMaxHeight,
  getElementBounds,
  measureText,
  refreshTextDimensions,
} from "@excalidraw/element";
import { Fonts } from "@excalidraw/excalidraw";

import { withTemplate } from "./cowork";
import { elementStep, getSlides, getTemplate, getTheme, slideData, slideTitle } from "./slides";

import { LINK_COLOR } from "./richText/layout";
import { richDocOf } from "./richText/model";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

type Box = [number, number, number, number];
type Issue = { slide: number | null; id?: string; kind: string; message: string };

const MIN_FONT = 16;

const round = (n: number) => Math.round(n);

const hexToRgb = (color: string) => {
  const hex = color?.trim().replace(/^#/, "");
  if (!hex || !/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    return null;
  }
  const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const luminance = ([r, g, b]: number[]) => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

const contrast = (a: string, b: string) => {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) {
    return null;
  }
  const [l1, l2] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const intersection = (a: Box, b: Box): Box => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];
const contains = (outer: Box, x: number, y: number) =>
  x >= outer[0] && x <= outer[2] && y >= outer[1] && y <= outer[3];

const isFilled = (el: ExcalidrawElement) =>
  ["rectangle", "ellipse", "diamond", "stickynote"].includes(el.type) &&
  el.backgroundColor !== "transparent" &&
  el.opacity > 30;

/**
 * Findings an element is marked to skip, because they are intended:
 * `customData.slides.ignore: ["overlap", "clipped"]` (or true: all of them)
 */
const ignores = (el: ExcalidrawElement | undefined, kind: string) => {
  const ignore = (el?.customData as any)?.slides?.ignore;
  return ignore === true || (Array.isArray(ignore) && (ignore.includes(kind) || ignore.includes("all")));
};

const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

const images = new Map<string, Promise<HTMLImageElement | null>>();
const loadImage = (fileId: string, dataURL: string) => {
  if (!images.has(fileId)) {
    images.set(
      fileId,
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        setTimeout(() => resolve(null), 10_000);
        image.src = dataURL;
      }),
    );
    while (images.size > 60) {
      images.delete(images.keys().next().value!);
    }
  }
  return images.get(fileId)!;
};

/** the average color of the part of a picture that lies under a box (null: unknown) */
const colorOfImage = async (image: any, box: Box, files: BinaryFiles) => {
  const file = image.fileId && (files as any)[image.fileId];
  if (!file?.dataURL || !image.width || !image.height) {
    return null;
  }
  const img = await loadImage(image.fileId, file.dataURL);
  if (!img || !img.naturalWidth) {
    return null;
  }
  const part = intersection(box, [image.x, image.y, image.x + image.width, image.y + image.height]);
  if (area(part) <= 0) {
    return null;
  }
  const crop = image.crop;
  const nw = crop?.width ?? img.naturalWidth;
  const nh = crop?.height ?? img.naturalHeight;
  const ox = crop?.x ?? 0;
  const oy = crop?.y ?? 0;
  const sx = ox + ((part[0] - image.x) / image.width) * nw;
  const sy = oy + ((part[1] - image.y) / image.height) * nh;
  const sw = Math.max(1, ((part[2] - part[0]) / image.width) * nw);
  const sh = Math.max(1, ((part[3] - part[1]) / image.height) * nh);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    const sum = [0, 0, 0];
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      sum[0] += data[i] * alpha;
      sum[1] += data[i + 1] * alpha;
      sum[2] += data[i + 2] * alpha;
      weight += alpha;
    }
    // (mostly) transparent: what's behind the picture shows
    return weight < 24 * 24 * 0.5 ? null : toHex(sum.map((v) => v / weight));
  } catch {
    return null;
  }
};

const preview = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return `"${line.length > 40 ? `${line.slice(0, 37)}…` : line}"`;
};

export const checkDeck = async (
  input: readonly ExcalidrawElement[],
  { deck, background = "#ffffff", files = {} }: { deck: string; background?: string; files?: BinaryFiles },
) => {
  const elements = withTemplate([...input], deck).filter((el) => !el.isDeleted);
  await Fonts.loadElementsFonts(elements).catch(() => []);
  const map = new Map(elements.map((el) => [el.id, el])) as any;
  const slides = getSlides(elements);
  const template = getTemplate(elements);
  const theme = getTheme(elements);
  const issues: Issue[] = [];
  const frames = elements.filter((el) => el.type === "frame");

  // text sizes as the user's browser will measure them
  const measured = new Map<string, Box>();
  const boxOf = (el: ExcalidrawElement): Box => {
    const cached = measured.get(el.id);
    if (cached) {
      return cached;
    }
    let box = getElementBounds(el, map) as Box;
    const any = el as any;
    if (el.type === "text" && !any.containerId && !el.angle) {
      const size = measureText(any.text, getFontString(any), any.lineHeight);
      const x =
        any.textAlign === "right" ? el.x + el.width - size.width : any.textAlign === "center" ? el.x + (el.width - size.width) / 2 : el.x;
      box = [x, el.y, x + size.width, el.y + size.height];
    }
    measured.set(el.id, box);
    return box;
  };

  /** what is behind a text: its filled shape, a filled shape or picture below it on the slide, or the canvas */
  const behindOf = (el: any, slideId: string): string | { image: any } => {
    const container = el.containerId && map.get(el.containerId);
    if (container && isFilled(container)) {
      return container.backgroundColor as string;
    }
    const box = boxOf(el);
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    for (let k = elements.indexOf(el) - 1; k >= 0; k--) {
      const under = elements[k];
      if (under.frameId === slideId && under.type === "image" && contains(boxOf(under), cx, cy)) {
        return { image: under };
      }
      if (under.frameId === slideId && isFilled(under) && contains(boxOf(under), cx, cy)) {
        return under.backgroundColor;
      }
    }
    return background;
  };
  /** the color behind a text (on a picture: the picture's average color there), and how to name it */
  const colorBehind = async (el: any, slideId: string) => {
    const behind = behindOf(el, slideId);
    if (typeof behind === "string") {
      return { color: behind, label: behind };
    }
    const color = await colorOfImage(behind.image, boxOf(el), files);
    return color ? { color, label: `the picture ${behind.image.id} (about ${color} there)` } : null;
  };
  /** huge, faint glyphs (a big quote mark, a watermark number) are decoration */
  const isDecoration = (el: any, slideId: string) =>
    el.type === "text" &&
    (el.opacity <= 30 ||
      (el.fontSize >= 96 &&
        (() => {
          const behind = behindOf(el, slideId);
          return typeof behind === "string" && (contrast(el.strokeColor, behind) ?? 99) < 1.6;
        })()));

  const report: any[] = [];
  for (const [index, slide] of slides.entries()) {
    const number = index + 1;
    const data = slideData(slide);
    const frameBox: Box = [slide.x, slide.y, slide.x + slide.width, slide.y + slide.height];
    const own = elements.filter((el) => el.frameId === slide.id);
    const content = own.filter((el) => !slideData(el).copyOf);
    const add = (kind: string, message: string, id?: string) =>
      ignores(id ? map.get(id) : slide, kind) || issues.push({ slide: number, kind, message, ...(id ? { id } : {}) });

    // cut off at the slide edge (frames clip their content)
    for (const el of own) {
      if (isDecoration(el, slide.id)) {
        continue;
      }
      const [x1, y1, x2, y2] = boxOf(el);
      const out = Math.max(frameBox[0] - x1, frameBox[1] - y1, x2 - frameBox[2], y2 - frameBox[3]);
      // a text's box includes line spacing above and below the letters
      const tolerance = el.type === "text" ? Math.max(2, (el as any).fontSize * 0.2) : 2;
      if (out > tolerance) {
        add("clipped", `${el.type} ${el.id}${el.type === "text" ? ` ${preview((el as any).text)}` : ""} sticks out of the slide by ${round(out)}px and is cut off`, el.id);
      }
    }

    // drawn on the slide but not part of it: not shown in presentations / PDF, no click steps
    for (const el of elements) {
      if (el.frameId || el.type === "frame" || (el as any).containerId) {
        continue;
      }
      const box = boxOf(el);
      if (area(intersection(box, frameBox)) > area(box) * 0.5 && area(box) > 0) {
        add("not-in-slide", `${el.type} ${el.id} lies on this slide but isn't part of it (frameId missing): presentations and PDFs leave it out`, el.id);
      }
    }

    // text that doesn't fit its shape
    for (const el of content) {
      const any = el as any;
      if (el.type === "text" && any.containerId) {
        const container = map.get(any.containerId);
        if (!container || container.type === "arrow") {
          continue;
        }
        const dims: any = refreshTextDimensions(any, container, map) || {};
        const height = dims.height ?? el.height;
        const max = getBoundTextMaxHeight(container, { ...any, ...dims });
        if (height > max + 1) {
          add("overflow", `label ${preview(any.text)} of ${container.id} needs ${round(height)}px but the shape has room for ${round(max)}px: make the shape taller or the text shorter`, el.id);
        }
      } else if (el.type === "text" && !el.angle) {
        // a free text bigger than its own box: the browser cuts it off at the box
        // (renders and PDFs don't), e.g. after a font change measured with another font
        const dims: any = refreshTextDimensions(any, null, map, any.originalText ?? any.text) || {};
        const width =
          any.autoResize === false
            ? (refreshTextDimensions({ ...any, autoResize: true }, null, map, dims.text ?? any.text) as any)?.width ?? el.width
            : dims.width ?? el.width;
        const height = dims.height ?? el.height;
        if (width > el.width + 2 || height > el.height + 2) {
          add(
            "text-box",
            `text ${preview(any.text)} needs ${round(width)}×${round(height)}px but its box is ${round(el.width)}×${round(el.height)}px: the user's browser cuts it off. Update it with "autoResize": true (one line, grows with the text) or a "width" (wraps at it)`,
            el.id,
          );
        }
      }
    }

    // overlapping text (and text over pictures)
    const texts = own.filter((el) => el.type === "text" && !isDecoration(el, slide.id));
    const blockers = own.filter((el) => el.type === "image");
    for (let i = 0; i < texts.length; i++) {
      const a = texts[i] as any;
      const boxA = boxOf(a);
      for (const b of [...texts.slice(i + 1), ...blockers] as any[]) {
        if (a.containerId && a.containerId === b.containerId) {
          continue;
        }
        // text on a picture is fine when drawn above it (its contrast is checked below)
        if (b.type === "image" && elements.indexOf(b) < elements.indexOf(a)) {
          continue;
        }
        const boxB = boxOf(b);
        const shared = area(intersection(boxA, boxB));
        if (shared > Math.min(area(boxA), area(boxB)) * 0.15 && shared > 50 && !ignores(b, "overlap")) {
          add(
            "overlap",
            b.type === "text"
              ? `text ${preview(a.text)} (${a.id}) overlaps text ${preview(b.text)} (${b.id})`
              : `text ${preview(a.text)} (${a.id}) is covered by image ${b.id} drawn on top of it`,
            a.id,
          );
        }
      }
    }

    // readability: size and contrast against what's behind the text
    for (const el of texts as any[]) {
      // formatted text: each piece in its own size and color
      const doc = richDocOf(el);
      const pieces: Array<{ size: number; color: string; text: string }> = doc
        ? doc.p.flatMap((para) =>
            para.r.map((run) => ({
              size: Math.round(el.fontSize * (run.z || 1)),
              color: run.c || (run.a ? LINK_COLOR : el.strokeColor),
              text: run.t,
            })),
          )
        : [{ size: el.fontSize, color: el.strokeColor, text: el.text }];
      const smallest = pieces.reduce((min, piece) => (piece.size < min.size ? piece : min), pieces[0]);
      if (smallest && smallest.size < MIN_FONT) {
        add("small-text", `text ${preview(smallest.text)} is ${smallest.size}px: hard to read on a projector (use ${MIN_FONT}px or more)`, el.id);
      }
      const box = boxOf(el);
      const behind = await colorBehind(el, slide.id);
      for (const piece of behind ? pieces.filter((p, i) => pieces.findIndex((q) => q.color === p.color && q.size >= 28 === p.size >= 28) === i) : []) {
        const ratio = contrast(piece.color, behind!.color);
        const needed = piece.size >= 28 ? 3 : 4.5;
        if (ratio !== null && ratio < needed) {
          add("contrast", `text ${preview(piece.text)} (${piece.color} on ${behind!.label}) has contrast ${ratio.toFixed(1)}:1, below ${needed}:1`, el.id);
          break;
        }
      }
      // covered by a filled shape drawn on top of it
      const z = elements.indexOf(el);
      const cover = elements.find(
        (over, k) =>
          k > z &&
          over.frameId === slide.id &&
          over.id !== el.containerId &&
          isFilled(over) &&
          over.opacity >= 90 &&
          contains(boxOf(over), (box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
      );
      if (cover) {
        add("hidden", `text ${preview(el.text)} (${el.id}) is covered by ${cover.type} ${cover.id} drawn on top of it`, el.id);
      }
      if (!slideData(el).copyOf && /\{(page|total|title|deck|date)\}/.test(el.text)) {
        add("placeholder", `text ${preview(el.text)} uses a placeholder: those are only filled in template elements`, el.id);
      }
    }

    // click steps
    const steps = new Set<number>();
    for (const el of content) {
      const step = elementStep(el, map);
      if (step > 0) {
        steps.add(step);
      }
    }
    for (const el of elements) {
      if (!el.frameId && (slideData(el).step ?? 0) > 0 && area(intersection(boxOf(el), frameBox)) > 0) {
        add("step-ignored", `${el.type} ${el.id} has step ${slideData(el).step} but isn't part of the slide, so it never hides`, el.id);
      }
    }
    // a connector showing before what it connects points at nothing
    for (const el of content as any[]) {
      if (el.type !== "arrow" && el.type !== "line") {
        continue;
      }
      const own = elementStep(el, map);
      for (const binding of [el.startBinding, el.endBinding]) {
        const target = binding?.elementId && map.get(binding.elementId);
        if (target && elementStep(target, map) > own) {
          add(
            "step-order",
            `${el.type} ${el.id} appears at click ${own} but connects ${target.type} ${target.id}, which only appears at click ${elementStep(target, map)}`,
            el.id,
          );
        }
      }
    }
    const sorted = [...steps].sort((a, b) => a - b);
    sorted.forEach((step, i) => {
      if (step !== i + 1) {
        add("step-gap", `click steps are ${sorted.join(", ")}: click ${i + 1} reveals nothing`);
      }
    });

    if (!data.notes?.trim()) {
      add("notes", "no speaker notes");
    }
    if (slide.width !== 1920 || slide.height !== 1080) {
      add("size", `slide is ${round(slide.width)}×${round(slide.height)}, not 1920×1080 (16:9)`);
    }
    for (const other of frames) {
      if (other.id !== slide.id && area(intersection(frameBox, boxOf(other))) > 0) {
        add("frames-overlap", `slide overlaps frame "${(other as any).name ?? other.id}"`);
      }
    }

    report.push({
      slide: number,
      id: slide.id,
      title: slideTitle(slide, index),
      elements: content.length,
      templateElements: own.length - content.length,
      steps: sorted.length ? Math.max(...sorted) : 0,
      notes: data.notes?.trim() ? data.notes.trim().length : 0,
      ...(data.skip ? { skip: true } : {}),
      ...(data.template === false ? { template: false } : {}),
      ...(data.hidden?.length ? { templateElementsRemoved: data.hidden.length } : {}),
    });
  }

  // a label must be on the same slide as its shape (else it is left out there)
  for (const el of elements as any[]) {
    const container = el.containerId && map.get(el.containerId);
    if (container && (container.frameId ?? null) !== (el.frameId ?? null)) {
      const number = slides.findIndex((slide) => slide.id === container.frameId) + 1;
      issues.push({
        slide: number || null,
        id: el.id,
        kind: "label-frame",
        message: `label ${el.id} ${preview(el.text)} is not part of the slide its shape ${container.id} is on: it won't show there when presenting or in PDFs (set its frameId to ${JSON.stringify(container.frameId ?? null)})`,
      });
    }
  }

  const stray = elements.filter(
    (el) => !el.frameId && el.type !== "frame" && !(el as any).containerId && !frames.some((f) => area(intersection(boxOf(el), boxOf(f))) > 0),
  );
  if (stray.length) {
    issues.push({ slide: null, kind: "outside", message: `${stray.length} elements are outside every slide (not presented): ${stray.slice(0, 10).map((el) => el.id).join(", ")}${stray.length > 10 ? ", …" : ""}` });
  }
  if (!slides.length) {
    issues.push({ slide: null, kind: "no-slides", message: "no slides: every frame is a slide (except the template frame)" });
  }
  if (!template) {
    issues.push({ slide: null, kind: "no-template", message: "no template frame (customData.slides.role = \"template\"): no shared header/footer/theme" });
  }

  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.kind] = (counts[issue.kind] || 0) + 1;
  }
  return {
    deck,
    slides: report,
    ...(template ? { template: { id: template.id, theme } } : {}),
    issues,
    summary: issues.length
      ? `${issues.length} findings: ${Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(", ")}`
      : "No findings: the deck looks clean.",
  };
};
