import { presentationOf, presentationEdit, restorePresentation } from "../../scenes-mcp/presentation.mjs";
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
  "./presentation": { presentationOf, presentationEdit, restorePresentation, serializeAsJSON: (...args: any[]) => JSON.stringify({ elements: args[0], appState: args[1], files: args[2] }) },
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
  "./fonts": { registerSceneFonts: vi.fn(), withFonts: vi.fn((json: string) => json) },
  "./online/drive": { connection: { getState: () => ({ user: { email: "me@example.test", name: "Me" } }) } },
  "./comments/store": { commentStore: { editorList: vi.fn(() => []), change: vi.fn(() => true) } },
  "../../scenes-mcp/sceneComments.mjs": await import("../../scenes-mcp/sceneComments.mjs"),
  "./api": { scenesApi: {} },
  "./controller": { scenesController: {} as Record<string, any>, withSceneName: vi.fn((json: string) => json) },
  "./storage": { getAgentBaseline: vi.fn(), getCheckpoint: vi.fn(), setAgentBaseline: vi.fn(), setCheckpoint: vi.fn() },
  "./editDiff": await import("../src/editDiff"),
  "../../scenes-mcp/editConflicts.mjs": await import("../../scenes-mcp/editConflicts.mjs"),
  "../../scenes-mcp/agentEdits.mjs": await import("../../scenes-mcp/agentEdits.mjs"),
  "./uploads": { MAX_UPLOADS: 100 },
  "./richText/agent": { applyMarkdownUpdate },
  "./richText/format": { applyFormat },
  "./richText/model": { docFromPlain, isPlainDoc, richDocOf },
  "./slides": {
    addTitleBlock,
    followDeckOrder: vi.fn((_before: any[], after: any[]) => after),
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
  Map, Set, Date, Math, Error, structuredClone, JSON, Object, Array, Number, String,
});
const applyEdits: typeof import("../src/cowork").applyEdits = loaded.applyEdits;
const movesFrames: typeof import("../src/cowork").movesFrames = loaded.movesFrames;
const checkConflictsHere: typeof import("../src/cowork").checkConflictsHere = loaded.checkConflictsHere;
const withReplacedComments: typeof import("../src/cowork").withReplacedComments = loaded.withReplacedComments;
const readLocalScene: typeof import("../src/cowork").readLocalScene = loaded.readLocalScene;
const saveLocalScene: typeof import("../src/cowork").saveLocalScene = loaded.saveLocalScene;
const controller = dependencies["./controller"].scenesController;
const followDeckOrder = dependencies["./slides"].followDeckOrder;

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

describe("agent images whose picture is nowhere", () => {
  const image = (id: string, fileId: string, extra: object = {}) => ({ id, type: "image", fileId, ...extra });
  const refuse = (before: any[], after: any[], files: Record<string, unknown>) => () => loaded.refuseImagesWithoutFile(before, after, files);

  it("refuses an added image without its picture and names it", () => {
    expect(refuse([], [image("im1", "f1")], {})).toThrow(/Pictures missing for im1 \(fileId f1\).*nothing was changed/);
  });
  it("accepts an added image whose picture comes with the edit or is in the scene", () => {
    expect(refuse([], [image("im1", "f1")], { f1: {} })).not.toThrow();
  });
  it("refuses an update that points an image at a picture that is nowhere", () => {
    expect(refuse([image("im1", "f1")], [image("im1", "f2")], { f1: {} })).toThrow(/im1 \(fileId f2\)/);
  });
  it("does not block an edit because of an image that was already broken", () => {
    const broken = image("old", "gone", { status: "error" });
    expect(refuse([broken], [broken, { id: "t", type: "text" }], {})).not.toThrow();
  });
  it("lets a deleted image go and treats a restored one as new", () => {
    expect(refuse([image("im1", "gone")], [image("im1", "gone", { isDeleted: true })], {})).not.toThrow();
    expect(refuse([image("im1", "gone", { isDeleted: true })], [image("im1", "gone")], {})).toThrow(/im1/);
  });
});

describe("slide frames moved by an agent", () => {
  const frame = (id: string, x: number) => el(id, { type: "frame", x, width: 1920, height: 1080 });

  it("an update of a frame's x or y is the agent's layout", () => {
    const before = [frame("q11", 0), el("box")];
    expect(movesFrames(before, [{ id: "q11", y: 2000 }])).toBe(true);
    expect(movesFrames(before, [{ id: "q11", x: 2260 }])).toBe(true);
    expect(movesFrames(before, [{ id: "q11", name: "Agenda" }])).toBe(false);
    expect(movesFrames(before, [{ id: "box", y: 2000 }])).toBe(false);
    expect(movesFrames(before, undefined)).toBe(false);
  });

  it("keeps frames where the agent put them instead of snapping the deck back to its grid", async () => {
    await edit([frame("q11", 0), frame("q12", 2160)], { update: [{ id: "q11", y: 2000 }] });
    expect(followDeckOrder).not.toHaveBeenCalled();
  });

  it("still follows the deck order when no frame is moved", async () => {
    await edit([frame("q11", 0), frame("q12", 2160)], { update: [{ id: "q11", name: "Agenda" }] });
    expect(followDeckOrder).toHaveBeenCalledTimes(1);
  });
});

