// Fixes of the code review in the scenes controller (specs/2026-11-13-code-review-browser-controller.md),
// run on the real controller with an in-memory editor, storage and Drive (./controllerHarness.ts).
import { describe, expect, it } from "vitest";

import { controllerHarness, el, flush, offline, sceneJson, syncedScene } from "./controllerHarness";

describe("the three-way merge keeps Drive's scene settings (B36)", () => {
  it("Drive changed the background, I changed elements: both are in the merged file", async () => {
    const { controller, drive, editor } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.open("A");
    await controller.syncNow({ refresh: true });
    drive.put("A", sceneJson("A", [el("a1")], { viewBackgroundColor: "#ffc9c9" }));
    editor.draw(el("mine"));
    await controller.syncNow({ refresh: true }); // diverged: merged and pushed
    await flush();
    const pushed = JSON.parse(drive.files.get("A")!.json);
    expect(pushed.appState.viewBackgroundColor).toBe("#ffc9c9");
    expect(pushed.elements.map((item: any) => item.id).sort((a: string, b: string) => a.localeCompare(b))).toEqual(["a1", "mine"]);
    expect(editor.appState.viewBackgroundColor).toBe("#ffc9c9");
  });
});

describe("a merge with nothing of mine takes Drive's version as it is", () => {
  it("a change only in how the editor writes the same content is not pushed (no new Drive version)", async () => {
    const { controller, drive, editor } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1", { boundElements: null })]) });
    await controller.open("A");
    await controller.syncNow({ refresh: true });
    const theirs = drive.put("A", sceneJson("A", [el("a1", { boundElements: null }), el("theirs")]));
    editor.updateScene({ elements: [el("a1", { boundElements: [], version: 2, versionNonce: 7 })] }); // same content, written differently
    expect(controller.getState().dirty).toBe(true);
    drive.calls.length = 0;
    await controller.syncNow({ refresh: true });
    await flush();
    expect(drive.calls).not.toContain("save");
    expect(drive.files.get("A")!.version).toBe(theirs);
    expect(editor.getSceneElements().map((item: any) => item.id)).toEqual(["a1", "theirs"]);
    expect(controller.getState().dirty).toBe(false);
    expect(controller.statusOf("A")).toBe("synced");
  });
});

describe("renaming and deleting the open scene replace the URL (B98)", () => {
  it("rename: state.current follows, the URL is replaced", async () => {
    const { controller, drive } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.open("A");
    await controller.rename("A", "Renamed");
    expect(controller.getState().current).toBe("Renamed");
    expect(controller.getState().urlMode).toBe("replace");
    expect(drive.files.has("Renamed")).toBe(true);
    await controller.open(null);
    expect(controller.getState().urlMode).toBe("push");
  });

  it("delete: the untitled scene opens in place", async () => {
    const { controller } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.open("A");
    await controller.remove("A");
    expect(controller.getState().current).toBeNull();
    expect(controller.getState().urlMode).toBe("replace");
  });
});

describe("renaming onto a name whose delete is still queued (B99)", () => {
  it("a scene in Drive: the queued delete runs first, then the rename", async () => {
    const { controller, drive, storage } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "Plan", [el("old")]);
        syncedScene(parts, "Plan v2", [el("new")]);
      },
    });
    await controller.syncNow({ refresh: true });
    drive.fail.remove = offline();
    await controller.remove("Plan"); // offline: queued
    expect(controller.pendingDeletes()).toEqual(["Plan"]);
    await controller.rename("Plan v2", "Plan");
    expect(controller.pendingDeletes()).toEqual([]);
    expect(JSON.parse(drive.files.get("Plan")!.json).elements[0].id).toBe("new");
    expect(drive.files.has("Plan v2")).toBe(false);
    expect(storage.saved.scenes.Plan.renamedFrom).toBeUndefined();
  });

  it("offline: the delete stays queued and runs before the queued rename", async () => {
    const { controller, drive } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "Plan", [el("old")]);
        syncedScene(parts, "Plan v2", [el("new")]);
      },
    });
    await controller.syncNow({ refresh: true });
    drive.fail.remove = offline();
    await controller.remove("Plan");
    drive.fail.remove = offline();
    drive.fail.rename = offline();
    await controller.rename("Plan v2", "Plan");
    expect(controller.pendingDeletes()).toEqual(["Plan"]);
    await controller.syncNow({ refresh: true }); // back online
    await flush();
    expect(controller.pendingDeletes()).toEqual([]);
    expect([...drive.files.keys()]).toEqual(["Plan"]);
    expect(JSON.parse(drive.files.get("Plan")!.json).elements[0].id).toBe("new");
  });

  it("a scene not in Drive takes the deleted version over as its base", async () => {
    const { controller, drive, storage } = await controllerHarness({ setup: (parts) => syncedScene(parts, "Plan", [el("old")]) });
    await controller.syncNow({ refresh: true });
    const deleted = drive.files.get("Plan")!.version;
    drive.fail.remove = offline();
    await controller.remove("Plan");
    drive.fail.list = offline(); // still offline: the new scene isn't pushed yet
    await controller.create("Draft", { localOnly: false });
    await controller.rename("Draft", "Plan");
    expect(controller.pendingDeletes()).toEqual([]);
    expect(storage.saved.scenes.Plan).toMatchObject({ baseMd5: deleted, dirty: true });
  });
});

