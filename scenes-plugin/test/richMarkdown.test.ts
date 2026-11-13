import { describe, expect, it } from "vitest";

import { docFromMarkdown, markdownOf, normalizeDoc } from "../src/richText/model";

import type { Marks, Para, RichDoc, Run } from "../src/richText/model";

// markdownOf and docFromMarkdown must be inverse: speaker notes are stored only
// as this markdown, and agents read and send the same form back.

const FLAGS = ["b", "i", "u", "s"] as const;

/** every combination of the four flag marks (16) */
const flagSets: Marks[] = Array.from({ length: 16 }, (_, bits) => {
  const marks: Marks = {};
  FLAGS.forEach((flag, index) => {
    if (bits & (1 << index)) {
      marks[flag] = true;
    }
  });
  return marks;
});

/** the other marks, alone and together */
const extras: Marks[] = [
  {},
  { a: "https://example.com/a_(b)" },
  { a: "https://example.com/x)y" },
  { c: "#e03131" },
  { c: "rgb(1, 2, 3)", h: "#ffec99" },
  { z: 1.6 },
  { n: 'a "note" with \\ and\nline' },
  { a: "https://ex.com", c: "red", h: "yellow", z: 0.8, n: "tip" },
];

const TEXTS = ["word", "a*b", " lead", "trail ", "x\\", "_u_", "~s~", "{b}", "[l](u)", "**", "2 * 3", "#", "1. x"];

const roundTrip = (doc: RichDoc) => docFromMarkdown(markdownOf(doc));

const docOf = (...paras: Para[]): RichDoc => normalizeDoc({ v: 1, p: paras });

/** a small deterministic random sequence, so a failure can be reproduced */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe("markdown round trip", () => {
  it("keeps every combination of marks, alone and next to each other", () => {
    for (const flags of flagSets) {
      for (const extra of extras) {
        for (const t of TEXTS) {
          const run: Run = { ...flags, ...extra, t };
          const alone = docOf({ r: [run] });
          expect(roundTrip(alone), markdownOf(alone)).toEqual(alone);
          for (const other of flagSets) {
            const pair = docOf({ r: [run, { ...other, t: "next" }] }, { k: "ul", r: [{ ...other, t: "x" }, run] });
            expect(roundTrip(pair), markdownOf(pair)).toEqual(pair);
          }
        }
      }
    }
  });

  it("keeps random documents", () => {
    const next = random(7);
    const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)];
    const kinds: Array<Partial<Para>> = [{}, { k: "ul" }, { k: "ol", d: 1 }, { k: "todo", x: true }, { k: "todo" }];
    for (let round = 0; round < 300; round++) {
      const paras: Para[] = Array.from({ length: 1 + Math.floor(next() * 4) }, () => ({
        ...pick(kinds),
        r: Array.from({ length: Math.floor(next() * 5) }, () => ({ ...pick(flagSets), ...pick(extras), t: pick(TEXTS) })),
      }));
      const doc = docOf(...paras);
      expect(roundTrip(doc), markdownOf(doc)).toEqual(doc);
    }
  });

  it("writes bold + italic so that it reads back (the reported case)", () => {
    const doc = docOf({ r: [{ t: "both", b: true, i: true }, { t: " and " }, { t: "all", b: true, i: true, u: true, s: true }] });
    expect(markdownOf(doc)).toBe("***both*** and ***__~~all~~__***");
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("keeps plain paragraphs that look like headings or list items", () => {
    for (const line of ["- not a list", "• bullet", "* star", "3. third", "1) one", "# title", "### small", "  - indented", "[ ] box", "[x] done"]) {
      const doc = docOf({ r: [{ t: line }] });
      expect(roundTrip(doc), markdownOf(doc)).toEqual(doc);
    }
  });

  it("keeps a link address with parentheses, balanced or not", () => {
    expect(markdownOf(docOf({ r: [{ t: "w", a: "https://a.b/c_(d)" }] }))).toBe("[w](https://a.b/c_(d))");
    expect(docFromMarkdown("[w](https://a.b/c_(d)) after").p[0].r).toEqual([{ t: "w", a: "https://a.b/c_(d)" }, { t: " after" }]);
  });

  it("still reads the markdown agents write by hand", () => {
    expect(docFromMarkdown("**bold** *it* __u__ ~~s~~ [l](https://x.y)").p[0].r).toEqual([
      { t: "bold", b: true },
      { t: " " },
      { t: "it", i: true },
      { t: " " },
      { t: "u", u: true },
      { t: " " },
      { t: "s", s: true },
      { t: " " },
      { t: "l", a: "https://x.y" },
    ]);
    expect(docFromMarkdown("2 * 3 * 4").p[0].r).toEqual([{ t: "2 * 3 * 4" }]);
    expect(docFromMarkdown("a ** b").p[0].r).toEqual([{ t: "a ** b" }]);
    expect(docFromMarkdown("- item\n  1. sub\n# Head").p).toEqual([
      { k: "ul", r: [{ t: "item" }] },
      { k: "ol", d: 1, r: [{ t: "sub" }] },
      { r: [{ t: "Head", b: true, z: 1.6 }] },
    ]);
  });

  it("stays fast on text full of unmatched delimiters", () => {
    const started = Date.now();
    expect(docFromMarkdown("[{_~ ".repeat(400)).p[0].r).toEqual([{ t: "[{_~ ".repeat(400) }]);
    expect(docFromMarkdown("**[{".repeat(400) + "*x*").p[0].r.at(-1)).toEqual({ t: "x", i: true });
    expect(docFromMarkdown("[".repeat(5000)).p[0].r).toEqual([{ t: "[".repeat(5000) }]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
