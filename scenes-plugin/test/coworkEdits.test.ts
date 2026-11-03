import { presentationOf } from "../../scenes-mcp/presentation.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { applyMarkdownUpdate } from "../src/richText/agent";
import { applyFormat } from "../src/richText/format";
import { docFromPlain, isPlainDoc, markdownOf, richDocOf } from "../src/richText/model";

// The browser-only package entry points cannot be resolved by the node test
// runner. Run the actual module with deterministic layout and storage fakes.
const require = createRequire(import.meta.url);
const ts = require("../../excalidraw/node_modules/typescript");
const Fonts = { loadElementsFonts: vi.fn(async (_elements: any[]) => []) };
const addTitleBlock = vi.fn<any>();
const resetTemplateChanges = vi.fn<any>();
const resetToTemplate = vi.fn<any>();
const dependencies: Record<string, any> = {
  "./editorYield": { editorYield: async () => {} },
  "./presentation": { presentationOf, serializeAsJSON: (...args: any[]) => JSON.stringify({ elements: args[0], appState: args[1], files: args[2] }) },
  "@excalidraw/excalidraw": {
    CaptureUpdateAction: {},
    newElementWith: (el: any, patch: any) => ({ ...el, ...patch, version: el.version + 1 }),
    Fonts,
    restoreElements: (elements: any[]) => elements,
    serializeAsJSON: vi.fn(),
  },
  "@excalidraw/element": {
    Scene: class {
      constructor(private elements: any[]) {}
      getNonDeletedElementsMap() { return new Map(this.getNonDeletedElements().map((el) => [el.id, el])); }
      getNonDeletedElements() { return this.elements.filter((el) => !el.isDeleted); }
      getElementsIncludingDeleted() { return this.elements; }
      mutateElement(el: any, patch: any) { Object.assign(el, patch); }
    },
    computeBoundTextPosition: () => ({ x: 10, y: 10 }),
    computeContainerDimensionForBoundText: (height: number) => height + 10,
    getBoundTextMaxHeight: () => 1000,
    hashString: () => 1,
    measureText: (text: string) => ({ width: text.length * 10 }),
    refreshTextDimensions: (el: any) => ({ width: String(el.originalText ?? el.text).length * 10, height: 20 }),
    syncInvalidIndices: vi.fn(),
    updateBoundElements: vi.fn(),
  },
  "@excalidraw/common": { getFontString: () => "20px test" },
  "./agentGlow": { showAgentChange: vi.fn() },
  "./fonts": { registerSceneFonts: vi.fn(), withFonts: vi.fn() },
  "./api": { scenesApi: {} },
  "./controller": { scenesController: {}, withSceneName: vi.fn() },
  "./storage": { getAgentBaseline: vi.fn(), getCheckpoint: vi.fn(), setAgentBaseline: vi.fn(), setCheckpoint: vi.fn() },
  "./online/liveMerge": {},
  "./richText/agent": { applyMarkdownUpdate },
  "./richText/format": { applyFormat },
  "./richText/model": { docFromPlain, isPlainDoc, richDocOf },
  "./slides": {
    addTitleBlock,
    followDeckOrder: (_before: any[], after: any[]) => after,
    getSlides: (elements: any[]) => elements.filter((el) => el.type === "frame" && !el.isDeleted),
    placeOnSlides: (items: any[]) => items,
    resetTemplateChanges,
    resetToTemplate,
    slideData: (el: any) => el?.customData?.slides ?? {},
    slideTitle: (el: any) => el.name ?? el.id,
    syncTemplate: vi.fn(),
  },
};
const source = readFileSync(new URL("../src/cowork.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const loaded: Record<string, any> = {};
runInNewContext(compiled.outputText, {
  exports: loaded,
  require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  },
  Map, Set, Date, Math, Error,
});
const applyEdits: typeof import("../src/cowork").applyEdits = loaded.applyEdits;

const el = (id: string, props: Record<string, any> = {}): any => ({
  id, type: "rectangle", version: 1, x: 0, y: 0, width: 100, height: 50,
  isDeleted: false, frameId: null, ...props,
});
const text = (id: string, words = "hello", props: Record<string, any> = {}) =>
  el(id, { type: "text", text: words, originalText: words, autoResize: true, ...props });
const convert = vi.fn(async (elements: any[]) => elements);
const edit = (elements: any[], command: Parameters<typeof applyEdits>[1]) => applyEdits(elements, command, convert, "Deck");
const byId = (result: Awaited<ReturnType<typeof applyEdits>>, id: string): any => result.elements.find((item) => item.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Fonts.loadElementsFonts).mockResolvedValue([]);
  vi.mocked(addTitleBlock).mockReturnValue(null);
  vi.mocked(resetToTemplate).mockReturnValue(null);
  vi.mocked(resetTemplateChanges).mockReturnValue(null);
  convert.mockImplementation(async (elements) => elements);
});

