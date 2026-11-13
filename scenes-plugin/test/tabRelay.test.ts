import { describe, expect, it } from "vitest";

import { bestTab, commandTimeout, COMMAND_TIMEOUT_MS, SLOW_TIMEOUT_MS } from "../../scenes-mcp/tabRelay.mjs";

describe("the relay rules shared by the local scenes server and the pairing object", () => {
  it("gives edits and pictures the longer timeout, everything else the short one", () => {
    for (const type of ["scene-edit", "local-edit", "render", "deck-check", "convert", "upload", "upload-payload", "http"]) {
      expect(commandTimeout(type)).toBe(SLOW_TIMEOUT_MS);
    }
    expect(commandTimeout("status")).toBe(COMMAND_TIMEOUT_MS);
    expect(commandTimeout(undefined)).toBe(COMMAND_TIMEOUT_MS);
  });

  it("picks the visible tab first, then the most recently focused, then the newest connection", () => {
    const tabs = [
      { id: "hidden-recent", visible: false, focusedAt: 900, connectedAt: 1 },
      { id: "visible-old", visible: true, focusedAt: 100, connectedAt: 2 },
      { id: "visible-new", visible: true, focusedAt: 200, connectedAt: 3 },
      { id: "visible-new-later", visible: true, focusedAt: 200, connectedAt: 4 },
    ];
    expect(bestTab(tabs, (tab) => tab)?.id).toBe("visible-new-later");
    expect(bestTab(tabs.slice(0, 3), (tab) => tab)?.id).toBe("visible-new");
    expect(bestTab([tabs[0]], (tab) => tab)?.id).toBe("hidden-recent");
  });

  it("keeps the first of equal tabs and has none without tabs", () => {
    const same = [{ id: "a", connectedAt: 1 }, { id: "b", connectedAt: 1 }];
    expect(bestTab(same, (tab) => tab)?.id).toBe("a");
    expect(bestTab([], () => ({}))).toBeNull();
  });
});
