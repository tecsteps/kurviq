// Rich text: formatting inside a text element. Stored in the element's
// `customData.rich`; the element's `originalText` stays the plain text
// (list markers included), so everything that only knows plain text — search,
// copy, other Excalidraw apps, agents — still sees the words. The formatting
// counts only while its plain text equals `originalText` (an edit by a tool
// that doesn't know it simply drops it).

import { MARK_KEYS, MAX_DEPTH, markersOf, paraText, plainOf, sameMarks, marksOf, safeLink, normalizeDoc, docFromPlain, isPlainDoc, richDocOf, markdownOf } from "../../../scenes-mcp/richDoc.mjs";

import type { Marks, Run, ParaKind, Para, RichDoc, MarkKey } from "../../../scenes-mcp/richDoc.mjs";

// the stored form, its checks, plain text and markdown: scenes-mcp/richDoc.mjs (shared with the MCP tools)
export { MARK_KEYS, MAX_DEPTH, markersOf, paraText, plainOf, sameMarks, marksOf, safeLink, normalizeDoc, docFromPlain, isPlainDoc, richDocOf, markdownOf };
export type { Marks, Run, ParaKind, Para, RichDoc, MarkKey };

// ---------------------------------------------------------------------------
// positions: a position is (paragraph, offset into its text — markers not
// counted). The plain text offsets of `originalText` (markers counted) map
// to and from them.

export type Pos = { p: number; o: number };

export const posToPlain = (doc: RichDoc, pos: Pos, markers = markersOf(doc)) => {
  let offset = 0;
  for (let i = 0; i < pos.p; i++) {
    offset += markers[i].length + paraText(doc.p[i]).length + 1;
  }
  return offset + markers[pos.p].length + pos.o;
};

export const plainToPos = (doc: RichDoc, offset: number, markers = markersOf(doc)): Pos => {
  let rest = Math.max(0, offset);
  for (let p = 0; p < doc.p.length; p++) {
    const length = paraText(doc.p[p]).length;
    const full = markers[p].length + length;
    if (rest <= full || p === doc.p.length - 1) {
      return { p, o: Math.max(0, Math.min(length, rest - markers[p].length)) };
    }
    rest -= full + 1;
  }
  return { p: 0, o: 0 };
};

export const comparePos = (a: Pos, b: Pos) => a.p - b.p || a.o - b.o;

/** splits a paragraph's runs at an offset: [before, after] */
const splitRuns = (runs: Run[], offset: number): [Run[], Run[]] => {
  const before: Run[] = [];
  const after: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.t.length;
    if (end <= offset) {
      before.push(run);
    } else if (at >= offset) {
      after.push(run);
    } else {
      before.push({ ...run, t: run.t.slice(0, offset - at) });
      after.push({ ...run, t: run.t.slice(offset - at) });
    }
    at = end;
  }
  return [before, after];
};

const cloneDoc = (doc: RichDoc): RichDoc => ({ v: 1, p: doc.p.map((para) => ({ ...para, r: para.r.map((run) => ({ ...run })) })) });

/** the formatting at a position: of the character before it (or after, at a paragraph's start) */
export const marksAt = (doc: RichDoc, pos: Pos): Marks => {
  const runs = doc.p[pos.p]?.r || [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.t.length;
    if (pos.o > at && pos.o <= end) {
      return marksOf(run);
    }
    at = end;
  }
  return runs[0] ? marksOf(runs[0]) : {};
};

/** removes [from, to) */
export const deleteRange = (doc: RichDoc, from: Pos, to: Pos): RichDoc => {
  if (comparePos(from, to) >= 0) {
    return doc;
  }
  const next = cloneDoc(doc);
  const [before] = splitRuns(next.p[from.p].r, from.o);
  const [, after] = splitRuns(next.p[to.p].r, to.o);
  next.p.splice(from.p, to.p - from.p + 1, { ...next.p[from.p], r: [...before, ...after] });
  return normalizeDoc(next);
};

/** inserts text (newlines start new paragraphs, like the one it's in) */
export const insertText = (doc: RichDoc, at: Pos, text: string, marks: Marks): { doc: RichDoc; end: Pos } => {
  const next = cloneDoc(doc);
  const para = next.p[at.p];
  const [before, after] = splitRuns(para.r, at.o);
  const lines = text.split("\n");
  const paras: Para[] = lines.map((line, index) => ({
    ...(index ? { ...para, x: undefined } : para),
    r: [
      ...(index === 0 ? before : []),
      ...(line ? [{ ...marks, t: line }] : []),
      ...(index === lines.length - 1 ? after : []),
    ],
  }));
  next.p.splice(at.p, 1, ...paras);
  const last = lines[lines.length - 1].length;
  return {
    doc: normalizeDoc(next),
    end: { p: at.p + lines.length - 1, o: (lines.length === 1 ? at.o : 0) + last },
  };
};

