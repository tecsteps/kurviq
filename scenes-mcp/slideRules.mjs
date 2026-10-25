// How slides read a scene (customData.slides, see scenes-plugin/src/slides.ts):
// deck order and what a template copy changed on its slide. Shared by the app
// (slides.ts, which also edits decks) and the MCP tools (reading scenes
// without the app).

export const slideData = (el) => el?.customData?.slides || {};

/** a slide frame or the template (Excalidraw's magic frames aren't slides) */
export const isSlideFrame = (el) => !!el && el.type === "frame" && !el.isDeleted;

/** slide frames in deck order: explicit order first, then canvas order (rows, left to right) */
export const deckOrder = (elements) => {
  const frames = elements.filter((el) => isSlideFrame(el) && slideData(el).role !== "template");
  const canvasOrder = [...frames].sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.height, b.height) / 2 ? a.y - b.y : a.x - b.x));
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
    return rank.get(a.id) - rank.get(b.id);
  });
};

/** stable JSON (sorted keys, numbers to half a pixel), so values survive save / load */
export const canon = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value === "number" ? Math.round(value * 2) / 2 : value);
};

/** what a copy takes from its template element, property by property, and what a change of it is called */
export const CHANGE_NAMES = {
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

const TRACKED = Object.keys(CHANGE_NAMES);

const round2 = (value) => Math.round(value * 100) / 100;

/** a free text's x where it is anchored (its right edge when right-aligned …): text of another width keeps it */
export const anchorX = (el) =>
  el.type === "text" && !el.containerId ? (el.textAlign === "right" ? el.x + el.width : el.textAlign === "center" ? el.x + el.width / 2 : el.x) : el.x;

/**
 * The tracked values of an element on a slide: positions relative to the
 * slide (moving or reordering slides changes nothing), a text's size left
 * out where Excalidraw measures it.
 */
export const tracked = (el, slide) => {
  const values = {};
  for (const key of TRACKED) {
    let value;
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
export const changedByHand = (el, slide, base) => {
  const now = tracked(el, slide);
  return new Set(Object.keys(base).filter((key) => key in now && canon(now[key]) !== canon(base[key])));
};
