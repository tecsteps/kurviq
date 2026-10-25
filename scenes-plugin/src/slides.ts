// Slides: every frame of a scene is a slide (like Excalidraw+). Everything
// lives in the scene itself, in `customData.slides` of frames and elements,
// so decks sync, merge and travel like any other scene:
//
//  - slide frames: { order, notes, skip, template: false = no template }
//  - one template frame ({ role: "template", theme: { transition } }): its elements (header,
//    footer, logo, background, headline, eyebrow) are copied onto every slide,
//    locked (headline and eyebrow not: each slide writes its own). What the
//    user changes on a copy stays there, property by property: a headline
//    colored by hand keeps its color, and still follows the template's
//    position, font … (each copy remembers the template's values in `base`).
//    A copy deleted on a slide stays away. "Back to template" (a slide, or
//    all slides) brings the template's version back.
//    The template's elements are the deck's style: styled with Excalidraw's
//    own tools there, every slide follows. (Older decks' theme values other
//    than the transition are no longer used.)
//  - elements: { step: n } appear on the n-th click while presenting.
//
// Template text may use {page} {total} {title} {deck} {date}.

import {
  CaptureUpdateAction,
  FONT_FAMILY,
  exportToCanvas,
  hashString,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import { duplicateElements, getCommonBounds, refreshTextDimensions, syncInvalidIndices } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type DeckTheme = {
  fontFamily: number;
  textColor: string;
  titleSize: number;
  bodySize: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid" | "hachure" | "cross-hatch" | "zigzag";
  roughness: number;
  strokeWidth: number;
  /** camera between slides: fly across the canvas, or cut */
  transition: "glide" | "cut";
};

export const DEFAULT_THEME: DeckTheme = {
  fontFamily: FONT_FAMILY.Excalifont,
  textColor: "#1e1e1e",
  titleSize: 64,
  bodySize: 32,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  roughness: 1,
  strokeWidth: 2,
  transition: "glide",
};

export type SlideData = {
  /** the template frame; on its texts: the headline / eyebrow (each slide writes its own) */
  role?: "template" | "headline" | "eyebrow";
  theme?: Partial<DeckTheme>;
  order?: number;
  notes?: string;
  skip?: boolean;
  /** false: this slide shows no template elements */
  template?: boolean;
  /** template copies: the template element it copies */
  copyOf?: string;
  /** template copies: the template's values at the last sync (what differs from them was changed by hand) */
  base?: Record<string, unknown>;
  /** older template copies: one signature over the whole element (see legacyOverridden) */
  sig?: number;
  rel?: true;
  /** removed by the template sync (not by the user) — may come back */
  removedBy?: "sync";
  /** appears on the n-th click while presenting */
  step?: number;
  /** slides: template elements the user removed from this slide (kept in the file, unlike deleted copies) */
  hidden?: string[];
};

export type Frame = NonDeleted<ExcalidrawFrameElement>;

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;
const SLIDE_GAP = 240;
/** slides per row on the canvas */
const SLIDE_COLUMNS = 7;

export const slideData = (el: ExcalidrawElement | null | undefined): SlideData =>
  ((el?.customData as any)?.slides as SlideData) || {};

export const withSlideData = <T extends ExcalidrawElement>(el: T, patch: Partial<SlideData>): T => {
  const next = { ...slideData(el), ...patch };
  for (const key of Object.keys(next) as (keyof SlideData)[]) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  return newElementWith(el, { customData: { ...(el.customData || {}), slides: next } } as any);
};

const isFrame = (el: ExcalidrawElement): el is Frame => el.type === "frame" && !el.isDeleted;

export const getTemplate = (elements: readonly ExcalidrawElement[]) =>
  (elements.find((el) => isFrame(el) && slideData(el).role === "template") as Frame | undefined) ?? null;

export const getTheme = (elements: readonly ExcalidrawElement[]): DeckTheme => ({
  ...DEFAULT_THEME,
  ...(slideData(getTemplate(elements)).theme || {}),
});

/** slide frames in deck order: explicit order first, then canvas order (rows, left to right) */
export const getSlides = (elements: readonly ExcalidrawElement[]): Frame[] => {
  const frames = elements.filter((el): el is Frame => isFrame(el) && slideData(el).role !== "template");
  const canvasOrder = [...frames].sort((a, b) =>
    Math.abs(a.y - b.y) > Math.min(a.height, b.height) / 2 ? a.y - b.y : a.x - b.x,
  );
  const rank = new Map(canvasOrder.map((frame, index) => [frame.id, index]));
  return frames.sort((a, b) => {
    const oa = slideData(a).order;
    const ob = slideData(b).order;
    if (oa !== undefined && ob !== undefined && oa !== ob) {
      return oa - ob;
    }
    if (oa !== undefined && ob === undefined) {
      return -1;
    }
    if (ob !== undefined && oa === undefined) {
      return 1;
    }
    return rank.get(a.id)! - rank.get(b.id)!;
  });
};

/**
 * Agents place elements relative to a slide: `slide` = slide number (1-based,
 * deck order), frame id or "template"; x / y then count from the slide's
 * top-left corner, and the element becomes part of the slide (frameId).
 */
export const placeOnSlides = <T extends Record<string, any> | null | undefined>(items: T[], all: readonly any[]): T[] => {
  if (!items.some((el) => el && el.slide !== undefined && el.slide !== null)) {
    return items;
  }
  const frames = all.filter((el) => el && el.type === "frame" && !el.isDeleted);
  const slides = getSlides(frames as any);
  return items.map((el) => {
    if (!el || el.slide === undefined || el.slide === null) {
      return el;
    }
    const { slide, ...rest } = el as Record<string, any>;
    const frame =
      slide === "template"
        ? frames.find((f) => f.customData?.slides?.role === "template")
        : typeof slide === "number" || /^\d+$/.test(String(slide))
        ? slides[Number(slide) - 1]
        : frames.find((f) => f.id === slide);
    if (!frame) {
      throw new Error(
        `slide ${JSON.stringify(slide)}: no such slide (the deck has ${slides.length}; use a number from 1, a frame id or "template")`,
      );
    }
    return {
      ...rest,
      ...(typeof rest.x === "number" ? { x: rest.x + frame.x } : {}),
      ...(typeof rest.y === "number" ? { y: rest.y + frame.y } : {}),
      frameId: frame.id,
    } as unknown as T;
  });
};

export const slideTitle = (frame: Frame, index: number) => frame.name?.trim() || `Slide ${index + 1}`;

/** the click on which an element appears while presenting (0: always); bound labels follow their container */
export const elementStep = (el: ExcalidrawElement, byId: ReadonlyMap<string, ExcalidrawElement>): number => {
  const own = slideData(el).step ?? 0;
  const containerId = (el as any).containerId;
  return containerId ? Math.max(own, slideData(byId.get(containerId)).step ?? 0) : own;
};

/** elements of a slide (its frame children), incl. template copies */
export const slideElements = (elements: readonly ExcalidrawElement[], frame: Frame) =>
  elements.filter((el) => !el.isDeleted && el.frameId === frame.id);

// -----------------------------------------------------------------------------
// template sync
// -----------------------------------------------------------------------------

/** stable JSON (sorted keys), so signatures survive save / load */
const canon = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon((value as any)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value === "number" ? Math.round(value * 2) / 2 : value);
};

