// The rules of the comments list (./ui.tsx), without the browser: its filters
// (open, resolved, mine, mentioning me) with their counts, "hide resolved
// after 7 days", the unread dot (per browser: thread id → what was seen) and
// the number of open threads of a scene (the scene list).

import { threadsOf } from "../../../scenes-mcp/sceneComments.mjs";

import type { CommentThread, SceneComment } from "../../../scenes-mcp/sceneComments.mjs";

export type ThreadFilter = "open" | "resolved" | "mine" | "mentions";

export const THREAD_FILTERS: ThreadFilter[] = ["open", "resolved", "mine", "mentions"];

export const isThreadFilter = (value: unknown): value is ThreadFilter => THREAD_FILTERS.includes(value as ThreadFilter);

/** resolved threads older than this are hidden with "hide resolved after 7 days" */
export const RESOLVED_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

/** the person looking: their key (comments carry it), name and address (mentions use them) */
export type Viewer = { key: string; name: string; email: string | null };

export type ListOptions = { me: Viewer | null; hideOldResolved: boolean; now: number };

/** an @mention in a comment's text */
export const MENTION_RE = /@[\p{L}\p{N}][\p{L}\p{M}\p{N}._'-]*/gu;

/** a mention or a name as compared: lower case, no spaces, no trailing punctuation */
const handle = (text: string) => text.toLowerCase().replaceAll(/\s+/g, "").replace(/[._'-]+$/, "");

/** the names a mention of this person may use: the full name (as the suggestions write it), the first name, the address's local part */
export const handlesOf = (me: Pick<Viewer, "name" | "email">) => {
  const first = me.name.trim().split(/\s+/)[0] ?? "";
  const local = me.email?.split("@")[0] ?? "";
  return new Set([handle(me.name), handle(first), handle(local)].filter(Boolean));
};

/** the mentions in a text, as compared */
export const mentionsIn = (text: string) => [...text.matchAll(MENTION_RE)].map((match) => handle(match[0].slice(1)));

const living = (thread: CommentThread): SceneComment[] => [thread.root, ...thread.replies].filter((comment) => !comment.gone);

/** this person started the thread or wrote in it */
export const isMine = (thread: CommentThread, me: Viewer | null) => !!me && living(thread).some((comment) => comment.by.key === me.key);

/** a comment in the thread mentions this person */
export const mentionsMe = (thread: CommentThread, me: Viewer | null) => {
  if (!me) {
    return false;
  }
  const handles = handlesOf(me);
  return living(thread).some((comment) => mentionsIn(comment.text).some((mention) => handles.has(mention)));
};

/** resolved more than 7 days ago */
export const resolvedLongAgo = (thread: CommentThread, now: number) => thread.resolved && !!thread.root.done && now - thread.root.done.at > RESOLVED_HIDE_MS;

const FILTER_TESTS: Record<ThreadFilter, (thread: CommentThread, me: Viewer | null) => boolean> = {
  open: (thread) => !thread.resolved,
  resolved: (thread) => thread.resolved,
  mine: isMine,
  mentions: mentionsMe,
};

/** the threads a filter shows (and pins on the canvas), oldest first */
export const filterThreads = (threads: CommentThread[], filter: ThreadFilter, { me, hideOldResolved, now }: ListOptions) =>
  threads.filter((thread) => FILTER_TESTS[filter](thread, me) && !(hideOldResolved && resolvedLongAgo(thread, now)));

/** how many threads each filter shows */
export const filterCounts = (threads: CommentThread[], options: ListOptions) =>
  Object.fromEntries(THREAD_FILTERS.map((filter) => [filter, filterThreads(threads, filter, options).length])) as Record<ThreadFilter, number>;

/** a scene's open threads (its kurviqComments, or anything else) */
export const openThreadCount = (value: unknown) => threadsOf(value).filter((thread) => !thread.resolved).length;

// a scene's stored copy (../storage.ts Snapshot) in the scene list: counted again only when it changed
export type StoredScene = { json: string; baseline: number | null; dirty: boolean };

export type CountCache = Record<string, { sig: string; n: number }>;

/** a stored copy's version, cheaply (no parse): its length, baseline and dirty flag */
export const snapshotSignature = (snapshot: StoredScene) => `${snapshot.json.length}:${snapshot.baseline}:${snapshot.dirty ? 1 : 0}`;

/** a stored copy's open threads (no parse when it has no comments) */
export const snapshotCount = (snapshot: StoredScene) => {
  if (!snapshot.json.includes('"kurviqComments"')) {
    return 0;
  }
  try {
    return openThreadCount(JSON.parse(snapshot.json).kurviqComments);
  } catch {
    return 0;
  }
};

/** what was stored (anything) as counts */
export const readCountCache = (raw: unknown): CountCache => {
  const out: CountCache = {};
  if (raw && typeof raw === "object") {
    for (const [name, entry] of Object.entries(raw as Record<string, { sig?: unknown; n?: unknown }>)) {
      if (typeof entry?.sig === "string" && typeof entry.n === "number" && Number.isFinite(entry.n)) {
        out[name] = { sig: entry.sig, n: entry.n };
      }
    }
  }
  return out;
};

/** the count of a stored copy: from the cache when it didn't change, else counted (and the cache updated) */
export const cachedCount = (cache: CountCache, name: string, snapshot: StoredScene) => {
  const sig = snapshotSignature(snapshot);
  const known = cache[name];
  if (known?.sig === sig) {
    return known.n;
  }
  const n = snapshotCount(snapshot);
  cache[name] = { sig, n };
  return n;
};

// -----------------------------------------------------------------------------
// unread: per browser, thread id → the newest comment seen there
// -----------------------------------------------------------------------------

/** what this browser has seen: since when it keeps track, and per thread the newest comment's time seen */
export type Seen = { since: number; threads: Record<string, number> };

/** at most this many threads are remembered (the oldest seen go first) */
export const MAX_SEEN = 3000;

/** the newest comment of others in a thread (0: none) */
const newestOfOthers = (thread: CommentThread, me: Viewer | null) =>
  Math.max(0, ...living(thread).filter((comment) => comment.by.key !== me?.key).map((comment) => comment.at));

/**
 * Unread: someone else wrote in the thread since it was last opened here
 * (a thread never opened here: since this browser keeps track).
 */
export const isUnread = (thread: CommentThread, me: Viewer | null, seen: Seen) => newestOfOthers(thread, me) > (seen.threads[thread.id] ?? seen.since);

/** the thread was opened: everything in it is seen (unchanged if it was) */
export const markSeen = (seen: Seen, thread: CommentThread): Seen => {
  const newest = Math.max(...[thread.root, ...thread.replies].map((comment) => comment.at));
  if ((seen.threads[thread.id] ?? -1) >= newest) {
    return seen;
  }
  const threads = { ...seen.threads, [thread.id]: newest };
  const ids = Object.keys(threads);
  if (ids.length > MAX_SEEN) {
    ids
      .sort((a, b) => threads[a] - threads[b])
      .slice(0, ids.length - MAX_SEEN)
      .forEach((id) => delete threads[id]);
  }
  return { since: seen.since, threads };
};

/** what was stored (anything) as Seen; a fresh start (from now) when it isn't */
export const readSeen = (raw: unknown, now: number): Seen => {
  const value = raw as Partial<Seen> | null;
  if (!value || typeof value !== "object" || typeof value.since !== "number" || !value.threads || typeof value.threads !== "object") {
    return { since: now, threads: {} };
  }
  const threads: Record<string, number> = {};
  for (const [id, at] of Object.entries(value.threads)) {
    if (typeof at === "number" && Number.isFinite(at)) {
      threads[id] = at;
    }
  }
  return { since: value.since, threads };
};
