import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import * as richDoc from "../../scenes-mcp/richDoc.mjs";
import * as slideRules from "../../scenes-mcp/slideRules.mjs";

// slides.ts imports the browser-only editor packages: run the real module
// with small deterministic stand-ins for them (text width: 10 px a character).
const require = createRequire(import.meta.url);
const ts = require("../../excalidraw/node_modules/typescript");
const dependencies: Record<string, any> = {
  "./presentation": { presentationChange: () => ({}) },
  "@excalidraw/excalidraw": {
    CaptureUpdateAction: { IMMEDIATELY: "immediately", NEVER: "never" },
    FONT_FAMILY: { Excalifont: 5 },
    exportToCanvas: () => null,
    hashString: (text: string) => [...text].reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)!) | 0, 7),
    newElementWith: (el: any, patch: any) => ({ ...el, ...patch, version: (el.version ?? 1) + 1 }),
    restoreElements: (elements: any[]) => elements.map((el) => ({ version: 1, isDeleted: false, groupIds: [], boundElements: null, ...el })),
  },
  "@excalidraw/element": {
    duplicateElements: () => ({ duplicatedElements: [], origIdToDuplicateId: new Map() }),
    getCommonBounds: () => [0, 0, 0, 0],
    refreshTextDimensions: (el: any, _container: unknown, _map: unknown, text: string) => ({ text, x: el.x, y: el.y, width: text.length * 10, height: 20 }),
    syncInvalidIndices: () => undefined,
  },
  "../../scenes-mcp/richDoc.mjs": richDoc,
  "../../scenes-mcp/slideRules.mjs": slideRules,
};
const compiled = ts.transpileModule(readFileSync(new URL("../src/slides.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const slides: Record<string, any> = {};
runInNewContext(compiled.outputText, {
  exports: slides,
  require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  },
  Map, Set, Date, Math, Error, JSON, Number, String, Object, Array, RegExp, crypto,
});

const base = { version: 1, isDeleted: false, angle: 0, groupIds: [], boundElements: null, frameId: null, locked: false, opacity: 100, strokeColor: "#000", backgroundColor: "transparent" };
const frame = (id: string, x: number, data: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  ...base, id, type: "frame", x, y: 0, width: 1920, height: 1080, name: null, customData: { slides: data }, ...props,
});
const rect = (id: string, frameId: string, props: Record<string, unknown> = {}) => ({
  ...base, id, type: "rectangle", x: 100, y: 100, width: 200, height: 100, frameId, ...props,
});
const text = (id: string, frameId: string, words: string, props: Record<string, unknown> = {}) => ({
  ...base, id, type: "text", x: 100, y: 100, width: words.length * 10, height: 20, frameId, text: words, originalText: words,
  fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true, ...props,
});
const byId = (elements: any[], id: string) => elements.find((el) => el.id === id);
const sync = (elements: any[]) => slides.syncTemplate(elements, "Deck")?.elements ?? elements;

describe("resolveSlide: one rule for slide references", () => {
  const elements = [frame("tpl", 0, { role: "template" }), frame("a", 2000, { order: 0 }), frame("b", 4000, { order: 1 }), frame("plain", 6000, {}, { isDeleted: true })];
  it("reads numbers, numeric strings, frame ids, the template and ranges", () => {
    expect(slides.resolveSlide(2, elements).map((f: any) => f.id)).toEqual(["b"]);
    expect(slides.resolveSlide("2", elements).map((f: any) => f.id)).toEqual(["b"]);
    expect(slides.resolveSlide(" a ", elements).map((f: any) => f.id)).toEqual(["a"]);
    expect(slides.resolveSlide("3", elements)).toEqual([]);
    expect(slides.resolveSlide("template", elements)).toEqual([]);
    expect(slides.resolveSlide("template", elements, { template: true }).map((f: any) => f.id)).toEqual(["tpl"]);
    expect(slides.resolveSlide("tpl", elements)).toEqual([]);
    expect(slides.resolveSlide("tpl", elements, { anyFrame: true }).map((f: any) => f.id)).toEqual(["tpl"]);
    expect(slides.resolveSlide("1-2", elements, { ranges: true }).map((f: any) => f.id)).toEqual(["a", "b"]);
    expect(slides.resolveSlide("1-2", elements)).toEqual([]);
  });
});

describe("addTitleBlock", () => {
  it("adds headline and eyebrow to an old template whose slides have no headline (no crash)", () => {
    const elements = [frame("tpl", 0, { role: "template" }), frame("a", 2000), frame("b", 4000), text("small", "a", "a note", { fontSize: 16 })];
    const result = slides.addTitleBlock(elements);
    expect(result.adopted).toBe(0);
    const roles = result.elements.filter((el: any) => el.frameId === "tpl").map((el: any) => slideRules.slideData(el).role);
    expect(roles.sort((a: string, b: string) => a.localeCompare(b))).toEqual(["eyebrow", "headline"]);
    expect(slideRules.slideData(byId(result.elements, "tpl")).titleBlock).toBe(true);
  });
});

describe("template sync", () => {
  const start = () => sync([frame("tpl", 0, { role: "template" }), rect("logo", "tpl"), frame("a", 2000)]);

  it("keeps a slide's hand-changed copy when its template element leaves the template, and drops unchanged ones", () => {
    const synced = start();
    expect(byId(synced, "logo~a")).toBeTruthy();
    const changed = synced.map((el: any) => (el.id === "logo~a" ? { ...el, strokeColor: "#e03131", version: el.version + 1 } : el));
    const gone = sync(changed.map((el: any) => (el.id === "logo" ? { ...el, isDeleted: true } : el)));
    expect(byId(gone, "logo~a").isDeleted).toBe(false);
    expect(byId(gone, "logo~a").strokeColor).toBe("#e03131");

    const unchanged = sync(synced.map((el: any) => (el.id === "logo" ? { ...el, isDeleted: true } : el)));
    expect(byId(unchanged, "logo~a").isDeleted).toBe(true);
    expect(slideRules.slideData(byId(unchanged, "logo~a")).removedBy).toBe("sync");
  });

  it("brings back a copy the sync removed with what the user changed on it", () => {
    const synced = start();
    const removed = synced.map((el: any) =>
      el.id === "logo~a"
        ? { ...el, strokeColor: "#e03131", isDeleted: true, customData: { slides: { ...slideRules.slideData(el), removedBy: "sync" } } }
        : el,
    );
    const back = sync(removed);
    expect(byId(back, "logo~a").isDeleted).toBe(false);
    expect(byId(back, "logo~a").strokeColor).toBe("#e03131");
  });

  it("fills placeholders inside formatted template text and keeps the formatting", () => {
    const rich = { v: 1, p: [{ r: [{ t: "Page ", b: true }, { t: "{page}", c: "#e03131" }] }] };
    const footer = text("footer", "tpl", "Page {page}", { customData: { rich } });
    const synced = sync([frame("tpl", 0, { role: "template" }), footer, frame("a", 2000), frame("b", 4000)]);
    const copy = byId(synced, "footer~b");
    expect(copy.originalText).toBe("Page 2");
    expect(richDoc.richDocOf(copy)).toEqual({ v: 1, p: [{ r: [{ t: "Page ", b: true }, { t: "2", c: "#e03131" }] }] });
  });

  it("leaves formatting whose placeholder is split across pieces (falls back to plain text)", () => {
    const rich = { v: 1, p: [{ r: [{ t: "{pa", b: true }, { t: "ge}" }] }] };
    expect(slides.filledRich(text("t", "tpl", "{page}", { customData: { rich } }), "1", { page: "1" })).toBeNull();
  });
});

describe("duplicating a slide keeps its own versions of template elements", () => {
  it("renames the duplicated copies to the new slide's copy ids, references included", () => {
    const originals = new Map<string, any>([
      ["headline~a", text("headline~a", "a", "My words", { customData: { slides: { copyOf: "headline", role: "headline" } }, boundElements: [{ id: "arrow1", type: "arrow" }] })],
      ["arrow1", { ...rect("arrow1", "a"), type: "arrow", startBinding: { elementId: "headline~a" } }],
      ["own", rect("own", "a")],
    ]);
    const duplicates = [
      { ...originals.get("headline~a"), id: "d1" },
      { ...originals.get("arrow1"), id: "d2", startBinding: { elementId: "d1" } },
      { ...originals.get("own"), id: "d3" },
    ];
    const toOriginal = new Map([["d1", "headline~a"], ["d2", "arrow1"], ["d3", "own"]]);
    const renamed = slides.renameTemplateCopies(duplicates, originals, toOriginal, "b");
    expect(renamed.map((el: any) => el.id)).toEqual(["headline~b", "d2", "d3"]);
    expect(renamed[0].text).toBe("My words");
    expect(renamed[1].startBinding.elementId).toBe("headline~b");
  });
});

describe("slide steps and thumbnails", () => {
  it("counts a bound label's step with its container", () => {
    const elements = [frame("a", 0), rect("box", "a", { customData: { slides: { step: 2 } } }), text("label", "a", "x", { containerId: "box", customData: { slides: { step: 1 } } }), rect("late", "a", { customData: { slides: { step: 3 } }, isDeleted: true })];
    expect(slides.slideSteps(elements).get("a")).toBe(2);
    expect(slides.elementsAtStep(elements, elements[0], 1).map((el: any) => el.id)).toEqual(["a"]);
  });

  it("changes a slide's picture key when its picture file arrives or the background changes", () => {
    const elements = [frame("a", 0), rect("img", "a", { type: "image", fileId: "f1" })];
    const before = slides.slideVersion(elements, elements[0], {}, "#fff");
    expect(slides.slideVersion(elements, elements[0], { f1: { dataURL: "data:" } }, "#fff")).not.toBe(before);
    expect(slides.slideVersion(elements, elements[0], {}, "#000")).not.toBe(before);
    expect(slides.slideVersion(elements, elements[0], {}, "#fff")).toBe(before);
  });
});