/** older copies' signature over everything the user can change (see legacyOverridden) */
const signature = (el: ExcalidrawElement, slide?: { x: number; y: number }) => {
  const any = el as any;
  const isText = el.type === "text";
  return hashString(
    canon({
      type: el.type,
      x: any.containerId ? 0 : el.x - (slide?.x ?? 0),
      y: any.containerId ? 0 : el.y - (slide?.y ?? 0),
      width: isText ? 0 : el.width,
      height: isText ? 0 : el.height,
      angle: el.angle,
      strokeColor: el.strokeColor,
      backgroundColor: el.backgroundColor,
      fillStyle: el.fillStyle,
      strokeWidth: el.strokeWidth,
      strokeStyle: el.strokeStyle,
      roughness: el.roughness,
      opacity: el.opacity,
      roundness: el.roundness,
      locked: el.locked,
      link: el.link,
      text: any.originalText ?? null,
      fontFamily: any.fontFamily ?? null,
      fontSize: any.fontSize ?? null,
      textAlign: any.textAlign ?? null,
      points: any.points ?? null,
      fileId: any.fileId ?? null,
      startArrowhead: any.startArrowhead ?? null,
      endArrowhead: any.endArrowhead ?? null,
    }),
  );
};

/**
 * An older copy (one signature, no `base`) the user changed. Some have
 * absolute signatures, which reordering slides broke: one still locked
 * where the template puts it (`fresh`) was moved along with its slide.
 */
const legacyOverridden = (el: ExcalidrawElement, slide: Frame, fresh?: ExcalidrawElement) => {
  const { sig, rel } = slideData(el);
  if (sig === undefined || signature(el, slide) === sig) {
    return false;
  }
  if (rel) {
    return true;
  }
  const inPlace = !!fresh && el.locked && Math.abs(el.x - fresh.x) < 1 && Math.abs(el.y - fresh.y) < 1;
  return signature(el) !== sig && !inPlace;
};

/** what a copy takes from its template element, property by property */
const TRACKED = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "link",
  "originalText",
  "fontFamily",
  "fontSize",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "autoResize",
  "points",
  "fileId",
  "startArrowhead",
  "endArrowhead",
  "rich",
] as const;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** a free text's x where it is anchored (its right edge when right-aligned …): text of another width keeps it */
const anchorX = (el: any) =>
  el.type === "text" && !el.containerId
    ? el.textAlign === "right"
      ? el.x + el.width
      : el.textAlign === "center"
      ? el.x + el.width / 2
      : el.x
    : el.x;

/**
 * The tracked values of an element on a slide: positions relative to the
 * slide (moving or reordering slides changes nothing), a text's size left
 * out where Excalidraw measures it.
 */
const tracked = (el: any, slide: Frame) => {
  const values: Record<string, unknown> = {};
  for (const key of TRACKED) {
    let value: unknown;
    if (key === "x") {
      value = el.containerId ? undefined : round2(anchorX(el) - slide.x);
    } else if (key === "y") {
      value = el.containerId ? undefined : round2(el.y - slide.y);
    } else if (key === "width" || key === "height") {
      value = el.type === "text" && (el.containerId || key === "height" || el.autoResize !== false) ? undefined : round2(el[key]);
    } else if (key === "rich") {
      value = el.customData?.rich;
    } else {
      value = el[key];
    }
    if (value !== undefined || key === "rich") {
      values[key] = value ?? null;
    }
  }
  return values;
};

/** the properties of a copy the user changed (they differ from the template's values it was made with) */
const changedByHand = (el: ExcalidrawElement, slide: Frame, base: Record<string, unknown>) => {
  const now = tracked(el, slide);
  return new Set(Object.keys(base).filter((key) => key in now && canon(now[key]) !== canon(base[key])));
};

