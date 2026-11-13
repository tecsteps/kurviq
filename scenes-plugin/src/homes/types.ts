// Where a scene lives (its "home", specs/2026-11-13-own-database.md): this
// browser only, Google Drive, or later the user's own database. The scenes
// controller (../controller.ts) talks to a home only through this interface;
// the contract is written down in docs/homes/CONCEPT.md.

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type HomeKind = "browser" | "drive" | "database";

/**
 * A version of a scene in its home, opaque to the controller: compared for
 * equality only. Drive: the file's MD5. A database: whatever names one state
 * of the scene's rows (e.g. a revision counter).
 */
export type HomeVersion = string;

export type HomeCapabilities = {
  /**
   * How copies are kept in step:
   * - "none": the home is the only copy (this browser), nothing to sync;
   * - "merge": whole-scene versions; the controller pushes, pulls and merges
   *   element by element against the base version (Drive);
   * - "realtime": the home streams element changes itself through its live
   *   session (a database); the controller only loads and stores.
   */
  sync: "none" | "merge" | "realtime";
  /** older versions can be listed and loaded (history, loadVersion) */
  history: boolean;
  /** pictures are part of the scene JSON (`files`); else the home's `files` store keeps them */
  filesInline: boolean;
  /** comments are part of the scene JSON (`kurviqComments`); else the home's `comments` keep them */
  commentsInline: boolean;
  /**
   * Others on the same scene: "none", "pen" (one editor at a time, the others
   * follow live: Drive's relay) or "realtime" (everyone edits, pointers and
   * selections shown: a database)
   */
  presence: "none" | "pen" | "realtime";
  /** who can be given access: nobody, Drive's permissions, the home's members (invited by email) */
  sharing: "none" | "drive" | "members";
  /** a scene can be opened by anyone with its link */
  publicLinks: boolean;
  /** people without a Google account can be invited (email codes) */
  guests: boolean;
  /** an old copy can carry a "moved to …" note (markMoved / movedTo) */
  moveMarker: boolean;
  /** needs the user's sign-in before anything can be read or written */
  needsSignIn: boolean;
};

/** a scene as its home lists it */
export type ListedScene = {
  name: string;
  version: HomeVersion;
  updatedAt: string | null;
  /** anyone with the link can open it */
  public?: boolean;
  /** the home's own id of the scene (Drive: the file id; a database: the row id) */
  id?: string;
};

export type HomeStatus = {
  /** the home answered at the last attempt (null: not tried yet) */
  online: boolean | null;
  lastFetchAt: string | null;
  lastError: string | null;
  /** this user may read the home's scenes, not change them (why) */
  readOnly?: string | null;
};

export type HomeListing = { scenes: ListedScene[]; status: HomeStatus };

/** a scene's content: its scene JSON and the version that is */
export type HomeContent = { json: string; version: HomeVersion };

/** an older version of a scene (newest first in lists) */
export type HomeHistoryEntry = {
  /** the home's id of that version (Drive: the revision id) */
  id: string;
  at: string | null;
  author: string | null;
  /** made by an agent */
  agent: boolean;
  version?: HomeVersion;
};

/**
 * What a home's calls throw. `status` follows HTTP: 404 not there, 409 the
 * base version is not the home's any more (`remoteVersion` names the one it
 * has) or the name is taken (`exists`), 403 not allowed.
 */
export type HomeError = Error & {
  status: number;
  /** not reachable: keep working locally, try again later */
  offline?: boolean;
  remoteVersion?: HomeVersion | null;
  /** rename: the target name is taken there */
  exists?: boolean;
  /** not signed in (or no access to the home at all) */
  notConnected?: boolean;
  /** this user may only read: nothing can be saved */
  readOnly?: boolean;
};

/** where a scene went ("Move to…"): shown at its old place */
export type MovedMark = { home: HomeKind; link: string; at: string };

