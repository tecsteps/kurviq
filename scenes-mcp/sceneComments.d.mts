export declare const MAX_COMMENTS: number;
export declare const MAX_TEXT: number;
export declare const MAX_NAME: number;

/** where a thread is: next to an element (dx/dy from its top-left; x/y its last place), or at x/y on the canvas */
export type CommentPin = { x: number; y: number; el?: string; dx?: number; dy?: number };

export type CommentAuthor = { name: string; key: string; agent?: true };

export type SceneComment = {
  id: string;
  /** the thread's first comment (its own id for that one) */
  thread: string;
  by: CommentAuthor;
  text: string;
  /** created (ms) */
  at: number;
  /** last change (ms): the newer version wins a merge */
  u: number;
  edited?: number;
  gone?: true;
  /** the thread's first comment only */
  pin?: CommentPin;
  done?: { name: string; at: number };
};

export type CommentThread = {
  id: string;
  root: SceneComment;
  replies: SceneComment[];
  resolved: boolean;
  at: number;
  last: number;
};

export declare const cleanComment: (raw: unknown) => SceneComment | null;
export declare const commentsOf: (value: unknown) => SceneComment[];
export declare const mergeComments: (...lists: unknown[]) => SceneComment[] | undefined;
export declare const commentsKey: (value: unknown) => string;
export declare const threadsOf: (value: unknown) => CommentThread[];
export declare const pinPosition: (
  pin: CommentPin,
  elementsById: Map<string, { x: number; y: number; isDeleted?: boolean }>,
) => { x: number; y: number; detached: boolean };
export declare const commentId: () => string;
export declare const authorKey: (email: string) => Promise<string>;
export declare const withComments: (json: string, comments: unknown) => string;
export declare const commenterRefusal: (before: SceneComment | null, after: SceneComment | null, key: string) => string | null;
/** the `u` of a change to a comment: now, but after the version it changes */
export declare const changeStamp: (comment: { u?: number } | null | undefined, now?: number) => number;

export type CommentReadable = { id: string; thread: string; key: string; at: number; t: string; p: string; gone?: true };
export declare const commentReadable: (comment: SceneComment) => CommentReadable;
export declare const cleanCommentReadable: (raw: unknown) => CommentReadable | null;
export declare const readableMatches: (comment: unknown, readable: unknown) => boolean;
export declare const commenterReadableRefusal: (before: CommentReadable | null, after: CommentReadable | null, key: string) => string | null;

export type CommentOp =
  | { action: "add"; text: string; element?: string; x?: number; y?: number }
  | { action: "reply"; thread: string; text: string }
  | { action: "resolve" | "reopen"; thread: string }
  | { action: "edit"; id: string; text: string }
  | { action: "delete"; id: string };
export declare const pinFor: (element: { id: string; x: number; y: number; width?: number } | null, x?: number, y?: number) => CommentPin;
export declare const applyCommentOps: (
  value: unknown,
  ops: unknown,
  author: { name: string; key: string },
  elementsById: Map<string, any>,
  now?: number,
) => { comments: SceneComment[]; changed: SceneComment[]; added: string[] };
export declare const commentsForAgents: (value: unknown, elementsById: Map<string, any>) => Array<Record<string, unknown>>;

export declare const sha256Fallback: (bytes: Uint8Array) => Uint8Array;
export declare const withoutDone: (comment: SceneComment) => SceneComment;
