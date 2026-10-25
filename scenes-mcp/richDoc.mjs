// Formatted text (customData.rich): the stored form, how it is checked, its
// plain text and its markdown-like form. Shared by the app
// (scenes-plugin/src/richText/model.ts, which adds the editing operations) and
// the MCP tools (agents see formatting as `markdown`).
//
// Rich text: formatting inside a text element. Stored in the element's
// `customData.rich`; the element's `originalText` stays the plain text
// (list markers included), so everything that only knows plain text — search,
// copy, other Excalidraw apps, agents — still sees the words. The formatting
// counts only while its plain text equals `originalText` (an edit by a tool
// that doesn't know it simply drops it).

export const MARK_KEYS = ["b", "i", "u", "s", "c", "h", "a", "z"];

export const MAX_DEPTH = 4;

const BULLETS = ["•", "◦", "▪"];

/** the marker each paragraph shows in front of it ("" for none) */
export const markersOf = (doc) => {
  // numbering per level: a plain paragraph ends all lists, a list item ends
  // the deeper levels, and a bullet or checklist item the numbering at its own
  const counters = [];
  return doc.p.map((para) => {
    const depth = para.d || 0;
    if (!para.k) {
      counters.length = 0;
      return "";
    }
    counters.length = Math.min(counters.length, depth + 1);
    if (para.k === "ol") {
      counters[depth] = (counters[depth] || 0) + 1;
      return `${counters[depth]}. `;
    }
    counters[depth] = 0;
    if (para.k === "ul") {
      return `${BULLETS[depth % BULLETS.length]} `;
    }
    if (para.k === "todo") {
      return para.x ? "☑ " : "☐ ";
    }
    return "";
  });
};

export const paraText = (para) => para.r.map((run) => run.t).join("");

/** the plain text: the element's `originalText` */
export const plainOf = (doc) => {
  const markers = markersOf(doc);
  return doc.p.map((para, index) => markers[index] + paraText(para)).join("\n");
};

export const sameMarks = (a, b) => MARK_KEYS.every((key) => a[key] === b[key]);

export const marksOf = (run) => {
  const marks = {};
  for (const key of MARK_KEYS) {
    if (run[key] !== undefined) {
      marks[key] = run[key];
    }
  }
  return marks;
};

// Scenes come from anywhere (shared links, files, agents, the clipboard), so
// formatting is checked value by value: it ends up in HTML and in links.
/** a CSS color: #hex, rgb()/rgba() with numbers, or a color name */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,30})$/i;

/** links only to the web and to mail (no javascript:, data: …) */
export const safeLink = (value) => {
  if (typeof value !== "string" || value.length > 2048) {
    return null;
  }
  const link = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(link) && !/[\u0000-\u001f\s<>"]/.test(link) ? link : null;
};

const cleanMark = (key, value) => {
  switch (key) {
    case "b":
    case "i":
    case "u":
    case "s":
      return value === true ? true : undefined;
    case "c":
    case "h":
      return typeof value === "string" && COLOR_RE.test(value.trim()) ? value.trim() : undefined;
    case "a":
      return safeLink(value) ?? undefined;
    case "z":
      return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 10 && Math.abs(value - 1) >= 0.001
        ? value
        : undefined;
  }
};

const cleanMarks = (run) => {
  const next = { t: typeof run.t === "string" ? run.t : "" };
  for (const key of MARK_KEYS) {
    const value = cleanMark(key, run[key]);
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
};

/** merges neighbors with the same formatting, drops empty pieces */
export const normalizeDoc = (doc) => ({
  v: 1,
  p: (doc.p.length ? doc.p : [{ r: [] }]).map((para) => {
    const runs = [];
    for (const raw of para.r) {
      const run = cleanMarks(raw);
      if (!run.t) {
        continue;
      }
      const last = runs[runs.length - 1];
      if (last && sameMarks(last, run)) {
        last.t += run.t;
      } else {
        runs.push(run);
      }
    }
    const next = { r: runs };
    if (para.k === "ul" || para.k === "ol" || para.k === "todo") {
      next.k = para.k;
      const depth = Math.max(0, Math.min(MAX_DEPTH, Math.round(para.d || 0)));
      if (depth) {
        next.d = depth;
      }
      if (para.k === "todo" && para.x) {
        next.x = true;
      }
    }
    return next;
  }),
});

export const docFromPlain = (text) => ({
  v: 1,
  p: text.split("\n").map((line) => ({ r: line ? [{ t: line }] : [] })),
});

/** true if the doc has no formatting at all (plain text would do) */
export const isPlainDoc = (doc) =>
  doc.p.every((para) => !para.k && para.r.every((run) => MARK_KEYS.every((key) => run[key] === undefined)));

const isDoc = (value) =>
  !!value &&
  value.v === 1 &&
  Array.isArray(value.p) &&
  value.p.every(
    (para) => para && typeof para === "object" && Array.isArray(para.r) && para.r.every((run) => run && typeof run.t === "string"),
  );

/** the checked, normalized version of a stored doc (stored docs are never used as they are) */
const checked = new WeakMap();

const checkedDoc = (doc) => {
  let clean = checked.get(doc);
  if (!clean) {
    clean = normalizeDoc(doc);
    checked.set(doc, clean);
  }
  return clean;
};

/**
 * The formatting of a text element, if it still applies to its text
 * (`originalText`, or the one given).
 */
export const richDocOf = (element, originalText = element?.originalText) => {
  const doc = element?.customData?.rich;
  if (!isDoc(doc) || typeof originalText !== "string") {
    return null;
  }
  const clean = checkedDoc(doc);
  return plainOf(clean) === originalText ? clean : null;
};

const escapeMd = (text) => text.replace(/([*_~[\]{}\\])/g, "\\$1");

/** a doc as the markdown-like text docFromMarkdown reads */
export const markdownOf = (doc) =>
  doc.p
    .map((para) => {
      const indent = para.k ? "  ".repeat(para.d || 0) : "";
      const prefix = para.k === "ul" ? "- " : para.k === "ol" ? "1. " : para.k === "todo" ? (para.x ? "[x] " : "[ ] ") : "";
      const body = para.r
        .map((run) => {
          let text = escapeMd(run.t);
          const style = [run.c && `color=${run.c}`, run.h && `highlight=${run.h}`, run.z && `size=${Math.round(run.z * 100) / 100}`].filter(
            Boolean,
          );
          if (style.length) {
            text = `{${style.join(" ")}}${text}{/}`;
          }
          if (run.s) text = `~~${text}~~`;
          if (run.u) text = `__${text}__`;
          if (run.i) text = `*${text}*`;
          if (run.b) text = `**${text}**`;
          if (run.a) text = `[${text}](${run.a})`;
          return text;
        })
        .join("");
      return indent + prefix + body;
    })
    .join("\n");
