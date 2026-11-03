import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("leaves user history to the editor during agent edits and scene application", () => {
  const controller = readFileSync(new URL("../src/controller.ts", import.meta.url), "utf8");
  expect(controller).not.toContain("api.history.clear()");
  const sync = readFileSync(new URL("../src/online/liveSync.ts", import.meta.url), "utf8");
  const surface = sync.slice(sync.indexOf("    edit: ({ elements, files, settings })"), sync.indexOf("    agentChange:"));
  expect(surface).toContain("captureUpdate: CaptureUpdateAction.NEVER");
  expect(surface).not.toContain("CaptureUpdateAction.IMMEDIATELY");
});
