// The editor keeps one canvas for every space in the browser: the canvas it
// restores may be another space's scene (a shared scene's, the own scenes').
// It is taken as this space's open scene only if the record of its owner
// says it is; else the scene loads from its stored copy. Run on the real
// controller (./controllerHarness.ts).
import { describe, expect, it } from "vitest";

import { canvasBelongsTo, otherDraftSpace, parseCanvasOwner } from "../src/spaces";

import { controllerHarness, el, flush, sceneJson, syncedScene, UNTITLED } from "./controllerHarness";
import type { FakeEditor, FakeStorage } from "./controllerHarness";

const SHARED = "f:sharedFile123";
const owner = (space: string | null, scene: string | null) => JSON.stringify({ space, scene });
const shown = (editor: FakeEditor) => editor.getSceneElements().map((item: any) => item.id);

/** the own scenes ("") with an untitled draft stored; the canvas the browser restores is `canvas` named `name` */
const draftStored = (record: string | null, canvas = [el("shared")], name = "Shared plan") => (parts: { storage: FakeStorage; editor: FakeEditor }) => {
  parts.storage.saved = { current: null, baseline: null, autoSync: true, scenes: { [UNTITLED]: { baseMd5: null, dirty: true } }, pendingDeletes: {} };
  parts.storage.snapshots.set(UNTITLED, { json: sceneJson("", [el("mine")]), baseline: null, dirty: true });
  parts.storage.canvasOwner = record;
  parts.editor.elements = canvas;
  parts.editor.appState = { ...parts.editor.appState, name };
};

describe("the canvas owner record", () => {
  const belongs = (raw: string | null, space: string, scene: string | null) => canvasBelongsTo(parseCanvasOwner(raw), space, scene);

  it("matches space and scene, untitled included", () => {
    expect(belongs(owner("", null), "", null)).toBe(true);
    expect(belongs(owner(SHARED, "Plan"), SHARED, "Plan")).toBe(true);
    expect(belongs(owner(SHARED, "Plan"), "", "Plan")).toBe(false);
    expect(belongs(owner(SHARED, null), "", null)).toBe(false);
    expect(belongs(owner("", "Plan"), "", null)).toBe(false);
    // cleared: nobody's
    expect(belongs(owner(null, null), "", null)).toBe(false);
  });

  it("no valid record: nobody can tell", () => {
    expect(belongs(null, "", null)).toBeNull();
    expect(belongs("not json", "", null)).toBeNull();
    expect(belongs("{}", "", null)).toBeNull();
    expect(belongs("[]", "", null)).toBeNull();
    expect(belongs(JSON.stringify({ space: 1, scene: null }), "", null)).toBeNull();
  });

  it("another space's draft, or this space's while a named scene is open", () => {
    expect(otherDraftSpace(parseCanvasOwner(owner(SHARED, null)), "", null)).toBe(SHARED);
    expect(otherDraftSpace(parseCanvasOwner(owner("", null)), "", "Plan")).toBe("");
    expect(otherDraftSpace(parseCanvasOwner(owner("", null)), "", null)).toBeNull();
    expect(otherDraftSpace(parseCanvasOwner(owner(SHARED, "Plan")), "", null)).toBeNull();
    expect(otherDraftSpace(parseCanvasOwner(owner(null, null)), "", null)).toBeNull();
    expect(otherDraftSpace(null, "", null)).toBeNull();
  });
});

