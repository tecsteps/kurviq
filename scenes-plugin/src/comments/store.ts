// The comments on screen (../../../scenes-mcp/sceneComments.mjs), in the
// browser. The scene file carries them (kurviqComments); this keeps them while
// a scene is shown, in two slots: the editor's open scene and the shared
// viewer's (publicScene.tsx, for people who may view or comment but not
// edit). Each slot is filled when its scene is loaded and kept current by its
// live session; the user's changes go to the slot's writer (the controller:
// live sync or its own save; the viewer: a commenter's way to the editor,
// ./mailbox.ts). A commenter's comments that wait in Drive's comments for an
// editor are marked pending ("waiting for an editor").

import { commentsKey, commentsOf } from "../../../scenes-mcp/sceneComments.mjs";

import type { SceneComment } from "../../../scenes-mcp/sceneComments.mjs";

export type CommentSlot = "editor" | "viewer";

type Writer = (comment: SceneComment) => boolean;

type Slot = { comments: SceneComment[]; key: string; writer: Writer | null };

const slots: Record<CommentSlot, Slot> = {
  editor: { comments: [], key: "", writer: null },
  viewer: { comments: [], key: "", writer: null },
};
/** comments (id:u) waiting in Drive's comments for an editor to take them in */
let pending = new Set<string>();
/** why the last change could not be sent (a commenter's: it goes out after the click) */
let problem: string | null = null;
const pendingKey = (comment: Pick<SceneComment, "id" | "u">) => `${comment.id}:${comment.u}`;
/** the shared viewer is on screen (its slot is the one shown) */
let viewerActive = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

const replace = (slot: CommentSlot, next: SceneComment[]) => {
  const nextKey = commentsKey(next);
  if (nextKey === slots[slot].key) {
    return false;
  }
  slots[slot] = { ...slots[slot], comments: next, key: nextKey };
  notify();
  return true;
};

const shown = (): CommentSlot => (viewerActive ? "viewer" : "editor");

export const commentStore = {
  /** the comments on screen (checked), oldest first */
  list: () => slots[shown()].comments,
  /** which slot is on screen */
  slot: shown,
  /** the editor's open scene: its comments (what it saves), and their key (changes with every change) */
  editorList: () => slots.editor.comments,
  editorKey: () => slots.editor.key,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** a scene was loaded: its comments (its file's kurviqComments) */
  load: (value: unknown, slot: CommentSlot = "editor") => {
    replace(slot, commentsOf(value));
  },
  /** a live session's view of its scene's comments (in force while live) */
  fromLive: (value: unknown, slot: CommentSlot = "editor") => replace(slot, commentsOf(value)),
  /** where the user's changes in a slot are saved */
  setWriter: (next: Writer | null, slot: CommentSlot = "editor") => {
    slots[slot] = { ...slots[slot], writer: next };
    notify();
  },
  /** someone may change the comments in this slot (it has a writer) */
  canWrite: (slot: CommentSlot = shown()) => !!slots[slot].writer,
  /** the shared viewer shows a scene (or not any more) */
  setViewerActive: (active: boolean) => {
    if (viewerActive !== active) {
      viewerActive = active;
      if (!active) {
        slots.viewer = { comments: [], key: "", writer: null };
        pending = new Set();
      }
      notify();
    }
  },
  /** this version of the comment waits for an editor (in Drive's comments) */
  isPending: (comment: SceneComment) => pending.has(pendingKey(comment)),
  /** mark comments as waiting for an editor (or not any more) */
  setPending: (comments: SceneComment[], waiting: boolean) => {
    const next = new Set(pending);
    comments.forEach((comment) => (waiting ? next.add(pendingKey(comment)) : next.delete(pendingKey(comment))));
    pending = next;
    notify();
  },
  /** the comments waiting for an editor: exactly these */
  replacePending: (comments: SceneComment[]) => {
    pending = new Set(comments.map(pendingKey));
    notify();
  },
  problem: () => problem,
  setProblem: (next: string | null) => {
    if (problem !== next) {
      problem = next;
      notify();
    }
  },
  /**
   * The user changed or added a comment on screen (or an agent in the
   * editor's scene: slot "editor"): in the list at once, then saved. False if
   * it can't be saved there now (nothing changed then). via: another way out
   * than the slot's writer (a commenter's, ./mailbox.ts).
   */
  change: (comment: SceneComment, slot: CommentSlot = shown(), via?: Writer) => {
    const clean = commentsOf([comment])[0];
    const writer = via ?? slots[slot].writer;
    if (!clean || !writer) {
      return false;
    }
    const before = slots[slot].comments;
    replace(slot, commentsOf([...before.filter((entry) => entry.id !== clean.id), clean]));
    if (!writer(clean)) {
      replace(slot, before);
      return false;
    }
    return true;
  },
};
