// The fake Google's files.list query language (online/worker/fakeGoogleQuery.ts):
// the queries Kurviq sends work, anything else is refused.
import { describe, expect, it } from "vitest";

import { parseQuery, splitTerms } from "../../online/worker/fakeGoogleQuery";

const me = { email: "alice@example.test", root: "rootA" };
const file = (over: Record<string, unknown> = {}) => ({
  parents: JSON.stringify(["folder1"]),
  trashed: 0,
  name: "Plan.excalidraw",
  mime: "application/vnd.excalidraw+json",
  owner: "alice@example.test",
  app_props: JSON.stringify({ kurviqRoot: "1" }),
  ...over,
});

describe("fake Google queries", () => {
  it("splits at and, not inside quotes or braces", () => {
    expect(splitTerms("appProperties has { key='a' and value='b' } and trashed=false")).toEqual([
      "appProperties has { key='a' and value='b' }",
      "trashed=false",
    ]);
    expect(splitTerms("name = 'cats and dogs' and trashed=false")).toEqual(["name = 'cats and dogs'", "trashed=false"]);
  });

  it("answers the app's queries", () => {
    const inFolder = parseQuery("'folder1' in parents and trashed=false");
    expect(inFolder(file(), me)).toBe(true);
    expect(inFolder(file({ trashed: 1 }), me)).toBe(false);
    expect(inFolder(file({ parents: JSON.stringify(["other"]) }), me)).toBe(false);

    const root = parseQuery("appProperties has { key='kurviqRoot' and value='1' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
    expect(root(file({ mime: "application/vnd.google-apps.folder" }), me)).toBe(true);
    expect(root(file({ mime: "application/vnd.google-apps.folder", app_props: "{}" }), me)).toBe(false);

    const shared = parseQuery("sharedWithMe and trashed=false and mimeType='application/vnd.excalidraw+json'");
    expect(shared(file({ owner: "bob@example.test" }), me)).toBe(true);
    expect(shared(file(), me)).toBe(false);

    // others' files Kurviq may open (the shared folders' listing)
    const others = parseQuery("mimeType='application/vnd.google-apps.folder' and not 'me' in owners and trashed=false");
    expect(others(file({ owner: "bob@example.test", mime: "application/vnd.google-apps.folder" }), me)).toBe(true);
    expect(others(file({ mime: "application/vnd.google-apps.folder" }), me)).toBe(false);

    expect(parseQuery("'root' in parents")(file({ parents: JSON.stringify(["rootA"]) }), me)).toBe(true);
    expect(parseQuery(String.raw`name = 'Bob\'s plan'`)(file({ name: "Bob's plan" }), me)).toBe(true);
  });

  it("refuses what it does not implement", () => {
    expect(() => parseQuery("name contains 'x'")).toThrow(/not supported/);
    expect(() => parseQuery("trashed=false or starred=true")).toThrow(/not supported/);
    expect(() => parseQuery("modifiedTime > '2026-01-01'")).toThrow(/not supported/);
  });
});