/** the template's values a copy was made with; older copies: derived once from their signature */
const baseOf = (el: ExcalidrawElement, slide: Frame, fresh: ExcalidrawElement) => {
  const data = slideData(el);
  if (data.base) {
    return data.base;
  }
  // unchanged: everything follows the template; changed: what differs from it now stays
  return data.sig !== undefined && legacyOverridden(el, slide, fresh) ? tracked(fresh, slide) : tracked(el, slide);
};

/** a copy changed by hand at all (one whose template element is gone or switched off stays then) */
const hasHandChanges = (el: ExcalidrawElement, slide: Frame) => {
  const data = slideData(el);
  return data.base ? changedByHand(el, slide, data.base).size > 0 : legacyOverridden(el, slide);
};

/** the fresh copy, with what the user changed on the existing one */
const withHandChanges = (fresh: any, existing: any, keys: Set<string>) => {
  if (!keys.size) {
    return fresh;
  }
  let next: any = { ...fresh };
  for (const key of keys) {
    if (key === "x" || key === "y") {
      continue; // below, after measuring
    }
    if (key === "rich") {
      const { rich: _rich, ...rest } = next.customData || {};
      next.customData = existing.customData?.rich ? { ...rest, rich: existing.customData.rich } : rest;
    } else if (key === "originalText") {
      next.originalText = existing.originalText;
      next.text = existing.text;
    } else {
      next[key] = existing[key];
    }
  }
  // its own words or font: measured again, at the template's anchor
  next = measureTexts([next])[0];
  if (keys.has("x")) {
    next.x += anchorX(existing) - anchorX(next);
  }
  if (keys.has("y")) {
    next.y = existing.y;
  }
  return next;
};

const fillPlaceholders = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(page|total|title|deck|date)\}/g, (_, key) => vars[key] ?? "");

const copyId = (id: string, slideId: string) => `${id}~${slideId}`;

const isTitleRole = (el: ExcalidrawElement) => ["headline", "eyebrow"].includes(slideData(el).role as string);

/** the copy of template element `src` on `slide` */
const makeCopy = (
  src: ExcalidrawElement,
  template: Frame,
  slide: Frame,
  templateIds: Set<string>,
  vars: Record<string, string>,
): ExcalidrawElement => {
  const map = (id: string | null | undefined) => (id && templateIds.has(id) ? copyId(id, slide.id) : null);
  const any = src as any;
  // same place relative to the frame (proportional when sizes differ)
  const sx = slide.width / template.width;
  const sy = slide.height / template.height;
  const copy: any = {
    ...src,
    id: copyId(src.id, slide.id),
    x: slide.x + (src.x - template.x) * sx,
    y: slide.y + (src.y - template.y) * sy,
    frameId: slide.id,
    groupIds: src.groupIds.map((group) => `${group}~${slide.id}`),
    boundElements:
      src.boundElements
        ?.filter((bound) => templateIds.has(bound.id))
        .map((bound) => ({ ...bound, id: copyId(bound.id, slide.id) })) ?? null,
    // headline / eyebrow: each slide writes its own (the rest: change the template)
    locked: !isTitleRole(src),
    index: null,
    customData: { ...(src.customData || {}), slides: { copyOf: src.id, ...(isTitleRole(src) ? { role: slideData(src).role } : {}) } },
  };
  if (any.containerId !== undefined) {
    copy.containerId = map(any.containerId);
  }
  for (const key of ["startBinding", "endBinding"]) {
    if (any[key]) {
      const elementId = map(any[key].elementId);
      copy[key] = elementId ? { ...any[key], elementId } : null;
    }
  }
  if (src.type === "text") {
    copy.text = fillPlaceholders(any.text, vars);
    copy.originalText = fillPlaceholders(any.originalText ?? any.text, vars);
  }
  return copy;
};

/**
 * re-measure texts whose placeholders were filled, keeping their alignment; a
 * box of a fixed width (`autoResize: false`) keeps the template's width and
 * wraps again inside it
 */
const measureTexts = (copies: any[]) =>
  copies.map((el) => {
    if (el.type !== "text" || el.containerId) {
      return el;
    }
    const next: any = refreshTextDimensions(el, null, new Map() as any, el.originalText ?? el.text) || el;
    if (el.autoResize === false) {
      return { ...el, text: next.text, height: next.height };
    }
    const shift = el.width - next.width;
    const x = el.textAlign === "right" ? el.x + shift : el.textAlign === "center" ? el.x + shift / 2 : el.x;
    return { ...el, text: next.text, width: next.width, height: next.height, x };
  });

export type SyncResult = { elements: ExcalidrawElement[]; changed: number } | null;

/**
 * decks from the short-lived layouts version (several templates, placeholders):
 * text typed into a placeholder becomes the slide's own, unfilled placeholders go
 */
const fromLayouts = (input: readonly ExcalidrawElement[]) => {
  let migrated = 0;
  const elements = input.map((el) => {
    const { ph, empty, copyOf, sig, ...rest } = slideData(el) as SlideData & { ph?: string; empty?: boolean };
    if (el.isDeleted || !ph) {
      return el;
    }
    migrated++;
    return newElementWith(el, (empty ? { isDeleted: true } : { locked: false, customData: { ...el.customData, slides: rest } }) as any);
  });
  return { elements, migrated };
};

/**
 * Bring every slide's template copies up to date. Returns null when nothing
 * changes. `reset`: slide ids whose overridden / hidden copies come back too.
 */
