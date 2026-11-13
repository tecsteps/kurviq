// Shared folders without anything on Kurviq's server
// (scenes-plugin/src/online/folderAccess.ts): what the person a folder is
// shared with sees, from what they picked in Google's Picker.
import { describe, expect, it } from "vitest";

import { folderCountOf, groupSharedFolders, unseenText } from "../src/online/folderAccess";
import type { PickedFolder, VisibleScene } from "../src/online/folderAccess";

const FOLDER: PickedFolder = { id: "folderAnna01", name: "Kurviq", owner: "Anna", ownerEmail: "anna@example.test", canEdit: true, count: 3 };

const scene = (fileId: string, name: string, parents: string[], extra: Partial<VisibleScene> = {}): VisibleScene => ({
  fileId,
  name,
  parents,
  owner: "Anna",
  ownerEmail: "anna@example.test",
  canEdit: false,
  modifiedTime: null,
  ...extra,
});

describe("the owner's noted scene count", () => {
  it("is a whole number, else not known", () => {
    expect(folderCountOf({ kurviqScenes: "12" })).toBe(12);
    expect(folderCountOf({ kurviqScenes: "-1" })).toBeNull();
    expect(folderCountOf({ kurviqScenes: "x" })).toBeNull();
    expect(folderCountOf(undefined)).toBeNull();
  });
});

describe("the scene list's groups of shared folders", () => {
  it("lists a picked folder with the scenes Kurviq may open in it, and how many still need a pick", () => {
    const groups = groupSharedFolders([FOLDER], [scene("sceneB", "Beta", ["folderAnna01"]), scene("sceneA", "Alpha", ["folderAnna01"])]);
    expect(groups).toEqual([
      {
        folderId: "folderAnna01",
        name: "Kurviq",
        owner: "Anna",
        ownerEmail: "anna@example.test",
        role: "writer",
        picked: true,
        unseen: 1,
        scenes: [
          { name: "Alpha", fileId: "sceneA", modifiedTime: null },
          { name: "Beta", fileId: "sceneB", modifiedTime: null },
        ],
      },
    ]);
  });

  it("knows of nothing new when the owner noted no count (or the folder grants all its files)", () => {
    const [group] = groupSharedFolders([{ ...FOLDER, count: null, canEdit: false }], []);
    expect(group).toMatchObject({ unseen: 0, role: "reader", scenes: [] });
    const [all] = groupSharedFolders([FOLDER], ["a", "b", "c", "d"].map((id) => scene(id, id, [FOLDER.id])));
    expect(all.unseen).toBe(0);
  });

  it("groups scenes picked out of a folder that wasn't picked as \"<owner>'s folder\"", () => {
    const groups = groupSharedFolders([], [scene("sceneA", "Alpha", ["folderBen01"], { owner: "Ben", canEdit: true })]);
    expect(groups).toEqual([
      expect.objectContaining({ folderId: "folderBen01", name: "Ben's folder", owner: "Ben", picked: false, role: "writer", unseen: 0 }),
    ]);
  });

  it("leaves scenes shared one by one out, unless their folder was picked", () => {
    const single = new Set(["sceneA", "sceneB"]);
    const groups = groupSharedFolders([FOLDER], [scene("sceneA", "Alpha", ["folderAnna01"]), scene("sceneB", "Beta", ["folderBen01"])], single);
    expect(groups.map((group) => [group.folderId, group.scenes.map((entry) => entry.name)])).toEqual([["folderAnna01", ["Alpha"]]]);
  });

  it("puts picked folders first, then by owner", () => {
    const groups = groupSharedFolders(
      [{ ...FOLDER, id: "folderZed001", owner: "Zed" }],
      [scene("sceneA", "Alpha", ["folderAmy001"], { owner: "Amy" })],
    );
    expect(groups.map((group) => group.owner)).toEqual(["Zed", "Amy"]);
  });
});

describe("the notice of new scenes", () => {
  it("counts them, or says nothing", () => {
    expect(unseenText(0)).toBeNull();
    expect(unseenText(1)).toBe("1 new scene in this folder");
    expect(unseenText(3)).toBe("3 new scenes in this folder");
  });
});
