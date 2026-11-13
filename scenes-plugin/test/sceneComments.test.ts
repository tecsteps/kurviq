import { describe, expect, it } from "vitest";

import {
  applyCommentOps,
  authorKey,
  cleanComment,
  commentReadable,
  commenterReadableRefusal,
  commentsForAgents,
  readableMatches,
  sha256Fallback,
  commenterRefusal,
  commentsKey,
  commentsOf,
  mergeComments,
  pinPosition,
  threadsOf,
  withComments,
} from "../../scenes-mcp/sceneComments.mjs";

const ann = { name: "Ann", key: "aaaaaaaaaaaaaaaa" };
const bob = { name: "Bob", key: "bbbbbbbbbbbbbbbb" };

const root = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  thread: id,
  by: ann,
  text: "Why orange?",
  at: 100,
  u: 100,
  pin: { x: 10, y: 20, el: "rect", dx: 5, dy: -3 },
  ...extra,
});
const reply = (id: string, thread: string, extra: Record<string, unknown> = {}) => ({ id, thread, by: bob, text: "Brand color", at: 200, u: 200, ...extra });

describe("stored comments are checked value by value", () => {
  it("keeps a valid thread and reply, cleans text and names", () => {
    expect(cleanComment(root("thread01", { text: "  a\r\nb\u0007  " }))).toEqual({ ...root("thread01"), text: "a\nb" });
    expect(cleanComment(reply("reply001", "thread01"))).toEqual(reply("reply001", "thread01"));
  });

  it("drops what isn't a comment: bad ids, no author key, empty text, a thread without a place", () => {
    expect(cleanComment({ ...root("x"), id: "x" })).toBeNull();
    expect(cleanComment(root("thread01", { by: { name: "Ann", key: "ann@example.com" } }))).toBeNull();
    expect(cleanComment(root("thread01", { text: "   " }))).toBeNull();
    expect(cleanComment(root("thread01", { pin: undefined }))).toBeNull();
    expect(cleanComment("nope")).toBeNull();
  });

  it("a deletion keeps an empty tombstone; no email or other fields survive", () => {
    expect(cleanComment(root("thread01", { gone: true, text: "secret", email: "ann@example.com" }))).toEqual({ ...root("thread01"), text: "", gone: true });
  });

  it("one entry per id (the newest), oldest first", () => {
    const list = commentsOf([reply("reply001", "thread01"), root("thread01"), root("thread01", { text: "Edited", u: 300 })]);
    expect(list.map((comment) => [comment.id, comment.text])).toEqual([["thread01", "Edited"], ["reply001", "Brand color"]]);
  });
});

describe("merging two versions of a scene's comments", () => {
  it("keeps everything both sides added, and the newer version of each", () => {
    const mine = [root("thread01"), reply("reply001", "thread01")];
    const theirs = [root("thread01", { done: { name: "Bob", at: 400 }, u: 400 }), reply("reply002", "thread01", { at: 300, u: 300 })];
    const merged = mergeComments(mine, theirs)!;
    expect(merged.map((comment) => comment.id)).toEqual(["thread01", "reply001", "reply002"]);
    expect(merged[0].done).toEqual({ name: "Bob", at: 400 });
  });

  it("a deletion can't come back through an older copy, and wins a tie", () => {
    const deleted = reply("reply001", "thread01", { gone: true, u: 500 });
    expect(mergeComments([deleted], [reply("reply001", "thread01")])![0].gone).toBe(true);
    expect(mergeComments([reply("reply001", "thread01", { u: 500 })], [deleted])![0].gone).toBe(true);
  });

  it("nothing on either side: no field", () => {
    expect(mergeComments(undefined, [])).toBeUndefined();
  });

  it("the key changes with every change, not with order", () => {
    expect(commentsKey([root("thread01"), reply("reply001", "thread01")])).toBe(commentsKey([reply("reply001", "thread01"), root("thread01")]));
    expect(commentsKey([root("thread01")])).not.toBe(commentsKey([root("thread01", { u: 101 })]));
  });
});

