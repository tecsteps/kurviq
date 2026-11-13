import { describe, expect, it } from "vitest";

import { linkTargetOf } from "../src/online/linkTarget";

import type { LinkFolder } from "../src/online/linkTarget";

const folder = (folderId: string, names: string[], role: "writer" | "reader" = "writer"): LinkFolder => ({
  folderId,
  role,
  scenes: names.map((name) => ({ name })),
});

describe("linkTargetOf: where a scene link goes when the tab has no scene of that name", () => {
  it("a shared folder with that scene", () => {
    expect(linkTargetOf("Madsack - Accounting", [folder("a", ["Other"]), folder("b", ["Madsack - Accounting"])], [], null)).toEqual({
      kind: "folder",
      folderId: "b",
    });
  });

  it("nowhere: a new scene (names match exactly)", () => {
    expect(linkTargetOf("Plan", [folder("a", ["plan", "Plan 2"])], [], null)).toBeNull();
    expect(linkTargetOf("Plan", [], [], null)).toBeNull();
  });

  it("several folders: one the user may edit first, else the first", () => {
    expect(linkTargetOf("X", [folder("r", ["X"], "reader"), folder("w", ["X"])], [], null)).toEqual({ kind: "folder", folderId: "w" });
    expect(linkTargetOf("X", [folder("r1", ["X"], "reader"), folder("r2", ["X"], "reader")], [], null)).toEqual({ kind: "folder", folderId: "r1" });
  });

  it("from a folder's tab: the user's own scenes first, never the folder it shows", () => {
    expect(linkTargetOf("Mine", [folder("other", ["Mine"])], ["Mine"], "here")).toEqual({ kind: "own" });
    expect(linkTargetOf("X", [folder("here", ["X"]), folder("other", ["X"])], [], "here")).toEqual({ kind: "folder", folderId: "other" });
    expect(linkTargetOf("X", [folder("here", ["X"])], [], "here")).toBeNull();
  });

  it("a scene shared on its own (opened in Kurviq once): before folders, one the user may edit first", () => {
    const files = [
      { fileId: "view", name: "AnotherTmpScene", canEdit: false },
      { fileId: "edit", name: "AnotherTmpScene", canEdit: true },
      { fileId: "other", name: "Other", canEdit: true },
    ];
    expect(linkTargetOf("AnotherTmpScene", [folder("f", ["AnotherTmpScene"])], [], null, files)).toEqual({ kind: "file", fileId: "edit" });
    expect(linkTargetOf("AnotherTmpScene", [], [], null, files.slice(0, 1))).toEqual({ kind: "file", fileId: "view" });
    expect(linkTargetOf("anothertmpscene", [], [], null, files)).toBeNull();
  });

  it("from a folder's tab the user's own scene still wins over a shared one", () => {
    expect(linkTargetOf("Mine", [], ["Mine"], "here", [{ fileId: "x", name: "Mine", canEdit: true }])).toEqual({ kind: "own" });
  });

  it("own names count only from a folder's tab (in the own space they are the tab's)", () => {
    expect(linkTargetOf("Mine", [], ["Mine"], null)).toBeNull();
  });
});
