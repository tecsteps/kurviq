// The open scene after its canvas was replaced by a page of another space
// (a shared scene, the own scenes): its stored copy may be older than what
// this browser pushed to Drive last. The scene must open with Drive's
// version, never empty or old (drive-new e2e "it opens from the list, with
// what was drawn"). Run on the real controller (./controllerHarness.ts).
import { describe, expect, it } from "vitest";

import { controllerHarness, el, flush, offline, sceneJson } from "./controllerHarness";
import type { FakeDrive, FakeEditor, FakeStorage } from "./controllerHarness";

/** "Plan" was open and pushed with a drawing; its stored copy is from before (stashed empty, baseline 111) */
const pushedAfterStash = (storedBaseline: number, stored: any[] = []) => (parts: { drive: FakeDrive; storage: FakeStorage; editor: FakeEditor }) => {
  const version = parts.drive.put("Plan", sceneJson("Plan", [el("drawn")]));
  parts.storage.saved = { current: "Plan", baseline: 222, autoSync: true, scenes: { Plan: { baseMd5: version, remoteMd5: version, dirty: false } }, pendingDeletes: {} };
  parts.storage.snapshots.set("Plan", { json: sceneJson("Plan", stored), baseline: storedBaseline, dirty: false });
  // the canvas the browser restores is another space's (its untitled scene)
  parts.editor.elements = [el("other")];
  parts.editor.appState = { ...parts.editor.appState, name: "" };
};

const shown = (editor: FakeEditor) => editor.getSceneElements().map((item: any) => item.id);

describe("the open scene, its canvas replaced by another space's page", () => {
  it("its stored copy is older than what was pushed: it opens with Drive's version", async () => {
    const { controller, drive, editor } = await controllerHarness({ setup: pushedAfterStash(111) });
    await flush();
    expect(shown(editor)).toEqual(["drawn"]);
    expect(controller.getState().dirty).toBe(false);
    await controller.syncNow({ refresh: true });
    await flush();
    expect(drive.calls).not.toContain("save");
    expect(JSON.parse(drive.files.get("Plan")!.json).elements.map((item: any) => item.id)).toEqual(["drawn"]);
  });

  it("Drive not reachable: the stored copy it is (checked against Drive later), no error", async () => {
    const { editor } = await controllerHarness({
      setup: (parts) => {
        pushedAfterStash(111, [el("older")])(parts);
        parts.drive.fail.load = offline();
      },
    });
    await flush();
    expect(shown(editor)).toEqual(["older"]);
  });

  it("its stored copy is what was pushed last: shown at once, Drive is asked in the background", async () => {
    const { editor } = await controllerHarness({
      setup: (parts) => {
        pushedAfterStash(222, [el("drawn")])(parts);
        parts.drive.hold.load = new Promise(() => {}); // Drive never answers: the copy is on screen anyway
      },
    });
    await flush();
    expect(shown(editor)).toEqual(["drawn"]);
  });
});
