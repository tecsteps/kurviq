// Comments on a scene: threads pinned to an element or a place on the canvas.
// Stored in the scene file itself, as a top-level "kurviqComments" array next
// to the elements (like "kurviqFonts"), so they travel with copies, versions
// and downloads. Shared by the app (scenes-plugin/src/comments), the scene's
// Durable Object (online/worker) and the MCP tools.
//
// A flat list: every comment and every reply is one entry (a thread is its
// first comment plus the replies that name it), so two people replying at the
// same time never touch the same entry. Two versions of a list merge entry by
// entry: the newer change (u) wins. A deleted comment stays as an empty
// tombstone (gone), so a merge with an older copy can't bring it back.
//
// Authors are a name plus a key (authorKey: a hash of their Google address),
// never the address itself: the file can be read by everyone it is shared
// with, and with "anyone with the link" by anyone. The key is a pseudonym,
// not a secret: it is the same in every scene, so someone who guesses an
// address can confirm that its owner commented. It is not salted per scene
// on purpose: a local-only scene has no file id, a scene's id changes when it
// goes to Drive or is copied, and its authors must still own their comments.

import { withTopLevelField } from "./sceneJson.mjs";

export const MAX_COMMENTS = 2000;
export const MAX_TEXT = 5000;
export const MAX_NAME = 100;

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const KEY_RE = /^[a-f0-9]{16}$/;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

const cleanText = (value, max) =>
  typeof value === "string" ? value.replaceAll(/\r\n?/g, "\n").replaceAll(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "";

const cleanPin = (pin) => {
  if (!pin || typeof pin !== "object" || !finite(pin.x) || !finite(pin.y)) {
    return null;
  }
  const clean = { x: Math.round(pin.x * 100) / 100, y: Math.round(pin.y * 100) / 100 };
  if (typeof pin.el === "string" && pin.el.length <= 100 && finite(pin.dx) && finite(pin.dy)) {
    clean.el = pin.el;
    clean.dx = Math.round(pin.dx * 100) / 100;
    clean.dy = Math.round(pin.dy * 100) / 100;
  }
  return clean;
};

const cleanBy = (by) => {
  if (!by || typeof by !== "object" || typeof by.key !== "string" || !KEY_RE.test(by.key)) {
    return null;
  }
  const clean = { name: cleanText(by.name, MAX_NAME) || "Someone", key: by.key };
  if (by.agent === true) {
    clean.agent = true;
  }
  return clean;
};

/**
 * One stored comment, checked value by value (scenes come from anywhere:
 * shared files, agents, other apps); null if it isn't one.
 */
/** a comment's words: its text (a deletion: empty, marked gone); false if a living comment has none */
const cleanBody = (raw, comment) => {
  if (raw.gone === true) {
    comment.gone = true;
    comment.text = "";
    return true;
  }
  comment.text = cleanText(raw.text, MAX_TEXT);
  if (finite(raw.edited)) {
    comment.edited = raw.edited;
  }
  return !!comment.text;
};

/** a thread's first comment: its place and whether it is resolved; false without a place */
const cleanThreadStart = (raw, comment) => {
  const pin = cleanPin(raw.pin);
  if (!pin) {
    return false; // a thread needs its place
  }
  comment.pin = pin;
  if (raw.done && typeof raw.done === "object" && finite(raw.done.at)) {
    comment.done = { name: cleanText(raw.done.name, MAX_NAME) || "Someone", at: raw.done.at };
  }
  return true;
};

export const cleanComment = (raw) => {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    return null;
  }
  const thread = typeof raw.thread === "string" && ID_RE.test(raw.thread) ? raw.thread : raw.id;
  const by = cleanBy(raw.by);
  if (!by || !finite(raw.at) || !finite(raw.u)) {
    return null;
  }
  const comment = { id: raw.id, thread, by, at: raw.at, u: Math.max(raw.u, raw.at) };
  if (!cleanBody(raw, comment) || (thread === raw.id && !cleanThreadStart(raw, comment))) {
    return null;
  }
  return comment;
};

