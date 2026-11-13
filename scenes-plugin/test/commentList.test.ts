// The comments list (scenes-plugin/src/comments/listRules.ts, shortcut.ts,
// store.ts) and the copy helper (useCopy.ts): filters and their counts, "hide
// resolved after 7 days", the unread rule, the scene list's counts, Shift+C,
// "waiting for an editor" until the file has the comment.
import { afterEach, describe, expect, it, vi } from "vitest";

import { threadsOf } from "../../scenes-mcp/sceneComments.mjs";
import {
  MAX_SEEN,
  RESOLVED_HIDE_MS,
  cachedCount,
  filterCounts,
  filterThreads,
  handlesOf,
  isUnread,
  markSeen,
  mentionsIn,
  openThreadCount,
  readCountCache,
  readSeen,
  snapshotCount,
} from "../src/comments/listRules";
import { isNewCommentKey, typingIn } from "../src/comments/shortcut";
import { commentStore } from "../src/comments/store";
import { copyText } from "../src/useCopy";

import type { SceneComment } from "../../scenes-mcp/sceneComments.mjs";
import type { Seen, Viewer } from "../src/comments/listRules";

const ANN: Viewer = { name: "Ann Lee", key: "aaaaaaaaaaaaaaaa", email: "ann.lee@example.test" };
const BOB: Viewer = { name: "Bob", key: "bbbbbbbbbbbbbbbb", email: "bob@example.test" };
const by = (who: Viewer) => ({ name: who.name, key: who.key });

const NOW = 100 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const root = (id: string, who: Viewer, extra: Partial<SceneComment> = {}): SceneComment => ({
  id,
  thread: id,
  by: by(who),
  text: "A note",
  at: 1000,
  u: 1000,
  pin: { x: 1, y: 2 },
  ...extra,
});
const reply = (id: string, thread: string, who: Viewer, extra: Partial<SceneComment> = {}): SceneComment => ({
  id,
  thread,
  by: by(who),
  text: "A reply",
  at: 2000,
  u: 2000,
  ...extra,
});

// open by Ann; open by Bob mentioning Ann; resolved yesterday by Bob with Ann's reply; resolved 8 days ago by Bob
const comments = [
  root("thread01", ANN),
  root("thread02", BOB, { text: "@AnnLee what do you think?" }),
  root("thread03", BOB, { done: { name: "Bob", at: NOW - DAY } }),
  reply("reply031", "thread03", ANN),
  root("thread04", BOB, { done: { name: "Bob", at: NOW - 8 * DAY } }),
];
const threads = threadsOf(comments);
const ids = (list: { id: string }[]) => list.map((thread) => thread.id);

describe("the list's filters", () => {
  const options = { me: ANN, hideOldResolved: false, now: NOW };

  it("show exactly their threads", () => {
    expect(ids(filterThreads(threads, "open", options))).toEqual(["thread01", "thread02"]);
    expect(ids(filterThreads(threads, "resolved", options))).toEqual(["thread03", "thread04"]);
    expect(ids(filterThreads(threads, "mine", options))).toEqual(["thread01", "thread03"]);
    expect(ids(filterThreads(threads, "mentions", options))).toEqual(["thread02"]);
  });

  it("count what they show", () => {
    expect(filterCounts(threads, options)).toEqual({ open: 2, resolved: 2, mine: 2, mentions: 1 });
    expect(filterCounts(threads, { ...options, me: BOB })).toEqual({ open: 2, resolved: 2, mine: 3, mentions: 0 });
  });

  it("without a person: nothing is theirs or mentions them", () => {
    expect(filterCounts(threads, { ...options, me: null })).toEqual({ open: 2, resolved: 2, mine: 0, mentions: 0 });
  });

  it("a deleted comment is not theirs any more, a deleted mention mentions nobody", () => {
    const gone = threadsOf([root("thread01", ANN, { gone: true, text: "" }), reply("reply011", "thread01", BOB, { text: "@Ann" })]);
    expect(filterThreads(gone, "mine", options)).toEqual([]);
    expect(ids(filterThreads(gone, "mentions", options))).toEqual(["thread01"]);
    const unmentioned = threadsOf([root("thread01", BOB), reply("reply011", "thread01", BOB, { text: "", gone: true })]);
    expect(filterThreads(unmentioned, "mentions", options)).toEqual([]);
  });
});