describe("copies get valid, free names (B100, U29)", () => {
  it("keep both: a long name is shortened, a second copy in the same minute gets (2)", async () => {
    const long = "L".repeat(95);
    const { controller, editor, exports } = await controllerHarness({ setup: (parts) => syncedScene(parts, long, [el("a1")]) });
    await controller.open(long);
    editor.draw(el("mine"));
    const first = await controller.keepBoth(long);
    editor.draw(el("again"));
    const second = await controller.keepBoth(long);
    for (const name of [first, second]) {
      expect(name.length).toBeLessThanOrEqual(100);
      expect(exports.sceneNameProblem(name)).toBeNull();
    }
    expect(second).not.toBe(first);
    expect(second.endsWith(" (2)")).toBe(true);
  });

  it("copyName shortens the name so the suffix fits", async () => {
    const { exports } = await controllerHarness();
    expect(exports.copyName("Plan", " (conflict 2026-11-13 10.00)", () => false)).toBe("Plan (conflict 2026-11-13 10.00)");
    const name = exports.copyName("x".repeat(100), " (copy)", () => false);
    expect(name).toBe(`${"x".repeat(93)} (copy)`);
  });
});

describe("a rename keeps the Drive file's listing entry (B103)", () => {
  it("file id and public flag stay with the new name", async () => {
    const { controller, drive } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "A", [el("a1")]);
        parts.drive.files.get("A")!.public = true;
      },
    });
    await controller.syncNow({ refresh: true });
    const id = drive.files.get("A")!.id;
    await controller.rename("A", "B");
    const item = controller.getState().list.find((entry: any) => entry.name === "B");
    expect(item).toMatchObject({ fileId: id, public: true, home: "drive" });
    expect(controller.fileIdOf("B")).toBe(id);
  });
});

describe("keep only here (B104)", () => {
  it("when Drive refuses the delete, the scene stays as it was", async () => {
    const { controller, drive, storage } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.syncNow({ refresh: true });
    drive.fail.remove = Object.assign(new Error("Forbidden"), { status: 403 });
    await expect(controller.keepOnlyHere("A")).rejects.toThrow(/Forbidden/);
    expect(controller.isLocalOnly("A")).toBe(false);
    expect(storage.saved.scenes.A.baseMd5).toBe(drive.files.get("A")!.version);
  });

  it("out of Drive first, then local only", async () => {
    const { controller, drive } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.syncNow({ refresh: true });
    await controller.keepOnlyHere("A");
    expect(drive.files.has("A")).toBe(false);
    expect(controller.isLocalOnly("A")).toBe(true);
    expect(controller.homeOf("A").kind).toBe("browser");
  });
});

describe("scene names (B37)", () => {
  it("names like constructor or toString are scenes like any other", async () => {
    const { controller } = await controllerHarness();
    await controller.create("constructor", { localOnly: true });
    await controller.create("toString", { localOnly: true });
    expect(controller.getState().list.map((item: any) => item.name)).toEqual(expect.arrayContaining(["constructor", "toString"]));
  });

  it("online, the names of Kurviq's pages are refused for new scenes", async () => {
    const { controller, exports } = await controllerHarness({ online: true });
    await expect(controller.create("about", { localOnly: true })).rejects.toThrow(/Kurviq's pages/);
    expect(exports.sceneNameProblem("features", true)).toMatch(/Kurviq's pages/);
    expect(exports.sceneNameProblem("About", true)).toBeNull();
    expect(exports.sceneNameProblem("about", false)).toBeNull();
  });
});

describe("the homes behind the controller", () => {
  it("each scene has one home: browser for local only and Untitled, Drive for the rest", async () => {
    const { controller } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.create("Here", { localOnly: true });
    expect(controller.homeOf("Here").kind).toBe("browser");
    expect(controller.homeOf(null).kind).toBe("browser");
    expect(controller.homeOf("A").kind).toBe("drive");
  });

  it("the browser home reads and writes the local-only scenes through the controller", async () => {
    const { controller } = await controllerHarness();
    const home = controller.browserHome;
    await home.save("Moved", sceneJson("Moved", [el("m1")]), "none");
    expect(controller.isLocalOnly("Moved")).toBe(true);
    const { json, version } = await home.load("Moved");
    expect(JSON.parse(json).elements[0].id).toBe("m1");
    expect((await home.list()).scenes).toEqual([{ name: "Moved", version, updatedAt: null }]);
    await expect(home.save("Moved", json, "stale")).rejects.toMatchObject({ status: 409, remoteVersion: version });
    await home.remove("Moved", version);
    expect(controller.isLocalOnly("Moved")).toBe(false);
  });

  it("history comes from the scene's home", async () => {
    const { controller } = await controllerHarness();
    await controller.create("Here", { localOnly: true });
    expect(await controller.history("Here")).toEqual([]);
    await expect(controller.loadVersion("Here", { id: "1", at: null, author: null, agent: false })).rejects.toThrow(/keeps no older versions/);
  });
});