/** a scene's comments (its kurviqComments, or anything else): checked, one per id (the newest), at most MAX_COMMENTS */
export const commentsOf = (value) => {
  const list = Array.isArray(value) ? value : [];
  const byId = new Map();
  for (const raw of list.slice(0, MAX_COMMENTS * 2)) {
    const comment = cleanComment(raw);
    if (comment && (!byId.has(comment.id) || newer(comment, byId.get(comment.id)))) {
      byId.set(comment.id, comment);
    }
  }
  return [...byId.values()].sort(byTime).slice(0, MAX_COMMENTS);
};

const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1);

/** which of two versions of one comment counts: the later change; a deletion wins a tie */
const newer = (a, b) => {
  if (a.u !== b.u) {
    return a.u > b.u;
  }
  if (!!a.gone !== !!b.gone) {
    return !!a.gone;
  }
  return JSON.stringify(a) > JSON.stringify(b);
};

/** two (or more) versions of a scene's comments: every comment, each in its newest version */
export const mergeComments = (...lists) => {
  const byId = new Map();
  for (const list of lists) {
    for (const comment of commentsOf(list)) {
      const known = byId.get(comment.id);
      if (!known || newer(comment, known)) {
        byId.set(comment.id, comment);
      }
    }
  }
  const merged = [...byId.values()].sort(byTime);
  return merged.length ? merged.slice(0, MAX_COMMENTS) : undefined;
};

/** the same comments (for "did anything change"): their ids and versions */
export const commentsKey = (value) =>
  commentsOf(value)
    .map((comment) => `${comment.id}:${comment.u}:${comment.gone ? 1 : 0}`)
    .join(",");

/**
 * Threads, oldest first: the first comment, its replies (oldest first), whether
 * it is resolved. Threads whose first comment was deleted stay while replies
 * remain (shown as "deleted"); a thread with nothing left is gone.
 */
export const threadsOf = (value) => {
  const comments = commentsOf(value);
  const roots = new Map();
  const replies = new Map();
  for (const comment of comments) {
    if (comment.thread === comment.id) {
      roots.set(comment.id, comment);
    } else {
      if (!replies.has(comment.thread)) replies.set(comment.thread, []);
      replies.get(comment.thread).push(comment);
    }
  }
  const threads = [];
  for (const root of roots.values()) {
    const own = (replies.get(root.id) ?? []).filter((reply) => !reply.gone);
    if (root.gone && !own.length) {
      continue;
    }
    threads.push({ id: root.id, root, replies: own, resolved: !!root.done, at: root.at, last: Math.max(root.u, ...own.map((reply) => reply.u)) });
  }
  return threads;
};

/**
 * Where a thread's pin is (scene coordinates): next to its element, which it
 * follows when moved; at its own place if it has none or that is gone.
 */
export const pinPosition = (pin, elementsById) => {
  const element = pin.el ? elementsById.get(pin.el) : null;
  if (element && !element.isDeleted && finite(element.x) && finite(element.y)) {
    return { x: element.x + pin.dx, y: element.y + pin.dy, detached: false };
  }
  return { x: pin.x, y: pin.y, detached: !!pin.el };
};

/** a short random id */
export const commentId = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
};

// SHA-256 without Web Crypto (plain-http pages such as the local install's
// http://draw.test have none): the same key as crypto.subtle gives
const K256 = Uint32Array.from(
  "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
    .split(" ")
    .map((hex) => Number.parseInt(hex, 16)),
);

const sha256 = (bytes) => {
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, length * 8);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  const hash = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => (hash[i] = (hash[i] + value) >>> 0));
  }
  const out = new Uint8Array(32);
  hash.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value));
  return out;
};

