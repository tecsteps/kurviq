import { describe, expect, it } from "vitest";

import {
  byIndex,
  changedKeys,
  components,
  groupIndex,
  inReceipt,
  liveDifference,
  rebase,
  sameState,
  touchedBy,
  withoutDanglingRefs,
} from "../src/online/liveMerge";

const el = (id: string, props: Record<string, any> = {}) => ({
  id,
  version: 1,
  versionNonce: 1,
  x: 0,
  y: 0,
  ...props,
});

describe("changedKeys / sameState", () => {
  it("ignores stamps, counts the z-index", () => {
    expect(
      changedKeys(
        el("a"),
        el("a", { version: 9, versionNonce: 4, updated: 5, seed: 2 })
      )
    ).toEqual([]);
    expect(
      new Set(changedKeys(el("a"), el("a", { x: 3, index: "a1" })))
    ).toEqual(new Set(["x", "index"]));
    expect(changedKeys(null, el("a"))).toBeNull();
    expect(sameState(el("a"), el("a", { version: 7 }))).toBe(true);
    expect(sameState(el("a"), el("a", { x: 1 }))).toBe(false);
  });
});

describe("rebase (live collision)", () => {
  it("puts only the user's properties on the newer state", () => {
    const base = el("a", { x: 0, y: 0, strokeColor: "black" });
    const theirs = el("a", { version: 5, x: 0, y: 0, strokeColor: "red" });
    const mine = el("a", { version: 2, x: 10, y: 0, strokeColor: "black" });
    const { el: result, overlaps } = rebase(
      theirs,
      mine,
      changedKeys(base, mine),
      base
    );
    expect(result.x).toBe(10);
    expect(result.strokeColor).toBe("red");
    expect(result.version).toBe(6);
    expect(overlaps).toEqual([]);
  });

  it("same property: the later (this) change wins and the other is reported", () => {
    const base = el("a", { x: 0 });
    const theirs = el("a", { version: 5, x: 5 });
    const mine = el("a", { version: 2, x: 10 });
    const { el: result, overlaps } = rebase(theirs, mine, ["x"], base);
    expect(result.x).toBe(10);
    expect(overlaps).toEqual(["x"]);
  });

  it("a property the user removed is removed", () => {
    const base = el("a", { link: "x" });
    const mine = el("a");
    const theirs = el("a", { version: 3, link: "x", y: 4 });
    const { el: result } = rebase(theirs, mine, changedKeys(base, mine), base);
    expect("link" in result).toBe(false);
    expect(result.y).toBe(4);
  });
});