describe("hide resolved after 7 days", () => {
  it("hides threads resolved more than 7 days ago, in every filter; off shows them", () => {
    const options = { me: ANN, hideOldResolved: true, now: NOW };
    expect(ids(filterThreads(threads, "resolved", options))).toEqual(["thread03"]);
    expect(filterCounts(threads, options)).toEqual({ open: 2, resolved: 1, mine: 2, mentions: 1 });
    expect(filterCounts(threads, { me: BOB, hideOldResolved: true, now: NOW }).mine).toBe(2);
    expect(ids(filterThreads(threads, "resolved", { ...options, hideOldResolved: false }))).toEqual(["thread03", "thread04"]);
  });

  it("counts from when it was resolved, not when it was written", () => {
    const old = threadsOf([root("thread05", BOB, { at: 1, u: 1, done: { name: "Bob", at: NOW - RESOLVED_HIDE_MS + 1000 } })]);
    expect(filterThreads(old, "resolved", { me: ANN, hideOldResolved: true, now: NOW })).toHaveLength(1);
    expect(filterThreads(old, "resolved", { me: ANN, hideOldResolved: true, now: NOW + 2000 })).toHaveLength(0);
  });
});

describe("mentions", () => {
  it("match the full name as suggested, the first name and the address", () => {
    expect([...handlesOf(ANN)]).toEqual(["annlee", "ann", "ann.lee"]);
    expect(mentionsIn("hi @AnnLee, and @ann. and @Ann.Lee!")).toEqual(["annlee", "ann", "ann.lee"]);
  });

  it("not someone else's name that starts the same", () => {
    const other = threadsOf([root("thread01", BOB, { text: "@Annabel look" })]);
    expect(filterThreads(other, "mentions", { me: ANN, hideOldResolved: false, now: NOW })).toEqual([]);
  });
});

describe("unread (per browser)", () => {
  const seen: Seen = { since: 500, threads: {} };
  const [thread01, thread02, thread03] = threads;

  it("a thread with others' comments since this browser keeps track is unread; one's own comments never", () => {
    expect(isUnread(thread02, ANN, seen)).toBe(true);
    expect(isUnread(thread01, ANN, seen)).toBe(false);
    expect(isUnread(thread01, ANN, { since: 5000, threads: {} })).toBe(false);
    expect(isUnread(thread02, ANN, { since: 5000, threads: {} })).toBe(false);
  });

  it("opening it clears the dot; a new reply by someone else brings it back, one's own doesn't", () => {
    const opened = markSeen(seen, thread02);
    expect(isUnread(thread02, ANN, opened)).toBe(false);
    const [withReply] = threadsOf([root("thread02", BOB), reply("reply021", "thread02", BOB, { at: 3000, u: 3000 })]);
    expect(isUnread(withReply, ANN, opened)).toBe(true);
    const [ownReply] = threadsOf([root("thread02", BOB), reply("reply021", "thread02", ANN, { at: 3000, u: 3000 })]);
    expect(isUnread(ownReply, ANN, opened)).toBe(false);
  });

  it("marking a seen thread again changes nothing (same object)", () => {
    const opened = markSeen(seen, thread03);
    expect(markSeen(opened, thread03)).toBe(opened);
  });

  it("keeps at most MAX_SEEN threads, dropping the oldest seen", () => {
    const many: Seen = { since: 0, threads: Object.fromEntries(Array.from({ length: MAX_SEEN }, (_, i) => [`t${i}`, i + 10])) };
    const next = markSeen(many, thread02);
    expect(Object.keys(next.threads)).toHaveLength(MAX_SEEN);
    expect(next.threads.t0).toBeUndefined();
    expect(next.threads.thread02).toBe(1000);
  });

  it("reads what was stored, or starts fresh from now", () => {
    expect(readSeen(null, 42)).toEqual({ since: 42, threads: {} });
    expect(readSeen({ since: "x" }, 42)).toEqual({ since: 42, threads: {} });
    expect(readSeen({ since: 7, threads: { a: 1, b: "no", c: Number.NaN } }, 42)).toEqual({ since: 7, threads: { a: 1 } });
  });
});