export const syncTemplate = (
  input: readonly ExcalidrawElement[],
  deck: string,
  { reset = new Set<string>() }: { reset?: Set<string> } = {},
): SyncResult => {
  const { elements, migrated } = fromLayouts(input);
  const template = getTemplate(elements);
  const slides = getSlides(elements);
  // (a placeholder's sample text from the layouts version is not copied)
  const sources = template
    ? elements.filter((el) => !el.isDeleted && el.frameId === template.id && !(slideData(el) as { placeholder?: string }).placeholder)
    : [];
  const templateIds = new Set(sources.map((el) => el.id));
  const byId = new Map(elements.map((el) => [el.id, el]));
  const replaced = new Map<string, ExcalidrawElement>();
  const added: ExcalidrawElement[] = [];
  const date = new Date().toLocaleDateString();

  slides.forEach((slide, index) => {
    const wanted = slideData(slide).template !== false && !!template;
    const vars = {
      page: String(index + 1),
      total: String(slides.length),
      title: slideTitle(slide, index),
      deck,
      date,
    };
    const fresh = wanted ? measureTexts(sources.map((src) => makeCopy(src, template!, slide, templateIds, vars))) : [];
    const freshIds = new Set(fresh.map((el) => el.id));
    const wasHidden = slideData(slide).hidden || [];
    const hidden = new Set(reset.has(slide.id) ? [] : wasHidden);
    for (const copy of fresh) {
      const existing = byId.get(copy.id) as any;
      const srcId = slideData(copy).copyOf!;
      const base = tracked(copy, slide);
      const stamp = (el: any) => ({ ...el, customData: { ...el.customData, slides: { ...slideData(copy), base } } });
      if (existing && !existing.isDeleted) {
        hidden.delete(srcId); // back on the slide (e.g. undo)
      }
      if (!existing) {
        if (!hidden.has(srcId)) {
          added.push({ ...stamp(copy), version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
        }
        continue;
      }
      const data = slideData(existing);
      const hiddenByUser = existing.isDeleted && data.removedBy !== "sync";
      if (hiddenByUser && !reset.has(slide.id)) {
        hidden.add(srcId); // remembered on the slide: deleted elements aren't saved
      }
      if ((hiddenByUser || (existing.isDeleted && hidden.has(srcId))) && !reset.has(slide.id)) {
        continue; // the user removed it from this slide
      }
      // what the user changed on this slide stays, the rest follows the template
      const keep = reset.has(slide.id) || existing.isDeleted ? new Set<string>() : changedByHand(existing, slide, baseOf(existing, slide, copy));
      const next = stamp(withHandChanges(copy, existing, keep));
      const upToDate =
        !existing.isDeleted &&
        !reset.has(slide.id) &&
        data.base &&
        canon(data.base) === canon(base) &&
        canon(tracked(existing, slide)) === canon(tracked(next, slide)) &&
        existing.text === next.text &&
        (next.type !== "text" || Math.abs(existing.width - next.width) < 1);
      if (upToDate) {
        continue;
      }
      // (the template element's version / nonce are not the copy's: new ones come with the change)
      const { version: _version, versionNonce: _nonce, updated: _updated, ...changes } = next;
      replaced.set(
        copy.id,
        newElementWith(existing, {
          ...changes,
          // unlocked by hand: stays so
          locked: existing.isDeleted || reset.has(slide.id) ? next.locked : existing.locked,
          index: existing.index,
          isDeleted: false,
        } as any),
      );
    }
    // copies whose template element is gone (or template off for this slide)
    for (const el of elements) {
      const data = slideData(el);
      if (el.isDeleted || el.frameId !== slide.id || !data.copyOf || freshIds.has(el.id)) {
        continue;
      }
      if (!hasHandChanges(el, slide) || !templateIds.has(data.copyOf)) {
        replaced.set(
          el.id,
          newElementWith(el, {
            isDeleted: true,
            customData: { ...(el.customData || {}), slides: { ...data, removedBy: "sync" } },
          } as any),
        );
      }
    }
    const nextHidden = [...hidden].filter((id) => templateIds.has(id)).sort();
    if (nextHidden.join() !== [...wasHidden].sort().join()) {
      replaced.set(slide.id, withSlideData(slide, { hidden: nextHidden.length ? nextHidden : undefined }));
    }
  });

  // copies left behind by a deleted slide (or an older generation of slides) go too
  const slideIds = new Set(slides.map((slide) => slide.id));
  for (const el of elements) {
    const data = slideData(el);
    if (!el.isDeleted && data.copyOf && !(el.frameId && slideIds.has(el.frameId)) && !replaced.has(el.id)) {
      replaced.set(el.id, newElementWith(el, { isDeleted: true, customData: { ...(el.customData || {}), slides: { ...data, removedBy: "sync" } } } as any));
    }
  }

  // new copies go to the bottom (backgrounds, headers under the slide's content)…
  let next = [...added, ...elements.map((el) => replaced.get(el.id) ?? el)];
  // …but above a slide's own full-size background, which would hide them
  const reordered = liftCopiesAboveBackgrounds(next, slides);
  if (!replaced.size && !added.length && !reordered && !migrated) {
    return null;
  }
  next = reordered?.elements ?? next;
  syncInvalidIndices(next as any);
  return { elements: next as ExcalidrawElement[], changed: replaced.size + added.length + (reordered?.moved ?? 0) + migrated };
};

/** a filled shape covering (nearly) the whole slide */
const isSlideBackground = (el: ExcalidrawElement, slide: Frame) =>
  !el.isDeleted &&
  el.frameId === slide.id &&
  !el.angle &&
  (el.type === "image" || (["rectangle", "ellipse", "diamond"].includes(el.type) && el.backgroundColor !== "transparent")) &&
  el.width * el.height >= slide.width * slide.height * 0.85;

const liftCopiesAboveBackgrounds = (elements: ExcalidrawElement[], slides: Frame[]) => {
  let list = elements;
  let moved = 0;
  for (const slide of slides) {
    const isBackground = (el: ExcalidrawElement) => isSlideBackground(el, slide);
    const lastBackground = list.reduce(
      (last, el, i) => (isBackground(el) && !slideData(el).copyOf ? i : last),
      -1,
    );
    if (lastBackground < 0) {
      continue;
    }
    // the template's own full-size background stays below the slide's
    const buried = list.filter(
      (el, i) => i < lastBackground && el.frameId === slide.id && !el.isDeleted && slideData(el).copyOf && !isBackground(el),
    );
    if (!buried.length) {
      continue;
    }
    const ids = new Set(buried.map((el) => el.id));
    const rest = list.filter((el) => !ids.has(el.id));
    const at = rest.findIndex((el) => el.id === list[lastBackground].id) + 1;
    list = [...rest.slice(0, at), ...buried.map((el) => newElementWith(el, { index: null } as any)), ...rest.slice(at)];
    moved += buried.length;
  }
  return moved ? { elements: list, moved } : null;
};

/** what decides whether the template sync has anything to do */
export const templateKey = (elements: readonly ExcalidrawElement[], deck: string) => {
  const template = getTemplate(elements);
  const slides = getSlides(elements);
  const parts: unknown[] = [deck, template?.id, template?.x, template?.y, template?.width, template?.height];
  if (template) {
    for (const el of elements) {
      if (el.frameId === template.id) {
        parts.push(el.id, el.version, el.isDeleted);
      }
    }
  }
  for (const slide of slides) {
    parts.push(slide.id, slide.x, slide.y, slide.width, slide.height, slide.name, slideData(slide).template, slideData(slide).hidden);
  }
  // copies the user deleted or edited don't need a sync; missing ones do
  parts.push(elements.filter((el) => slideData(el).copyOf && !el.isDeleted).length);
  return hashString(JSON.stringify(parts));
};

/** what a hand change on a copy is called (properties that go together share a name) */
const CHANGE_NAMES: Record<string, string> = {
  x: "position",
  y: "position",
  width: "size",
  height: "size",
  angle: "rotation",
  strokeColor: "color",
  backgroundColor: "background",
  fillStyle: "fill",
  strokeWidth: "stroke width",
  strokeStyle: "stroke style",
  roughness: "sloppiness",
  opacity: "opacity",
  roundness: "corners",
  link: "link",
  originalText: "text",
  fontFamily: "font",
  fontSize: "font size",
  textAlign: "alignment",
  verticalAlign: "vertical alignment",
  lineHeight: "line height",
  autoResize: "box width",
  points: "shape",
  fileId: "image",
  startArrowhead: "arrowheads",
  endArrowhead: "arrowheads",
  rich: "formatting",
};

/**
 * The hand changes of template copies among `ids`: per change name (color,
 * text …) the copies that have it. Elements that aren't copies are left out.
 */
export const templateChanges = (elements: readonly ExcalidrawElement[], ids: readonly string[]) => {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const result = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const el = byId.get(id);
    const data = slideData(el);
    const slide = el?.frameId ? (byId.get(el.frameId) as Frame | undefined) : undefined;
    if (!el || el.isDeleted || !data.copyOf || !data.base || !slide) {
      continue;
    }
    for (const key of changedByHand(el, slide, data.base)) {
      const name = CHANGE_NAMES[key] ?? key;
      result.set(name, [...(result.get(name) ?? []).filter((other) => other !== id), id]);
    }
  }
  return result;
};

/**
 * Copies back to the template, for some changes (names from templateChanges)
 * or all of them: the same for the canvas's "back to template" bar and an
 * agent's reset of single elements.
 */
export const resetTemplateChanges = (
  elements: readonly ExcalidrawElement[],
  ids: readonly string[],
  names: readonly string[] | null,
  deck: string,
) => {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const wanted = new Set(ids);
  let touched = 0;
  const next = elements.map((el) => {
    const data = slideData(el);
    const slide = el.frameId ? (byId.get(el.frameId) as Frame | undefined) : undefined;
    if (!wanted.has(el.id) || el.isDeleted || !data.copyOf || !data.base || !slide) {
      return el;
    }
    const base = data.base;
    const keys = [...changedByHand(el, slide, base)].filter((key) => !names || names.includes(CHANGE_NAMES[key] ?? key));
    if (!keys.length) {
      return el;
    }
    // the template's values again (the sync below takes them from there)
    const patch: Record<string, any> = {};
    const any = el as any;
    for (const key of keys) {
      if (key === "x") {
        patch.x = slide.x + (base.x as number) - (anchorX(el) - el.x);
      } else if (key === "y") {
        patch.y = slide.y + (base.y as number);
      } else if (key === "originalText") {
        patch.originalText = base.originalText;
        patch.text = base.originalText;
      } else if (key === "rich") {
        const { rich: _rich, ...rest } = el.customData || {};
        patch.customData = { ...(patch.customData ?? rest), ...(base.rich ? { rich: base.rich } : {}) };
      } else {
        patch[key] = base[key] ?? (key in any ? null : undefined);
      }
    }
    touched++;
    return newElementWith(el, patch as any);
  });
  if (!touched) {
    return null;
  }
  return syncTemplate(next, deck)?.elements ?? next;
};

/**
 * Slides back to the template: its elements as in the template again (hand
 * changes and deleted ones back). The same for the slide card's icon,
 * "Reset all slides" and an agent's reset / restyle.
 */
export const resetToTemplate = (elements: readonly ExcalidrawElement[], ids: Set<string>, deck: string) =>
  syncTemplate(elements, deck, { reset: ids })?.elements ?? null;

// -----------------------------------------------------------------------------
// editing helpers (all undoable)
// -----------------------------------------------------------------------------

const update = (api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[]) =>
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });

