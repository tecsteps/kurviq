import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("leaves user history to the editor during agent edits and scene application", () => {
  const controller = readFileSync(new URL("../src/controller.ts", import.meta.url), "utf8");
  expect(controller).not.toContain("api.history.clear()");
  // the pen holder's changes on a viewer's canvas never enter the viewer's undo history
  const pen = readFileSync(new URL("../src/online/pen.ts", import.meta.url), "utf8");
  const surface = pen.slice(pen.indexOf("  private applyChange(value: any) {"), pen.indexOf("  // pointers"));
  expect(surface).toContain("captureUpdate: CaptureUpdateAction.NEVER");
  expect(pen).not.toContain("CaptureUpdateAction.IMMEDIATELY");
});
