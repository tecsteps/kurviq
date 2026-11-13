// The scenes controller's one source of truth and one queue (code review
// S5, B34, B35, B102): opening a scene, sync steps and other tabs' metadata
// never step on each other.
import { describe, expect, it } from "vitest";

import { controllerHarness, deferred, el, flush, sceneJson, syncedScene } from "./controllerHarness";

const names = (elements: any[]) => elements.filter((item) => !item.isDeleted).map((item) => item.id);

describe("opening a scene", () => {
  it("shows it and derives state.current from the metadata (S5)", async () => {
    const { controller, editor } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.open("A");
    expect(controller.getState().current).toBe("A");
    expect(editor.appState.name).toBe("A");
    expect(names(editor.elements)).toEqual(["a1"]);
    expect(controller.getState().urlMode).toBe("push");
  });

  it("a pull of the scene being left waits until the switch is done, and lands in its stored copy (B34)", async () => {
    let newer = "";
    const { controller, drive, storage, editor } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "A", [el("a1")]);
        parts.drive.put("B", sceneJson("B", [el("b1")]));
      },
    });
    await controller.open("A");
    await flush();
    // Drive gets a newer A (someone else saved), B was never opened here: its download is slow
    newer = sceneJson("A", [el("a1"), el("a2")]);
    const newerVersion = drive.put("A", newer);
    const download = deferred();
    drive.hold.load = download.promise;
    const opening = controller.open("B");
    const sync = controller.syncNow({ refresh: true });
    await flush();
    expect(editor.appState.name).toBe("A"); // B is still downloading
    download.resolve();
    await opening;
    await sync;
    await flush();
    expect(controller.getState().current).toBe("B");
    expect(names(editor.elements)).toEqual(["b1"]);
    // A's stored copy is Drive's newer version, and that is its base: nothing old pushed later
    expect(JSON.parse(storage.snapshots.get("A")!.json).elements.map((item: any) => item.id)).toEqual(["a1", "a2"]);
    expect(storage.saved.scenes.A).toMatchObject({ baseMd5: newerVersion, dirty: false });
    expect(controller.statusOf("A")).toBe("synced");
  });

  it("edits made while the next scene downloads are kept in the scene left (B34)", async () => {
    const { controller, drive, storage, editor } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "A", [el("a1")]);
        parts.drive.put("B", sceneJson("B", [el("b1")]));
      },
    });
    await controller.open("A");
    await flush();
    const download = deferred();
    drive.hold.load = download.promise;
    const opening = controller.open("B");
    await flush();
    editor.draw(el("late"));
    download.resolve();
    await opening;
    const stored = storage.snapshots.get("A")!;
    expect(JSON.parse(stored.json).elements.map((item: any) => item.id)).toEqual(["a1", "late"]);
    expect(stored.dirty).toBe(true);
    expect(storage.saved.scenes.A.dirty).toBe(true);
  });

  it("a failed load leaves the open scene as it was (B102)", async () => {
    const { controller, drive, editor } = await controllerHarness({
      setup: (parts) => {
        syncedScene(parts, "A", [el("a1")]);
        parts.drive.put("B", sceneJson("B", [el("b1")]));
      },
    });
    await controller.open("A");
    await flush();
    drive.fail.load = Object.assign(new Error("Drive answered 500"), { status: 500 });
    await expect(controller.open("B")).rejects.toThrow(/500/);
    expect(controller.getState().current).toBe("A");
    expect(editor.appState.name).toBe("A");
    expect(names(editor.elements)).toEqual(["a1"]);
    expect(controller.getState().busy).toBeNull();
  });

  it("opens run in the order asked, also when the first one downloads longer", async () => {
    const { controller, drive, editor } = await controllerHarness({
      setup: (parts) => {
        parts.drive.put("B", sceneJson("B", [el("b1")]));
        syncedScene(parts, "C", [el("c1")]);
      },
    });
    await controller.syncNow({ refresh: true });
    const download = deferred();
    drive.hold.load = download.promise;
    const first = controller.open("B");
    const second = controller.open("C");
    await flush();
    download.resolve();
    await Promise.all([first, second]);
    expect(controller.getState().current).toBe("C");
    expect(editor.appState.name).toBe("C");
  });
});

describe("another tab's metadata during an operation (B35)", () => {
  it("a push whose answer comes after a storage event still records Drive's new version", async () => {
    const { controller, drive, storage, editor, window } = await controllerHarness({ setup: (parts) => syncedScene(parts, "A", [el("a1")]) });
    await controller.open("A");
    await controller.syncNow({ refresh: true });
    editor.draw(el("a2"));
    const saving = deferred();
    drive.hold.save = saving.promise;
    const pushing = controller.flush("A");
    await flush();
    // another tab writes the metadata (it still has A's old base) while the push is on its way
    const before = structuredClone(storage.saved);
    storage.saved = before;
    window.fire("storage", { key: "excalidraw-scenes" });
    window.fire("focus");
    saving.resolve();
    await pushing;
    const version = drive.files.get("A")!.version;
    expect(storage.saved.scenes.A.baseMd5).toBe(version);
    expect(controller.statusOf("A")).toBe("synced");
  });
});