describe("touching and logical operations", () => {
  it("an element touches its references, group members, image and font", () => {
    const arrow = el("arrow", {
      startBinding: { elementId: "s" },
      endBinding: { elementId: "t" },
      groupIds: ["g"],
      frameId: "f",
      boundElements: [{ id: "label", type: "text" }],
    });
    const members = groupIndex([arrow, el("other", { groupIds: ["g"] })]);
    expect(touchedBy(arrow, members)).toEqual(
      new Set(["arrow", "label", "s", "t", "f", "other"])
    );
    expect(touchedBy(el("img", { fileId: "abc", fontFamily: 2001 }))).toEqual(
      new Set(["img", "file:abc", "font:2001"])
    );
  });

  it("connected changes form one group", () => {
    const links: Record<string, string[]> = {
      a: ["b"],
      b: [],
      c: ["d"],
      d: [],
      e: [],
    };
    const parts = components(["a", "b", "c", "d", "e"], (id) => links[id]).map(
      (part) => [...part].sort()
    );
    expect(parts.sort()).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});

describe("receipts", () => {
  it("a contiguous mark plus exceptions", () => {
    const receipt = { mark: 4, extra: [7] };
    expect(
      [1, 4, 5, 6, 7, 8].map((counter) => inReceipt(receipt, counter))
    ).toEqual([true, true, false, false, true, false]);
    expect(inReceipt(undefined, 1)).toBe(false);
  });
});

describe("order, references, whole-scene writes", () => {
  it("sorts by fractional index, elements without one last", () => {
    const sorted = byIndex([
      el("c", { index: null }),
      el("b", { index: "a2" }),
      el("a", { index: "a1" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("drops references to elements that are gone", () => {
    const fixed = withoutDanglingRefs(
      el("t", {
        containerId: "gone",
        frameId: "f",
        boundElements: [{ id: "x" }, { id: "gone" }],
        startBinding: { elementId: "gone" },
      }),
      (id) => id !== "gone"
    );
    expect(fixed.containerId).toBeNull();
    expect(fixed.frameId).toBe("f");
    expect(fixed.boundElements).toEqual([{ id: "x" }]);
    expect(fixed.startBinding).toBeNull();
  });

  it("a whole new state: changed elements stamped above, missing ones deleted", () => {
    const current = [
      el("keep", { version: 4 }),
      el("move", { version: 2 }),
      el("gone", { version: 3 }),
    ];
    const next = [el("keep"), el("move", { x: 5 }), el("new")];
    const diff = liveDifference(current, next);
    const byId = new Map(diff.map((item) => [item.id, item]));
    expect(byId.has("keep")).toBe(false);
    expect(byId.get("move")!.version).toBe(3);
    expect(byId.get("gone")!.isDeleted).toBe(true);
    expect(byId.get("new")!.version).toBe(2);
  });
});

import { contentEqual, reapplyChain } from "../src/online/liveMerge";

describe("content with order", () => {
  it("a layer move or a change under the same stamp is a change; noise is not", () => {
    expect(
      contentEqual(el("a", { index: "a1" }), el("a", { index: "a2" }))
    ).toBe(false);
    expect(contentEqual(el("a", { x: 1 }), el("a", { x: 2 }))).toBe(false); // same stamps, other content
    expect(
      contentEqual(
        el("a", { x: 1.001, link: null, groupIds: [] }),
        el("a", { x: 1, version: 9 })
      )
    ).toBe(true);
  });
});

describe("rebasing a chain of batches", () => {
  it("later steps keep only their own properties", () => {
    // A moves twice (x 0→10→20) while B turns black into red: after the rebase of the first
    // move onto red, the second must stay red too
    const base = el("a", { x: 0, strokeColor: "black" });
    const first = el("a", { version: 2, x: 10, strokeColor: "black" });
    const second = el("a", { version: 3, x: 20, strokeColor: "black" });
    const rebasedFirst = el("a", { version: 6, x: 10, strokeColor: "red" });
    const [next] = reapplyChain(first, rebasedFirst, [second]);
    expect(next).toMatchObject({ x: 20, strokeColor: "red" });
    expect(next.version).toBeGreaterThan(6);
    void base;
  });
});

describe("whole-scene writes against the state the writer read", () => {
  it("keeps what others did meanwhile, refuses the same element", () => {
    const read = [el("a", { x: 0 }), el("b", { x: 0 })];
    // meanwhile: the user added c and moved b
    const current = [
      el("a", { x: 0 }),
      el("b", { x: 9, version: 2 }),
      el("c", { x: 1 }),
    ];
    // the agent moved a and deleted nothing (it never saw c)
    const write = [el("a", { x: 5 }), el("b", { x: 0 })];
    const diff = liveDifference(current, write, read);
    expect(diff.map((item) => item.id)).toEqual(["a"]);
    expect(diff.clashes).toEqual([]);
    // the agent also moved b: both changed b
    const clash = liveDifference(
      current,
      [el("a", { x: 5 }), el("b", { x: 3 })],
      read
    );
    expect(clash.clashes).toEqual(["b"]);
    // a layer move alone is a change
    expect(
      liveDifference([el("a", { index: "a1" })], [el("a", { index: "a3" })])
    ).toHaveLength(1);
  });
});

describe("an image's loading state", () => {
  it("is not content", () => {
    expect(
      contentEqual(
        el("i", { type: "image", status: "pending" }),
        el("i", { type: "image", status: "saved", version: 3 })
      )
    ).toBe(true);
    expect(
      changedKeys(el("i", { status: "pending" }), el("i", { status: "saved" }))
    ).toEqual([]);
  });
});

describe("merge edge cases", () => {
  it("rebases all properties with null keys", () => {
    const result = rebase(
      el("a", { version: 5, x: 8 }),
      el("a", { x: 9 }),
      null,
      null
    );
    expect(result.el).toMatchObject({ id: "a", x: 9, version: 6 });
  });
  it("terminates cycles and joins transitive components", () => {
    const links: Record<string, string[]> = {
      a: ["b"],
      b: ["c"],
      c: ["a"],
      d: [],
    };
    expect(
      components(Object.keys(links), (id) => links[id])
        .map((part) => [...part].sort())
        .sort()
    ).toEqual([["a", "b", "c"], ["d"]]);
  });
  it("reports deletion against a concurrent edit and edit against deletion", () => {
    const read = [el("a")];
    expect(liveDifference([el("a", { x: 10 })], [], read).clashes).toEqual([
      "a",
    ]);
    expect(
      liveDifference([el("a", { isDeleted: true })], [el("a", { x: 10 })], read)
        .clashes
    ).toEqual(["a"]);
  });
  it("handles empty scenes", () => {
    expect(liveDifference([], [])).toHaveLength(0);
    expect(components([], () => [])).toEqual([]);
  });
  it("reapplies a three-step chain through deletion and restoration", () => {
    const first = el("a", { x: 1, strokeColor: "black" });
    const steps = [
      el("a", { x: 2, strokeColor: "black" }),
      el("a", { x: 2, strokeColor: "black", isDeleted: true }),
      el("a", { x: 3, strokeColor: "black", isDeleted: false }),
    ];
    const result = reapplyChain(
      first,
      el("a", { x: 1, version: 10, strokeColor: "red" }),
      steps
    );
    expect(
      result.map((item) => [item.x, !!item.isDeleted, item.strokeColor])
    ).toEqual([
      [2, false, "red"],
      [2, true, "red"],
      [3, false, "red"],
    ]);
    expect(result[2].version).toBeGreaterThan(result[1].version);
  });
});

describe("agent edits with restored arrow geometry", () => {
  const arrow = () => el("arrow", { type: "arrow", height: 45, width: 420, points: [[0, 0], [25, 0], [25, -65], [420, -65], [420, -30]] });

  it("does not let an unrelated inconsistent arrow block an edit", () => {
    const raw = arrow();
    const diff = liveDifference([raw, el("box")], [{ ...raw, height: 65 }, el("box", { x: 20 })], [raw, el("box")]);
    expect(diff.clashes).toEqual([]);
    expect(diff.map((item) => item.id)).toEqual(["box"]);
  });

  it("allows editing the arrow across derived geometry and binding repairs", () => {
    const raw = arrow();
    const diff = liveDifference([raw], [{ ...raw, height: 65, strokeColor: "red", boundElements: [{ id: "label", type: "text" }] }], [{ ...raw, height: 65, version: 7 }]);
    expect(diff.clashes).toEqual([]);
    expect(diff[0].strokeColor).toBe("red");
  });

  it("reports real concurrent fields and supports explicit overwrite", () => {
    const base = [arrow()];
    const current = [{ ...base[0], x: 40 }];
    const next = [{ ...base[0], strokeColor: "red" }];
    const diff = liveDifference(current, next, base);
    expect(diff.clashes).toEqual(["arrow"]);
    expect(diff.conflictFields.arrow).toEqual(["x"]);
    const forced = liveDifference(current, next, base, true);
    expect(forced.clashes).toEqual([]);
    expect(forced[0].strokeColor).toBe("red");
  });
});