describe("threads", () => {
  it("groups replies under their thread, resolved and deleted ones as such", () => {
    const threads = threadsOf([
      root("thread01", { done: { name: "Bob", at: 300 } }),
      reply("reply001", "thread01"),
      reply("reply002", "thread01", { gone: true }),
      root("thread02", { at: 50, u: 50 }),
    ]);
    expect(threads.map((thread) => [thread.id, thread.replies.length, thread.resolved])).toEqual([
      ["thread02", 0, false],
      ["thread01", 1, true],
    ]);
  });

  it("a deleted first comment stays while replies remain; with none left the thread is gone", () => {
    expect(threadsOf([root("thread01", { gone: true }), reply("reply001", "thread01")]).length).toBe(1);
    expect(threadsOf([root("thread01", { gone: true })]).length).toBe(0);
  });
});

describe("pins", () => {
  const pin = { x: 10, y: 20, el: "rect", dx: 5, dy: -3 };
  it("follow their element", () => {
    expect(pinPosition(pin, new Map([["rect", { x: 100, y: 200 }]]))).toEqual({ x: 105, y: 197, detached: false });
  });
  it("stay at their last place when the element is gone", () => {
    expect(pinPosition(pin, new Map([["rect", { x: 100, y: 200, isDeleted: true }]]))).toEqual({ x: 10, y: 20, detached: true });
    expect(pinPosition({ x: 1, y: 2 }, new Map())).toEqual({ x: 1, y: 2, detached: false });
  });
});

describe("in the scene file", () => {
  it("a top-level field after the scene's own; none: unchanged", () => {
    const json = JSON.stringify({ type: "excalidraw", elements: [] }, null, 2);
    expect(JSON.parse(withComments(json, [root("thread01")])).kurviqComments).toEqual([root("thread01")]);
    expect(withComments(json, [])).toBe(json);
  });

  it("the SHA-256 fallback (pages without Web Crypto) equals Web Crypto's", async () => {
    for (const text of ["", "abc", "kurviq-comment:ann@example.com", "x".repeat(200)]) {
      const bytes = new TextEncoder().encode(text);
      const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      expect(Array.from(sha256Fallback(bytes))).toEqual(Array.from(expected));
    }
  });

  it("the author key is a hash of the address, the same for any spelling of it", async () => {
    const key = await authorKey("Ann@Example.com ");
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(await authorKey("ann@example.com")).toBe(key);
    expect(await authorKey("bob@example.com")).not.toBe(key);
  });
});

describe("what a commenter may change", () => {
  const mine = cleanComment(reply("reply001", "thread01"))!;
  it("their own new comments; not in someone else's name", () => {
    expect(commenterRefusal(null, mine, bob.key)).toBeNull();
    expect(commenterRefusal(null, mine, ann.key)).toMatch(/own/);
  });
  it("edit and delete only their own", () => {
    const edited = { ...mine, text: "Changed", u: 300 };
    expect(commenterRefusal(mine, edited, bob.key)).toBeNull();
    expect(commenterRefusal(mine, edited, ann.key)).toMatch(/author/);
    expect(commenterRefusal(mine, { ...mine, gone: true as const, text: "", u: 300 }, ann.key)).toMatch(/author/);
  });
  it("resolve and reopen any thread, but not move someone else's pin or rewrite history", () => {
    const thread = cleanComment(root("thread01"))!;
    expect(commenterRefusal(thread, { ...thread, done: { name: "Bob", at: 300 }, u: 300 }, bob.key)).toBeNull();
    expect(commenterRefusal(thread, { ...thread, pin: { x: 0, y: 0 }, u: 300 }, bob.key)).toMatch(/pin/);
    expect(commenterRefusal(thread, { ...thread, by: bob, u: 300 }, bob.key)).toMatch(/author/);
  });
});