describe("agent edits merged with what the user did meanwhile", () => {
  const keepUserChanges: typeof import("../src/cowork").keepUserChanges = loaded.keepUserChanges;
  const at = (id: string, x: number, version = 1, props: Record<string, any> = {}) => el(id, { x, version, versionNonce: version, ...props });

  it("takes the edit's result as it is when nothing changed in between", () => {
    const base = [at("a", 0)];
    const next = [at("a", 50, 2), at("new", 0)];
    expect(keepUserChanges(base, next, base.map((item) => ({ ...item })))).toEqual(next);
  });

  it("keeps what the user added and moved while the edit was converted", () => {
    const base = [at("a", 0), at("b", 0)];
    const next = [at("a", 50, 2), at("b", 0), at("agent", 0)];
    const current = [at("a", 0), at("b", 99, 2), at("user", 5)];
    const merged = keepUserChanges(base, next, current);
    expect(merged.map((item) => [item.id, item.x])).toEqual([["a", 50], ["b", 99], ["agent", 0], ["user", 5]]);
  });

  it("refuses an edit of an element the user changed too, unless the agent overwrites", () => {
    const base = [at("a", 0)];
    const next = [at("a", 50, 2)];
    const current = [at("a", 70, 2)];
    expect(() => keepUserChanges(base, next, current)).toThrow(/The user changed a \(x\).*nothing was changed/);
    expect(keepUserChanges(base, next, current, true)[0].x).toBe(50);
  });

  it("deletes what the edit deleted, and keeps what the user deleted deleted", () => {
    const base = [at("a", 0), at("b", 0)];
    const next = [at("a", 0, 2, { isDeleted: true }), at("b", 0)];
    const current = [at("a", 0), at("b", 0, 2, { isDeleted: true })];
    const merged = keepUserChanges(base, next, current);
    expect(merged.map((item) => [item.id, item.isDeleted])).toEqual([["a", true], ["b", true]]);
  });
});

