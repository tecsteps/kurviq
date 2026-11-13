import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restorePresentation, presentationSave, presentationOf } from "../../scenes-mcp/presentation.mjs";

// Execute the real controller lifecycle methods without the browser-only editor.
const source = ts.createSourceFile("controller.ts", readFileSync(new URL("../src/controller.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["liveWriteSettings", "cacheCanvasPresentation", "rememberPresentation", "adoptInitialCanvas", "untitledWasStashed", "onSceneChange", "persistMeta", "sceneMeta"]);
const controller = source.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === "ScenesController") as ts.ClassDeclaration;
const methods = controller.members.filter((member) => member.name && names.has(member.name.getText(source))).map((member) => member.getText(source)).join("\n");
const compiled = ts.transpileModule(`class Controller { ${methods} }; exports.Controller = Controller;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} as Record<string, any> };
let saved: any;
const UNTITLED = "\u0000untitled";
new Function("exports", "restorePresentation", "loadMeta", "saveMeta", "UNTITLED", "CaptureUpdateAction", "nextFrame", "LIVE_CAPABLE", "hashElementsVersion", "sceneHash", "getNonDeletedElements", "presentationSave", "presentationOf", "restoreAppState", "commentStore", "getSnapshot", compiled)(
  loaded.exports, restorePresentation,
  () => structuredClone(saved), (meta: any) => { saved = structuredClone(meta); },
  UNTITLED, { NEVER: "never" }, async () => {}, false, () => 1, () => 2, (elements: any[]) => elements, presentationSave, presentationOf, (app: any) => app,
  { load: () => {}, editorKey: () => "", editorList: () => [] }, async () => undefined,
);

const fixture = (current: string | null = "local", remembered?: any) => {
  const key = current ?? UNTITLED;
  const meta = { current, baseline: null, scenes: { [key]: { baseMd5: null, dirty: false, ...remembered } } };
  saved = structuredClone(meta);
  let app: any = { name: current, viewBackgroundColor: "#ffffff", isLoading: false };
  let elements: any[] = [];
  const api = {
    getAppState: () => app,
    getSceneElementsIncludingDeleted: () => elements,
    updateScene: vi.fn(({ appState }: any) => { app = { ...app, ...appState }; }),
  };
  const instance = new loaded.exports.Controller();
  Object.assign(instance, {
    meta, api, state: { busy: null, dirty: false }, claimsCurrent: true, persistedCurrent: current,
    requireApi: () => api, recomputeDirty: vi.fn(), setState: vi.fn(),
  });
  return { instance, api, key, setElements: (next: any[]) => { elements = next; } };
};

beforeEach(() => { saved = undefined; });

describe("presentation reload recovery", () => {
  it.each(["local", "Drive", "live", null])("persists a toggle immediately and restores %s without a snapshot", async (name) => {
    const f = fixture(name);
    const presentation = { kurviqPresentation: true, kurviqPresentationAt: 42 };
    f.instance.onSceneChange([], { ...f.api.getAppState(), ...presentation });
    expect(saved.scenes[f.key]).toMatchObject(presentation);
    const reloaded = fixture(name, saved.scenes[f.key]);
    await reloaded.instance.adoptInitialCanvas();
    expect(reloaded.api.getAppState()).toMatchObject(presentation);
    reloaded.instance.onSceneChange([], { ...reloaded.api.getAppState(), kurviqPresentation: false, kurviqPresentationAt: 43 });
    const again = fixture(name, saved.scenes[f.key]);
    await again.instance.adoptInitialCanvas();
    expect(again.api.getAppState().kurviqPresentation).toBe(false);
  });
  it("recovers an immediately reloaded live edit before older server settings can replace it", () => {
    const f = fixture("live", { kurviqPresentation: true, kurviqPresentationAt: 42 });
    f.instance.onSceneChange([], { ...f.api.getAppState(), kurviqPresentation: false, kurviqPresentationAt: 10 });
    expect(f.api.getAppState()).toMatchObject({ kurviqPresentation: true, kurviqPresentationAt: 42 });
    expect(saved.scenes.live.kurviqPresentation).toBe(true);
  });
  it("keeps newer loaded content and ignores older cached metadata", () => {
    const f = fixture("Drive", { kurviqPresentation: true, kurviqPresentationAt: 10 });
    expect(f.instance.rememberPresentation({ appState: { kurviqPresentation: false, kurviqPresentationAt: 20 } }, "Drive").kurviqPresentation).toBe(false);
    expect(saved.scenes.Drive.kurviqPresentationAt).toBe(20);
  });
  it("migrates restored template content once and remembers explicit false", async () => {
    const f = fixture();
    f.setElements([{ type: "frame", customData: { slides: { role: "template" } } }]);
    await f.instance.adoptInitialCanvas();
    expect(saved.scenes.local.kurviqPresentation).toBe(true);
    f.instance.onSceneChange([], { ...f.api.getAppState(), kurviqPresentation: false, kurviqPresentationAt: 1 });
    const reload = fixture("local", saved.scenes.local);
    reload.setElements([{ type: "frame", customData: { slides: { notes: "notes" } } }]);
    await reload.instance.adoptInitialCanvas();
    expect(reload.api.getAppState().kurviqPresentation).toBe(false);
  });
});