describe("agents' comment operations", () => {
  const me = { name: "Fabian", key: "cccccccccccccccc" };
  const elements = new Map([["box", { id: "box", x: 100, y: 50, width: 80 }]]);

  it("add on an element, reply, resolve, reopen: in order, as the agent of the signed-in person", async () => {
    const first = applyCommentOps([], [{ action: "add", text: "Too wide?", element: "box" }], me, elements, 1000);
    const thread = first.added[0];
    expect(first.comments[0]).toMatchObject({ thread, by: { ...me, agent: true }, pin: { el: "box", dx: 88, dy: 0, x: 188, y: 50 } });
    const next = applyCommentOps(first.comments, [
      { action: "reply", thread, text: "Fixed" },
      { action: "resolve", thread },
    ], me, elements, 2000);
    expect(next.changed.map((comment) => comment.id)).toEqual([next.added[0], thread]);
    expect(threadsOf(next.comments)[0]).toMatchObject({ resolved: true, replies: [{ text: "Fixed" }] });
    const reopened = applyCommentOps(next.comments, [{ action: "reopen", thread }], me, elements, 3000);
    expect(threadsOf(reopened.comments)[0].resolved).toBe(false);
  });

  it("edits and deletes only its own; invalid operations change nothing", () => {
    const theirs = [cleanComment(root("thread01"))!];
    expect(() => applyCommentOps(theirs, [{ action: "edit", id: "thread01", text: "x" }], me, elements)).toThrow(/Ann's/);
    expect(() => applyCommentOps(theirs, [{ action: "reply", thread: "nope00", text: "x" }], me, elements)).toThrow(/no thread/);
    expect(() => applyCommentOps(theirs, [{ action: "add", text: "x", element: "gone" }], me, elements)).toThrow(/no element/);
    expect(() => applyCommentOps(theirs, [{ action: "add", text: "  " }], me, elements)).toThrow(/not valid/);
    const mine = applyCommentOps(theirs, [{ action: "add", text: "Mine", x: 5, y: 6 }], me, elements, 1000);
    const deleted = applyCommentOps(mine.comments, [{ action: "delete", id: mine.added[0] }], me, elements, 2000);
    expect(threadsOf(deleted.comments).map((thread) => thread.id)).toEqual(["thread01"]);
  });

  it("agents read threads with the element they are about", () => {
    const list = applyCommentOps([], [{ action: "add", text: "Here", element: "box" }], me, elements, 1000).comments;
    expect(commentsForAgents(list, elements)).toEqual([
      expect.objectContaining({ element: "box", x: 188, y: 50, comments: [expect.objectContaining({ by: "Fabian (agent)", text: "Here" })] }),
    ]);
    expect(commentsForAgents(list, new Map())[0]).toMatchObject({ elementDeleted: true });
  });
});

describe("readable parts (the server's check without the key)", () => {
  const comment = cleanComment(reply("reply001", "thread01"))!;
  it("match only the comment they describe", () => {
    const readable = commentReadable(comment);
    expect(readableMatches(comment, readable)).toBe(true);
    expect(readableMatches({ ...comment, text: "forged" }, readable)).toBe(false);
    expect(readableMatches({ ...comment, by: ann }, readable)).toBe(false);
  });
  it("let a commenter change only what is theirs", () => {
    const before = commentReadable(comment);
    expect(commenterReadableRefusal(null, before, bob.key)).toBeNull();
    expect(commenterReadableRefusal(null, before, ann.key)).toMatch(/own/);
    const edited = commentReadable({ ...comment, text: "Changed", u: 300 });
    expect(commenterReadableRefusal(before, edited, bob.key)).toBeNull();
    expect(commenterReadableRefusal(before, edited, ann.key)).toMatch(/author/);
    const thread = cleanComment(root("thread01"))!;
    expect(commenterReadableRefusal(commentReadable(thread), commentReadable({ ...thread, done: { name: "Bob", at: 1 }, u: 300 }), bob.key)).toBeNull();
  });
});
