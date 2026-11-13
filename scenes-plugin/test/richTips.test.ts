import { describe, expect, it } from "vitest";

import { applyFormat } from "../src/richText/format";
import { docFromMarkdown, markdownOf, normalizeDoc, safeTip } from "../src/richText/model";
import { placeTip, tipInFragments } from "../src/richText/tipHit";
import { convertInNode } from "../../scenes-mcp/convert.mjs";

describe("tooltips in the stored form", () => {
  it("keeps plain text notes, trims them, drops empty, too long and control characters", () => {
    expect(safeTip("  What it means  ")).toBe("What it means");
    expect(safeTip("line one\r\nline two")).toBe("line one\nline two");
    expect(safeTip("a\u0000b\u0007c")).toBe("abc");
    expect(safeTip("   ")).toBeNull();
    expect(safeTip("x".repeat(1001))).toBeNull();
    expect(safeTip(42)).toBeNull();
  });

  it("splits runs by tooltip and merges equal neighbours", () => {
    const doc = normalizeDoc({ v: 1, p: [{ r: [{ t: "a " }, { t: "special", n: "note" }, { t: " term", n: "note" }, { t: "!", n: "" as any }] }] });
    expect(doc.p[0].r).toEqual([{ t: "a " }, { t: "special term", n: "note" }, { t: "!" }]);
  });
});

describe("tooltips in markdown", () => {
  it("reads {tip=\"…\"} and writes it back the same way", () => {
    const markdown = String.raw`THIS IS A {tip="A \"term\" with\na second line \\ backslash"}special term{/}`;
    const doc = docFromMarkdown(markdown);
    expect(doc.p[0].r[1]).toEqual({ t: "special term", n: 'A "term" with\na second line \\ backslash' });
    expect(markdownOf(doc)).toBe(markdown);
  });

  it("combines with the other settings and with bold and links", () => {
    const markdown = String.raw`{color=#1971c2 tip="Explained"}**[docs](https://example.com)**{/} and {tip="a } brace"}more{/}`;
    const doc = docFromMarkdown(markdown);
    expect(doc.p[0].r[0]).toEqual({ t: "docs", c: "#1971c2", n: "Explained", b: true, a: "https://example.com" });
    expect(doc.p[0].r[2]).toEqual({ t: "more", n: "a } brace" });
    expect(markdownOf(docFromMarkdown(markdownOf(doc)))).toBe(markdownOf(doc));
  });

  it("agents set and remove a tooltip with format", () => {
    const set = markdownOf(applyFormat(docFromMarkdown("a special term"), { match: "special term", tip: " The note " }, "t"));
    expect(set).toBe('a {tip="The note"}special term{/}');
    expect(markdownOf(applyFormat(docFromMarkdown(set), { match: "special term", tip: null }, "t"))).toBe("a special term");
    expect(() => applyFormat(docFromMarkdown("a term"), { match: "term", tip: "  " }, "t")).toThrow(/tip/);
  });
});

describe("markdown without a browser (the fallback conversion)", () => {
  const plain = (markdown: string) => convertInNode([{ type: "text", id: "t", x: 0, y: 0, markdown }])[0].text;

  it("keeps the words of styled and tooltip parts, and literal braces", () => {
    expect(plain(String.raw`A {tip="a \"quoted\" } note"}special term{/} and {color=red size=0.8}red{/}`)).toBe("A special term and red");
    expect(plain(String.raw`\{literal\} {not a style} [x](https://a.b)`)).toBe("{literal} {not a style} x");
    expect(plain("# Head\n- {size=0.8}small{/}\n1. one")).toBe("Head\n• small\n1. one");
  });
});

describe("the tooltip under the pointer", () => {
  const fragment = (x: number, n?: string) => ({ text: "w", x, width: 40, baseline: 16, top: 0, height: 20, size: 20, font: "", marks: n ? { n } : {} });
  const fragments = [fragment(0), fragment(50, "the note")];
  const text = { id: "t", type: "text", x: 100, y: 200, width: 90, height: 20, angle: 0 };

  it("finds the words with a note, not the others", () => {
    expect(tipInFragments(text, fragments, 0, { x: 170, y: 210 })?.tip).toBe("the note");
    expect(tipInFragments(text, fragments, 0, { x: 120, y: 210 })).toBeNull();
    expect(tipInFragments(text, fragments, 0, { x: 170, y: 230 })).toBeNull();
  });

  it("follows the alignment shift and the rotation", () => {
    expect(tipInFragments(text, fragments, 10, { x: 145, y: 210 })).toBeNull();
    expect(tipInFragments(text, fragments, 10, { x: 165, y: 210 })?.tip).toBe("the note");
    const turned = { ...text, angle: Math.PI };
    // half a turn around the center (145, 210): the words with a note are now on the left
    const hit = tipInFragments(turned, fragments, 0, { x: 120, y: 210 });
    expect(hit?.tip).toBe("the note");
    expect(Math.min(...hit!.corners.map((c) => c.x))).toBeCloseTo(100);
  });

  it("places the tooltip under the words, above near the bottom, on screen", () => {
    expect(placeTip({ left: 400, top: 100, right: 500, bottom: 120 }, { width: 1000, height: 800 })).toEqual({ left: 450, top: 128, arrow: 0, above: false });
    expect(placeTip({ left: 400, top: 750, right: 500, bottom: 770 }, { width: 1000, height: 800 }).above).toBe(true);
    expect(placeTip({ left: 0, top: 100, right: 40, bottom: 120 }, { width: 1000, height: 800 })).toMatchObject({ left: 170, arrow: -150 });
  });
});
