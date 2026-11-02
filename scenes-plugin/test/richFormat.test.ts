import { describe, expect, it } from "vitest";

import { applyFormat } from "../src/richText/format";
import {
  docFromMarkdown,
  docFromPlain,
  markdownOf,
} from "../src/richText/model";

const md = (markdown: string, format: any) =>
  markdownOf(applyFormat(docFromMarkdown(markdown), format, "t"));

describe("applyFormat", () => {
  it("colors and bolds a phrase, the rest stays as it is", () => {
    expect(
      md("We start.\nA company transformation.", {
        match: "A company transformation.",
        color: "#1565c0",
        bold: true,
      })
    ).toBe("We start.\n**{color=#1565c0}A company transformation.{/}**");
  });

  it("works on plain text too", () => {
    expect(
      markdownOf(
        applyFormat(
          docFromPlain("one two"),
          { match: "two", italic: true },
          "t"
        )
      )
    ).toBe("one *two*");
  });

  it("keeps the formatting already there and adds to it", () => {
    const doc = applyFormat(
      docFromMarkdown("**one two** three"),
      { match: "two three", underline: true },
      "t"
    );
    expect(doc.p[0].r).toEqual([
      { t: "one ", b: true },
      { t: "two", b: true, u: true },
      { t: " three", u: true },
    ]);
  });

  it("removes formatting: color null, bold false", () => {
    expect(
      md("**{color=#e03131}red{/}** text", { match: "red", color: null })
    ).toBe("**red** text");
    expect(md("**red** text", { match: "red", bold: false })).toBe("red text");
  });

  it("occurrence: the n-th or all", () => {
    expect(md("a b a b a", { match: "a", occurrence: 2, bold: true })).toBe(
      "a b **a** b a"
    );
    expect(
      md("a b a b a", { match: "a", occurrence: "all", strike: true })
    ).toBe("~~a~~ b ~~a~~ b ~~a~~");
    expect(() =>
      md("a b a", { match: "a", occurrence: 3, bold: true })
    ).toThrow(/occurs 2 time/);
  });

  it("several specs at once; across lines; in list items (markers not part of the text)", () => {
    expect(
      md("one two", [
        { match: "one", bold: true },
        { match: "two", color: "#1565c0" },
      ])
    ).toBe("**one** {color=#1565c0}two{/}");
    expect(
      md("end of one\nstart of two", { match: "one\nstart", italic: true })
    ).toBe("end of *one*\n*start* of two");
    expect(
      md("- first item\n- second item", { match: "second", bold: true })
    ).toBe("- first item\n- **second** item");
  });

  it("highlight, size, link", () => {
    expect(md("x y", { match: "y", highlight: "#fff3bf", size: 1.5 })).toBe(
      "x {highlight=#fff3bf size=1.5}y{/}"
    );
    expect(md("x y", { match: "y", link: "https://kurviq.com" })).toBe(
      "x [y](https://kurviq.com)"
    );
  });

  it("errors clearly: phrase not found, invalid values, nothing to do", () => {
    expect(() =>
      md("A company change.", { match: "transformation", bold: true })
    ).toThrow(/"transformation" is not in the text.*A company change\./);
    expect(() => md("x", { match: "x", color: "javascript:alert(1)" })).toThrow(
      /format.color/
    );
    expect(() => md("x", { match: "x", link: "javascript:alert(1)" })).toThrow(
      /format.link/
    );
    expect(() => md("x", { match: "x" })).toThrow(/changes nothing/);
    expect(() => md("x", { match: "x", colour: "#000" })).toThrow(
      /does not know colour/
    );
    expect(() => md("x", { color: "#000" })).toThrow(/needs "match"/);
  });
});

describe("format boundaries", () => {
  it("rejects empty specs, empty matches and an empty document", () => {
    expect(() => md("x", [])).toThrow(/empty/);
    expect(() => md("x", { match: "", bold: true })).toThrow(/match/);
    expect(() => md("", { match: "x", bold: true })).toThrow(/not in the text/);
  });
  it.each([0, -1, 1.5])("rejects occurrence %s", (occurrence) => {
    expect(() => md("aaa", { match: "a", occurrence, bold: true })).toThrow(
      /occurrence/
    );
  });
  it("counts non-overlapping matches", () => {
    expect(md("aaa", { match: "aa", occurrence: "all", bold: true })).toBe(
      "**aa**a"
    );
    expect(() => md("aaa", { match: "aa", occurrence: 2, bold: true })).toThrow(
      /occurs 1/
    );
  });
  it("preserves emoji and combining characters across paragraphs", () => {
    expect(md("🦊 é\n日本語", { match: "é\n日本", italic: true })).toBe(
      "🦊 *é*\n*日本*語"
    );
  });
  it.each([0.1, 10])("accepts size %s at the boundary", (size) => {
    expect(md("x", { match: "x", size })).toBe(`{size=${size}}x{/}`);
  });
  it.each([0, 0.09, 10.01, Infinity])("rejects size %s", (size) => {
    expect(() => md("x", { match: "x", size })).toThrow(/size/);
  });
  it("leaves the original intact when a later spec fails", () => {
    const doc = docFromPlain("one two");
    const before = JSON.stringify(doc);
    expect(() =>
      applyFormat(
        doc,
        [
          { match: "one", bold: true },
          { match: "absent", italic: true },
        ],
        "t"
      )
    ).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });
});