/** the key that marks an author's comments as theirs: 16 hex of SHA-256 of their address (lowercased) */
export const authorKey = async (email) => {
  const data = new TextEncoder().encode(`kurviq-comment:${String(email).trim().toLowerCase()}`);
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)) : sha256(data);
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** the fallback itself (tests: it must equal Web Crypto's) */
export const sha256Fallback = sha256;

/** a scene's JSON (as written by Excalidraw: ends with "}") plus its comments; no comments: unchanged */
export const withComments = (json, comments) => {
  const list = commentsOf(comments);
  return list.length ? withTopLevelField(json, "kurviqComments", list) : json;
};

/**
 * What a commenter (someone who may comment but not edit) may change, given
 * the comment as it was (null: new) and as they send it: their own new
 * comments and replies, edits and deletions of their own comments, and
 * resolving / reopening any thread. Answers why not, or null if it is allowed.
 */
export const commenterRefusal = (before, after, key) => {
  if (!after) {
    return "not a comment";
  }
  if (!before) {
    if (after.by.key !== key) return "a new comment must be the commenter's own";
    if (after.gone) return "nothing to delete";
    return null;
  }
  if (before.thread !== after.thread || before.at !== after.at || before.by.key !== after.by.key) {
    return "a comment's thread, time and author stay";
  }
  if (JSON.stringify(before.pin ?? null) !== JSON.stringify(after.pin ?? null) && before.by.key !== key) {
    return "only the author moves a pin";
  }
  const ownChange =
    before.text !== after.text ||
    !!before.gone !== !!after.gone ||
    before.by.name !== after.by.name ||
    !!before.by.agent !== !!after.by.agent ||
    (before.edited ?? null) !== (after.edited ?? null);
  if (ownChange && before.by.key !== key) {
    return "only the author edits or deletes a comment (its text, name, agent mark and edit time)";
  }
  return null;
};

/**
 * The `u` of a change to a comment: now, but always after the version it
 * changes (merges keep the larger `u`; a device whose clock is behind would
 * otherwise lose its change to the one it changed).
 */
export const changeStamp = (comment, now = Date.now()) => Math.max(now, (Number(comment?.u) || 0) + 1);

// -----------------------------------------------------------------------------
// live sync: a comment travels encrypted like every change; a small readable
// part lets the scene's server check, without the scene key, what a commenter
// may change (commenterRefusal on readable parts). Every tab and the server's
// save check that the encrypted comment matches it (readableMatches).
// -----------------------------------------------------------------------------

/** FNV-1a, 8 hex: enough to notice a changed text or pin (not a secret) */
const shortHash = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/** what the server may read of a comment */
export const commentReadable = (comment) => ({
  id: comment.id,
  thread: comment.thread,
  key: comment.by.key,
  at: comment.at,
  t: shortHash(comment.gone ? "" : comment.text),
  p: shortHash(JSON.stringify(comment.pin ?? null)),
  ...(comment.gone ? { gone: true } : {}),
});

/** a readable part as it came over the wire: checked, or null */
export const cleanCommentReadable = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const { id, thread, key, at, t, p } = raw;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof thread !== "string" || !ID_RE.test(thread)) return null;
  if (typeof key !== "string" || !KEY_RE.test(key) || !finite(at) || typeof t !== "string" || !/^[a-f0-9]{8}$/.test(t)) return null;
  if (typeof p !== "string" || !/^[a-f0-9]{8}$/.test(p)) return null;
  return { id, thread, key, at, t, p, ...(raw.gone === true ? { gone: true } : {}) };
};

/** the encrypted comment is the one its readable part describes */
export const readableMatches = (comment, readable) => {
  const clean = cleanComment(comment);
  const r = cleanCommentReadable(readable);
  return !!clean && !!r && JSON.stringify(commentReadable(clean)) === JSON.stringify(r);
};

/** commenterRefusal on readable parts (the server's check: it has no key) */
export const commenterReadableRefusal = (before, after, key) => {
  if (!after) return "not a comment";
  if (!before) {
    if (after.key !== key) return "a new comment must be the commenter's own";
    return after.gone ? "nothing to delete" : null;
  }
  if (before.thread !== after.thread || before.at !== after.at || before.key !== after.key) {
    return "a comment's thread, time and author stay";
  }
  if (before.key !== key && (before.t !== after.t || before.p !== after.p || !!before.gone !== !!after.gone)) {
    return "only the author edits, moves or deletes a comment";
  }
  return null;
};

// -----------------------------------------------------------------------------
// agents: edit_scene's `comments` operations
// -----------------------------------------------------------------------------

const opError = (index, message) => new Error(`comments[${index}]: ${message}`);

/**
 * A thread's place for a new comment on an element: just right of its top
 * right corner; without an element at x/y (default: the scene's top left).
 */
export const pinFor = (element, x, y) => {
  if (element) {
    const dx = (element.width ?? 0) + 8;
    return { x: element.x + dx, y: element.y, el: element.id, dx, dy: 0 };
  }
  return { x: finite(x) ? x : 0, y: finite(y) ? y : 0 };
};