/** patch the slide data of some frames / elements */
export const patchSlideData = (
  api: ExcalidrawImperativeAPI,
  patches: Map<string, Partial<SlideData>>,
) => {
  const elements = api.getSceneElementsIncludingDeleted();
  update(
    api,
    elements.map((el) => (patches.has(el.id) ? withSlideData(el, patches.get(el.id)!) : el)),
  );
};

/**
 * The slides in deck order as a grid on the canvas, SLIDE_COLUMNS per row,
 * starting at the top-left of where they are now (or at `at`). Each
 * slide moves with everything on it.
 */
const layOut = (elements: readonly ExcalidrawElement[], at?: { x: number; y: number } | null) => {
  const slides = getSlides(elements);
  if (!slides.length) {
    return [...elements];
  }
  const start = at ?? origin(slides)!;
  const cellWidth = Math.max(...slides.map((s) => s.width)) + SLIDE_GAP;
  const cellHeight = Math.max(...slides.map((s) => s.height)) + SLIDE_GAP;
  const shift = new Map<string, { dx: number; dy: number }>();
  slides.forEach((slide, index) => {
    const dx = start.x + (index % SLIDE_COLUMNS) * cellWidth - slide.x;
    const dy = start.y + Math.floor(index / SLIDE_COLUMNS) * cellHeight - slide.y;
    if (dx || dy) {
      shift.set(slide.id, { dx, dy });
    }
  });
  return elements.map((el) => {
    const by = shift.get(el.id) ?? (el.frameId && !el.isDeleted ? shift.get(el.frameId) : undefined);
    return by ? newElementWith(el as any, { x: el.x + by.dx, y: el.y + by.dy } as any) : el;
  });
};

