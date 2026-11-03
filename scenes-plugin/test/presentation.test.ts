import { describe, expect, it } from "vitest";
import { presentationOf, mergePresentation, editedPresentation, presentationEdit, presentationChange, presentationSave, restorePresentation } from "../../scenes-mcp/presentation.mjs";
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

describe("explicit false survives unrelated and stale writes", () => {
  const off = { kurviqPresentation: false, kurviqPresentationAt: 20 };
  const on = { kurviqPresentation: true, kurviqPresentationAt: 10 };
  const existing = [{ id: "template", type: "frame", customData: { slides: { role: "template", notes: "notes" } } }];

  it.each([
    { add: [{ type: "text", slide: 1 }] },
    { update: [{ id: "a", slide: 2 }] },
    { restyle: true }, { reset: "all" }, { addTitleBlock: true },
    { update: existing },
    { update: [{ id: "a", type: "slide", customData: { slides: { notes: "notes" } } }] },
    { update: [{ id: "template", type: "template" }] },
    { add: existing, upsert: true },
    { add: [{ type: "slide" }] },
  ])("does not author settings for %j", (command) => {
    expect(presentationEdit(command, off, existing)).toBeNull();
    expect(editedPresentation(command, off, existing)).toBe(false);
    expect(off.kurviqPresentationAt).toBe(20);
  });
  it("explicit template authoring and flag edits still work", () => {
    expect(presentationEdit({ add: [{ id: "new", type: "template" }] }, off, existing)?.kurviqPresentation).toBe(true);
    expect(presentationEdit({ isPresentation: false, add: [{ type: "template" }] }, off)?.kurviqPresentation).toBe(false);
  });
  it("a later click wins even with a clock behind the previously observed writer", () => {
    const click = presentationChange(false, { ...on, kurviqPresentationAt: 1000000 }, 5);
    expect(click.kurviqPresentationAt).toBe(1000001);
    expect(restorePresentation({ appState: { ...on, kurviqPresentationAt: 1000000 } }, click)).toEqual(click);
  });
  it("stale detached saves change only fields changed against their baseline", () => {
    expect(presentationSave(on, on, off)).toEqual(off);
    expect(presentationSave(on, null, off)).toEqual(off);
    expect(presentationSave({ ...on, kurviqPresentationAt: 30 }, on, off).kurviqPresentation).toBe(true);
  });
  it("an older Drive file or legacy migration cannot replace explicit false", () => {
    expect(restorePresentation({ appState: on }, off)).toEqual(off);
    expect(restorePresentation({ elements: existing }, off)).toEqual(off);
    expect(mergePresentation(off, on)).toEqual(off);
  });
});