/** pictures kept outside the scene JSON (homes with filesInline: false) */
export interface HomeFiles {
  put(sceneId: string, fileId: string, dataURL: string, mimeType: string): Promise<void>;
  get(sceneId: string, fileId: string): Promise<{ dataURL: string; mimeType: string } | null>;
}

/** comments kept outside the scene JSON (homes with commentsInline: false), in kurviqComments' shape */
export interface HomeComments {
  list(sceneId: string): Promise<unknown[]>;
  /** one comment added or changed (the home applies the commenter rules) */
  write(sceneId: string, comment: unknown): Promise<void>;
}

/**
 * The tab's side of a live session (the controller implements it): what the
 * home's live session (Drive: the pen, ../online/pen.ts; a database: its
 * realtime channel) may ask of and tell the controller about the open scene.
 */
export interface LiveHost {
  /** someone else may write the open scene now (their name): it is read only here; null: this tab may write */
  setPenLock(holder: string | null): void;
  /** another tab saved the open scene: its version is the base here too */
  penAdoptSaved(version: HomeVersion, hash: number | null): void;
  /** the open scene's saved version and the canvas hash it has */
  penSavedVersion(): { md5: HomeVersion; hash: number | null } | null;
  /** save this tab's changes of the open scene now (before handing over); the saved version */
  penSaveNow(): Promise<{ md5: HomeVersion; hash: number | null } | null>;
  /** edits made here without the right to write are merged into the home before this tab turns read only */
  penFlushOwn(): Promise<void>;
  /** told by the controller: a save of the open scene, a version pulled while following */
  penHooks: { saved: (name: string, version: HomeVersion, hash: number | null) => void; pulled: (name: string) => void } | null;
}

/** a home's live session: joins the open scene of the editor (presence, others' changes) */
export interface HomeLive {
  attach(api: ExcalidrawImperativeAPI): void;
}

/** sharing in the home, for the share panel */
export interface HomeSharing {
  /** the home's id of a scene and whether this user may change who has access */
  fileOf(name: string): Promise<{ id: string; canShare: boolean; owner: string | null } | null>;
}

export interface SceneHome {
  readonly kind: HomeKind;
  /** shown to the user: "This browser", "Google Drive", the database's name */
  readonly label: string;
  readonly capabilities: HomeCapabilities;

  /** the home's scenes (refresh: not from a cache) */
  list(refresh?: boolean): Promise<HomeListing>;
  /** the latest version, or a given one (a base for a merge) */
  load(name: string, version?: HomeVersion): Promise<HomeContent>;
  /**
   * Store a scene. base: the version this content is based on ("none": must
   * be new; undefined: overwrite). Throws a HomeError 409 with
   * remoteVersion when the home has another version (merge, then save again).
   */
  save(name: string, json: string, base: HomeVersion | "none" | undefined, source?: string): Promise<{ version: HomeVersion; changed: boolean }>;
  /** delete (base: only if the home still has that version, else 409) */
  remove(name: string, base?: HomeVersion | null): Promise<void>;
  /** rename (content and version stay) */
  rename(from: string, to: string): Promise<{ version: HomeVersion }>;

  /** older versions (capabilities.history) */
  history?(name: string): Promise<HomeHistoryEntry[]>;
  loadVersion?(name: string, entry: HomeHistoryEntry): Promise<HomeContent>;
  /** pictures (capabilities.filesInline false) */
  files?: HomeFiles;
  /** comments (capabilities.commentsInline false) */
  comments?: HomeComments;
  /** live session of the open scene (capabilities.presence not "none"); wired once by the app (see ./live.ts) */
  live?: HomeLive;
  /** sharing (capabilities.sharing not "none") */
  sharing?: HomeSharing;
  /** leave a "moved to …" note at the scene's old place (capabilities.moveMarker) */
  markMoved?(name: string, mark: MovedMark): Promise<void>;
  /** the note left by markMoved, if any (`id`: the home's id of the old scene) */
  movedTo?(id: string): Promise<MovedMark | null>;
}