/** reorder: `ids` is the full new order; the canvas follows */
export const setSlideOrder = (api: ExcalidrawImperativeAPI, ids: string[]) =>
  update(api, layOut(withOrder(api.getSceneElementsIncludingDeleted(), ids)));

const newFrame = (props: { x: number; y: number; width: number; height: number; name: string }) =>
  ({
    id: Math.random().toString(36).slice(2, 12),
    type: "frame",
    ...props,
    angle: 0,
    strokeColor: "#bbb",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index: null,
    customData: {},
  }) as any;

/** the top-left corner of the slides' grid (null: no slides yet) */
const origin = (slides: Frame[]) =>
  slides.length ? { x: Math.min(...slides.map((s) => s.x)), y: Math.min(...slides.map((s) => s.y)) } : null;

/** the elements with `order` set to their position in `ids` */
const withOrder = (elements: readonly ExcalidrawElement[], ids: string[]) =>
  elements.map((el) => {
    const order = ids.indexOf(el.id);
    return order >= 0 ? withSlideData(el, { order }) : el;
  });

/** move slides (in their current relative order) so the first of them lands at `index` of the remaining deck */
export const moveSlides = (api: ExcalidrawImperativeAPI, ids: string[], index: number) => {
  const slides = getSlides(api.getSceneElementsIncludingDeleted()).map((s) => s.id);
  const moving = slides.filter((id) => ids.includes(id));
  const rest = slides.filter((id) => !ids.includes(id));
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, ...moving);
  setSlideOrder(api, rest);
};

/**
 * Duplicate slides: each copy (frame + its elements, click steps and notes
 * included) goes right after its original in the deck, and next to it on the
 * canvas. Template copies are not duplicated — the template sync puts fresh
 * ones on the new slide. Returns the new slides' ids.
 */
export const duplicateSlides = (api: ExcalidrawImperativeAPI, ids: string[]) => {
  let elements: ExcalidrawElement[] = [...api.getSceneElementsIncludingDeleted()];
  const order = getSlides(elements).map((s) => s.id);
  const created: string[] = [];
  for (const id of order.filter((slideId) => ids.includes(slideId))) {
    const frame = elements.find((el) => el.id === id && isFrame(el)) as Frame | undefined;
    if (!frame) {
      continue;
    }
    const own = elements.filter((el) => !el.isDeleted && el.frameId === id && !slideData(el).copyOf);
    const { duplicatedElements, origIdToDuplicateId } = duplicateElements({
      type: "everything",
      elements: [frame, ...own],
      randomizeSeed: true,
    });
    // next to the original for now: the layout below puts it in its place
    const [dx, dy] = [frame.width + SLIDE_GAP, 0];
    const copyId = origIdToDuplicateId.get(id)!;
    const copies = duplicatedElements.map((el) => {
      const moved = newElementWith(el as any, { x: el.x + dx, y: el.y + dy } as any) as ExcalidrawElement;
      return el.id === copyId
        ? newElementWith(moved as any, { name: frame.name ? `${frame.name} copy` : null } as any)
        : moved;
    });
    elements = [...elements, ...copies];
    order.splice(order.indexOf(id) + 1, 0, copyId);
    created.push(copyId);
  }
  elements = layOut(withOrder(elements, order));
  syncInvalidIndices(elements as any);
  update(api, elements as any);
  return created;
};

/** delete slides with everything on them (undo brings them back) */
export const deleteSlides = (api: ExcalidrawImperativeAPI, ids: string[]) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const gone = new Set(ids);
  const remaining = getSlides(elements).map((s) => s.id).filter((id) => !gone.has(id));
  update(
    api,
    layOut(
      withOrder(
        elements.map((el) =>
          !el.isDeleted && (gone.has(el.id) || (el.frameId && gone.has(el.frameId)))
            ? newElementWith(el as any, { isDeleted: true } as any)
            : el,
        ),
        remaining,
      ),
      origin(getSlides(elements)),
    ),
  );
};

