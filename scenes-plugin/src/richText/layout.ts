// Rich text layout and drawing. The browser lays a doc out (the same HTML and
// CSS the editor shows), we read where every piece of text landed, and draw
// those pieces on the canvas and into SVG (as real text), so what you see
// while editing is what the canvas, the export and the PDF show.
//
// ../../vite.config.mts patches Excalidraw's text measuring and drawing to
// call richWrap / richMeasure / drawRich / svgRich.

import { applyDarkModeFilter, getFontFamilyString, getFontString } from "@excalidraw/common";

import { MARK_KEYS, markersOf, richDocOf, safeLink } from "./model";

import type { Marks, Para, RichDoc, Run } from "./model";

export const LINK_COLOR = "#1971c2";
/** a list level's indent, in the element's font size */
export const LIST_INDENT = 1.6;
/** room between a list marker and its text, in the marker's size */
const MARKER_GAP = 0.35;
/**
 * Bold is drawn as an outline around the letters, this thick (in the text's
 * size): Excalidraw's fonts have no bold faces, and the canvas doesn't fake
 * them. The editor (CSS text-stroke), the canvas and SVG do the same.
 */
export const BOLD_STROKE = 0.055;

type TextSpec = {
  id?: string;
  fontFamily: number;
  fontSize: number;
  lineHeight: number;
  textAlign: string;
};

// ---------------------------------------------------------------------------
// HTML (the editor shows the same)

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** a tooltip without underline or link: underlined dotted */
const tipOnly = (marks: Marks) => !!marks.n && !marks.u && !marks.a;

const round = (value: number) => Math.round(value * 10000) / 10000;

/** the smallest size in a paragraph: its line height floor (the CSS strut) */
const paraSize = (para: Para) => (para.r.length ? Math.min(...para.r.map((run) => run.z || 1)) : 1);

const runStyle = (run: Marks, z0: number, dark: boolean) => {
  const style: string[] = [];
  if (run.b) style.push(`-webkit-text-stroke:${BOLD_STROKE}em currentColor`);
  if (run.i) style.push("font-style:italic");
  const decoration = [(run.u || run.a || run.n) && "underline", run.s && "line-through"].filter(Boolean);
  if (decoration.length) style.push(`text-decoration:${decoration.join(" ")}`);
  // a tooltip only: a dotted underline (a real underline or link wins)
  if (tipOnly(run)) style.push("text-decoration-style:dotted");
  const color = run.c || (run.a ? LINK_COLOR : null);
  if (color) style.push(`color:${applyDarkModeFilter(color, dark)}`);
  if (run.h) style.push(`background-color:${applyDarkModeFilter(run.h, dark)}`);
  if ((run.z || 1) !== z0) style.push(`font-size:${round((run.z || 1) / z0)}em`);
  return style.join(";");
};

const runAttrs = (run: Run) =>
  MARK_KEYS
    .filter((key) => run[key] !== undefined)
    .map((key) => ` data-${key}="${escapeHtml(String(run[key]))}"`)
    .join("") + (run.n ? ` title="${escapeHtml(run.n)}"` : "");

export const paraAttrs = (para: Para, marker: string) => {
  const z0 = paraSize(para);
  const style = [`font-size:${round(z0)}em`];
  if (para.k) {
    style.push("text-align:left", `--rt-indent:${round((LIST_INDENT * ((para.d || 0) + 1)) / z0)}em`, "padding-left:var(--rt-indent)");
  }
  const attrs = [
    para.k && ` data-k="${escapeHtml(String(para.k))}"`,
    para.d && ` data-d="${Number(para.d) || 0}"`,
    para.x && ` data-x="1"`,
    marker && ` data-m="${escapeHtml(marker.trim())}"`,
  ].filter(Boolean);
  return `class="rt-p"${attrs.join("")} style="${escapeHtml(style.join(";"))}"`;
};

export const docToHtml = (doc: RichDoc, dark = false) => {
  const markers = markersOf(doc);
  return doc.p
    .map((para, index) => {
      const z0 = paraSize(para);
      const body = para.r.length
        ? para.r
            .map((run) => `<span${runAttrs(run)} style="${escapeHtml(runStyle(run, z0, dark))}">${escapeHtml(run.t)}</span>`)
            .join("")
        : "<br>";
      return `<div ${paraAttrs(para, markers[index])}>${body}</div>`;
    })
    .join("");
};

