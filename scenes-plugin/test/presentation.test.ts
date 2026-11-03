import { describe, expect, it } from "vitest";
import { presentationOf, mergePresentation, editedPresentation } from "../../scenes-mcp/presentation.mjs";
import { buildSceneFile, subjectsOfFile } from "../../online/worker/serverMerge";

const frames = Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, type: "frame", x: i * 200, y: 0, width: 180, height: 100 }));
const meta = { op: "test", receipts: {}, authors: {}, onBehalf: [] };

describe("saved presentation setting", () => {
  it("uses the last explicit writer for local merge, including false", () => {
    const on = { kurviqPresentation: true, kurviqPresentationAt: 1 };
    const off = { kurviqPresentation: false, kurviqPresentationAt: 2 };
    expect(mergePresentation(on, off)).toEqual(off);
    expect(mergePresentation(off, on)).toEqual(off);
  });
  it("defaults to false regardless of frame count", () => {
    expect(presentationOf({ elements: frames })).toBe(false);
    expect(presentationOf({})).toBe(false);
  });
  it("migrates only definite presentation content", () => {
    for (const slides of [{ role: "template" }, { notes: "Speaker notes" }]) {
      const elements = [{ ...frames[0], customData: { slides } }];
      expect(presentationOf({ elements })).toBe(true);
      expect(presentationOf({ elements, appState: { kurviqPresentation: false } })).toBe(false);
      expect(presentationOf({ elements: [{ ...elements[0], isDeleted: true }] })).toBe(false);
    }
  });
  it.each([false, true])("round trips %s through live subjects and Drive JSON", async (flag) => {
    const subjects = await subjectsOfFile(JSON.stringify({ elements: frames, appState: { kurviqPresentation: flag, kurviqPresentationAt: 42 } }), "test", async () => "hash");
    const saved = JSON.parse(buildSceneFile(subjects, meta).json);
    expect(saved.appState.kurviqPresentation).toBe(flag);
    expect(saved.appState.kurviqPresentationAt).toBe(42);
    expect(saved.elements).toHaveLength(3);
  });
  it("writes migration into the saved file so later content cannot reclassify it", async () => {
    const subjects = await subjectsOfFile(JSON.stringify({ elements: frames }), "test", async () => "hash");
    const saved = JSON.parse(buildSceneFile(subjects, meta).json);
    saved.elements[0].customData = { slides: { notes: "later" } };
    expect(presentationOf(saved)).toBe(false);
  });
});

describe("agent edits and the presentation flag", () => {
  it("placing elements on a frame with slide does not make a scene a presentation", async () => {
    const appState = { kurviqPresentation: false };
    expect(editedPresentation({ add: [{ type: "text", slide: "flow-frame" }], update: [{ id: "a", slide: 2 }] } as any, appState)).toBe(false);
  });

  it("an explicit flag wins, a template does turn it on", async () => {
    expect(editedPresentation({ isPresentation: true } as any, { kurviqPresentation: false })).toBe(true);
    expect(editedPresentation({ isPresentation: false, add: [{ type: "template" }] } as any, { kurviqPresentation: true })).toBe(false);
    expect(editedPresentation({ add: [{ type: "template" }] } as any, { kurviqPresentation: false })).toBe(true);
  });
});
