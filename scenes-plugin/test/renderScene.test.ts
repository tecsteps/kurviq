import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import * as boundText from "../../scenes-mcp/boundText.mjs";
import * as convert from "../../scenes-mcp/convert.mjs";

// render.ts imports the browser-only editor: run the real module with
// stand-ins for the exporter and the slide helpers (slides.ts has its own tests).
const require = createRequire(import.meta.url);
const ts = require("../../excalidraw/node_modules/typescript");
const slides = {
  getSlides: (elements: any[]) => elements.filter((el) => el.type === "frame"),
  resolveSlide: vi.fn((_ref: unknown, _elements: any[], _options: unknown): any[] => []),
  elementsAtStep: vi.fn((elements: any[], frame: any) => elements.filter((el) => el.id === frame.id || el.frameId === frame.id)),
  renderSlide: vi.fn(),
  slideSteps: () => new Map(),
  slideTitle: (frame: any) => frame.name ?? frame.id,
};
const dependencies: Record<string, any> = {
  "../../scenes-mcp/boundText.mjs": boundText,
  "../../scenes-mcp/convert.mjs": convert,
  "./fonts": { registerSceneFonts: async () => {} },
  "./controller": { scenesController: { getApi: () => null } },
  "./leanFiles": { fillFiles: async (files: unknown) => files ?? {} },
  "@excalidraw/excalidraw": {
    Fonts: { loadElementsFonts: async () => [] },
    exportToBlob: vi.fn(),
    elementsOverlappingBBox: ({ elements }: { elements: any[] }) => elements,
    getCommonBounds: () => [0, 0, 100, 100],
    getNonDeletedElements: (elements: any[]) => elements.filter((el) => !el.isDeleted),
    restoreElements: (elements: any[]) => elements,
  },
  "./cowork": { withTemplate: (elements: any[]) => elements },
  "./pdfExport": { pickSlides: (elements: any[]) => slides.getSlides(elements) },
  "./slides": slides,
};
const source = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const loaded: Record<string, any> = {};
runInNewContext(compiled.outputText, {
  exports: loaded,
  require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  },
  document: { fonts: { load: async () => {} } },
  Map, Set, Math, Error, Promise,
});
const renderScene: typeof import("../src/render").renderScene = loaded.renderScene;

const scene = (elements: any[]) => ({ elements: elements.map((el) => ({ version: 1, isDeleted: false, ...el })) });
const open = () => ({ elements: [], files: {}, background: "#fff" });

describe("pictures of a scene in the tab", () => {
  it("a contact sheet of a scene without slides says so", async () => {
    await expect(renderScene({ type: "render", scene: scene([{ id: "box", type: "rectangle" }]), sheet: "all" }, open, async (els) => els)).rejects.toThrow(
      "The scene has no slides",
    );
  });

  it("finds the slide like the other tools do (numbers, numeric strings, any frame's id) and names what is missing", async () => {
    const elements = scene([{ id: "f1", type: "frame" }, { id: "box", type: "rectangle", frameId: "f1" }]);
    await expect(renderScene({ type: "render", scene: elements, slide: "3" }, open, async (els) => els)).rejects.toThrow('No slide or frame "3": the deck has 1 slides');
    expect(slides.resolveSlide).toHaveBeenCalledWith("3", expect.any(Array), { anyFrame: true });
  });
});
