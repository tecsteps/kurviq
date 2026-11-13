import { describe, expect, it } from "vitest";

// @ts-ignore: plain JS module of the MCP tools
import { conflictBaseOf, conflictList, findConflicts, resolveConflicts, withLateConflicts } from "../../scenes-mcp/editConflicts.mjs";

let stamp = 1;
const el = (id: string, props: Record<string, any> = {}) => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: stamp++,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  ...props,
});
const text = (id: string, words: string, props: Record<string, any> = {}) =>
  el(id, { type: "text", text: words, originalText: words, fontSize: 20, fontFamily: 5, autoResize: true, ...props });
/** the same element, changed by the user */
const changed = (element: Record<string, any>, props: Record<string, any>) => ({ ...element, ...props, version: element.version + 1, versionNonce: stamp++ });

const rich = (...lines: Array<Array<Record<string, any>>>) => ({ rich: { v: 1, p: lines.map((r) => ({ r })) } });

describe("findConflicts", () => {
  const t = text("t", "A company transformation.");

  it("markdown / text / originalText all clash with the user's text change", () => {
    const now = changed(t, { text: "A company transformation.\n", originalText: "A company transformation.\n", height: 60 });
    for (const update of [{ id: "t", markdown: "A {color=#1565c0}company{/} transformation." }, { id: "t", text: "x" }, { id: "t", originalText: "x" }]) {
      const [conflict] = findConflicts({ base: [t], current: [now], updates: [update] });
      expect(conflict.properties).toEqual(["text"]);
      expect(conflict.theirs.text.text).toBe("A company transformation.\n");
      expect(conflict.userChanged).toContain("text");
    }
  });

  it("a formatting change by the user (customData.rich) is a text change too, and theirs has its markdown", () => {
    const now = changed(t, { customData: rich([{ t: "A company " }, { t: "transformation.", b: true }]) });
    const [conflict] = findConflicts({ base: [t], current: [now], updates: [{ id: "t", text: "New" }] });
    expect(conflict.properties).toEqual(["text"]);
    expect(conflict.theirs.text.markdown).toBe("A company **transformation.**");
  });

  it("moves clash with x / y (also slide-relative), not with a recolor", () => {
    const now = changed(t, { x: 40, y: 10 });
    expect(findConflicts({ base: [t], current: [now], updates: [{ id: "t", strokeColor: "#1565c0" }] })).toEqual([]);
    const [conflict] = findConflicts({ base: [t], current: [now], updates: [{ id: "t", slide: "f1", x: 5 }] });
    expect(conflict.properties).toEqual(["position"]);
    expect(conflict.yours.position).toEqual({ x: 5, slide: "f1" });
    expect(conflict.theirs.position).toEqual({ x: 40, y: 10 });
  });

  it("style properties by name; the same element's other changes don't clash", () => {
    const now = changed(t, { strokeColor: "#e03131", fontSize: 28 });
    expect(findConflicts({ base: [t], current: [now], updates: [{ id: "t", fontFamily: 7 }] })).toEqual([]);
    const [conflict] = findConflicts({ base: [t], current: [now], updates: [{ id: "t", strokeColor: "#1565c0", fontSize: 20 }] });
    expect(conflict.properties).toEqual(["strokeColor", "fontSize"]);
    expect(conflict.theirs).toEqual({ strokeColor: "#e03131", fontSize: 28 });
  });

  it("width / height: a resize clashes; an auto-sized text re-measured for new words does not", () => {
    const box = el("b");
    expect(findConflicts({ base: [box], current: [changed(box, { width: 200 })], updates: [{ id: "b", height: 80 }] })[0].properties).toEqual(["size"]);
    const grown = changed(t, { text: "Longer words here", originalText: "Longer words here", width: 300 });
    expect(findConflicts({ base: [t], current: [grown], updates: [{ id: "t", width: 120 }] })).toEqual([]);
  });

  it("customData key by key, one level down", () => {
    const frame = el("f", { type: "frame", customData: { slides: { notes: "a", skip: false } } });
    const now = changed(frame, { customData: { slides: { notes: "b", skip: false } } });
    expect(findConflicts({ base: [frame], current: [now], updates: [{ id: "f", customData: { slides: { skip: true } } }] })).toEqual([]);
    const [conflict] = findConflicts({ base: [frame], current: [now], updates: [{ id: "f", customData: { slides: { notes: "c" } } }] });
    expect(conflict.properties).toEqual(["customData.slides.notes"]);
    expect(conflict.theirs["customData.slides.notes"]).toBe("b");
  });

  it("a shape's label: the update on the shape vs the user's change of its bound text", () => {
    const box = el("box");
    const label = text("box-label", "Old", { containerId: "box" });
    const relabeled = changed(label, { text: "Mine", originalText: "Mine" });
    const [conflict] = findConflicts({ base: [box, label], current: [box, relabeled], updates: [{ id: "box", label: { text: "Theirs" } }] });
    expect(conflict.id).toBe("box");
    expect(conflict.properties).toEqual(["label.text"]);
    expect(conflict.theirs["label.text"].text).toBe("Mine");
    // a label's font size vs their text: no clash; and the label element by its own id
    expect(findConflicts({ base: [box, label], current: [box, relabeled], updates: [{ id: "box", label: { fontSize: 28 } }] })).toEqual([]);
    expect(findConflicts({ base: [box, label], current: [box, relabeled], updates: [{ id: "box-label", markdown: "**x**" }] })[0].properties).toEqual(["text"]);
    // the user moved the shape (its label moved along): a label update doesn't clash
    const moved = changed(box, { x: 50 });
    const labelMoved = changed(label, { x: 60 });
    expect(findConflicts({ base: [box, label], current: [moved, labelMoved], updates: [{ id: "box", label: { text: "New" } }] })).toEqual([]);
  });

  it("an element the user deleted", () => {
    const [conflict] = findConflicts({ base: [t], current: [], updates: [{ id: "t", strokeColor: "#000" }] });
    expect(conflict.properties).toEqual(["deleted"]);
    expect(conflict.reason).toMatch(/deleted/);
  });

  it("format clashes only when the user's text change took the phrase away", () => {
    const edited = changed(t, { text: "A company transformation.\n\nNew line", originalText: "A company transformation.\n\nNew line" });
    expect(findConflicts({ base: [t], current: [edited], updates: [{ id: "t", format: { match: "transformation", color: "#1565c0" } }] })).toEqual([]);
    const reworded = changed(t, { text: "A company change.", originalText: "A company change." });
    const [conflict] = findConflicts({ base: [t], current: [reworded], updates: [{ id: "t", format: { match: "transformation", bold: true } }] });
    expect(conflict.properties).toEqual(["text"]);
    expect(conflict.reason).toMatch(/no longer in the text/);
    // a label, by the shape's id
    const box = el("box");
    const label = text("box-label", "Hello world", { containerId: "box" });
    const now = changed(label, { text: "Hello there", originalText: "Hello there" });
    expect(findConflicts({ base: [box, label], current: [box, now], updates: [{ id: "box", format: { match: "world", italic: true } }] })[0].properties).toEqual(["label.text"]);
  });

  it("a property that already has the value the update sets does not clash (a retry, or the same change)", () => {
    const now = changed(t, { x: 40, strokeColor: "#1565c0", text: "New words", originalText: "New words", customData: { slides: { skip: true } } });
    const retry = { id: "t", x: 40, strokeColor: "#1565c0", text: "New words", customData: { slides: { skip: true } } };
    expect(findConflicts({ base: [t], current: [now], updates: [retry] })).toEqual([]);
    // slide-relative x / y count from the element's slide
    const frame = el("f", { type: "frame", x: 1000, y: 0 });
    const onSlide = el("s", { frameId: "f", x: 1010, y: 20 });
    const moved = changed(onSlide, { x: 1040 });
    expect(findConflicts({ base: [frame, onSlide], current: [frame, moved], updates: [{ id: "s", slide: "f", x: 40 }] })).toEqual([]);
    expect(findConflicts({ base: [frame, onSlide], current: [frame, moved], updates: [{ id: "s", slide: "f", x: 50 }] })[0].properties).toEqual(["position"]);
  });

  it("empty lists and missing fields are the same (as for userChanges)", () => {
    const line = el("l", { type: "line", groupIds: [] });
    const now = changed(line, { groupIds: undefined, strokeColor: "#e03131" });
    expect(findConflicts({ base: [line], current: [now], updates: [{ id: "l", groupIds: ["g"] }] })).toEqual([]);
  });

  it("elements new since the agent's version, or unchanged ones, never clash", () => {
    const fresh = el("n");
    expect(findConflicts({ base: [t], current: [t, fresh], updates: [{ id: "n", x: 3 }, { id: "t", x: 3, text: "y" }] })).toEqual([]);
  });
});