/** a new 16:9 slide after the last one (or after `after`) */
export const addSlide = (api: ExcalidrawImperativeAPI, after?: string) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const slides = getSlides(elements);
  const anchor = slides.find((s) => s.id === after) ?? slides[slides.length - 1];
  const template = getTemplate(elements);
  const width = template?.width ?? SLIDE_WIDTH;
  const height = template?.height ?? SLIDE_HEIGHT;
  // the first slide goes next to what is already drawn (not on top of it);
  // the others take their place in the grid (see layOut)
  const drawn = elements.filter((el) => !el.isDeleted);
  const [, minY, maxX] = drawn.length ? getCommonBounds(drawn) : [0, 0, -SLIDE_GAP * 2];
  const start = origin(slides) ?? { x: Math.round(maxX + SLIDE_GAP * 2), y: Math.round(minY) };
  const position = anchor ? slides.indexOf(anchor) + 1 : 0;
  const frame = withSlideData(newFrame({ ...start, width, height, name: `Slide ${slides.length + 1}` }), {});
  const ordered = [...slides.slice(0, position).map((s) => s.id), frame.id, ...slides.slice(position).map((s) => s.id)];
  const next = layOut(withOrder([...elements, frame], ordered), start);
  syncInvalidIndices(next as any);
  update(api, next);
  return frame.id as string;
};

