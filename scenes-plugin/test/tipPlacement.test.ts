import { describe, expect, it } from "vitest";

import { TIP_DELAY, tipPlacement } from "../src/titleTips";

describe("tooltip placement (title tooltips and QuickTip)", () => {
  const view = { width: 1000, height: 800 };

  it("goes below the control, centred, with the arrow in the middle", () => {
    expect(tipPlacement({ left: 400, width: 100, top: 100, bottom: 130 }, view)).toEqual({
      left: 450,
      top: 138,
      above: false,
      arrow: "calc(50% + 0px)",
    });
  });

  it("goes above when it would leave the window at the bottom", () => {
    const at = tipPlacement({ left: 400, width: 100, top: 760, bottom: 790 }, view);
    expect(at.above).toBe(true);
    expect(at.top).toBe(752);
  });

  it("stays 140 px from the sides; the arrow still points at the control", () => {
    expect(tipPlacement({ left: 0, width: 20, top: 0, bottom: 20 }, view)).toMatchObject({ left: 140, arrow: "calc(50% + -130px)" });
    expect(tipPlacement({ left: 980, width: 20, top: 0, bottom: 20 }, view)).toMatchObject({ left: 860, arrow: "calc(50% + 130px)" });
  });

  it("waits the same short delay everywhere", () => {
    expect(TIP_DELAY).toBe(120);
  });
});