describe("the scene list's counts", () => {
  const json = (list: unknown) => JSON.stringify({ type: "excalidraw", elements: [], kurviqComments: list });

  it("open threads only", () => {
    expect(openThreadCount(comments)).toBe(2);
    expect(openThreadCount(undefined)).toBe(0);
  });

  it("from a stored copy: none without comments, none from broken JSON", () => {
    expect(snapshotCount({ json: json(comments), baseline: 1, dirty: false })).toBe(2);
    expect(snapshotCount({ json: '{"elements":[]}', baseline: 1, dirty: false })).toBe(0);
    expect(snapshotCount({ json: '{"kurviqComments": [', baseline: 1, dirty: false })).toBe(0);
  });

  it("counted again only when the stored copy changed", () => {
    const cache = readCountCache({ broken: { sig: 1 }, other: { sig: "x", n: 4 } });
    expect(cache).toEqual({ other: { sig: "x", n: 4 } });
    const snapshot = { json: json(comments), baseline: 1, dirty: false };
    expect(cachedCount(cache, "A", snapshot)).toBe(2);
    // the same signature: the cache answers (here on purpose wrong, to see it is used)
    cache.A.n = 9;
    expect(cachedCount(cache, "A", snapshot)).toBe(9);
    expect(cachedCount(cache, "A", { ...snapshot, dirty: true })).toBe(2);
  });
});

describe("Shift+C", () => {
  const key = (extra: Partial<Parameters<typeof isNewCommentKey>[0]> = {}) => ({ key: "C", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, ...extra });

  it("starts a new comment, with CapsLock too; no other modifier, no repeat", () => {
    expect(isNewCommentKey(key())).toBe(true);
    expect(isNewCommentKey(key({ key: "c" }))).toBe(true);
    expect(isNewCommentKey(key({ shiftKey: false, key: "c" }))).toBe(false);
    expect(isNewCommentKey(key({ altKey: true }))).toBe(false); // Excalidraw: copy as PNG
    expect(isNewCommentKey(key({ ctrlKey: true }))).toBe(false);
    expect(isNewCommentKey(key({ metaKey: true }))).toBe(false);
    expect(isNewCommentKey(key({ repeat: true }))).toBe(false);
    expect(isNewCommentKey(key({ isComposing: true }))).toBe(false);
  });

  it("not while typing: text fields, text areas, selects, rich text", () => {
    expect(typingIn({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingIn({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingIn({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(typingIn({ tagName: "INPUT" })).toBe(true);
    expect(typingIn({ tagName: "SELECT" })).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingIn({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typingIn({ tagName: "CANVAS" })).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});

describe("waiting for an editor", () => {
  const mine = root("thread09", ANN, { at: 5000, u: 5000 });

  it("until a load of the file has the comment (that version or newer)", () => {
    commentStore.setViewerActive(true);
    commentStore.load([mine], "viewer");
    commentStore.replacePending([mine]);
    expect(commentStore.isPending(mine)).toBe(true);
    // a load without it: still waiting
    commentStore.load([], "viewer");
    expect(commentStore.isPending(mine)).toBe(true);
    // an older version in the file: still waiting
    commentStore.fromLive([{ ...mine, u: 4000, at: 4000 }], "viewer");
    expect(commentStore.isPending(mine)).toBe(true);
    commentStore.fromLive([mine], "viewer");
    expect(commentStore.isPending(mine)).toBe(false);
    commentStore.setViewerActive(false);
  });

  it("tells its followers when it stops waiting, even if the list didn't change", () => {
    commentStore.setViewerActive(true);
    commentStore.load([mine], "viewer");
    commentStore.replacePending([mine]);
    const listener = vi.fn();
    const off = commentStore.subscribe(listener);
    commentStore.load([mine], "viewer");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(commentStore.isPending(mine)).toBe(false);
    off();
    commentStore.setViewerActive(false);
  });
});

describe("copy to clipboard (one helper)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers whether it worked, never throws", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyText("hello")).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyText("hello")).toBe(false);
  });
});
