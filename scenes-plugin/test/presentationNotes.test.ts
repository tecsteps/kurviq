import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { presentationChange } from "../../scenes-mcp/presentation.mjs";

// Run the production patch helper without importing the browser-only editor.
const source = ts.createSourceFile("slides.ts", readFileSync(new URL("../src/slides.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((item) => item.name.getText(source) === "patchSlideData");
if (!declaration?.initializer) throw new Error("patchSlideData not found");
const compiled = ts.transpileModule(`const patch = ${declaration.initializer.getText(source)}; exports.patch = patch;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded: Record<string, any> = {};
new Function("exports", "presentationChange", "CaptureUpdateAction", "withSlideData", "update", compiled)(
  loaded, presentationChange, { NEVER: "never" },
  (el: any, data: any) => ({ ...el, customData: { slides: data } }),
  (api: any, elements: any[]) => api.updateScene({ elements }),
);

describe("pending speaker notes when presentation is disabled", () => {
  it("saves cleanup notes without turning the user's false back on", () => {
    const api = { getAppState: () => ({ kurviqPresentation: false, kurviqPresentationAt: 20 }), getSceneElementsIncludingDeleted: () => [{ id: "frame", type: "frame" }], updateScene: vi.fn() };
    loaded.patch(api, new Map([["frame", { notes: "unsaved notes" }]]), { enablePresentation: false });
    expect(api.updateScene).toHaveBeenCalledOnce();
    expect(api.updateScene.mock.calls[0][0]).toMatchObject({ elements: [{ id: "frame", customData: { slides: { notes: "unsaved notes" } } }] });
    expect(api.updateScene.mock.calls[0][0].appState).toBeUndefined();
  });
});
