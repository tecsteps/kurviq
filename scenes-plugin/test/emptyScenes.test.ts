// Scenes that are only a name (made here, never in Drive, nothing drawn) don't stick: leaving one
// forgets it, the start forgets old ones, and a scene link to such a name looks for the scene again
// (e.g. a link opened while signed out, then again after signing in). Real controller, ./controllerHarness.ts.
import { describe, expect, it, vi } from "vitest";

import { controllerHarness, el, sceneJson, UNTITLED } from "./controllerHarness";

const names = (controller: any) => controller.getState().list.map((item: any) => item.name).filter((name: string | null) => name !== null);

describe("an empty new scene doesn't stick", () => {
  it("leaving it forgets it (list, metadata, stored copy)", async () => {
    const { controller, storage } = await controllerHarness();
    await controller.create("Only a name");
    await controller.create("Next");
    expect(names(controller)).not.toContain("Only a name");
    expect(storage.saved.scenes["Only a name"]).toBeUndefined();
    expect(storage.snapshots.has("Only a name")).toBe(false);
  });

  it("one with a drawing stays", async () => {
    const { controller, editor, storage } = await controllerHarness();
    await controller.create("Drawn");
    editor.draw(el("d1"));
    await controller.create("Next");
    expect(names(controller)).toContain("Drawn");
    expect(storage.snapshots.get("Drawn")?.json).toContain("d1");
  });

  it("at the start, old empty ones are forgotten; the open one and those with content stay", async () => {
    const { controller, storage } = await controllerHarness({
      setup: ({ storage }) => {
        storage.saved = {
          current: null, baseline: null, autoSync: true, pendingDeletes: {},
          scenes: {
            "Old link": { baseMd5: null, dirty: false, localOnly: true, moveOnSignIn: true },
            "Empty copy": { baseMd5: null, dirty: false },
            Kept: { baseMd5: null, dirty: true, localOnly: true },
            "In Drive": { baseMd5: "abc", remoteMd5: "abc", dirty: false },
          },
        };
        storage.snapshots.set("Empty copy", { json: sceneJson("Empty copy", []), baseline: null, dirty: false });
        storage.snapshots.set("Kept", { json: sceneJson("Kept", [el("k1")]), baseline: null, dirty: true });
      },
    });
    await controller.ready;
    expect(Object.keys(storage.saved.scenes).filter((name) => name !== UNTITLED).sort((a, b) => a.localeCompare(b))).toEqual(["In Drive", "Kept"]);
    expect(storage.snapshots.has("Empty copy")).toBe(false);
  });
});

describe("a scene link to the open scene, which is only a name", () => {
  it("found elsewhere now (shared with the user): the tab goes there, the empty one is forgotten", async () => {
    const { controller, storage } = await controllerHarness();
    await controller.create("Madsack");
    const go = vi.fn();
    const elsewhere = vi.fn(() => Promise.resolve(go));
    expect(await controller.openOrCreate("Madsack", { elsewhere })).toBe(false);
    expect(elsewhere).toHaveBeenCalledWith("Madsack");
    expect(go).toHaveBeenCalled();
    expect(storage.saved.scenes.Madsack).toBeUndefined();
    expect(storage.saved.current).toBeNull();
  });

  it("not found: it stays open, as if just made (the router offers to look among shared scenes)", async () => {
    const { controller } = await controllerHarness();
    await controller.create("Madsack");
    const elsewhere = vi.fn(() => Promise.resolve(null));
    expect(await controller.openOrCreate("Madsack", { elsewhere })).toBe(true);
    expect(controller.getState().current).toBe("Madsack");
  });

  it("with a drawing it is the user's scene: nothing is looked up", async () => {
    const { controller, editor } = await controllerHarness();
    await controller.create("Madsack");
    editor.draw(el("m1"));
    const elsewhere = vi.fn(() => Promise.resolve(vi.fn()));
    expect(await controller.openOrCreate("Madsack", { elsewhere })).toBe(false);
    expect(elsewhere).not.toHaveBeenCalled();
  });
});