/** the editor's / measuring box's own style for an element */
export const boxStyle = (spec: TextSpec, wrapWidth: number | null) => ({
  font: getFontString(spec as any),
  lineHeight: String(spec.lineHeight),
  whiteSpace: wrapWidth === null ? "pre" : "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "break-word",
  textAlign: spec.textAlign,
  width: wrapWidth === null ? "max-content" : `${wrapWidth}px`,
});

// ---------------------------------------------------------------------------
// layout

export type Fragment = {
  text: string;
  /** left, from the box's left */
  x: number;
  /** width of the text (trailing spaces left out) */
  width: number;
  baseline: number;
  /** the text's own box (for highlights) */
  top: number;
  height: number;
  size: number;
  font: string;
  marks: Marks;
};

export type ListMarker = {
  kind: "ul" | "ol" | "todo";
  text: string;
  checked: boolean;
  /** where the marker ends (its right edge) */
  right: number;
  baseline: number;
  /** the middle of its line */
  middle: number;
  size: number;
};

export type RichLayout = {
  /** the text as Excalidraw keeps it: lines wrapped, markers included */
  text: string;
  width: number;
  height: number;
  fragments: Fragment[];
  markers: ListMarker[];
};

let host: HTMLDivElement | null = null;
const getHost = () => {
  if (!host?.isConnected) {
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.className = "rt-measure";
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
      margin: "0",
      padding: "0",
      border: "0",
    });
    document.body.appendChild(host);
  }
  return host;
};

const fontMetrics = new Map<string, { ascent: number; height: number }>();
/** where the baseline is in a font's text box, and how tall the box is */
const metricsOf = (font: string) => {
  let metrics = fontMetrics.get(font);
  if (!metrics) {
    const probe = document.createElement("div");
    Object.assign(probe.style, { position: "fixed", left: "-100000px", top: "0", font, lineHeight: "normal", whiteSpace: "pre" });
    const text = document.createTextNode("x");
    const base = document.createElement("span");
    Object.assign(base.style, { display: "inline-block", width: "0", height: "0", verticalAlign: "baseline" });
    probe.append(text, base);
    document.body.appendChild(probe);
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = range.getBoundingClientRect();
    metrics = { ascent: base.getBoundingClientRect().bottom - box.top, height: box.height };
    probe.remove();
    fontMetrics.set(font, metrics);
  }
  return metrics;
};

const cache = new Map<string, RichLayout>();
const CACHE_SIZE = 400;

if (typeof document !== "undefined" && (document as any).fonts?.addEventListener) {
  // a font that came in late changes every measure
  (document as any).fonts.addEventListener("loadingdone", () => {
    cache.clear();
    fontMetrics.clear();
    sizes.clear();
  });
}

/**
 * A fragment grows by a character at [left, right): from its leftmost to the
 * right end of its rightmost visible character. In right-to-left text (Arabic,
 * Hebrew) each further character lies left of the one before.
 */
export const growFragment = (fragment: { x: number; width: number }, ends: Map<object, number>, left: number, right: number, isSpace: boolean) => {
  fragment.x = Math.min(fragment.x, left);
  if (!isSpace) {
    ends.set(fragment, Math.max(ends.get(fragment) ?? -Infinity, right));
  }
  const end = ends.get(fragment);
  if (end !== undefined) {
    fragment.width = end - fragment.x;
  }
};

export const runFont = (marks: Marks, size: number, family: string) =>
  `${marks.i ? "italic " : ""}${round(size)}px ${family}`;

/**
 * Lays a doc out for an element: wrapped at `wrapWidth`, or not at all
 * (`null`: as wide as its longest line).
 */