describe("agent edit pipeline", () => {
  it("keeps untouched elements and reports an empty edit", async () => {
    const original = el("a");
    const result = await edit([original], {});
    expect(result).toEqual({ elements: [original], addedIds: [], updated: [], deleted: [] });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toBe(original);
    expect(convert).not.toHaveBeenCalled();
  });

  it("deletes a frame, its actual children and their labels, while preserving an unframed overlay", async () => {
    const input = [el("frame", { type: "frame" }), el("child", { frameId: "frame" }), text("label", "x", { containerId: "child" }), el("overlay"), el("old", { isDeleted: true })];
    const snapshot = structuredClone(input);
    const result = await edit(input, { delete: ["frame", "absent", "old"], update: [{ id: "absent", x: 1 }] });
    expect(result.deleted).toEqual(["frame"]);
    expect(result.missingIds).toEqual(["absent", "old", "absent"]);
    expect(result.alsoDeleted).toBe("2 more elements went with them (labels, and everything on deleted slides)");
    expect(result.elements.filter((item) => item.isDeleted).map((item) => item.id)).toEqual(["frame", "child", "label", "old"]);
    expect(byId(result, "overlay").isDeleted).toBe(false);
    expect(input).toEqual(snapshot);
  });

  it("accumulates updates, protects element identity and merges customData two levels deep", async () => {
    const original = el("a", { customData: { keep: 1, drop: 2, slides: { notes: "keep", skip: true } } });
    const result = await edit([original], { update: [
      { id: "a", x: 3, type: "text", version: 90, isDeleted: true, index: "bad", customData: { drop: null, slides: { skip: null, order: 2 } } },
      { id: "a", y: 4, customData: { extra: true } },
    ] });
    expect(byId(result, "a")).toMatchObject({ type: "rectangle", version: 2, isDeleted: false, x: 3, y: 4, customData: { keep: 1, slides: { notes: "keep", order: 2 }, extra: true } });
    expect(byId(result, "a").index).toBeUndefined();
    expect(original.customData.slides.skip).toBe(true);
    expect(result.updated).toEqual(["a", "a"]);
  });

  it("moves unpatched frame children once, preserving explicit positions and deleted children", async () => {
    const input = [el("f", { type: "frame" }), el("inner", { type: "frame", frameId: "f", x: 2 }), el("grandchild", { frameId: "inner", x: 3 }), el("child", { frameId: "f", x: 4 }), el("explicit", { frameId: "f", x: 5 }), el("gone", { frameId: "f", x: 6, isDeleted: true })];
    const result = await edit(input, { update: [{ id: "f", x: 20, y: 10 }, { id: "explicit", x: 7 }] });
    expect(byId(result, "inner")).toMatchObject({ x: 22, y: 10 });
    expect(byId(result, "grandchild").x).toBe(3);
    expect(byId(result, "child")).toMatchObject({ x: 24, y: 10 });
    expect(byId(result, "explicit")).toMatchObject({ x: 7, y: 0 });
    expect(byId(result, "gone").x).toBe(6);
  });

  it("updates an existing label, drops old rich text for plain text and preserves other custom data", async () => {
    const result = await edit([el("box"), text("label", "old", { containerId: "box", customData: { keep: 1, rich: { v: 1, p: [{ r: [{ t: "old", b: true }] }] } } })], { update: [{ id: "box", label: "new" }] });
    expect(byId(result, "label")).toMatchObject({ text: "new", originalText: "new", containerId: "box", customData: { keep: 1 } });
    expect(byId(result, "label").customData.rich).toBeUndefined();
    expect(Fonts.loadElementsFonts).toHaveBeenCalledOnce();
  });

  it("creates a missing label with its stable id and rich formatting", async () => {
    const result = await edit([el("box")], { update: [{ id: "box", label: { markdown: "**new**", id: "ignored" } }] });
    expect(convert).toHaveBeenCalledOnce();
    expect(byId(result, "box-label")).toMatchObject({ type: "text", containerId: "box", text: "new" });
    expect(markdownOf(byId(result, "box-label").customData.rich)).toBe("**new**");
    expect(result.addedIds).toEqual(["box-label"]);
  });

  it.each([
    { text: "new" }, { markdown: "new" }, { originalText: "new" }, { label: "new" }, { label: { text: "new" } }, { label: { markdown: "new" } },
  ])("rejects a format combined with a text replacement: %j", async (props) => {
    await expect(edit([el("box")], { update: [{ id: "box", format: { bold: true }, ...props }] })).rejects.toThrow("don't combine it with text / markdown");
    expect(convert).not.toHaveBeenCalled();
  });

  it("rejects formatting a shape with no text", async () => {
    await expect(edit([el("box")], { update: [{ id: "box", format: { bold: true } }] })).rejects.toThrow("this rectangle has no text");
  });

  it("formats the current label and preserves its unrelated custom data", async () => {
    const result = await edit([el("box"), text("label", "hello", { containerId: "box", customData: { keep: 1 } })], { update: [{ id: "box", format: { match: "hello", bold: true } }] });
    expect(markdownOf(byId(result, "label").customData.rich)).toBe("**hello**");
    expect(byId(result, "label").customData.keep).toBe(1);
  });

  it("wraps fixed-width text, preserves centered alignment and tolerates font load failure", async () => {
    vi.mocked(Fonts.loadElementsFonts).mockRejectedValueOnce(new Error("offline"));
    const result = await edit([text("t", "hi", { x: 100, width: 100, textAlign: "center" })], { update: [{ id: "t", text: "hello" }] });
    expect(byId(result, "t")).toMatchObject({ x: 125, width: 50, originalText: "hello" });
    const fixed = await edit([text("t")], { update: [{ id: "t", width: 10 }] });
    expect(byId(fixed, "t").autoResize).toBe(false);
  });

  it("rejects id clashes before conversion and explains unframed leftovers after deleting a frame", async () => {
    await expect(edit([el("f", { type: "frame" }), el("overlay")], { delete: ["f"], add: [el("overlay")] })).rejects.toThrow("survived the frame you deleted");
    expect(convert).not.toHaveBeenCalled();
  });

  it("upserts shapes with their labels but preserves a replaced frame's content", async () => {
    const result = await edit([el("f", { type: "frame" }), el("child", { frameId: "f" }), el("box"), text("label", "old", { containerId: "box" })], { upsert: true, add: [el("f", { type: "frame", x: 5 }), el("box", { x: 8 })] });
    expect(result.replaced).toEqual(["f", "box"]);
    expect(byId(result, "f").version).toBe(3);
    expect(byId(result, "box").version).toBe(3);
    expect(byId(result, "child").isDeleted).toBe(false);
    expect(byId(result, "label").isDeleted).toBe(true);
    expect(result.elements.filter((item) => item.id === "f")).toHaveLength(1);
  });

  it("revives tombstones above their old version and registers standalone bound text", async () => {
    const result = await edit([el("old", { version: 8, isDeleted: true }), el("box", { frameId: "f" })], { add: [el("old"), text("label", "new", { containerId: "box" })] });
    expect(byId(result, "old").version).toBe(9);
    expect(byId(result, "label")).toMatchObject({ textAlign: "center", verticalAlign: "middle", frameId: "f" });
    expect(byId(result, "box").boundElements).toEqual([{ type: "text", id: "label" }]);
    expect(result.elements.filter((item) => item.id === "old")).toHaveLength(1);
  });

  it("propagates converter failures without mutating the input", async () => {
    const input = [el("a")];
    convert.mockRejectedValueOnce(new Error("conversion failed"));
    await expect(edit(input, { add: [el("b")] })).rejects.toThrow("conversion failed");
    expect(input).toEqual([el("a")]);
  });

  it("resets slides by number and copies by selected changes, in request order", async () => {
    const input = [el("f", { type: "frame" }), el("copy", { customData: { slides: { copyOf: "source" } } })];
    vi.mocked(resetToTemplate).mockReturnValueOnce(input);
    vi.mocked(resetTemplateChanges).mockReturnValueOnce(input);
    const result = await edit(input, { reset: [1, { id: "copy", changes: ["color"] }] });
    expect(resetToTemplate).toHaveBeenCalledWith(input, new Set(["f"]), "Deck");
    expect(resetTemplateChanges).toHaveBeenCalledWith(input, ["copy"], ["color"], "Deck");
    expect(result.reset).toBe("2 slides / template copies back to the template");
  });

  it("rejects unknown reset targets before applying any template reset", async () => {
    await expect(edit([el("f", { type: "frame" })], { reset: [1, "missing"] })).rejects.toThrow("reset: no such slide or template copy: missing");
    expect(resetToTemplate).not.toHaveBeenCalled();
  });

  it("reports title block adoption and tolerates templates that do not need a reset", async () => {
    const input = [el("f", { type: "frame" })];
    vi.mocked(addTitleBlock).mockReturnValueOnce({ elements: input, adopted: 2 } as any);
    const result = await edit(input, { addTitleBlock: true, restyle: true });
    expect(result.titleBlock).toBe("headline and eyebrow on the template; 2 slide texts became their copies");
    expect(result.reset).toBeUndefined();
    expect(resetToTemplate).toHaveBeenCalledOnce();
  });

  it("keeps layer moves after conversion and reports invalid references", async () => {
    const result = await edit([el("a"), el("b")], { update: [{ id: "a", zIndex: "front" }, { id: "b", above: "missing" }] });
    expect(result.elements.map((item) => item.id)).toEqual(["b", "a"]);
    expect(result.layerProblems).toEqual(['b: above "missing": no such element']);
  });

  it("keeps edits without font loading or conversion synchronous until their result", async () => {
    const pending = edit([el("a")], { addTitleBlock: true });
    expect(addTitleBlock).toHaveBeenCalledOnce();
    expect(Fonts.loadElementsFonts).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect((await pending).titleBlock).toBeUndefined();
  });

  it("waits for fonts before template work and conversion, in the original order", async () => {
    let releaseFonts!: (value: never[]) => void;
    Fonts.loadElementsFonts.mockReturnValueOnce(new Promise((resolve) => { releaseFonts = resolve; }));
    const pending = edit([text("t")], { update: [{ id: "t", text: "new" }], addTitleBlock: true, add: [el("b")] });
    expect(Fonts.loadElementsFonts).toHaveBeenCalledOnce();
    expect(addTitleBlock).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    releaseFonts([]);
    const result = await pending;
    expect(addTitleBlock.mock.invocationCallOrder[0]).toBeLessThan(convert.mock.invocationCallOrder[0]);
    expect(byId(result, "t").text).toBe("new");
    expect(result.addedIds).toEqual(["b"]);
  });

  it("propagates formatting errors without applying the patches or starting conversion", async () => {
    const input = [text("t")];
    await expect(edit(input, { update: [{ id: "t", x: 9, format: { match: "absent", bold: true } }], add: [el("b")] })).rejects.toThrow(/absent/);
    expect(input[0].x).toBe(0);
    expect(convert).not.toHaveBeenCalled();
    expect(Fonts.loadElementsFonts).not.toHaveBeenCalled();
  });

  it("removes rich formatting when the final mark is cleared, retaining unrelated data", async () => {
    const rich = { v: 1, p: [{ r: [{ t: "hello", b: true }] }] };
    const result = await edit([text("t", "hello", { customData: { rich, keep: 1 } })], { update: [{ id: "t", format: { match: "hello", bold: false } }] });
    expect(byId(result, "t").customData).toEqual({ keep: 1 });
  });

  it("accepts explicit null customData and ignores a new label without text", async () => {
    const result = await edit([el("box", { customData: { old: true } })], { update: [{ id: "box", customData: null, label: { fontSize: 30 } }] });
    expect(byId(result, "box").customData).toBeNull();
    expect(result.addedIds).toEqual([]);
    expect(convert).not.toHaveBeenCalled();
  });

  it("resets an entire template copy when changes are omitted and leaves unsuccessful resets uncounted", async () => {
    const input = [el("copy", { customData: { slides: { copyOf: "source" } } })];
    const result = await edit(input, { reset: ["copy"] });
    expect(resetTemplateChanges).toHaveBeenCalledWith(input, ["copy"], null, "Deck");
    expect(result.reset).toBeUndefined();
  });
});

 it("normalizes arrow extents when points change", async () => {
    const result = await edit([el("arrow", { type: "arrow", width: 420, height: 45 })], {
      update: [{ id: "arrow", points: [[0, 0], [25, 0], [25, -65], [420, -65], [420, -30]] }],
    });
    expect(result.elements[0]).toMatchObject({ width: 420, height: 65 });
  });

it("names pictures the agent must upload again", () => {
  const image = { id: "broken", type: "image", fileId: "missing", status: "error" };
  const result = loaded.repairImages([image], {});
  expect(result.info.imagesWithoutFile).toBe("broken: picture missing, upload again");
  expect(result.elements[0]).toBe(image);
});
