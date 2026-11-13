// The share panel's folder note and the scene list's folding groups (pure parts).
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { audienceText, folderAudience, roleRank, rowAccess } from "../src/online/folderAccess";
import { scenesOfMeta } from "../src/storage";
import { GROUPS_KEY, folderGroup, isOpen, ownGroup, ownerDomain, readGroups, toggled } from "../src/sceneGroups";

const owner = { type: "user" as const, role: "owner", emailAddress: "owner@a.com" };
const editor = { type: "user" as const, role: "writer", emailAddress: "Ed@b.com" };
const viewer = { type: "user" as const, role: "reader", emailAddress: "vi@c.com" };
const domain = { type: "domain" as const, role: "reader", domain: "team.com" };

describe("where a person's access comes from", () => {
  it("is the folder's when the folder gives the same role or more (case-insensitive address)", () => {
    expect(rowAccess({ type: "user", role: "writer", emailAddress: "ed@B.com" }, [owner, editor])).toEqual({ kind: "folder" });
    expect(rowAccess({ type: "user", role: "reader", emailAddress: "ed@b.com" }, [owner, editor])).toEqual({ kind: "folder" });
  });

  it("is this scene's own when the folder gives less (then it names the folder's role)", () => {
    expect(rowAccess({ type: "user", role: "writer", emailAddress: "vi@c.com" }, [owner, viewer])).toEqual({ kind: "more", folderRole: "reader" });
  });

  it("is this scene's own for people the folder doesn't know", () => {
    expect(rowAccess({ type: "user", role: "reader", emailAddress: "new@d.com" }, [owner, editor])).toEqual({ kind: "direct" });
    expect(rowAccess({ type: "user", role: "reader", emailAddress: "new@d.com" }, [])).toEqual({ kind: "direct" });
  });

  it("matches domains by domain, never a person by a domain", () => {
    expect(rowAccess({ type: "domain", role: "reader", domain: "TEAM.com" }, [domain])).toEqual({ kind: "folder" });
    expect(rowAccess({ type: "user", role: "reader", emailAddress: "x@team.com" }, [domain])).toEqual({ kind: "direct" });
    expect(rowAccess({ type: "domain", role: "reader" }, [{ type: "domain", role: "reader" }])).toEqual({ kind: "direct" });
  });

  it("is this scene's own when the scene lets someone comment and the folder only view", () => {
    expect(rowAccess({ type: "user", role: "commenter", emailAddress: "vi@c.com" }, [owner, viewer])).toEqual({ kind: "more", folderRole: "reader" });
  });

  it("takes the best of several folder grants", () => {
    const twice = [{ ...editor, role: "reader" }, editor];
    expect(rowAccess({ type: "user", role: "writer", emailAddress: "ed@b.com" }, twice)).toEqual({ kind: "folder" });
  });

  it("ranks roles", () => {
    expect(roleRank("reader")).toBe(1);
    expect(roleRank("commenter")).toBe(2);
    expect(roleRank("writer")).toBe(3);
    expect(roleRank("organizer")).toBe(3);
    expect(roleRank("owner")).toBe(4);
  });
});

describe("the folder note", () => {
  it("is not shown for a folder nobody else has", () => {
    expect(audienceText(folderAudience([owner]))).toBeNull();
  });

  it("says who and what they can do", () => {
    expect(audienceText(folderAudience([owner, editor]))).toEqual({ whom: "1 person", what: "can open and change every scene in it" });
    expect(audienceText(folderAudience([owner, editor, viewer, domain]))).toEqual({ whom: "3 people", what: "can open every scene in it" });
    expect(audienceText(folderAudience([owner, { type: "anyone", role: "reader" }]))).toEqual({
      whom: "anyone with its link",
      what: "can open every scene in it",
    });
    expect(audienceText(folderAudience([owner, viewer, { type: "anyone", role: "reader" }]))?.whom).toBe("1 person and anyone with its link");
  });
});

describe("folding groups of the scene list", () => {
  it("opens this tab's group and folds shared folders by default", () => {
    expect(isOpen({}, ownGroup(null))).toBe(true);
    expect(isOpen({}, ownGroup("f1"))).toBe(true);
    expect(isOpen({}, folderGroup("f1"))).toBe(false);
  });

  it("remembers each group on its own", () => {
    let state = toggled({}, folderGroup("a"));
    state = toggled(state, ownGroup(null));
    expect(isOpen(state, folderGroup("a"))).toBe(true);
    expect(isOpen(state, folderGroup("b"))).toBe(false);
    expect(isOpen(state, ownGroup(null))).toBe(false);
    expect(isOpen(toggled(state, folderGroup("a")), folderGroup("a"))).toBe(false);
    expect(readGroups(JSON.stringify(state))).toEqual(state);
  });

  it("reads broken storage as nothing remembered", () => {
    expect(readGroups(null)).toEqual({});
    expect(readGroups("not json")).toEqual({});
    expect(readGroups("[true]")).toEqual({});
    expect(readGroups('{"own":false,"x":"yes"}')).toEqual({ own: false });
    expect(GROUPS_KEY).toBe("kurviq-scene-groups");
  });
});

describe("a shared folder's group name", () => {
  it("shows the domain of the owner's address", () => {
    expect(ownerDomain("fabian.wesner@Enstoke.com")).toBe("enstoke.com");
    expect(ownerDomain("a@b@c.org")).toBe("c.org");
  });

  it("shows nothing without an address", () => {
    expect(ownerDomain(null)).toBeNull();
    expect(ownerDomain(undefined)).toBeNull();
    expect(ownerDomain("")).toBeNull();
    expect(ownerDomain("@x.com")).toBeNull();
    expect(ownerDomain("nobody")).toBeNull();
  });
});

describe("the user's own scenes, listed from a shared folder's tab", () => {
  it("are the named scenes of the stored list, with where they are", () => {
    const raw = JSON.stringify({
      scenes: {
        "\u0000untitled": { baseMd5: null, dirty: true },
        Roadmap: { baseMd5: "abc", dirty: false },
        Notes: { baseMd5: null, dirty: true, localOnly: true },
        Broken: null,
      },
    });
    expect(scenesOfMeta(raw)).toEqual([
      { name: "Roadmap", localOnly: false, inDrive: true },
      { name: "Notes", localOnly: true, inDrive: false },
    ]);
  });

  it("are none for nothing stored or broken storage", () => {
    expect(scenesOfMeta(null)).toEqual([]);
    expect(scenesOfMeta("nope")).toEqual([]);
    expect(scenesOfMeta('{"scenes":5}')).toEqual([]);
  });
});
