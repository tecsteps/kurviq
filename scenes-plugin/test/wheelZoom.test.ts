import { describe, expect, it } from "vitest";

import { deltaPixels, isMouseWheel } from "../src/wheelZoom";

describe("isMouseWheel: a mouse wheel zooms, a trackpad pans", () => {
  it("Chrome / Safari: a wheel comes in notches of 120, a trackpad's legacy delta is -3 × deltaY", () => {
    expect(isMouseWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: -200, deltaMode: 0, wheelDeltaY: 240 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 })).toBe(false);
    // a trackpad scroll that happens to be a multiple of 120 is still -3 × deltaY
    expect(isMouseWheel({ deltaX: 0, deltaY: 40, deltaMode: 0, wheelDeltaY: -120 })).toBe(false);
  });

  it("Firefox's wheel scrolls in lines or pages", () => {
    expect(isMouseWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 })).toBe(true);
  });

  it("unclear or sideways: a trackpad (pans as before)", () => {
    expect(isMouseWheel({ deltaX: 0, deltaY: 12, deltaMode: 0 })).toBe(false);
    expect(isMouseWheel({ deltaX: 5, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 })).toBe(false);
    expect(isMouseWheel({ deltaX: 2, deltaY: 3, deltaMode: 1 })).toBe(false);
  });

  it("lines and pages in pixels", () => {
    expect(deltaPixels({ deltaY: 3, deltaMode: 1 })).toBe(120);
    expect(deltaPixels({ deltaY: -1, deltaMode: 2 })).toBe(-800);
    expect(deltaPixels({ deltaY: 53, deltaMode: 0 })).toBe(53);
  });
});