describe("agent edits of the open scene and of local-only scenes", () => {
  const controller = dependencies["./controller"].scenesController;
  const commentStore = dependencies["./comments/store"].commentStore;
  const fakeApi = (initial: any[]) => {
    let scene = initial;
    return {
      getSceneElementsIncludingDeleted: () => scene,
      getSceneElements: () => scene.filter((item) => !item.isDeleted),
      getFiles: () => ({}),
      getAppState: () => ({}),
      addFiles: vi.fn(),
      updateScene: vi.fn(({ elements }: { elements: any[] }) => {
        scene = elements;
      }),
      draw: (next: any[]) => {
        scene = next;
      },
    };
  };
  const openScene = (api: ReturnType<typeof fakeApi>) => {
    const state = { current: "A", dirty: false };
    Object.assign(controller, {
      getApi: () => api,
      getState: () => state,
      autoSyncFor: () => true,
      statusOf: () => "synced",
    });
    return state;
  };
  const badComment = [{ action: "reply", thread: "nope", text: "hi" }];

  it("keeps a shape the user drew while the edit was converted (not live)", async () => {
    const api = fakeApi([el("a")]);
    openScene(api);
    convert.mockImplementation(async (elements) => {
      api.draw([el("a"), el("user")]);
      return elements;
    });
    await loaded.editOpenScene({ type: "edit", add: [el("agent")] }, convert);
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.getSceneElements().map((item: any) => item.id).sort((x: string, y: string) => x.localeCompare(y))).toEqual(["a", "agent", "user"]);
  });

  it("does not apply an edit to another scene the user switched to meanwhile", async () => {
    const api = fakeApi([el("a")]);
    const state = openScene(api);
    convert.mockImplementation(async (elements) => {
      state.current = "B";
      return elements;
    });
    await expect(loaded.editOpenScene({ type: "edit", add: [el("agent")] }, convert)).rejects.toThrow(/switched scenes: the app now shows "B", not "A".*nothing was changed/);
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("checks the comment operations before the elements are changed", async () => {
    const api = fakeApi([el("a")]);
    openScene(api);
    await expect(loaded.editOpenScene({ type: "edit", update: [{ id: "a", x: 5 }], comments: badComment }, convert)).rejects.toThrow(/no thread "nope"/);
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(commentStore.change).not.toHaveBeenCalled();
  });

  it("keeps what the user drew in a local-only scene while the edit was converted", async () => {
    const before = JSON.stringify({ elements: [el("a")] });
    const during = JSON.stringify({ elements: [el("a"), el("user")] });
    const reads = [before, during];
    const written: string[] = [];
    Object.assign(controller, {
      localOnlyJson: vi.fn(async () => reads.shift() ?? during),
      writeLocalOnly: vi.fn(async (_name: string, json: string) => {
        written.push(json);
      }),
    });
    const result = await loaded.editLocalScene({ type: "local-edit", name: "A", add: [el("agent")], update: [{ id: "a", x: 5 }] }, convert);
    const saved = JSON.parse(written[0]).elements;
    expect(saved.map((item: any) => item.id)).toEqual(["a", "agent", "user"]);
    expect(saved[0].x).toBe(5);
    expect(result.elements.map((item: any) => item.id)).toEqual(["a", "agent", "user"]);
  });
});

describe("the edit's conflict check in the tab, against the version it edits", () => {
  const base = [el("box", { x: 0 }), text("label", "old", { containerId: "box" }), el("free")];

  it("leaves the edit as it is without a base (no basedOn)", () => {
    const command = { type: "scene-edit" as const, name: "S", update: [{ id: "box", x: 5 }] };
    expect(checkConflictsHere(command, [el("box", { x: 9 })])).toEqual({ command, conflicts: [] });
  });

  it("rejects an update of what the user changed after the MCP's check, and keeps the rest", () => {
    const command = { type: "scene-edit" as const, name: "S", conflictBase: base, update: [{ id: "box", x: 5 }, { id: "free", strokeColor: "red" }] };
    const current = [el("box", { x: 40, version: 2 }), base[1], el("free")];
    const checked = checkConflictsHere(command, current);
    expect(checked.command.update).toEqual([{ id: "free", strokeColor: "red" }]);
    expect(checked.conflicts).toMatchObject([{ id: "box", resolution: "rejected" }]);
  });

  it("with overwrite applies the update and still lists it", () => {
    const command = { type: "scene-edit" as const, name: "S", conflictBase: base, onConflict: "overwrite" as const, update: [{ id: "box", x: 5 }] };
    const checked = checkConflictsHere(command, [el("box", { x: 40, version: 2 })]);
    expect(checked.command.update).toEqual([{ id: "box", x: 5 }]);
    expect(checked.conflicts).toMatchObject([{ id: "box", resolution: "overwritten" }]);
  });

  it("checks upsert adds too, and an element the user deleted meanwhile", () => {
    const command = { type: "scene-edit" as const, name: "S", conflictBase: base, upsert: true, add: [el("free", { x: 3 })], update: [{ id: "box", x: 1 }] };
    const checked = checkConflictsHere(command, [el("free", { strokeColor: "blue", version: 2 })]);
    expect(checked.command.add).toEqual([]);
    expect(checked.command.update).toEqual([]);
    expect(checked.conflicts.map((c) => [c.id, c.properties])).toEqual([["box", ["deleted"]], ["free", ["replaced"]]]);
  });
});

describe("local-only scenes: comments", () => {
  const comment = { id: "comment1", thread: "comment1", by: { name: "Ann", key: "0123456789abcdef" }, text: "hi", at: 1, u: 1, pin: { x: 0, y: 0 } };

  it("read_scene gets the scene's comment threads", async () => {
    controller.localOnlyJson = vi.fn(async () => JSON.stringify({ elements: [el("a")], kurviqComments: [comment] }));
    const read = await readLocalScene({ name: "Local" });
    expect(read.file.kurviqComments).toEqual([comment]);
  });

  it("a replacing scene keeps the replaced scene's comments, merged with its own", () => {
    const own = { ...comment, id: "comment2", thread: "comment2", text: "new", at: 2, u: 2 };
    const json = withReplacedComments(JSON.stringify({ elements: [], kurviqComments: [own] }), JSON.stringify({ elements: [], kurviqComments: [comment] }));
    expect(JSON.parse(json).kurviqComments.map((c: any) => c.id)).toEqual(["comment1", "comment2"]);
    expect(withReplacedComments("{\"elements\":[]}", null)).toBe("{\"elements\":[]}");
  });

  it("save_scene(local, replace) stores the scene with the replaced one's comments", async () => {
    controller.isLocalOnly = vi.fn(() => true);
    controller.localOnlyJson = vi.fn(async () => JSON.stringify({ elements: [], kurviqComments: [comment] }));
    controller.createLocalOnly = vi.fn(async () => {});
    await saveLocalScene({ type: "local-save", name: "Local", json: JSON.stringify({ elements: [el("a")] }), replace: true });
    const stored = JSON.parse(vi.mocked(controller.createLocalOnly).mock.calls[0][1]);
    expect(stored.kurviqComments.map((c: any) => c.id)).toEqual(["comment1"]);
    expect(controller.createLocalOnly).toHaveBeenCalledWith("Local", expect.any(String), { replace: true });
  });
});