/** a thread's first comment, reopened (no longer resolved) */
export const withoutDone = (comment) => {
  const copy = { ...comment };
  delete copy.done;
  return copy;
};

/**
 * Applies agents' comment operations to a scene's comments, as `author`
 * (the signed-in person, marked as agent): { action: "add", text, element?,
 * x?, y? }, { action: "reply", thread, text }, { action: "resolve" | "reopen",
 * thread }, { action: "edit", id, text }, { action: "delete", id }. Edit and
 * delete only the author's own comments. Answers the new list, the changed
 * comments and the ids of new ones; throws on the first invalid operation
 * (nothing is applied then).
 */
export const applyCommentOps = (value, ops, author, elementsById, now = Date.now()) => {
  if (!Array.isArray(ops)) {
    throw new TypeError("comments must be an array of operations");
  }
  const byId = new Map(commentsOf(value).map((comment) => [comment.id, comment]));
  const changed = new Map();
  const added = [];
  const put = (comment, index) => {
    const clean = cleanComment(comment);
    if (!clean) throw opError(index, "the comment is not valid (empty text?)");
    byId.set(clean.id, clean);
    changed.set(clean.id, clean);
    return clean;
  };
  const threadOf = (id, index) => {
    const thread = byId.get(id);
    if (!thread || thread.thread !== thread.id) throw opError(index, `no thread "${id}"`);
    return thread;
  };
  const ownOf = (id, index) => {
    const comment = byId.get(id);
    if (!comment || comment.gone) throw opError(index, `no comment "${id}"`);
    if (comment.by.key !== author.key) throw opError(index, `"${id}" is ${comment.by.name}'s: only its author changes it`);
    return comment;
  };
  ops.forEach((op, index) => {
    const at = now + index; // in order, also within one call
    const by = { ...author, agent: true };
    switch (op?.action) {
      case "add": {
        const element = op.element === undefined ? null : elementsById.get(op.element);
        if (op.element !== undefined && (!element || element.isDeleted)) throw opError(index, `no element "${op.element}"`);
        const id = commentId();
        added.push(put({ id, thread: id, by, text: op.text, at, u: at, pin: pinFor(element, op.x, op.y) }, index).id);
        break;
      }
      case "reply": {
        threadOf(op.thread, index);
        const id = commentId();
        added.push(put({ id, thread: op.thread, by, text: op.text, at, u: at }, index).id);
        break;
      }
      case "resolve":
      case "reopen": {
        const thread = threadOf(op.thread, index);
        // a change of a stored comment: stamped after it, also when its stamp is ahead of this clock
        const u = changeStamp(thread, at);
        put(op.action === "resolve" ? { ...thread, done: { name: author.name, at }, u } : { ...withoutDone(thread), u }, index);
        break;
      }
      case "edit": {
        const comment = ownOf(op.id, index);
        put({ ...comment, text: op.text, edited: at, u: changeStamp(comment, at) }, index);
        break;
      }
      case "delete": {
        const comment = ownOf(op.id, index);
        put({ ...comment, gone: true, text: "", u: changeStamp(comment, at) }, index);
        break;
      }
      default:
        throw opError(index, 'action must be "add", "reply", "resolve", "reopen", "edit" or "delete"');
    }
  });
  return { comments: [...byId.values()].sort(byTime), changed: [...changed.values()], added };
};

/** threads as agents read them: compact, the element they are about, replies */
export const commentsForAgents = (value, elementsById) =>
  threadsOf(value).map((thread) => {
    const position = pinPosition(thread.root.pin, elementsById);
    const describe = (comment) => ({
      id: comment.id,
      by: comment.by.name + (comment.by.agent ? " (agent)" : ""),
      at: new Date(comment.at).toISOString(),
      ...(comment.gone ? { deleted: true } : { text: comment.text }),
      ...(comment.edited ? { edited: true } : {}),
    });
    return {
      thread: thread.id,
      ...(thread.root.pin.el && !position.detached ? { element: thread.root.pin.el } : {}),
      ...(position.detached ? { elementDeleted: true } : {}),
      x: Math.round(position.x),
      y: Math.round(position.y),
      ...(thread.resolved ? { resolved: true } : {}),
      comments: [describe(thread.root), ...thread.replies.map(describe)],
    };
  });
