import { describe, expect, it } from "vitest";
import { viewTarget } from "../src/viewTarget";

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