describe("the restored canvas and the space's open scene", () => {
  it("another space's canvas while the untitled draft is open: the draft comes from its stored copy", async () => {
    const { controller, editor, storage } = await controllerHarness({ setup: draftStored(owner(SHARED, "Shared plan")) });
    await flush();
    expect(shown(editor)).toEqual(["mine"]);
    expect(controller.getState().dirty).toBe(true);
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: "", scene: null });
  });

  it("another space's untitled canvas, no draft stored: an empty draft, not the other one's content", async () => {
    const { editor, storage } = await controllerHarness({
      setup: (parts) => {
        draftStored(owner(SHARED, null), [el("theirs")], "")(parts);
        parts.storage.snapshots.clear();
        parts.storage.saved.scenes = {};
      },
    });
    await flush();
    expect(shown(editor)).toEqual([]);
    expect(storage.snapshots.has(UNTITLED)).toBe(false);
  });

  it("the record says it is this space's draft: the canvas is taken as it is", async () => {
    const { editor } = await controllerHarness({ setup: draftStored(owner("", null), [el("latest")], "") });
    await flush();
    expect(shown(editor)).toEqual(["latest"]);
  });

  it("no record (saved by an older version): the canvas is taken as the draft, as before", async () => {
    const { editor, storage } = await controllerHarness({ setup: draftStored(null, [el("latest")], "") });
    await flush();
    expect(shown(editor)).toEqual(["latest"]);
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: "", scene: null });
  });

  it("a named scene: another space's scene of the same name is not taken, its stored copy is", async () => {
    const { editor } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "Plan", [el("own plan")]);
        parts.storage.saved.current = "Plan";
        parts.storage.canvasOwner = owner(SHARED, "Plan");
        parts.editor.elements = [el("shared plan")];
        parts.editor.appState = { ...parts.editor.appState, name: "Plan" };
      },
    });
    await flush();
    expect(shown(editor)).toEqual(["own plan"]);
  });

  it("leaving for another space: the cleared canvas is nobody's", async () => {
    const { controller, storage } = await controllerHarness({ setup: draftStored(owner("", null), [el("latest")], "") });
    await flush();
    await controller.leaveForReload();
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: null, scene: null });
    expect(JSON.parse(storage.snapshots.get(UNTITLED)!.json).elements.map((item: any) => item.id)).toEqual(["latest"]);
  });

  it("another tab recorded its canvas: this tab's next change records its own again", async () => {
    const { editor, storage, window } = await controllerHarness({ setup: draftStored(owner("", null), [el("latest")], "") });
    await flush();
    storage.canvasOwner = owner(SHARED, "Shared plan");
    window.fire("storage", { key: "kurviq-canvas-owner" });
    expect(JSON.parse(storage.canvasOwner)).toEqual({ space: SHARED, scene: "Shared plan" });
    editor.draw(el("more"));
    expect(JSON.parse(storage.canvasOwner)).toEqual({ space: "", scene: null });
  });

  it("another space's untitled draft on the canvas: it goes to that space's stored draft, not to this one", async () => {
    const { editor, storage } = await controllerHarness({ setup: draftStored(owner(SHARED, null), [el("their draft")], "") });
    await flush();
    expect(shown(editor)).toEqual(["mine"]);
    expect(JSON.parse(storage.otherSpaces.get(SHARED)!).elements.map((item: any) => item.id)).toEqual(["their draft"]);
  });

  it("this space's draft on the canvas while a named scene is open here: kept as the stored draft", async () => {
    const { editor, storage } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "Plan", [el("plan")]);
        parts.storage.saved.current = "Plan";
        parts.storage.canvasOwner = owner("", null);
        parts.editor.elements = [el("draft")];
      },
    });
    await flush();
    expect(shown(editor)).toEqual(["plan"]);
    expect(JSON.parse(storage.snapshots.get(UNTITLED)!.json).elements.map((item: any) => item.id)).toEqual(["draft"]);
    expect(storage.saved.scenes[UNTITLED]).toMatchObject({ dirty: true });
    expect(storage.otherSpaces.size).toBe(0);
  });

  it("a scene saved under a name or renamed: the record follows", async () => {
    const { controller, editor, storage } = await controllerHarness({ setup: draftStored(owner("", null), [el("latest")], "") });
    await flush();
    editor.draw(el("more"));
    await controller.save("Named", { localOnly: true });
    await flush();
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: "", scene: "Named" });
  });

  it("the page is hidden when the canvas changes: the record no longer vouches for the stored canvas", async () => {
    const { controller, document, storage } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "Plan", [el("plan")]);
        syncedScene(parts, "Other", [el("other")]);
        parts.storage.saved.current = "Plan";
        parts.storage.canvasOwner = owner("", "Plan");
        parts.editor.elements = [el("plan")];
        parts.editor.appState = { ...parts.editor.appState, name: "Plan" };
      },
    });
    await flush();
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: "", scene: "Plan" });
    document.visibilityState = "hidden";
    await controller.open("Other");
    await flush();
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: null, scene: null });
    document.visibilityState = "visible";
    controller.getApi().draw(el("new"));
    expect(JSON.parse(storage.canvasOwner!)).toEqual({ space: "", scene: "Other" });
  });

  it("the editor hands out a second API object while loading: the stored draft is loaded once, not lost", async () => {
    const { editor, storage } = await controllerHarness({
      setup: draftStored(owner(null, null), [], ""),
      attached: (controller, editor, storage) => {
        // the second one comes while the first loads the draft; its reads of the stored copy come later
        const getSnapshot = storage.module.getSnapshot;
        let second = false;
        storage.module.getSnapshot = (name: string | null) => {
          if (second) {
            return new Promise((resolve) => setTimeout(() => resolve(getSnapshot(name)), 0));
          }
          second = true;
          controller.attach({ ...editor });
          return getSnapshot(name);
        };
      },
    });
    await flush();
    expect(shown(editor)).toEqual(["mine"]);
    expect(storage.saved.scenes[UNTITLED]).toMatchObject({ dirty: true });
  });
});