/** a template frame above the slides, with a footer to start from */
export const createTemplate = (api: ExcalidrawImperativeAPI, theme: DeckTheme = DEFAULT_THEME) => {
  const elements = api.getSceneElementsIncludingDeleted();
  if (getTemplate(elements)) {
    return getTemplate(elements)!.id;
  }
  const slides = getSlides(elements);
  const width = slides[0]?.width ?? SLIDE_WIDTH;
  const height = slides[0]?.height ?? SLIDE_HEIGHT;
  const minX = slides.length ? Math.min(...slides.map((s) => s.x)) : 0;
  const minY = slides.length ? Math.min(...slides.map((s) => s.y)) : 0;
  const frame = withSlideData(newFrame({ x: minX, y: minY - height - SLIDE_GAP * 2, width, height, name: "Template" }), {
    role: "template",
    theme,
  });
  const text = (id: string, x: number, value: string, align: "left" | "right") =>
    ({
      ...newFrame({ x, y: frame.y + height - 70, width: 300, height: 30, name: "" }),
      id,
      type: "text",
      name: undefined,
      frameId: frame.id,
      strokeColor: "#868e96",
      text: value,
      originalText: value,
      fontSize: 22,
      fontFamily: theme.fontFamily,
      textAlign: align,
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      autoResize: true,
      roughness: 0,
    }) as any;
  const line = {
    ...newFrame({ x: frame.x + 60, y: frame.y + height - 90, width: width - 120, height: 0, name: "" }),
    id: `${frame.id}-rule`,
    type: "line",
    name: undefined,
    frameId: frame.id,
    strokeColor: "#ced4da",
    strokeWidth: 1,
    roughness: 0,
    points: [
      [0, 0],
      [width - 120, 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  } as any;
  const footer = [
    ...titleBlock(frame, theme),
    line,
    text(`${frame.id}-deck`, frame.x + 60, "{deck}", "left"),
    text(`${frame.id}-page`, frame.x + width - 360, "{page} / {total}", "right"),
  ];
  const next = [...restoreElements(footer, null, { refreshDimensions: true }), ...elements, frame];
  // right-aligned page number: anchor its right edge
  const page: any = next.find((el) => el.id === `${frame.id}-page`);
  if (page) {
    page.x = frame.x + width - 60 - page.width;
  }
  syncInvalidIndices(next as any);
  update(api, next);
  return frame.id as string;
};

/** a text element on the template */
const templateText = (frame: Frame, props: Record<string, unknown>) =>
  ({
    ...newFrame({ x: frame.x, y: frame.y, width: 300, height: 30, name: "" }),
    type: "text",
    name: undefined,
    frameId: frame.id,
    containerId: null,
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.25,
    autoResize: true,
    roughness: 0,
    ...props,
  }) as any;

/** the template's headline and eyebrow (default place and style) */
const titleBlock = (frame: Frame, theme: DeckTheme) => [
  templateText(frame, {
    id: `${frame.id}-eyebrow`,
    x: frame.x + 120,
    y: frame.y + 100,
    text: "SECTION",
    originalText: "SECTION",
    fontSize: 24,
    fontFamily: theme.fontFamily,
    strokeColor: "#868e96",
    customData: { slides: { role: "eyebrow" } },
  }),
  templateText(frame, {
    id: `${frame.id}-headline`,
    x: frame.x + 120,
    y: frame.y + 140,
    text: "{title}",
    originalText: "{title}",
    fontSize: theme.titleSize,
    fontFamily: theme.fontFamily,
    strokeColor: theme.textColor,
    customData: { slides: { role: "headline" } },
  }),
];

/** the template has a headline / eyebrow */
export const hasTitleBlock = (elements: readonly ExcalidrawElement[]) => {
  const template = getTemplate(elements);
  return !!template && elements.some((el) => !el.isDeleted && el.frameId === template.id && isTitleRole(el));
};

/**
 * A slide's own headline (its biggest text near the top) and the eyebrow
 * above it (a smaller text right above, if any)
 */
const findTitles = (elements: readonly ExcalidrawElement[], slide: Frame) => {
  const texts = elements.filter(
    (el: any) => !el.isDeleted && el.type === "text" && el.frameId === slide.id && !el.containerId && !slideData(el).copyOf,
  ) as any[];
  const headline = texts
    .filter((el) => el.y - slide.y < slide.height * 0.35 && el.fontSize >= 36)
    .sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)[0];
  if (!headline) {
    return null;
  }
  const eyebrow = texts
    .filter(
      (el) =>
        el !== headline &&
        el.fontSize < headline.fontSize &&
        el.y + el.height <= headline.y + 8 &&
        headline.y - (el.y + el.height) < 60 &&
        Math.abs(el.x - headline.x) < 40,
    )
    .sort((a, b) => b.y - a.y)[0];
  return { headline, eyebrow: eyebrow ?? null };
};

/**
 * Headline and eyebrow on the template. The slides' own ones become their
 * copies (their words stay theirs; place and style follow the template,
 * which takes them from where most slides have their headline).
 */
export const addTitleBlock = (elements: readonly ExcalidrawElement[]) => {
  const template = getTemplate(elements);
  if (!template || hasTitleBlock(elements)) {
    return null;
  }
  // slides without the template keep everything as it is
  const slides = getSlides(elements).filter((slide) => slideData(slide).template !== false);
  const found = new Map(slides.map((slide) => [slide.id, findTitles(elements, slide)]));
  const [eyebrowSrc, headlineSrc] = titleBlock(template, getTheme(elements));
  // place and style from where most slides have their headline (one with an eyebrow there, if any)
  const spotOf = (slide: Frame) => {
    const headline = found.get(slide.id)?.headline as any;
    return headline && `${Math.round((headline.x - slide.x) / 24)},${Math.round((headline.y - slide.y) / 24)},${headline.fontSize}`;
  };
  const counts = new Map<string, number>();
  for (const slide of slides) {
    const spot = spotOf(slide);
    if (spot) {
      counts.set(spot, (counts.get(spot) ?? 0) + 1);
    }
  }
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const atCommon = slides.filter((slide) => spotOf(slide) === common);
  const model = atCommon.find((slide) => found.get(slide.id)?.eyebrow) ?? atCommon[0];
  if (model) {
    const { headline, eyebrow } = found.get(model.id)!;
    const styleOf = (el: any) => ({
      x: template.x + (el.x - model.x),
      y: template.y + (el.y - model.y),
      fontSize: el.fontSize,
      fontFamily: el.fontFamily,
      strokeColor: el.strokeColor,
      textAlign: el.textAlign,
      lineHeight: el.lineHeight,
    });
    Object.assign(headlineSrc, styleOf(headline));
    if (eyebrow) {
      Object.assign(eyebrowSrc, styleOf(eyebrow), { text: "SECTION", originalText: "SECTION" });
    } else {
      // right above the headline
      Object.assign(eyebrowSrc, { x: headlineSrc.x, y: headlineSrc.y - 40, textAlign: headline.textAlign });
    }
  }
  const sources = restoreElements([eyebrowSrc, headlineSrc], null, { refreshDimensions: true });
  // only texts where the template's sit are taken over; elsewhere (a title
  // slide …) the template's headline / eyebrow stay hidden: nothing moves
  const inPlace = (own: any, src: any, slide: Frame) =>
    !!own && Math.abs(own.x - slide.x - (src.x - template.x)) < 24 && Math.abs(own.y - slide.y - (src.y - template.y)) < 24;
  const adopted = new Map<string, ExcalidrawElement>();
  const hiddenOn = new Map<string, string[]>();
  for (const slide of slides) {
    const titles = found.get(slide.id);
    for (const [own, src] of [
      [titles?.headline, sources[1]],
      [titles?.eyebrow, sources[0]],
    ] as const) {
      if (!model) {
        continue; // nothing to go by: the template's show everywhere
      }
      if (!inPlace(own, src, slide)) {
        hiddenOn.set(slide.id, [...(hiddenOn.get(slide.id) ?? slideData(slide).hidden ?? []), src.id]);
        continue;
      }
      if (!own) {
        continue;
      }
      // the slide's text, as the copy: its words stay (they differ from the template's), the rest follows
      adopted.set(own.id, {
        ...own,
        id: copyId(src.id, slide.id),
        locked: false,
        customData: {
          ...(own.customData || {}),
          slides: { copyOf: src.id, role: slideData(src).role, base: { ...tracked(own, slide), originalText: "\u0000" } },
        },
      } as ExcalidrawElement);
    }
  }
  const next = [
    ...elements.flatMap((el) => {
      const copy = adopted.get(el.id);
      if (copy) {
        return [newElementWith(el, { isDeleted: true }), { ...copy, index: null } as ExcalidrawElement];
      }
      return hiddenOn.has(el.id) ? [withSlideData(el, { hidden: hiddenOn.get(el.id) })] : [el];
    }),
    ...sources,
  ];
  syncInvalidIndices(next as any);
  return { elements: next, adopted: adopted.size };
};

// -----------------------------------------------------------------------------
// pictures of slides (thumbnails, presenter view, PDF)
// -----------------------------------------------------------------------------

export const renderSlide = async (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  frame: Frame,
  { width, background }: { width: number; background: string },
) =>
  exportToCanvas({
    elements: elements.filter((el) => !el.isDeleted) as any,
    appState: { exportBackground: true, viewBackgroundColor: background },
    files,
    exportingFrame: frame,
    exportPadding: 0,
    getDimensions: (w, h) => ({ width, height: Math.round((width * h) / w), scale: width / w }),
  });

/** version key of what a slide shows (for caching its picture) */
export const slideVersion = (elements: readonly ExcalidrawElement[], frame: Frame) => {
  let key = `${frame.version}`;
  for (const el of elements) {
    if (el.frameId === frame.id) {
      key += `,${el.id}:${el.version}`;
    }
  }
  return hashString(key);
};
