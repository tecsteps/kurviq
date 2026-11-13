// A commenter's comments (scenes-plugin/src/comments/mailboxRules.ts): how
// they travel in a Drive comment, how an editor's Kurviq checks them, who
// wrote a Drive comment.
import { describe, expect, it } from "vitest";

import { authorKey } from "../../scenes-mcp/sceneComments.mjs";
import {
  MAILBOX_MARK,
  MAILBOX_MAX,
  checkCommenterOps,
  mailboxAuthor,
  mailboxText,
  readMailbox,
  stillWaiting,
} from "../src/comments/mailboxRules";

import type { SceneComment } from "../../scenes-mcp/sceneComments.mjs";

const BOB = { name: "Bob Example", key: "b0b0b0b0b0b0b0b0" };
const ANNA = { name: "Anna", key: "a1a1a1a1a1a1a1a1" };

const thread = (id: string, by = ANNA, extra: Partial<SceneComment> = {}): SceneComment => ({
  id,
  thread: id,
  by,
  text: "Looks good",
  at: 1000,
  u: 1000,
  pin: { x: 10, y: 20 },
  ...extra,
});

describe("the mailbox: Kurviq comments in a Drive comment", () => {
  it("carries comments after its mark and reads them back, checked", () => {
    const comment = thread("comment01", BOB);
    const text = mailboxText([comment]);
    expect(text).toContain(MAILBOX_MARK);
    expect(text.startsWith("A comment on this Kurviq scene")).toBe(true);
    expect(readMailbox(text)).toEqual([comment]);
  });

  it("refuses a comment too long for a Drive comment", () => {
    const long = thread("comment01", BOB, { text: "x".repeat(MAILBOX_MAX) });
    expect(() => mailboxText([long, { ...long, id: "comment02", thread: "comment02" }])).toThrow(/too long/);
  });

  it("ignores Drive comments that carry no (valid) Kurviq comments", () => {
    expect(readMailbox("Nice drawing!")).toBeNull();
    expect(readMailbox(undefined)).toBeNull();
    expect(readMailbox(`${MAILBOX_MARK}{"not":"a list"}`)).toBeNull();
    expect(readMailbox(`${MAILBOX_MARK}[]`)).toBeNull();
    expect(readMailbox(`${MAILBOX_MARK}[{"id":"x"}]`)).toBeNull();
    expect(readMailbox(`${MAILBOX_MARK}[broken`)).toBeNull();
  });
});

describe("an editor's Kurviq checks a commenter's comments (commenterRefusal)", () => {
  it("takes the commenter's own new comment, under the name the editor's side knows", () => {
    const result = checkCommenterOps([], [thread("comment01", { name: "Bobby", key: BOB.key })], BOB);
    expect(result).toEqual({ comments: [thread("comment01", BOB)] });
  });

  it("refuses a new comment in someone else's name", () => {
    expect(checkCommenterOps([], [thread("comment01", ANNA)], BOB)).toEqual({ refused: "a new comment must be the commenter's own" });
  });

  it("refuses changing someone else's text, allows resolving their thread", () => {
    const anna = thread("comment01", ANNA);
    const edited = { ...anna, text: "Changed by Bob", u: 2000 };
    expect(checkCommenterOps([anna], [edited], BOB)).toEqual({ refused: expect.stringMatching(/only the author/) });
    const resolved = { ...anna, done: { name: "Bob Example", at: 2000 }, u: 2000 };
    expect(checkCommenterOps([anna], [resolved], BOB)).toEqual({ comments: [resolved] });
  });

  it("is all or nothing, and checks each change against the ones before it", () => {
    const own = thread("comment01", BOB);
    const reply = { ...thread("comment02", BOB), thread: "comment01", pin: undefined };
    const foreign = thread("comment03", ANNA);
    expect(checkCommenterOps([], [own, foreign], BOB)).toHaveProperty("refused");
    const ok = checkCommenterOps([], [own, { ...own, text: "Edited", edited: 1500, u: 1500 }, reply], BOB);
    expect("comments" in ok && ok.comments.map((comment) => comment.text)).toEqual(["Looks good", "Edited", "Looks good"]);
  });

  it("refuses what isn't a comment, or nothing at all", () => {
    expect(checkCommenterOps([], [{ id: "x" }], BOB)).toEqual({ refused: "not a comment" });
    expect(checkCommenterOps([], [], BOB)).toEqual({ refused: "no comments" });
  });
});

describe("who wrote a Drive comment", () => {
  const people = [
    { type: "user", emailAddress: "Bob@Example.test", displayName: "Bob Example" },
    { type: "user", emailAddress: "anna@example.test", displayName: "Anna" },
    { type: "user", emailAddress: "anna2@example.test", displayName: "Anna" },
    { type: "anyone" },
  ];

  it("is the address Drive gives, else the one person of that name", async () => {
    expect(await mailboxAuthor({ displayName: "Bob Example", emailAddress: "BOB@example.test" }, [])).toEqual({
      name: "Bob Example",
      email: "bob@example.test",
      key: await authorKey("bob@example.test"),
    });
    expect(await mailboxAuthor({ displayName: "Bob Example" }, people)).toEqual({
      name: "Bob Example",
      email: "bob@example.test",
      key: await authorKey("bob@example.test"),
    });
  });

  it("is not known when several people (or nobody) have that name", async () => {
    expect(await mailboxAuthor({ displayName: "Anna" }, people)).toBeNull();
    expect(await mailboxAuthor({ displayName: "Carol" }, people)).toBeNull();
    expect(await mailboxAuthor(undefined, people)).toBeNull();
  });
});

describe("the commenter's comments still waiting for an editor", () => {
  it("are those the file has in no version as new as theirs", () => {
    const waiting = [thread("comment01", BOB, { u: 2000 }), thread("comment02", BOB, { u: 2000 }), thread("comment03", BOB)];
    const inFile = [thread("comment01", BOB, { u: 2000 }), thread("comment02", BOB, { u: 1000 })];
    expect(stillWaiting(waiting, inFile).map((comment) => comment.id)).toEqual(["comment02", "comment03"]);
  });
});
