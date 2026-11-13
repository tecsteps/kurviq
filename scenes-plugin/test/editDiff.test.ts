import { describe, expect, it } from "vitest";

import { contentEqual, editDifference } from "../src/editDiff";

const el = (id: string, props: Record<string, any> = {}) => ({
  id,
  version: 1,
  versionNonce: 1,
  x: 0,
  y: 0,
  ...props,
});

describe("whole-scene writes", () => {
  it("a whole new state: changed elements stamped above, missing ones deleted", () => {
    const current = [
      el("keep", { version: 4 }),
      el("move", { version: 2 }),
      el("gone", { version: 3 }),
    ];
    const next = [el("keep"), el("move", { x: 5 }), el("new")];
    const diff = editDifference(current, next);
    const byId = new Map(diff.map((item) => [item.id, item]));
    expect(byId.has("keep")).toBe(false);
    expect(byId.get("move")!.version).toBe(3);
    expect(byId.get("gone")!.isDeleted).toBe(true);
    expect(byId.get("new")!.version).toBe(2);
  });
});

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
    const diff = editDifference(current, write, read);
    expect(diff.map((item) => item.id)).toEqual(["a"]);
    expect(diff.clashes).toEqual([]);
    // the agent also moved b: both changed b
    const clash = editDifference(
      current,
      [el("a", { x: 5 }), el("b", { x: 3 })],
      read
    );
    expect(clash.clashes).toEqual(["b"]);
    // a layer move alone is a change
    expect(
      editDifference([el("a", { index: "a1" })], [el("a", { index: "a3" })])
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
  });
});

describe("agent edits with restored arrow geometry", () => {
  const arrow = () => el("arrow", { type: "arrow", height: 45, width: 420, points: [[0, 0], [25, 0], [25, -65], [420, -65], [420, -30]] });

  it("does not let an unrelated inconsistent arrow block an edit", () => {
    const raw = arrow();
    const diff = editDifference([raw, el("box")], [{ ...raw, height: 65 }, el("box", { x: 20 })], [raw, el("box")]);
    expect(diff.clashes).toEqual([]);
    expect(diff.map((item) => item.id)).toEqual(["box"]);
  });

  it("allows editing the arrow across derived geometry and binding repairs", () => {
    const raw = arrow();
    const diff = editDifference([raw], [{ ...raw, height: 65, strokeColor: "red", boundElements: [{ id: "label", type: "text" }] }], [{ ...raw, height: 65, version: 7 }]);
    expect(diff.clashes).toEqual([]);
    expect(diff[0].strokeColor).toBe("red");
  });

  it("reports real concurrent fields and supports explicit overwrite", () => {
    const base = [arrow()];
    const current = [{ ...base[0], x: 40 }];
    const next = [{ ...base[0], strokeColor: "red" }];
    const diff = editDifference(current, next, base);
    expect(diff.clashes).toEqual(["arrow"]);
    expect(diff.conflictFields.arrow).toEqual(["x"]);
    const forced = editDifference(current, next, base, true);
    expect(forced.clashes).toEqual([]);
    expect(forced[0].strokeColor).toBe("red");
  });
});
