import { describe, expect, it } from "vitest";
import { fitView, viewTarget } from "../src/viewTarget";

// the smallest zoom a fit goes to (viewTarget.ts MIN_FIT_ZOOM)
const MIN_FIT_ZOOM = 0.01;

const frame = (id: string, x: number, extra: object = {}) => ({ id, type: "frame", x, y: 0, width: 1920, height: 1080, ...extra });
const deck = [
  frame("s1", 2260),
  frame("s2", 4420),
  { id: "t", type: "text", x: 2300, y: 40, width: 400, height: 50 },
  // stray elements beside the deck (the public scene that opened off center)
  { id: "far", type: "text", x: 25030, y: 4860, width: 734, height: 150 },
  { id: "left", type: "rectangle", x: 530, y: 6365, width: 520, height: 80 },
];

describe("viewTarget: what the shared-scene viewer fits on open", () => {
  it("fits a presentation's slides, not stray elements beside them", () => {
    expect(viewTarget(deck, true).map((e) => e.id)).toEqual(["s1", "s2"]);
  });
  it("leaves template frames and deleted frames out", () => {
    const elements = [...deck, frame("tpl", 40000, { customData: { slides: { role: "template" } } }), frame("gone", 50000, { isDeleted: true })];
    expect(viewTarget(elements, true).map((e) => e.id)).toEqual(["s1", "s2"]);
  });
  it("fits everything visible when the scene is no presentation", () => {
    expect(viewTarget([...deck, { id: "x", type: "text", x: 0, y: 0, width: 1, height: 1, isDeleted: true }], false).map((e) => e.id)).toEqual(["s1", "s2", "t", "far", "left"]);
  });
  it("fits everything when a presentation has no slides yet", () => {
    const loose = deck.filter((e) => e.type !== "frame");
    expect(viewTarget(loose, true)).toEqual(loose);
  });
});

describe("fitView: the whole target in view, centered", () => {
  const offsets = { top: 48, bottom: 64, left: 48, right: 48 };
  const viewport = { width: 2000, height: 888 };
  const center = (view: ReturnType<typeof fitView>, x: number, y: number) => [(x + view.scrollX) * view.zoom.value, (y + view.scrollY) * view.zoom.value];
  it("goes below Excalidraw's 10 % for a big deck and centers it in the free area", () => {
    const bounds = [2260, -1462, 17140, 11076] as const;
    const view = fitView(bounds, viewport, offsets);
    expect(view.zoom.value).toBeCloseTo(776 / 12538, 6);
    const [cx, cy] = center(view, (2260 + 17140) / 2, (-1462 + 11076) / 2);
    expect(cx).toBeCloseTo(48 + 1904 / 2, 6);
    expect(cy).toBeCloseTo(48 + 776 / 2, 6);
    // the corners are inside the free area
    const [left] = center(view, 2260, 0);
    const [right] = center(view, 17140, 0);
    expect(left).toBeGreaterThanOrEqual(48);
    expect(right).toBeLessThanOrEqual(2000 - 48);
  });
  it("keeps the zoom within its limits", () => {
    expect(fitView([0, 0, 1e9, 1e9], viewport, offsets).zoom.value).toBe(MIN_FIT_ZOOM);
    expect(fitView([0, 0, 1, 1], viewport, offsets).zoom.value).toBe(30);
  });
});
