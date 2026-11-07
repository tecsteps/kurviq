// Formatting part of a text for agents, without resending it: an update's
// `format: { match: "a phrase", color: "#1565c0", bold: true }` styles that
// phrase in the element's CURRENT text (so whatever else the user changed in
// it stays). See REFERENCE.md, "Formatted text".

import { formatRange, normalizeDoc, paraText } from "./model";

import type { Marks, Pos, RichDoc } from "./model";

export type FormatSpec = {
  /** the phrase to format, as written (without list markers; a line break is "\n") */
  match: string;
  /** which one: 1 = the first (default), or "all" */
  occurrence?: number | "all";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** text color; null removes it */
  color?: string | null;
  /** highlight (background) color; null removes it */
  highlight?: string | null;
  /** size relative to the element's font size (e.g. 1.5); null or 1 = normal */
  size?: number | null;
  /** a link (http(s): or mailto:); null removes it */
  link?: string | null;
};

const FLAGS = { bold: "b", italic: "i", underline: "u", strike: "s" } as const;
const VALUES = { color: "c", highlight: "h", size: "z", link: "a" } as const;
const KNOWN = new Set(["match", "occurrence", ...Object.keys(FLAGS), ...Object.keys(VALUES)]);

/** a value the stored form accepts (colors, links and sizes are checked there) */
const accepted = (key: "c" | "h" | "z" | "a", value: unknown) => {
  const doc = normalizeDoc({ v: 1, p: [{ r: [{ t: "x", [key]: value } as any] }] });
  return (doc.p[0].r[0] as any)[key] !== undefined;
};

const valueDescription = (key: string) => {
  if (key === "z") return "a number from 0.1 to 10";
  if (key === "a") return "an http(s): or mailto: link";
  return "a CSS color, e.g. #1565c0";
};

const collectFlags = (spec: FormatSpec, where: string, set: Marks, unset: string[]) => {
  for (const [name, key] of Object.entries(FLAGS)) {
    const value = (spec as any)[name];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new TypeError(`${where}: format.${name} must be true or false`);
    }
    if (value) {
      (set as any)[key] = true;
    } else {
      unset.push(key);
    }
  }
};

const trimValue = (value: any) => typeof value === "string" ? value.trim() : value;

const collectValues = (spec: FormatSpec, where: string, set: Marks, unset: string[]) => {
  for (const [name, key] of Object.entries(VALUES)) {
    let value = (spec as any)[name];
    if (value === undefined) continue;
    if (key === "z" && value === 1) value = null;
    if (value === null || value === false) {
      unset.push(key);
    } else if (accepted(key, trimValue(value))) {
      (set as any)[key] = trimValue(value);
    } else {
      throw new Error(
        `${where}: format.${name} ${JSON.stringify(value)} is not valid (${
          valueDescription(key)
        }; null removes it)`,
      );
    }
  }
};

/** checks a spec, returns how it changes a piece's marks */
const changeOf = (spec: FormatSpec, where: string) => {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${where}: format must be { match, bold / italic / underline / strike / color / highlight / size / link }`);
  }
  const unknown = Object.keys(spec).filter((key) => !KNOWN.has(key));
  if (unknown.length) {
    throw new Error(`${where}: format does not know ${unknown.join(", ")} (it takes match, occurrence, bold, italic, underline, strike, color, highlight, size, link)`);
  }
  if (typeof spec.match !== "string" || !spec.match) {
    throw new Error(`${where}: format needs "match": the phrase to format, as it is written in the text`);
  }
  const set: Marks = {};
  const unset: string[] = [];
  collectFlags(spec, where, set, unset);
  collectValues(spec, where, set, unset);
  if (!Object.keys(set).length && !unset.length) {
    throw new Error(`${where}: format changes nothing: say what to set (e.g. "color": "#1565c0", "bold": true; null / false removes)`);
  }
  return (marks: Marks): Marks => {
    const next: Record<string, unknown> = { ...marks, ...set };
    for (const key of unset) {
      delete next[key];
    }
    return next as Marks;
  };
};

/** the paragraphs' text as `match` is searched in (no list markers, "\n" between paragraphs) */
export const searchableText = (doc: RichDoc) => doc.p.map(paraText).join("\n");

const posAt = (doc: RichDoc, offset: number): Pos => {
  let rest = offset;
  for (let p = 0; p < doc.p.length; p++) {
    const length = paraText(doc.p[p]).length;
    if (rest <= length) {
      return { p, o: rest };
    }
    rest -= length + 1;
  }
  const last = doc.p.length - 1;
  return { p: last, o: paraText(doc.p[last]).length };
};

const shorten = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

const applySpec = (next: RichDoc, spec: FormatSpec, where: string): RichDoc => {
    const change = changeOf(spec, where);
    const text = searchableText(next);
    const starts: number[] = [];
    for (let at = text.indexOf(spec.match); at >= 0; at = text.indexOf(spec.match, at + spec.match.length)) {
      starts.push(at);
    }
    if (!starts.length) {
      throw new Error(
        `${where}: format: "${shorten(spec.match)}" is not in the text (exact, case-sensitive; without list markers). The text now reads: "${shorten(text)}". Nothing was changed.`,
      );
    }
    const occurrence = spec.occurrence ?? 1;
    if (occurrence !== "all" && (!Number.isInteger(occurrence) || occurrence < 1)) {
      throw new Error(`${where}: format.occurrence must be a number from 1 or "all"`);
    }
    if (occurrence !== "all" && occurrence > starts.length) {
      throw new Error(`${where}: format: "${shorten(spec.match)}" occurs ${starts.length} time(s), not ${occurrence}. Nothing was changed.`);
    }
    const chosen = occurrence === "all" ? starts : [starts[occurrence - 1]];
    for (const start of chosen) {
      next = formatRange(next, posAt(next, start), posAt(next, start + spec.match.length), change);
    }
  return next;
};

/**
 * Applies one or more `format` specs to a doc. Throws (nothing changed) if a
 * phrase is not found or a spec is invalid; `where` names the element.
 */
export const applyFormat = (doc: RichDoc, format: FormatSpec | FormatSpec[], where: string): RichDoc => {
  const specs = Array.isArray(format) ? format : [format];
  if (!specs.length) {
    throw new Error(`${where}: format is empty`);
  }
  let next = doc;
  for (const spec of specs) {
    next = applySpec(next, spec, where);
  }
  return next;
};