/** splits the paragraph at a position (Enter) */
export const splitParagraph = (doc: RichDoc, at: Pos): { doc: RichDoc; end: Pos } => {
  const para = doc.p[at.p];
  // Enter in an empty list item: one level out, or out of the list
  if (para.k && !paraText(para)) {
    const next = cloneDoc(doc);
    next.p[at.p] = para.d ? { ...para, d: para.d - 1 } : { r: [] };
    return { doc: normalizeDoc(next), end: at };
  }
  const next = cloneDoc(doc);
  const [before, after] = splitRuns(para.r, at.o);
  const { x: _checked, ...kind } = para;
  next.p.splice(at.p, 1, { ...para, r: before }, { ...kind, r: after });
  return { doc: normalizeDoc(next), end: { p: at.p + 1, o: 0 } };
};

/** the part [from, to) of a doc, as a doc */
export const sliceDoc = (doc: RichDoc, from: Pos, to: Pos): RichDoc => {
  const paras: Para[] = [];
  for (let p = from.p; p <= to.p; p++) {
    const para = doc.p[p];
    let runs = para.r;
    if (p === to.p) {
      runs = splitRuns(runs, to.o)[0];
    }
    if (p === from.p) {
      runs = splitRuns(runs, from.o)[1];
    }
    paras.push({ ...para, r: runs.map((run) => ({ ...run })) });
  }
  return normalizeDoc({ v: 1, p: paras });
};

/**
 * Inserts a doc at a position: its first paragraph's text joins the
 * paragraph there, the others come with their own list kinds.
 */
export const insertDoc = (doc: RichDoc, at: Pos, piece: RichDoc): { doc: RichDoc; end: Pos } => {
  const next = cloneDoc(doc);
  const para = next.p[at.p];
  const [before, after] = splitRuns(para.r, at.o);
  const pieces = piece.p.map((p) => ({ ...p, r: p.r.map((run) => ({ ...run })) }));
  const last = pieces[pieces.length - 1];
  const endOffset = (pieces.length === 1 ? at.o : 0) + paraText(last).length;
  const paras: Para[] = pieces.map((p, index) => ({
    ...(index === 0 ? para : p.k || p.r.length ? p : { ...para, x: undefined }),
    r: [...(index === 0 ? before : []), ...p.r, ...(index === pieces.length - 1 ? after : [])],
  }));
  next.p.splice(at.p, 1, ...paras);
  return { doc: normalizeDoc(next), end: { p: at.p + pieces.length - 1, o: endOffset } };
};

/** applies a change to the formatting of [from, to) */
export const formatRange = (doc: RichDoc, from: Pos, to: Pos, change: (marks: Marks) => Marks): RichDoc => {
  const next = cloneDoc(doc);
  for (let p = from.p; p <= to.p; p++) {
    const para = next.p[p];
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    const runs: Run[] = [];
    let at = 0;
    for (const run of para.r) {
      const runEnd = at + run.t.length;
      const a = Math.max(start, at);
      const b = Math.min(end, runEnd);
      if (b <= a) {
        runs.push(run);
      } else {
        if (a > at) {
          runs.push({ ...run, t: run.t.slice(0, a - at) });
        }
        runs.push({ ...change(marksOf(run)), t: run.t.slice(a - at, b - at) });
        if (b < runEnd) {
          runs.push({ ...run, t: run.t.slice(b - at) });
        }
      }
      at = runEnd;
    }
    para.r = runs;
  }
  return normalizeDoc(next);
};

/** the formatting all of [from, to) shares (for the toolbar's state) */
export const commonMarks = (doc: RichDoc, from: Pos, to: Pos): Marks => {
  if (comparePos(from, to) >= 0) {
    return marksAt(doc, from);
  }
  let common: Marks | null = null;
  for (let p = from.p; p <= to.p; p++) {
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    let at = 0;
    for (const run of doc.p[p].r) {
      const runEnd = at + run.t.length;
      if (Math.min(end, runEnd) > Math.max(start, at)) {
        const marks = marksOf(run);
        if (!common) {
          common = marks;
        } else {
          for (const key of MARK_KEYS) {
            if (common[key] !== marks[key]) {
              delete common[key];
            }
          }
        }
      }
      at = runEnd;
    }
  }
  return common || {};
};

/** the values a mark takes in [from, to) (undefined: some text without it) */
export const markValues = (doc: RichDoc, from: Pos, to: Pos, key: MarkKey) => {
  const values = new Set<Marks[MarkKey]>();
  if (comparePos(from, to) >= 0) {
    values.add(marksAt(doc, from)[key]);
    return values;
  }
  for (let p = from.p; p <= to.p; p++) {
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    let at = 0;
    for (const run of doc.p[p].r) {
      const runEnd = at + run.t.length;
      if (Math.min(end, runEnd) > Math.max(start, at)) {
        values.add(run[key]);
      }
      at = runEnd;
    }
  }
  return values;
};