export const layoutRich = (spec: TextSpec, doc: RichDoc, wrapWidth: number | null): RichLayout => {
  const key = JSON.stringify([doc.p, spec.fontFamily, spec.fontSize, spec.lineHeight, spec.textAlign, wrapWidth]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const box = getHost();
  Object.assign(box.style, boxStyle(spec, wrapWidth));
  box.innerHTML = docToHtml(doc);
  const origin = box.getBoundingClientRect();
  const family = getFontFamilyString(spec as any);
  const markerTexts = markersOf(doc);
  const range = document.createRange();

  const fragments: Fragment[] = [];
  const fragmentEnds = new Map<Fragment, number>();
  const markers: ListMarker[] = [];
  const paraTexts: string[] = [];
  let contentWidth = 0;

  doc.p.forEach((para, index) => {
    const el = box.children[index] as HTMLElement;
    const rect = el.getBoundingClientRect();
    const z0 = paraSize(para);
    const lines: string[] = [];
    let lineBaseline = Number.NaN;
    let lineLeft = Infinity;
    let lineRight = -Infinity;
    let firstBaseline = Number.NaN;
    const endLine = () => {
      if (Number.isFinite(lineLeft)) {
        const left = para.k ? rect.left - origin.left : lineLeft;
        contentWidth = Math.max(contentWidth, lineRight - left);
      }
    };

    para.r.forEach((run, runIndex) => {
      const node = el.children[runIndex]?.firstChild;
      if (!node) {
        return;
      }
      const size = spec.fontSize * (run.z || 1);
      const font = runFont(run, size, family);
      const { ascent, height } = metricsOf(font);
      let fragment: Fragment | null = null;
      let offset = 0;
      for (const char of Array.from(run.t)) {
        range.setStart(node, offset);
        range.setEnd(node, offset + char.length);
        offset += char.length;
        const r = range.getBoundingClientRect();
        const baseline = r.top - origin.top + ascent;
        const x = r.left - origin.left;
        const isSpace = /\s/.test(char);
        if (!lines.length || Math.abs(baseline - lineBaseline) > 1) {
          // a new line
          if (lines.length) {
            endLine();
          }
          lines.push("");
          lineBaseline = baseline;
          lineLeft = Infinity;
          lineRight = -Infinity;
          if (Number.isNaN(firstBaseline)) {
            firstBaseline = baseline;
          }
          fragment = null;
        }
        lines[lines.length - 1] += char;
        if (!fragment) {
          fragment = { text: "", x, width: 0, baseline: lineBaseline, top: r.top - origin.top, height, size, font, marks: run };
          fragments.push(fragment);
        }
        fragment.text += char;
        growFragment(fragment, fragmentEnds, x, r.right - origin.left, isSpace);
        if (!isSpace) {
          lineLeft = Math.min(lineLeft, fragment.x);
          lineRight = Math.max(lineRight, r.right - origin.left);
        }
      }
    });
    endLine();

    if (Number.isNaN(firstBaseline)) {
      // an empty paragraph: the baseline of its (strut's) line
      const { ascent, height } = metricsOf(runFont({}, spec.fontSize * z0, family));
      firstBaseline = rect.top - origin.top + (rect.height - height) / 2 + ascent;
    }
    if (para.k) {
      const contentLeft = rect.left - origin.left + Number.parseFloat(getComputedStyle(el).paddingLeft || "0");
      const size = spec.fontSize * z0;
      const strut = metricsOf(runFont({}, size, family));
      markers.push({
        kind: para.k,
        text: markerTexts[index].trim(),
        checked: !!para.x,
        right: contentLeft - MARKER_GAP * size,
        baseline: firstBaseline,
        middle: firstBaseline - strut.ascent + strut.height / 2,
        size,
      });
    }
    paraTexts.push(markerTexts[index] + lines.join("\n"));
  });

  const height = box.getBoundingClientRect().height;
  const layout: RichLayout = {
    text: paraTexts.join("\n"),
    width: wrapWidth === null ? origin.width : Math.min(wrapWidth, Math.ceil(contentWidth * 100) / 100),
    height,
    fragments,
    markers,
  };
  box.innerHTML = "";
  cache.set(key, layout);
  if (cache.size > CACHE_SIZE) {
    cache.delete(cache.keys().next().value!);
  }
  return layout;
};

// ---------------------------------------------------------------------------
// Excalidraw's measuring, for formatted texts (see ../../vite.config.mts)

type TextElementLike = TextSpec & {
  id: string;
  type: string;
  text: string;
  originalText: string;
  width: number;
  height: number;
  autoResize: boolean;
  containerId: string | null;
  strokeColor: string;
  customData?: Record<string, any> | null;
};

/** sizes of texts laid out lately: element (id, font, formatting) + wrapped text -> size */
const sizes = new Map<string, { width: number; height: number }>();
/** a number per formatting object (a change of formatting is a new object): part of the size's key */
const richIds = new WeakMap<object, number>();
let lastRichId = 0;
const richId = (rich: unknown) => {
  if (!rich || typeof rich !== "object") {
    return 0;
  }
  let id = richIds.get(rich);
  if (id === undefined) {
    lastRichId += 1;
    id = lastRichId;
    richIds.set(rich, id);
  }
  return id;
};
const sizeKey = (element: TextElementLike, text: string) =>
  `${element.id}\0${element.fontFamily}\0${element.fontSize}\0${element.lineHeight}\0${element.textAlign}\0${richId(element.customData?.rich)}\0${text}`;
const remember = (element: TextElementLike, layout: RichLayout) => {
  sizes.set(sizeKey(element, layout.text), { width: layout.width, height: layout.height });
  if (sizes.size > CACHE_SIZE) {
    sizes.delete(sizes.keys().next().value!);
  }
};

/** wrapText for a formatted text: null if it isn't one */
export const richWrap = (element: TextElementLike | null | undefined, originalText: string, maxWidth: number) => {
  const doc = element && richDocOf(element, originalText);
  if (!doc || typeof document === "undefined") {
    return null;
  }
  const layout = layoutRich(element, doc, Number.isFinite(maxWidth) ? Math.max(1, maxWidth) : null);
  remember(element, layout);
  return layout.text;
};

/** measureText for a formatted text (text: as richWrap returned it, or its plain text) */
export const richMeasure = (element: TextElementLike | null | undefined, text: string) => {
  if (!element?.customData?.rich || typeof document === "undefined") {
    return null;
  }
  // the text itself first (cheap: layouts are cached by doc and font); the remembered sizes only
  // for wrapped text, which is no longer the plain text
  const doc = richDocOf(element, text);
  if (doc) {
    const layout = layoutRich(element, doc, null);
    remember(element, layout);
    return { width: layout.width, height: layout.height };
  }
  const known = sizes.get(sizeKey(element, text));
  if (known) {
    return known;
  }
  if (text === element.text && richDocOf(element)) {
    return { width: element.width, height: element.height };
  }
  return null;
};

/** wrapText + measureText in one, for a font size of its own (sticky notes) */
export const richFit = (element: TextElementLike, originalText: string, maxWidth: number, fontSize: number) => {
  const text = richWrap({ ...element, fontSize }, originalText, maxWidth);
  return text === null ? null : { text, ...richMeasure({ ...element, fontSize }, text)! };
};

/** the layout an element shows */
export const elementLayout = (element: TextElementLike) => {
  const doc = richDocOf(element);
  if (!doc || typeof document === "undefined") {
    return null;
  }
  const wraps = !!element.containerId || !element.autoResize;
  const layout = layoutRich(element, doc, wraps ? element.width + 1 : null);
  // laid out 1px wider than the element (so no line wraps earlier than it
  // did): centered and right-aligned lines move back by that; a text that
  // doesn't wrap aligns inside its box, like plain text (the box may be wider)
  const extra = wraps ? -1 : element.width - layout.width;
  let shift = 0;
  if (element.textAlign === "center") shift = extra / 2;
  else if (element.textAlign === "right") shift = extra;
  return { layout, shift };
};

const decorations = (fragment: Fragment) => {
  const { marks, size, baseline } = fragment;
  const thickness = Math.max(1, size / 15);
  const lines: Array<{ y: number; thickness: number; dotted?: boolean }> = [];
  if (marks.u || marks.a || marks.n) lines.push({ y: baseline + size * 0.1, thickness, dotted: tipOnly(marks) });
  if (marks.s) lines.push({ y: baseline - size * 0.28, thickness });
  return lines;
};

const markerColor = (element: TextElementLike, _marker: ListMarker, dark: boolean) =>
  applyDarkModeFilter(element.strokeColor, dark);

const drawMarkers = (element: TextElementLike, context: CanvasRenderingContext2D, dark: boolean, markers: ListMarker[]) => {
  const family = getFontFamilyString(element as any);
  for (const marker of markers) {
    const color = markerColor(element, marker, dark);
    context.fillStyle = color;
    context.strokeStyle = color;
    if (marker.kind === "todo") {
      const box = checkbox(marker);
      context.lineWidth = box.stroke;
      context.beginPath();
      (context as any).roundRect ? (context as any).roundRect(box.x, box.y, box.side, box.side, box.radius) : context.rect(box.x, box.y, box.side, box.side);
      context.stroke();
      if (marker.checked) {
        context.beginPath();
        box.check.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
        context.lineWidth = box.stroke * 1.3;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke();
      }
    } else {
      context.font = runFont({}, marker.size, family);
      context.textAlign = "right";
      context.fillText(marker.text, marker.right, marker.baseline);
      context.textAlign = "left";
    }
  }
};

/** a tooltip's dotted underline: dots a line thick, as far apart */
const drawDotted = (context: CanvasRenderingContext2D, fragment: Fragment, line: { y: number; thickness: number }) => {
  for (let x = fragment.x; x < fragment.x + fragment.width; x += line.thickness * 2) {
    context.fillRect(x, line.y - line.thickness / 2, line.thickness, line.thickness);
  }
};

/** a fragment's underline / strikethrough lines, in the current fill color */
const drawDecorations = (context: CanvasRenderingContext2D, fragment: Fragment) => {
  for (const line of decorations(fragment)) {
    if (line.dotted) {
      drawDotted(context, fragment, line);
    } else {
      context.fillRect(fragment.x, line.y - line.thickness / 2, fragment.width, line.thickness);
    }
  }
};

/** draws a formatted text on the canvas (at its top-left); false if it isn't one */
export const drawRich = (element: TextElementLike, context: CanvasRenderingContext2D, dark: boolean) => {
  const result = elementLayout(element);
  if (!result) {
    return false;
  }
  const { layout, shift } = result;
  context.save();
  context.canvas.setAttribute("dir", "ltr");
  context.translate(shift, 0);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  for (const fragment of layout.fragments) {
    if (fragment.marks.h && fragment.width > 0) {
      context.fillStyle = applyDarkModeFilter(fragment.marks.h, dark);
      context.fillRect(fragment.x, fragment.top, fragment.width, fragment.height);
    }
  }
  for (const fragment of layout.fragments) {
    const color = applyDarkModeFilter(fragment.marks.c || (fragment.marks.a ? LINK_COLOR : element.strokeColor), dark);
    context.font = fragment.font;
    context.fillStyle = color;
    if (fragment.marks.b) {
      context.strokeStyle = color;
      context.lineWidth = fragment.size * BOLD_STROKE;
      context.lineJoin = "round";
      context.strokeText(fragment.text, fragment.x, fragment.baseline);
    }
    context.fillText(fragment.text, fragment.x, fragment.baseline);
    drawDecorations(context, fragment);
  }
  drawMarkers(element, context, dark, layout.markers);
  context.restore();
  return true;
};

const checkbox = (marker: ListMarker) => {
  const side = marker.size * 0.72;
  const x = marker.right - side;
  const y = marker.middle - side / 2;
  return {
    x,
    y,
    side,
    radius: side * 0.18,
    stroke: Math.max(1, marker.size / 14),
    check: [
      [x + side * 0.22, y + side * 0.52],
      [x + side * 0.43, y + side * 0.72],
      [x + side * 0.8, y + side * 0.28],
    ] as Array<[number, number]>,
  };
};

const SVG_NS = "http://www.w3.org/2000/svg";

type AddSvg = (parent: Element, tag: string, attrs: Record<string, string | number>) => Element;

const svgMarkers = (element: TextElementLike, dark: boolean, markers: ListMarker[], family: string, add: AddSvg, group: Element) => {
  for (const marker of markers) {
    const color = markerColor(element, marker, dark);
    if (marker.kind === "todo") {
      const box = checkbox(marker);
      add(group, "rect", {
        x: box.x,
        y: box.y,
        width: box.side,
        height: box.side,
        rx: box.radius,
        fill: "none",
        stroke: color,
        "stroke-width": box.stroke,
      });
      if (marker.checked) {
        add(group, "polyline", {
          points: box.check.map(([x, y]) => `${x},${y}`).join(" "),
          fill: "none",
          stroke: color,
          "stroke-width": box.stroke * 1.3,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        });
      }
    } else {
      const text = add(group, "text", {
        x: marker.right,
        y: marker.baseline,
        "font-family": family,
        "font-size": `${round(marker.size)}px`,
        fill: color,
        "text-anchor": "end",
        "dominant-baseline": "alphabetic",
      });
      text.textContent = marker.text;
    }
  }
};

/** a fragment's underline / strikethrough lines (a tooltip's dotted) */
const svgDecorations = (fragment: Fragment, color: string, add: AddSvg, parent: Element) => {
  for (const line of decorations(fragment)) {
    if (line.dotted) {
      const dash = `${line.thickness} ${line.thickness}`;
      add(parent, "line", { x1: fragment.x, y1: line.y, x2: fragment.x + fragment.width, y2: line.y, stroke: color, "stroke-width": line.thickness, "stroke-dasharray": dash });
    } else {
      add(parent, "rect", { x: fragment.x, y: line.y - line.thickness / 2, width: fragment.width, height: line.thickness, fill: color });
    }
  }
};

/** a fragment's text attributes: font, color, bold, italic */
const svgTextAttrs = (fragment: Fragment, color: string, family: string) => ({
  x: fragment.x,
  y: fragment.baseline,
  "font-family": family,
  "font-size": `${round(fragment.size)}px`,
  fill: color,
  style: "white-space: pre;",
  "dominant-baseline": "alphabetic",
  ...(fragment.marks.b ? { stroke: color, "stroke-width": round(fragment.size * BOLD_STROKE), "stroke-linejoin": "round" } : {}),
  ...(fragment.marks.i ? { "font-style": "italic" } : {}),
});

const svgFragments = (element: TextElementLike, dark: boolean, fragments: Fragment[], family: string, add: AddSvg, group: Element) => {
  for (const fragment of fragments) {
    const color = applyDarkModeFilter(fragment.marks.c || (fragment.marks.a ? LINK_COLOR : element.strokeColor), dark);
    const href = safeLink(fragment.marks.a);
    const parent = href ? add(group, "a", { href, target: "_blank", rel: "noopener noreferrer" }) : group;
    const text = add(parent, "text", svgTextAttrs(fragment, color, family));
    text.textContent = fragment.text;
    if (fragment.marks.n) {
      // hovering the text shows its tooltip where SVG is viewed
      add(text, "title", {}).textContent = fragment.marks.n;
    }
    svgDecorations(fragment, color, add, parent);
  }
};

/** adds a formatted text to an SVG group (at its top-left); false if it isn't one */
export const svgRich = (element: TextElementLike, node: SVGElement, doc: Document, dark: boolean) => {
  const result = elementLayout(element);
  if (!result) {
    return false;
  }
  const { layout, shift } = result;
  const family = getFontFamilyString(element as any);
  const add = (parent: Element, tag: string, attrs: Record<string, string | number>) => {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      child.setAttribute(name, String(value));
    }
    parent.appendChild(child);
    return child;
  };
  const group = shift ? add(node, "g", { transform: `translate(${shift} 0)` }) : node;
  for (const fragment of layout.fragments) {
    if (fragment.marks.h && fragment.width > 0) {
      add(group, "rect", {
        x: fragment.x,
        y: fragment.top,
        width: fragment.width,
        height: fragment.height,
        fill: applyDarkModeFilter(fragment.marks.h, dark),
      });
    }
  }
  svgFragments(element, dark, layout.fragments, family, add, group);
  svgMarkers(element, dark, layout.markers, family, add, group);
  return true;
};