describe("resolveConflicts", () => {
  const a = el("a");
  const b = el("b");
  const current = [changed(a, { backgroundColor: "#ffc9c9" }), b];
  const updates = [{ id: "a", backgroundColor: "#a5d8ff" }, { id: "b", backgroundColor: "#a5d8ff" }];

  it("reject: the clashing entries are left out", () => {
    const result = resolveConflicts({ base: [a, b], current, updates });
    expect(result.updates).toEqual([updates[1]]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: "a", properties: ["backgroundColor"], resolution: "rejected", yours: { backgroundColor: "#a5d8ff" }, theirs: { backgroundColor: "#ffc9c9" } });
    expect(conflictList(result.conflicts)).toBe("a (backgroundColor)");
  });

  it("overwrite: everything is sent, the clashes still listed", () => {
    const result = resolveConflicts({ base: [a, b], current, updates, onConflict: "overwrite" });
    expect(result.updates).toEqual(updates);
    expect(result.conflicts[0].resolution).toBe("overwritten");
  });

  it("upsert: an add replacing an element the user changed is a conflict; others pass", () => {
    const adds = [el("a", { x: 9 }), el("b", { x: 9 }), el("c")];
    const result = resolveConflicts({ base: [a, b], current, updates: [], adds, upsert: true });
    expect(result.adds).toEqual([adds[1], adds[2]]);
    expect(result.conflicts).toEqual([expect.objectContaining({ id: "a", properties: ["replaced"], resolution: "rejected" })]);
    expect(resolveConflicts({ base: [a, b], current, updates: [], adds }).adds).toEqual(adds);
    expect(resolveConflicts({ base: [a, b], current, updates: [], adds, upsert: true, onConflict: "overwrite" }).adds).toEqual(adds);
  });
});

describe("the conflict check again in the tab", () => {
  const base = [
    { id: "box", type: "rectangle" },
    { id: "box-label", type: "text", containerId: "box" },
    { id: "other", type: "rectangle" },
    { id: "added", type: "rectangle" },
  ];

  it("sends only the base elements the edit names, with their labels (upsert adds only with upsert)", () => {
    expect(conflictBaseOf(base, { updates: [{ id: "box" }], adds: [{ id: "added" }] }).map((el) => el.id)).toEqual(["box", "box-label"]);
    expect(conflictBaseOf(base, { updates: [], adds: [{ id: "added" }], upsert: true }).map((el) => el.id)).toEqual(["added"]);
    expect(conflictBaseOf(undefined, { updates: [{ id: "box" }] })).toEqual([]);
  });

  it("reports each conflict once when both checks found it", () => {
    const mcp = [{ id: "box", properties: ["position"] }];
    const tab = [{ id: "box", properties: ["position"] }, { id: "other", properties: ["text"] }];
    expect(withLateConflicts(mcp, tab)).toEqual([...mcp, tab[1]]);
    expect(withLateConflicts(mcp, undefined)).toEqual(mcp);
  });
});
