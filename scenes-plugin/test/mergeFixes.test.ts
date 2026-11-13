// The three-way merge (src/merge.ts): z-order (B101) and scene settings (B36),
// and the one canonical element form (scenes-mcp/elementContent.mjs, U3).
import { describe, expect, it } from "vitest";

import * as elementContent from "../../scenes-mcp/elementContent.mjs";
import { contentEqual } from "../src/editDiff";

import { runModule } from "./runModule";

const merge = runModule(new URL("../src/merge.ts", import.meta.url), {
  "@excalidraw/element": { syncInvalidIndices: () => {} },
  "../../scenes-mcp/elementContent.mjs": elementContent,
});

const el = (id: string, index: string, props: Record<string, unknown> = {}) => ({ id, index, version: 1, versionNonce: 1, x: 0, ...props });

describe("z-order in a merge (B101)", () => {
  it("an element I only moved to the front stays in front", () => {
    const base = [el("a", "a0"), el("b", "a1")];
    const mine = [el("b", "a1"), el("a", "a2", { version: 2, versionNonce: 2 })]; // a to the front
    const theirs = [el("a", "a0"), el("b", "a1", { x: 5, version: 2, versionNonce: 3 })]; // b moved
    const result = merge.mergeElements(base, mine, theirs);
    expect(result.clashes).toEqual([]);
    expect(result.elements.map((item: any) => item.id)).toEqual(["b", "a"]);
    expect(result.elements.find((item: any) => item.id === "b").x).toBe(5);
  });

  it("Drive's reorder is kept when I didn't reorder", () => {
    const base = [el("a", "a0"), el("b", "a1")];
    const mine = [el("a", "a0", { x: 3, version: 2, versionNonce: 2 }), el("b", "a1")];
    const theirs = [el("b", "a1"), el("a", "a2", { version: 2, versionNonce: 4 })];
    const result = merge.mergeElements(base, mine, theirs);
    expect(result.elements.map((item: any) => [item.id, item.index, item.x])).toEqual([["b", "a1", 0], ["a", "a2", 3]]);
  });
});

describe("scene settings in a merge (B36)", () => {
  const base = { viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false };
  it("theirs where only they changed it, mine where I did", () => {
    const mine = { ...base, gridModeEnabled: true };
    const theirs = { ...base, viewBackgroundColor: "#ffc9c9" };
    expect(merge.mergeSceneSettings(base, mine, theirs)).toEqual({ viewBackgroundColor: "#ffc9c9", gridSize: 20, gridStep: 5, gridModeEnabled: true });
  });
  it("both changed: mine; no base known: mine", () => {
    expect(merge.mergeSceneSettings(base, { ...base, viewBackgroundColor: "#000" }, { ...base, viewBackgroundColor: "#fff000" }).viewBackgroundColor).toBe("#000");
    expect(merge.mergeSceneSettings(null, { viewBackgroundColor: "#000" }, { viewBackgroundColor: "#fff000" })).toEqual({ viewBackgroundColor: "#000" });
  });
});

describe("one canonical element form (U3)", () => {
  it("normalize drops the given keys, empty fields and rounding noise", () => {
    const a = { id: "a", x: 1.0001, index: "a1", status: "pending", groupIds: [], link: null };
    expect(elementContent.normalize(a)).toEqual({ id: "a", x: 1, status: "pending" });
    expect(elementContent.normalize(a, new Set(["status"]))).toEqual({ id: "a", x: 1, index: "a1" });
  });
  it("the merge ignores the z-order and trusts stamps; the edit diff counts the z-order and never the stamps", () => {
    const a = { id: "a", version: 1, versionNonce: 1, index: "a1", x: 0 };
    const moved = { ...a, index: "a2" };
    expect(elementContent.sameContent(a, moved)).toBe(true);
    expect(contentEqual(a, moved)).toBe(false);
    expect(contentEqual(a, { ...a, version: 9, versionNonce: 9, updated: 5 })).toBe(true);
  });
});