/** the stretch around a position that has the same value of a mark (e.g. a link) */
export const markRangeAt = (doc: RichDoc, pos: Pos, key: MarkKey): { from: Pos; to: Pos } | null => {
  const runs = doc.p[pos.p]?.r || [];
  const value = marksAt(doc, pos)[key];
  if (value === undefined) {
    return null;
  }
  let at = 0;
  const spans = runs.map((run) => {
    const span = { start: at, end: at + run.t.length, same: run[key] === value };
    at = span.end;
    return span;
  });
  const index = spans.findIndex((span) => span.same && pos.o >= span.start && pos.o <= span.end);
  if (index < 0) {
    return null;
  }
  let first = index;
  let last = index;
  while (first > 0 && spans[first - 1].same) first--;
  while (last < spans.length - 1 && spans[last + 1].same) last++;
  return { from: { p: pos.p, o: spans[first].start }, to: { p: pos.p, o: spans[last].end } };
};

export const setParagraphs =(doc: RichDoc, from: number, to: number, change: (para: Para) => Para): RichDoc => {
  const next = cloneDoc(doc);
  for (let p = from; p <= to; p++) {
    next.p[p] = change(next.p[p]);
  }
  return normalizeDoc(next);
};

// ---------------------------------------------------------------------------
// markdown-ish text <-> doc, for agents (see the MCP's `richText`)

const MD_MARKS: Array<[RegExp, MarkKey]> = [
  [/^\*\*([\s\S]+?)\*\*/, "b"],
  [/^__([\s\S]+?)__/, "u"],
  [/^~~([\s\S]+?)~~/, "s"],
  [/^\*([^*\s][\s\S]*?)\*/, "i"],
];

const parseInline = (text: string, marks: Marks, runs: Run[]) => {
  let plain = "";
  const flush = () => {
    if (plain) {
      runs.push({ ...marks, t: plain });
      plain = "";
    }
  };
  let rest = text;
  while (rest) {
    if (rest[0] === "\\" && rest.length > 1 && /[*_~[\]{}\\]/.test(rest[1])) {
      plain += rest[1];
      rest = rest.slice(2);
      continue;
    }
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (link) {
      flush();
      parseInline(link[1], { ...marks, a: link[2] }, runs);
      rest = rest.slice(link[0].length);
      continue;
    }
    // {color=#e03131 highlight=#ffec99 size=0.8}text{/}
    const styled = rest.match(/^\{((?:\s*(?:color|highlight|size)=[^\s}]+)+)\s*\}([\s\S]*?)\{\/\}/);
    if (styled) {
      flush();
      const next: Marks = { ...marks };
      for (const [, key, value] of styled[1].matchAll(/(color|highlight|size)=([^\s}]+)/g)) {
        if (key === "color") {
          next.c = value;
        } else if (key === "highlight") {
          next.h = value;
        } else if (Number(value) > 0) {
          next.z = Number(value);
        }
      }
      parseInline(styled[2], next, runs);
      rest = rest.slice(styled[0].length);
      continue;
    }
    const mark = MD_MARKS.map(([re, key]) => [rest.match(re), key] as const).find(([m]) => m);
    if (mark) {
      flush();
      parseInline(mark[0]![1], { ...marks, [mark[1]]: true }, runs);
      rest = rest.slice(mark[0]![0].length);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
};

/**
 * Markdown-like text to a doc: `# ` (size 1.6, bold), `## ` (1.3, bold),
 * `- ` / `* ` bullets, `1. ` numbered, `[ ] ` / `[x] ` checklist (indent with
 * 2 spaces per level); inline **bold**, *italic*, __underline__,
 * ~~strike~~, [link](url) and {color=#hex highlight=#hex size=0.8}…{/}.
 */
export const docFromMarkdown = (markdown: string): RichDoc => {
  const paras: Para[] = markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const indent = line.match(/^ */)![0].length;
    let rest = line.slice(indent);
    const para: Para = { r: [] };
    const base: Marks = {};
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(#{1,3}) /))) {
      base.b = true;
      base.z = [1.6, 1.3, 1.1][m[1].length - 1];
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^[-*] \[( |x|X)\] /)) || (m = rest.match(/^\[( |x|X)\] /))) {
      para.k = "todo";
      if (m[1].toLowerCase() === "x") {
        para.x = true;
      }
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^[-*•] /))) {
      para.k = "ul";
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^\d+[.)] /))) {
      para.k = "ol";
      rest = rest.slice(m[0].length);
    }
    if (para.k) {
      para.d = Math.min(MAX_DEPTH, Math.floor(indent / 2));
    } else if (indent) {
      rest = line;
    }
    parseInline(rest, base, para.r);
    return para;
  });
  return normalizeDoc({ v: 1, p: paras });
};

