import { describe, expect, it, vi } from "vitest";
import { editorYield } from "../src/editorYield";

describe("editor settling", () => {
  it("yields in a hidden tab without a timer", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await editorYield();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the visible settling delay", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const pending = editorYield().then(settled);
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
