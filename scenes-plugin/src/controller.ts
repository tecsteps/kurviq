// Scenes: switching, saving and syncing with their homes. Talks to the editor
// only through the public ExcalidrawImperativeAPI, and to a scene's home
// (this browser only, Google Drive; see ./homes/types.ts and
// docs/homes/CONCEPT.md) only through the SceneHome interface.
//
// Offline-first: the browser (localStorage + IndexedDB) is the source of
// truth. Drive is a sync target: when it is not reachable, everything keeps
// working locally and syncs later.
//
// Per scene we track the home's version (Drive: MD5 of its content) the local
// copy is based on. Compared with the latest version in the home and the local
// dirty flag this gives a visible status: synced / ahead / behind / diverged /
// conflict / local. Auto-sync (default on, per-scene override) pushes after
// 10s idle, pulls clean scenes, merges element-wise on divergence and stops
// on real clashes.
//
// One source of truth for the open scene (meta.current; state.current is
// derived from it) and one queue (./opQueue.ts): user actions, opening a
// scene and sync steps never interleave.

import { editorYield } from "./editorYield";
import { mergePresentation, restorePresentation } from "../../scenes-mcp/presentation.mjs";
import { serializeAsJSON, presentationOf } from "./presentation";
import {
  CaptureUpdateAction,
  getNonDeletedElements,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw";
import { hashElementsVersion, hashString } from "@excalidraw/element";

import { mergeFontLists, registerSceneFonts, withFonts } from "./fonts";
import { commentStore } from "./comments/store";
import { commentsKey, mergeComments, withComments } from "../../scenes-mcp/sceneComments.mjs";
import type { SceneComment } from "../../scenes-mcp/sceneComments.mjs";
import { IS_ONLINE } from "./api";
import { sharedFileId } from "./online/drive";
import { isSceneName } from "../../scenes-mcp/sceneName.mjs";
import { randomNonce } from "./editDiff";
import { browserHomeOf } from "./homes/browser";
import { driveHome } from "./homes/drive";
import { changedFields, live, mergeElements, mergeSceneSettings, MERGE_VERSION, newestWins } from "./merge";
import type { ClashChoice } from "./merge";
import { OpQueue } from "./opQueue";
import { freeName, UNTITLED } from "./spaces";
import {
  META_KEY,
  deleteAgentBaseline,
  deleteSnapshot,
  getSnapshot,
  loadMeta,
  moveAgentBaseline,
  saveMeta,
  setSnapshot,
} from "./storage";

import type { HomeError, HomeHistoryEntry, HomeVersion, ListedScene, LiveHost, SceneHome } from "./homes/types";
import type { SceneMeta, ScenesMeta } from "./storage";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

export type SyncStatus =
  /** same as in Drive */
  | "synced"
  /** local changes not pushed yet */
  | "ahead"
  /** Drive has a newer version, no local changes */
  | "behind"
  /** both changed: will be merged */
  | "diverged"
  /** both changed the same elements: needs a decision */
  | "conflict"
  /** never pushed */
  | "local"
  /** kept only in this browser on purpose: never synced */
  | "local-only"
  /** not named yet */
  | "untitled";

export type SceneListItem = {
  /** null = untitled draft */
  name: string | null;
  status: SyncStatus;
  dirty: boolean;
  inDrive: boolean;
  autoSync: boolean;
  /** kept only in this browser, never synced to Drive */
  localOnly: boolean;
  updatedAt?: string | null;
  /** renamed here, not yet in Drive: the name it still has there */
  pendingRename?: string;
  /** shared "anyone with the link" in Drive */
  public?: boolean;
  /** its Google Drive file */
  fileId?: string;
  /** where it lives (homes/types.ts) */
  home: SceneHome["kind"];
};

export type Activity = {
  at: number;
  kind: "push" | "pull" | "merge" | "conflict" | "error" | "info";
  text: string;
};

type SyncInfo = {
  /** Drive answered at the last attempt (null = not tried yet) */
  driveOnline: boolean | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  running: boolean;
  /** not signed in with Google (or no Drive access): everything stays in this browser */
  notConnected: boolean;
  /** a shared scene Drive lets this user read, not change (why); nothing is pushed */
  readOnly: string | null;
};

export type ScenesState = {
  /** the open scene (always this.meta.current: set by setState, never by a patch) */
  readonly current: string | null;
  /** how the URL follows the last change of `current`: a new history entry (open) or in place (rename, delete) */
  urlMode: "push" | "replace";
  dirty: boolean;
  busy: null | "loading" | "saving";
  error: string | null;
  /** the Drive home's listing (null: not listed yet) */
  remote: ListedScene[] | null;
  list: SceneListItem[];
  autoSync: boolean;
  sync: SyncInfo;
  activity: Activity[];
  /** clashing element ids of the active scene, if it is in conflict */
  conflict: { clashes: string[] } | null;
  /** the open scene is a local copy being checked against Drive (read-only) */
  checking: boolean;
  /** a scene being opened (e.g. named by the link): shown while it loads instead of "Untitled" */
  opening: string | null;
};

/** push the active scene after this long without changes */
export const IDLE_PUSH_MS = 10_000;
/** check Drive for changes this often */
const POLL_MS = 60_000;

/** names whose URL is one of Kurviq's pages on kurviq.com (online/worker/stats.ts PLAIN_PAGES, publicScene.tsx PUBLIC_SCENES) */
const RESERVED_ONLINE = new Set(["about", "contact", "features", "imprint", "privacy", "terms"]);

/** what is wrong with a new scene name (null: fine) */
export const sceneNameProblem = (name: string, online = IS_ONLINE) => {
  if (!isSceneName(name)) {
    return "Invalid name. Use letters, numbers, spaces and _ . ( ) - (max 100 chars).";
  }
  if (online && RESERVED_ONLINE.has(name)) {
    return `"${name}" is the address of one of Kurviq's pages: choose another name`;
  }
  return null;
};

/** the name a scene still has in Drive (renamed here, the rename not in Drive yet: its old name) */
const driveNameOf = (meta: ScenesMeta, name: string) => meta.scenes[name]?.renamedFrom ?? name;
/** a just-opened local copy is read-only at most this long while Drive is asked */
const CHECK_LOCK_MS = 3_000;

/** what the user does in a tab that makes it the tab in use (its scene is the one "/" opens) */
const INTERACTIONS = ["pointerdown", "keydown", "wheel"] as const;

/** the scene "Edit" in the shared-link viewer opens after the reload (its exact name) */
export const OPENING_KEY = "kurviq-opening";

/**
 * A shared scene's space opened with "Edit" in the viewer: the name the pill shows while the
 * scene loads, instead of "Untitled" (the link's path only has a readable slug of it)
 */
const linkedScene = (current: string | null) => {
  if (!sharedFileId || typeof window === "undefined") {
    return null;
  }
  let name: string | null = null;
  try {
    const raw = sessionStorage.getItem(OPENING_KEY);
    sessionStorage.removeItem(OPENING_KEY);
    const handed = raw ? (JSON.parse(raw) as { fileId?: string; name?: string }) : null;
    name = handed?.fileId === sharedFileId && typeof handed.name === "string" ? handed.name : null;
  } catch {}
  return name && name !== current && isSceneName(name) ? name : null;
};

const sceneHash = (
  elements: readonly ExcalidrawElement[],
  appState: Pick<AppState, "viewBackgroundColor">,
  comments: unknown = undefined,
) => {
  const parts: unknown[] = [
    appState.viewBackgroundColor,
    (appState as any).kurviqPresentation,
    (appState as any).kurviqPresentationAt ?? 0,
    getNonDeletedElements(elements).map(
      ({ version, versionNonce, updated, index, ...rest }) => rest,
    ),
  ];
  // comments count only when there are some (the hashes stored for scenes without stay valid)
  const commented = commentsKey(comments);
  if (commented) {
    parts.push(commented);
  }
  return hashString(JSON.stringify(parts));
};

const hashJson = (json: string) => {
  const data = JSON.parse(json);
  return sceneHash(
    restoreElements(data.elements, null, { repairBindings: true }),
    { viewBackgroundColor: data.appState?.viewBackgroundColor ?? "#ffffff", kurviqPresentation: data.appState?.kurviqPresentation, kurviqPresentationAt: data.appState?.kurviqPresentationAt ?? 0 } as any,
    data.kurviqComments,
  );
};

const isEmptyJson = (json: string) =>
  !getNonDeletedElements(JSON.parse(json).elements || []).length;

/** scene JSON whose appState.name is `name` (the server checks it) */
export const withSceneName = (json: string, name: string) => {
  const data = JSON.parse(json);
  if (data.appState?.name === name) {
    return json;
  }
  return JSON.stringify({ ...data, appState: { ...data.appState, name } });
};

/** the files (image data) of these elements, nothing else */
const usedFiles = (elements: readonly any[], files: Record<string, any>) => {
  const used: Record<string, any> = {};
  for (const el of elements) {
    if (!el.isDeleted && el.fileId && files[el.fileId]) {
      used[el.fileId] = files[el.fileId];
    }
  }
  return used;
};

/** a free, valid name for a copy of `name`: the name shortened so the suffix fits, then "(2)", "(3)", … if taken */
export const copyName = (name: string, suffix: string, taken: (name: string) => boolean) =>
  freeName(`${name.slice(0, 100 - suffix.length).trimEnd()}${suffix}`, taken);

const timestamp = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}.${pad(d.getMinutes())}`;
};

/**
 * A merge took nothing of mine: no element of mine, no clash settled, and
 * background, grid, presentation, fonts and comments are Drive's
 */
const nothingOfMine = (
  merged: { fromMine: number },
  settled: readonly string[],
  parts: { appState: Record<string, any>; kurviqFonts: unknown; kurviqComments: unknown },
  theirs: any,
) => {
  if (merged.fromMine > 0 || settled.length > 0) {
    return false;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const keys = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "kurviqPresentation", "kurviqPresentationAt"];
  return (
    keys.every((key) => same(parts.appState[key], theirs.appState?.[key])) &&
    same(parts.kurviqFonts, theirs.kurviqFonts) &&
    same(commentsKey(parts.kurviqComments), commentsKey(theirs.kurviqComments))
  );
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const unknownDriveStatus = (base: string | null, dirty: boolean): SyncStatus => {
  if (!base) return "local";
  return dirty ? "ahead" : "synced";
};

const conflictChanges = (base: any, current: any) => {
  if (!current) return ["deleted"];
  return base ? changedFields(base, current) : ["added"];
};

class ScenesController implements LiveHost {
  private api: ExcalidrawImperativeAPI | null = null;
  private unsubscribeChange: (() => void) | null = null;
  private meta: ScenesMeta = loadMeta();
  private readonly listeners = new Set<() => void>();
  private lastVersionKey = "";
  private lastChangeAt = 0;
  private pushCurrentNow = false;
  private timers: number[] = [];

  /** the home every synced scene lives in today (Drive); a database home joins here */
  private readonly drive: SceneHome = driveHome;
  /** the scenes kept only in this browser, as a home (for "Move to…"; the controller keeps them itself) */
  readonly browserHome: SceneHome = browserHomeOf({
    names: () => Object.keys(this.meta.scenes).filter((name) => name !== UNTITLED && this.isLocalOnly(name)),
    read: (name) => (this.isLocalOnly(name) ? this.localOnlyJson(name) : Promise.resolve(null)),
    write: (name, json) => (this.isLocalOnly(name) ? this.writeLocalOnly(name, json) : this.createLocalOnly(name, json)),
    remove: (name) => this.remove(name),
    rename: (from, to) => this.rename(from, to),
  });

  /** one operation at a time (see the top of this file) */
  private readonly queue = new OpQueue();
  /** set just before a rename / delete changes the open scene: the URL is replaced, not pushed */
  private urlMode: ScenesState["urlMode"] = "push";

  state: ScenesState = {
    current: this.meta.current,
    urlMode: "push",
    dirty: false,
    busy: null,
    error: null,
    remote: null,
    list: [],
    autoSync: this.meta.autoSync,
    sync: {
      driveOnline: null,
      lastCheckedAt: null,
      lastError: null,
      running: false,
      notConnected: false,
      readOnly: null,
    },
    activity: [],
    conflict: null,
    checking: false,
    opening: linkedScene(this.meta.current),
  };

  constructor() {
    this.state.list = this.buildList();
    commentStore.setWriter((comment) => this.writeComment(comment));
  }

  private driveStatusOf(name: string, meta: SceneMeta | undefined): SyncStatus {
    const dirty = this.isDirty(name);
    const base = meta?.baseMd5 ?? null;
    const remote = this.remoteMd5Of(name);
    if (remote === undefined) {
      // Drive state unknown (offline since start)
      return unknownDriveStatus(base, dirty);
    }
    if (!remote) {
      return base && dirty ? "ahead" : "local";
    }
    if (!base) {
      // in Drive, never synced locally
      return dirty ? "diverged" : "behind";
    }
    if (remote === base) {
      return dirty ? "ahead" : "synced";
    }
    return dirty ? "diverged" : "behind";
  }

  // ---------------------------------------------------------------------------
  // store plumbing (for useSyncExternalStore)
  // ---------------------------------------------------------------------------

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private setState(patch: Partial<Omit<ScenesState, "current" | "urlMode">>) {
    const current = this.meta.current;
    const switched = current !== this.state.current;
    this.state = { ...this.state, ...patch, current, urlMode: switched ? this.urlMode : this.state.urlMode };
    if (switched) {
      this.urlMode = "push";
    }
    if (this.state.opening !== null && this.state.current === this.state.opening) {
      this.state.opening = null; // it is open
    }
    this.state.list = this.buildList();
    const conflict = current !== null ? this.meta.scenes[current]?.conflict : undefined;
    this.state.conflict = conflict ? { clashes: conflict.clashes } : null;
    this.listeners.forEach((listener) => listener());
  }

  private refresh() {
    this.setState({});
  }

  /**
   * The stored `current` is the scene a new tab opens at "/": the scene of the tab the user used
   * last. Every tab writes the whole metadata (e.g. its background sync), so a tab only writes its
   * own scene as `current` while it holds the claim: it switched scenes, or the user used it
   * (pointer, keys) since another tab claimed it. Else it keeps the stored one (another tab's),
   * so a tab left open in the background doesn't turn "the scene I left" into its own scene (or
   * into Untitled).
   */
  private claimsCurrent = true;
  private persistedCurrent: string | null = this.meta.current;

  /** the user does something in this tab: it is the one in use */
  private readonly onInteract = () => {
    if (!this.claimsCurrent) {
      this.claimsCurrent = true;
      this.persistMeta();
    }
  };

  private persistMeta() {
    if (this.meta.current !== this.persistedCurrent) {
      this.claimsCurrent = true; // this tab switched scenes (the user, or an agent showing one)
    }
    this.persistedCurrent = this.meta.current;
    const stored = loadMeta();
    for (const [name, scene] of Object.entries(this.meta.scenes)) {
      const remembered = stored.scenes[name];
      if (typeof remembered?.kurviqPresentation === "boolean") {
        Object.assign(scene, restorePresentation({ appState: scene }, remembered));
      }
    }
    if (this.claimsCurrent || (stored.current !== null && !this.meta.scenes[stored.current])) {
      saveMeta(this.meta); // (the other tab's scene is gone: this one's then)
      return;
    }
    saveMeta({ ...this.meta, current: stored.current, baseline: stored.baseline });
  }

  private log(kind: Activity["kind"], text: string) {
    if (this.state.activity[0]?.text === text) {
      return; // e.g. the same error on every poll
    }
    this.setState({
      activity: [{ at: Date.now(), kind, text }, ...this.state.activity].slice(0, 30),
    });
  }

  /**
   * One thing at a time: user actions, opening a scene and sync steps never
   * interleave (priority: before the waiting ones, after the running one).
   * Never called from inside an operation (it would wait for itself).
   */
  private exclusive<T>(fn: () => Promise<T>, { priority = false }: { priority?: boolean } = {}): Promise<T> {
    return this.queue.run(fn, { priority });
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  private readonly readyDeferred = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  })();

  /** resolves once the editor finished loading its initial scene */
  ready: Promise<void> = this.readyDeferred.promise;

  getApi() {
    return this.api;
  }

  /** how many mounted components hold the editor (attach / release); none left a tick later: it is gone */
  private holds = 0;

  /**
   * A component that attached lets go: when nothing holds the editor a tick
   * later, it is gone. (React runs an effect's cleanup also when the editor
   * hands out a new API object, and twice in development: those attach again
   * at once, so they don't count as gone.)
   */
  release(api: ExcalidrawImperativeAPI) {
    this.holds = Math.max(0, this.holds - 1);
    window.setTimeout(() => {
      if (this.holds === 0) {
        this.editorGone(api);
      }
    }, 0);
  }

  attach(api: ExcalidrawImperativeAPI) {
    this.holds++;
    if (this.api === api) {
      return;
    }
    if (api.isDestroyed) {
      this.editorGone();
      return;
    }
    // a new API object of the same editor (it hands out one more at start): the old one lets go first, quietly
    if (this.api) {
      this.detach();
    }
    // the app loads its initial scene asynchronously; switching scenes
    // before that would get overwritten
    const waitForLoad = () => {
      if (api.getAppState().isLoading) {
        void editorYield(100).then(waitForLoad).catch((error) => console.error("[scenes] initialization wait failed", error));
        return;
      }
      this.adoptInitialCanvas()
        .finally(() => this.readyDeferred.resolve())
        .catch((error) => console.error("[scenes] could not initialize scene", error));
    };
    this.unsubscribeChange?.();
    this.api = api;
    this.unsubscribeChange = api.onChange((elements, appState) =>
      this.onSceneChange(elements, appState),
    );
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("storage", this.onStorage);
    document.addEventListener("visibilitychange", this.onVisibility);
    for (const type of INTERACTIONS) {
      window.addEventListener(type, this.onInteract, { capture: true, passive: true });
    }
    this.onSceneChange(api.getSceneElementsIncludingDeleted(), api.getAppState());
    waitForLoad();
  }

  /**
   * The app restores the canvas the browser saved last, possibly by another
   * tab showing another scene. The canvas says which scene it is
   * (appState.name); if that isn't this tab's scene, load the right one.
   */
  private async adoptInitialCanvas() {
    const current = this.meta.current;
    const shown = this.api?.getAppState().name;
    if (current === null && (await this.untitledWasStashed())) {
      // the canvas was cleared on leaving (another space, e.g. after signing in): the untitled scene comes back
      await this.openInner(null, { stash: false, force: true });
      return;
    }
    if (current === null || shown === current) {
      const api = this.requireApi();
      // the restored canvas has no comments: they come from the scene's stored copy (else the next
      // save would write the scene without them)
      const stored = await getSnapshot(current).catch(() => undefined);
      commentStore.load(stored?.json ? JSON.parse(stored.json).kurviqComments : undefined);
      const presentation = this.rememberPresentation({
        elements: api.getSceneElementsIncludingDeleted(),
        appState: api.getAppState(),
      }, current);
      api.updateScene({ appState: presentation as any, captureUpdate: CaptureUpdateAction.NEVER });
      await editorYield();
      this.recomputeDirty();
      return;
    }
    try {
      await this.openInner(current, { stash: false, force: true });
      this.log("info", `Loaded "${current}" (the restored canvas belonged to "${shown}")`);
    } catch (error) {
      console.error("[scenes] could not load the current scene", error);
    }
  }

  /** the untitled scene was stored on leaving (its content) and the canvas shows nothing */
  private async untitledWasStashed() {
    if (!this.meta.scenes[UNTITLED]?.dirty) {
      return false;
    }
    if (this.requireApi().getSceneElementsIncludingDeleted().some((element) => !element.isDeleted)) {
      return false;
    }
    return !!(await getSnapshot(null).catch(() => undefined));
  }

  /** start polling / auto-sync (not in the hidden renderer tab) */
  startSync() {
    if (this.timers.length) {
      return;
    }
    this.ready.then(() => this.syncNow({ refresh: true })).catch((error) => console.error("[scenes] could not start sync", error));
    this.timers.push(
      window.setInterval(() => this.syncNow({ refresh: true }), POLL_MS),
      window.setInterval(() => this.maybePushCurrent(), 5_000),
    );
  }

  /**
   * The editor unmounted (e.g. it crashed while rendering). Its API then
   * reads an emptied scene: nothing may be read, stored or pushed from it any
   * more, or the empty canvas would be synced over the scene. `api`: only if
   * that one is still the attached one (a new editor may have replaced it).
   */
  editorGone(api?: ExcalidrawImperativeAPI) {
    if (!this.api || (api && this.api !== api)) {
      return;
    }
    console.error("[scenes] the editor is gone (unmounted): sync stopped, nothing is saved from it");
    this.detach();
  }

  detach() {
    this.unsubscribeChange?.();
    this.unsubscribeChange = null;
    this.api = null;
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("storage", this.onStorage);
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const type of INTERACTIONS) {
      window.removeEventListener(type, this.onInteract, { capture: true });
    }
  }

  /** other tabs may have changed scene metadata; this tab keeps its own scene */
  private readonly onFocus = () => {
    this.takeOverStored(loadMeta());
    this.lastVersionKey = "";
    if (this.api) {
      this.onSceneChange(this.api.getSceneElementsIncludingDeleted(), this.api.getAppState());
    }
    this.setState({ autoSync: this.meta.autoSync });
  };

  /**
   * another tab changed the scene metadata (e.g. renamed / deleted a scene):
   * take it over, so this tab doesn't write its stale copy back. The scene
   * this tab shows stays (it is reloaded on focus, like the canvas).
   */
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key !== META_KEY) {
      return;
    }
    const stored = loadMeta();
    if (stored.current !== this.meta.current) {
      this.claimsCurrent = false; // another tab is the one in use now
    }
    this.takeOverStored(stored);
    this.refresh();
  };

  /**
   * The stored metadata replaces this tab's (its own open scene and baseline
   * stay). Operations running meanwhile look their scene's record up again
   * after every await and store their changes before the next one, so
   * nothing they do is written to a record that was replaced here.
   */
  private takeOverStored(stored: ScenesMeta) {
    const { current, baseline } = this.meta;
    this.meta = { ...stored, current, baseline };
  }

  private readonly onOnline = () => this.syncNow({ refresh: true });

  /** leaving the tab: push right away instead of waiting for idle */
  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden" && this.state.dirty) {
      this.pushCurrentNow = true;
      void this.syncNow();
    }
  };

  private onSceneChange(
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    { force = false } = {},
  ) {
    // while a scene is being loaded the canvas is in flux; recomputeDirty()
    // forces an update once it's done
    if (this.state.busy === "loading" && !force) {
      return;
    }
    // Persist before Excalidraw's filtered reload copy; recover newer pending edits.
    if (this.cacheCanvasPresentation(appState)) {
      return;
    }
    // cheap check first, onChange fires on every pointer move
    const versionKey = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${(appState as any).kurviqPresentation}:${(appState as any).kurviqPresentationAt ?? 0}:${commentStore.editorKey()}`;
    if (versionKey === this.lastVersionKey) {
      return;
    }
    this.lastVersionKey = versionKey;
    this.lastChangeAt = Date.now();

    const hash = sceneHash(elements, appState, commentStore.editorList());
    if (this.meta.baseline === null) {
      if (this.meta.current === null || !this.meta.scenes[this.meta.current]?.baseMd5) {
        // untitled / never pushed: dirty as soon as there's something on the canvas
        const dirty = getNonDeletedElements(elements).length > 0 || (appState as any).kurviqPresentation === true;
        if (dirty !== this.state.dirty) {
          this.setState({ dirty });
        }
        return;
      }
      this.meta.baseline = hash;
      this.persistMeta();
    }
    const dirty = hash !== this.meta.baseline;
    if (dirty !== this.state.dirty) {
      this.setState({ dirty });
    }
  }

  private recomputeDirty() {
    this.lastVersionKey = "";
    const api = this.api;
    if (api) {
      this.onSceneChange(api.getSceneElementsIncludingDeleted(), api.getAppState(), { force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  private sceneMeta(name: string): SceneMeta {
    this.meta.scenes[name] ??= { baseMd5: null, dirty: false };
    return this.meta.scenes[name];
  }

  /** per-scene override (undefined = follows the global switch) */
  sceneAutoSyncOverride(name: string) {
    return this.meta.scenes[name]?.autoSync;
  }

  isLocalOnly(name: string | null) {
    return name !== null && !!this.meta.scenes[name]?.localOnly;
  }

  /** where a scene lives: this browser only (local only, and the untitled draft), else Google Drive */
  homeOf(name: string | null): SceneHome {
    return name === null || this.isLocalOnly(name) ? this.browserHome : this.drive;
  }

  autoSyncFor(name: string | null) {
    if (name === null || this.isLocalOnly(name)) {
      return false;
    }
    return this.meta.scenes[name]?.autoSync ?? this.meta.autoSync;
  }

  /** the Drive listing's entry of a scene (renamed here but not in Drive yet: under its old name) */
  private listedOf(name: string) {
    const driveName = driveNameOf(this.meta, name);
    return this.state.remote?.find((scene) => scene.name === driveName);
  }

  /** latest known version in Drive: string, null (not there) or undefined (unknown) */
  private remoteMd5Of(name: string): HomeVersion | null | undefined {
    if (this.state.remote) {
      return this.listedOf(name)?.version ?? null;
    }
    return this.meta.scenes[name]?.remoteMd5;
  }

  /**
   * Drive names that are deleted / renamed here, but not in Drive yet:
   * hidden from the list (unless a local scene took the name again)
   */
  private hiddenRemoteNames() {
    const hidden = new Set(Object.keys(this.meta.pendingDeletes));
    for (const meta of Object.values(this.meta.scenes)) {
      if (meta.renamedFrom) {
        hidden.add(meta.renamedFrom);
      }
    }
    return hidden;
  }

  private isDirty(name: string) {
    return name === this.meta.current ? this.state.dirty : !!this.meta.scenes[name]?.dirty;
  }

  statusOf(name: string | null): SyncStatus {
    if (name === null) {
      return "untitled";
    }
    const meta = this.meta.scenes[name];
    if (meta?.localOnly) {
      return "local-only";
    }
    if (meta?.conflict) {
      return "conflict";
    }
    if (meta?.renamedFrom) {
      return "ahead";
    }
    return this.driveStatusOf(name, meta);
  }

  private buildList(): SceneListItem[] {
    const names = new Set<string>();
    const hidden = this.hiddenRemoteNames();
    for (const scene of this.state.remote ?? []) {
      if (!hidden.has(scene.name)) {
        names.add(scene.name);
      }
    }
    for (const name of Object.keys(this.meta.scenes)) {
      if (name !== UNTITLED) {
        names.add(name);
      }
    }
    if (this.meta.current !== null) {
      names.add(this.meta.current);
    }
    const list: SceneListItem[] = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const meta = this.meta.scenes[name];
        const remote = this.listedOf(name);
        return {
          name,
          status: this.statusOf(name),
          dirty: this.isDirty(name),
          inDrive: remote ? true : !!meta?.remoteMd5,
          autoSync: this.autoSyncFor(name),
          localOnly: !!meta?.localOnly,
          updatedAt: remote?.updatedAt,
          ...(meta?.renamedFrom ? { pendingRename: meta.renamedFrom } : {}),
          ...(remote?.public ? { public: true } : {}),
          ...(remote?.id ? { fileId: remote.id } : {}),
          home: this.homeOf(name).kind,
        };
      });
    if (this.meta.current === null || this.meta.scenes[UNTITLED]) {
      list.unshift({
        name: null,
        status: "untitled",
        dirty: this.meta.current === null ? this.state.dirty : true,
        inDrive: false,
        autoSync: false,
        localOnly: false,
        home: "browser",
      });
    }
    return list;
  }

  /** number of scenes with changes waiting to be pushed */
  pendingCount() {
    return this.state.list.filter((item) =>
      ["ahead", "diverged", "conflict"].includes(item.status) ||
      (item.status === "local" && item.name !== null && item.dirty),
    ).length;
  }

  /** scenes deleted here whose deletion in Drive is still pending */
  pendingDeletes() {
    return Object.keys(this.meta.pendingDeletes);
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------

  /** signed in with Google and Drive allowed (set by the online UI) */
  private signedIn = false;

  setSignedIn = (on: boolean) => {
    this.signedIn = on;
  };

  /** new scenes: in Drive while signed in (unless the user chose otherwise), in this browser while signed out */
  newScenesLocalOnly() {
    return !this.signedIn || (this.meta.newLocalOnly ?? false);
  }

  /** a scene made local only by default while signed out: offered for Drive at the next sign-in */
  private madeSignedOut() {
    return this.signedIn ? {} : { moveOnSignIn: true };
  }

  /**
   * At sign-in: the scenes only in this browser (with content) the user hasn't
   * decided on yet; `ticked`: made while signed out (not chosen local only)
   */
  signInCandidates = async () => {
    await this.ready;
    const found: { name: string; ticked: boolean }[] = [];
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name === UNTITLED || !meta.localOnly || meta.keptLocal) {
        continue;
      }
      const json = await this.localJson(name); // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
      if (json && !isEmptyJson(json)) {
        found.push({ name, ticked: !!meta.moveOnSignIn });
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  };

  /**
   * Keep a scene only in this browser and take it out of Drive (its file goes
   * to Drive's trash: people it was shared with lose access).
   */
  keepOnlyHere = async (name: string) => {
    await this.ready;
    const inDrive = await this.exclusive(async () => {
      const status = this.statusOf(name);
      if (status === "behind" || status === "diverged" || status === "conflict") {
        throw new Error(`Drive has changes to "${name}" that aren't here yet: sync it first`);
      }
      if (this.meta.scenes[name]?.renamedFrom) {
        throw new Error(`The rename of "${name}" is not in Drive yet. Try again once it is`);
      }
      // out of Drive first: if that fails, nothing changed here
      const there = !!this.remoteMd5Of(name);
      if (there) {
        await this.drive.remove(name);
        this.updateRemoteMd5(name, null);
      }
      this.makeLocalOnly(name);
      const meta = this.sceneMeta(name);
      meta.baseMd5 = null;
      meta.keptLocal = true;
      delete meta.remoteMd5;
      this.persistMeta();
      this.refresh();
      return there;
    });
    this.log("info", `"${name}" is only in this browser now${inDrive ? " (removed from Google Drive)" : ""}`);
    void this.syncNow({ refresh: true });
  };

  /** the user puts a scene in Drive (the cloud icon): local only or not, it is uploaded now */
  putInDrive = async (name: string) => {
    await this.ready;
    if (this.isLocalOnly(name)) {
      await this.setLocalOnly(name, false);
      return;
    }
    const meta = this.sceneMeta(name);
    if (!meta.baseMd5) {
      meta.adopt = true;
      this.persistMeta();
    }
    if (name === this.meta.current) {
      this.pushCurrentNow = true;
    }
    void this.syncNow();
  };

  /** the user's answer at sign-in: these go to Drive, the others stay here (not asked again) */
  decideSignIn = async (toDrive: string[], keep: string[]) => {
    for (const name of keep) {
      const meta = this.meta.scenes[name];
      if (meta) {
        meta.keptLocal = true;
        delete meta.moveOnSignIn;
      }
    }
    this.persistMeta();
    for (const name of toDrive) {
      await this.putInDrive(name).catch((error) => this.log("error", `"${name}" not put in Drive: ${error.message}`)); // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
    }
  };

  setNewScenesLocalOnly = (on: boolean) => {
    this.meta.newLocalOnly = on;
    this.persistMeta();
    this.refresh();
  };

  /** same element changed here and in Drive: newest edit wins, or ask */
  clashMode() {
    return this.meta.clashes ?? "newest";
  }

  setClashMode = (mode: "newest" | "ask") => {
    this.meta.clashes = mode;
    this.persistMeta();
    this.refresh();
    if (mode === "newest") {
      void this.syncNow(); // open conflicts settle now
    }
  };

  setGlobalAutoSync = (on: boolean) => {
    this.meta.autoSync = on;
    this.persistMeta();
    this.setState({ autoSync: on });
    this.log("info", `Auto-sync ${on ? "on" : "off"}`);
    if (on) {
      void this.syncNow({ refresh: true });
    }
  };

  /** per-scene override; undefined = follow the global switch */
  setSceneAutoSync = (name: string, on: boolean | undefined) => {
    const meta = this.sceneMeta(name);
    if (on === undefined) {
      delete meta.autoSync;
    } else {
      meta.autoSync = on;
    }
    this.persistMeta();
    this.refresh();
    if (this.autoSyncFor(name)) {
      void this.syncNow();
    }
  };

  /**
   * Keep a scene only in this browser (never pushed or pulled), or sync it
   * again. A copy already in Drive stays there unchanged meanwhile; when
   * syncing is turned on again, both versions are merged as usual.
   */
  /** the user keeps it here (their own choice: not "made while signed out" any more) */
  private makeLocalOnly(name: string) {
    const meta = this.sceneMeta(name);
    delete meta.moveOnSignIn;
    meta.localOnly = true;
  }

  setLocalOnly = (name: string, on: boolean) =>
    this.exclusive(async () => {
      await this.ready;
      const meta = this.sceneMeta(name);
      if (on === !!meta.localOnly) {
        return;
      }
      if (on && meta.conflict) {
        throw new Error(`"${name}" has a conflict: resolve it first`);
      }
      if (on && meta.renamedFrom) {
        throw new Error(`The rename of "${name}" is not in Drive yet. Try again once it is`);
      }
      if (on) {
        this.makeLocalOnly(name);
      } else {
        delete meta.moveOnSignIn; // the user's own choice: not "made while signed out" any more
        delete meta.localOnly;
        delete meta.keptLocal;
        if (!meta.baseMd5) {
          // not in Drive: uploaded with the next sync even without changes
          meta.adopt = true;
        }
      }
      this.persistMeta();
      this.refresh();
      let message: string;
      if (on) {
        const suffix = this.remoteMd5Of(name) ? " (the copy there stays as it is)" : "";
        message = `"${name}" is local only now: not synced to Drive${suffix}`;
      } else {
        message = `"${name}" is synced with Drive again`;
      }
      this.log("info", message);
    }).then(() => {
      if (!on && this.autoSyncFor(name)) {
        if (name === this.meta.current) {
          this.pushCurrentNow = true;
        }
        void this.syncNow();
      }
    });

  // ---------------------------------------------------------------------------
  // the pen (online/pen.ts): one editor at a time on a Drive scene. While
  // someone else holds it, the open scene is read only in this tab: it
  // follows their changes live and their saves in Drive, and this tab never
  // writes it (docs/relay/CONCEPT.md).
  // ---------------------------------------------------------------------------

  /** the Drive file of a scene (its shared space's file, or the listing's) */
  fileIdOf(name: string | null) {
    if (name === null) {
      return undefined;
    }
    return this.listedOf(name)?.id ?? (sharedFileId && !this.meta.scenes[name]?.localOnly ? sharedFileId : undefined);
  }

  /** who holds the pen while this tab may not write the open scene (null: it may) */
  private penHolder: string | null = null;

  /** what the pen hears from here: a save of the open scene, a version pulled from Drive while following */
  penHooks: { saved: (name: string, md5: string, hash: number | null) => void; pulled: (name: string) => void } | null = null;

  /** someone else holds the pen (their name): the open scene is read only here; null: this tab may write it again */
  setPenLock(holder: string | null) {
    if (holder !== this.penHolder) {
      this.penHolder = holder;
      this.refresh();
    }
  }

  /** who holds the pen of the open scene, if not this tab */
  penLock() {
    return this.penHolder;
  }

  private penBlocks(name: string | null) {
    return name !== null && name === this.meta.current && this.penHolder !== null;
  }

  /** the holder saved: its version is the base here too (this canvas follows it live) */
  penAdoptSaved(md5: string, hash: number | null) {
    const name = this.meta.current;
    if (name === null || this.isLocalOnly(name)) {
      return;
    }
    const meta = this.sceneMeta(name);
    meta.baseMd5 = md5;
    meta.remoteMd5 = md5;
    this.updateRemoteMd5(name, md5);
    if (hash !== null) {
      this.meta.baseline = hash;
    }
    this.persistMeta();
    this.recomputeDirty();
  }

  /** the open scene's version in Drive and the canvas hash it has (the holder's catch-up names it) */
  penSavedVersion() {
    const name = this.meta.current;
    const md5 = name === null ? null : this.meta.scenes[name]?.baseMd5;
    return md5 ? { md5, hash: this.meta.baseline } : null;
  }

  /** the holder's changes go to Drive now (before it hands the pen over or stops): the saved version */
  penSaveNow = async () => {
    await this.ready;
    const name = this.meta.current;
    if (name === null || this.isLocalOnly(name)) {
      return null;
    }
    if (this.state.dirty || this.statusOf(name) !== "synced") {
      await this.exclusive(() => this.pushScene(name, { manual: true }));
    }
    const meta = this.meta.scenes[name];
    return meta?.baseMd5 ? { md5: meta.baseMd5, hash: this.meta.baseline } : null;
  };

  /**
   * Edits made here without the pen (offline, or while the relay was not
   * reachable) are merged into Drive (element by element; the same element
   * changed on both sides keeps both) before this tab turns read only:
   * nothing is lost.
   */
  penFlushOwn = async () => {
    await this.ready;
    const name = this.meta.current;
    if (name === null || this.isLocalOnly(name) || !this.state.dirty) {
      return;
    }
    await this.refreshListing();
    const status = this.statusOf(name);
    if (status === "diverged" || status === "conflict") {
      await this.exclusive(() => this.mergeScene(name, { pushAfter: true }));
    } else {
      this.pushCurrentNow = true;
      await this.exclusive(() => this.pushScene(name));
    }
  };

  /** read only while someone else holds the pen: Drive's newer version replaces the canvas (the pen asks the holder for the rest) */
  private async followDrive(name: string) {
    let latest;
    try {
      latest = await this.drive.load(name);
    } catch {
      return;
    }
    if (!this.penBlocks(name)) {
      return;
    }
    await this.writeLocal(name, latest.json, { dirty: false });
    this.setBase(name, latest.version);
    this.penHooks?.pulled(name);
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // local content
  // ---------------------------------------------------------------------------

  /**
   * A comment the user added or changed (comments/store.ts) is saved with the
   * open scene (this controller's own save: it makes the scene dirty). A
   * scene that is read only here (Drive's commenters, or someone else holds
   * the pen) takes no comments here; false: not here.
   */
  private writeComment(comment: SceneComment) {
    if (!this.api || this.state.busy === "loading" || this.penHolder !== null) {
      return false;
    }
    if (this.state.sync.readOnly && !this.isLocalOnly(this.meta.current)) {
      return false;
    }
    this.recomputeDirty();
    // the canvas survives a reload by itself (Excalidraw stores it), comments only in the scene's
    // stored copy: written now, not only when the scene is left
    this.stashCurrent()
      .then(() => this.persistMeta())
      .catch((error) => console.error("[scenes] could not store the comment", error));
    return true;
  }

  /** whether the user can comment on the open scene here now (when it can be saved from this tab) */
  canComment() {
    if (!this.api || this.penHolder !== null) {
      return false;
    }
    return !this.state.sync.readOnly || this.isLocalOnly(this.meta.current);
  }

  private requireApi() {
    if (!this.api) {
      throw new Error("Editor not ready");
    }
    return this.api;
  }

  private serializeCurrent() {
    const api = this.requireApi();
    const elements = api.getSceneElements();
    const appState = api.getAppState();
    return {
      json: withComments(withFonts(serializeAsJSON(elements, appState, api.getFiles(), "local"), elements), commentStore.editorList()),
      hash: sceneHash(elements, appState, commentStore.editorList()),
      isEmpty: elements.length === 0 && !(appState as any).kurviqPresentation,
    };
  }

  /** current content of a scene: the canvas if active, else its snapshot */
  private async localJson(name: string): Promise<string | null> {
    if (name === this.meta.current) {
      return this.serializeCurrent().json;
    }
    return (await getSnapshot(name))?.json ?? null;
  }

  /** a scene has no elements here (the open one: read from the editor, not serialized) */
  private async isEmptyHere(name: string) {
    if (name === this.meta.current && this.api) {
      return this.api.getSceneElements().length === 0;
    }
    const json = (await getSnapshot(name))?.json;
    return !json || isEmptyJson(json);
  }

  /** the open scene as a stored snapshot ("Move my browser scenes"); changes nothing */
  openSceneSnapshot(): { metaKey: string; name: string | null; snapshot: { json: string; baseline: number | null; dirty: boolean } } | null {
    if (!this.api) {
      return null;
    }
    const { json, isEmpty } = this.serializeCurrent();
    const name = this.meta.current;
    if (name === null && isEmpty) {
      return null;
    }
    return { metaKey: META_KEY, name, snapshot: { json, baseline: name === null ? null : this.meta.baseline, dirty: name === null || this.state.dirty } };
  }

  /** stash the active scene into IndexedDB before switching away from it */
  private async stashCurrent() {
    const { json, isEmpty } = this.serializeCurrent();
    const name = this.meta.current;
    if (name === null) {
      if (isEmpty) {
        await deleteSnapshot(null);
        delete this.meta.scenes[UNTITLED];
      } else {
        await setSnapshot(null, { json, baseline: null, dirty: true });
        this.meta.scenes[UNTITLED] = { baseMd5: null, dirty: true };
      }
    } else {
      const dirty = this.state.dirty;
      await setSnapshot(name, { json, baseline: this.meta.baseline, dirty });
      this.sceneMeta(name).dirty = dirty;
    }
    this.persistMeta();
  }

  private cacheCanvasPresentation(appState: AppState) {
    const content = appState as AppState & { kurviqPresentation?: boolean; kurviqPresentationAt?: number };
    if (appState.isLoading || typeof content.kurviqPresentation !== "boolean" ||
      (this.meta.current !== null && appState.name !== this.meta.current)) {
      return false;
    }
    const presentation = this.rememberPresentation({ appState }, this.meta.current);
    if (content.kurviqPresentation === presentation.kurviqPresentation &&
      (content.kurviqPresentationAt ?? 0) === presentation.kurviqPresentationAt) {
      return false;
    }
    this.requireApi().updateScene({ appState: presentation as any, captureUpdate: CaptureUpdateAction.NEVER });
    return true;
  }

  private rememberPresentation(data: any, name: string | null) {
    const scene = this.sceneMeta(name ?? UNTITLED);
    const presentation = restorePresentation(data, scene);
    if (scene.kurviqPresentation !== presentation.kurviqPresentation ||
      scene.kurviqPresentationAt !== presentation.kurviqPresentationAt) {
      Object.assign(scene, presentation);
      this.persistMeta();
    }
    return restorePresentation({ appState: scene }, null);
  }

  private presentationMigrationBaseline: number | null = null;

  private applyScene(json: string | null, name: string | null, { keepView = false } = {}) {
    const api = this.requireApi();
    const data = json ? JSON.parse(json) : {};
    this.presentationMigrationBaseline = json && typeof data.appState?.kurviqPresentation !== "boolean" ? hashJson(json) : null;
    // its custom fonts (the canvas redraws once they are loaded)
    registerSceneFonts(data).catch((error) => console.error("[scenes] could not load scene fonts", error));
    // its comments (before anything compares the canvas with the file)
    commentStore.load(data.kurviqComments);
    const elements = restoreElements(data.elements, null, { repairBindings: true });
    const restoredAppState = restoreAppState(data.appState, null);
    const files: BinaryFiles = data.files || {};

    const sceneAppState = {
      ...this.rememberPresentation(data, name),
      name: name ?? restoredAppState.name,
      viewBackgroundColor: restoredAppState.viewBackgroundColor,
      gridSize: restoredAppState.gridSize,
      gridStep: restoredAppState.gridStep,
      gridModeEnabled: restoredAppState.gridModeEnabled,
    };
    if (keepView) {
      api.updateScene({ elements, appState: sceneAppState as any, captureUpdate: CaptureUpdateAction.NEVER });
    } else {
      api.updateScene({
        elements,
        appState: { ...sceneAppState, selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null } as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    const fileList = Object.values(files) as BinaryFileData[];
    if (fileList.length) {
      api.addFiles(fileList);
    }
  }

  /** after loading a base version of the open scene `name` into the canvas: it is the new baseline */
  private async setBaselineFromCanvas(name: string | null) {
    await editorYield();
    if (name !== this.meta.current) {
      return; // switched meanwhile: the canvas shows another scene
    }
    const api = this.requireApi();
    this.meta.baseline = this.presentationMigrationBaseline ?? sceneHash(api.getSceneElements(), api.getAppState(), commentStore.editorList());
    this.presentationMigrationBaseline = null;
    this.persistMeta();
    this.recomputeDirty();
  }

  /** store a scene's content locally (canvas if active, else snapshot) */
  private async writeLocal(name: string, json: string, { dirty }: { dirty: boolean }) {
    if (name === this.meta.current) {
      this.applyScene(json, name, { keepView: true });
      if (dirty) {
        await editorYield();
        this.recomputeDirty();
      } else {
        await this.setBaselineFromCanvas(name);
      }
      // the canvas survives a reload by itself, its comments only in the stored copy (else a reload
      // brings back the old comments and the next save writes them over the new ones)
      if (name === this.meta.current) {
        await this.stashCurrent();
      }
    } else {
      await setSnapshot(name, { json, baseline: dirty ? null : hashJson(json), dirty });
    }
    this.sceneMeta(name).dirty = dirty;
  }

  /**
   * The home's `version` is the scene's base now (and the latest known
   * there); `settled`: its conflict is over. Stored right away.
   */
  private setBase(name: string, version: HomeVersion, { settled = false } = {}) {
    const meta = this.sceneMeta(name);
    meta.baseMd5 = version;
    meta.remoteMd5 = version;
    if (settled) {
      delete meta.conflict;
    }
    this.persistMeta();
  }

  // ---------------------------------------------------------------------------
  // user actions
  // ---------------------------------------------------------------------------

  private async withBusy<T>(busy: ScenesState["busy"], fn: () => Promise<T>): Promise<T> {
    await this.ready;
    return this.exclusive(async () => {
      this.setState({ busy, error: null });
      try {
        return await fn();
      } catch (error: any) {
        console.error(error);
        this.setState({ error: error.message });
        throw error;
      } finally {
        this.setState({ busy: null });
      }
    });
  }

  /**
   * Switch to a scene (null = untitled draft), in the queue's priority lane:
   * after the operation that is running, before the sync steps waiting, so
   * no sync step of the scene being left runs between stashing it and
   * showing the new one. Opens run one at a time, in the order asked.
   */
  open = async (name: string | null, { missingIsFine = false }: { missingIsFine?: boolean } = {}) => {
    if (name !== null && name !== this.meta.current) {
      this.setState({ opening: name });
    }
    await this.ready;
    return this.exclusive(async () => {
      this.setState({ busy: "loading", error: null });
      try {
        return await this.openInner(name);
      } catch (error: any) {
        // "not found" while opening-or-creating is the cue to create it, no error
        if (!(missingIsFine && error?.status === 404)) {
          console.error(error);
          this.setState({ error: error.message });
        }
        throw error;
      } finally {
        this.setState({ busy: null, ...(this.state.opening === name ? { opening: null } : {}) });
      }
    }, { priority: true });
  };

  /** editing is locked while a just-opened local copy is checked against Drive */
  private openLock: { token: number; viewMode: boolean } | null = null;
  private openToken = 0;

  private releaseOpenLock() {
    if (this.openLock) {
      this.requireApi().updateScene({
        appState: { viewModeEnabled: this.openLock.viewMode },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      this.openLock = null;
      this.setState({ checking: false });
    }
  }

  /**
   * The local copy is on screen (read-only); ask Drive for a newer version.
   * Editing unlocks when Drive answers, or after CHECK_LOCK_MS at the latest
   * (then the sync merges whatever comes later).
   */
  private checkOpenedScene(name: string) {
    const api = this.requireApi();
    const token = ++this.openToken;
    // a scene opened while the last one is still being checked: the mode from
    // before that check comes back, not the check's own view mode (else the
    // editor would stay read-only)
    this.openLock = { token, viewMode: this.openLock?.viewMode ?? api.getAppState().viewModeEnabled };
    api.updateScene({ appState: { viewModeEnabled: true }, captureUpdate: CaptureUpdateAction.NEVER });
    this.setState({ checking: true });
    const release = () => {
      if (this.openLock?.token === token) {
        this.releaseOpenLock();
      }
    };
    const timer = window.setTimeout(release, CHECK_LOCK_MS);
    this.drive
      .load(name)
      .then((latest) =>
        // in the queue: no sync step or open runs while it is applied
        this.exclusive(async () => {
          if (this.openToken !== token || this.meta.current !== name || this.isDirty(name)) {
            return; // switched on, or edited after the unlock: sync takes it from here
          }
          this.updateRemoteMd5(name, latest.version);
          if (latest.version === this.meta.scenes[name]?.baseMd5) {
            return; // the local copy is up to date
          }
          this.applyScene(latest.json, name, { keepView: true });
          this.sceneMeta(name).dirty = false;
          this.setBase(name, latest.version);
          await this.setBaselineFromCanvas(name);
          if (name === this.meta.current) {
            await this.stashCurrent(); // its comments for a reload (see writeLocal)
          }
          this.log("pull", `Updated "${name}" from Drive`);
          this.refresh();
        }),
      )
      .catch(() => {}) // offline: the local copy it is
      .finally(() => {
        window.clearTimeout(timer);
        release();
      });
  }

  /** a scene made here and never in Drive (it has no stored copy when it was empty): it opens empty */
  private onlyInThisBrowser(name: string, meta: SceneMeta | undefined) {
    return !!meta && (meta.localOnly || !meta.baseMd5) && !this.state.remote?.some((scene) => scene.name === name);
  }

  private async loadFromHomeOrEmpty(name: string, meta: SceneMeta | undefined): Promise<{ json: string | null; version: HomeVersion | null }> {
    const onlyHere = this.onlyInThisBrowser(name, meta);
    if (onlyHere && meta?.localOnly) {
      return { json: null, version: null };
    }
    try {
      return await this.drive.load(name);
    } catch (error: any) {
      if (onlyHere && error?.status === 404) {
        return { json: null, version: null };
      }
      throw error;
    }
  }

  private async loadOpeningScene(name: string | null) {
      const snapshot = await getSnapshot(name);
      let json: string | null = null;
      let baseline: number | null = null;
      let loadedMd5: string | null = null;
      let checkDrive = false;
      const meta = name === null ? undefined : this.meta.scenes[name];

      if (name === null || (snapshot && (snapshot.dirty || meta?.conflict))) {
        // local changes win; sync takes care of Drive
        json = snapshot?.json ?? null;
        baseline = snapshot?.baseline ?? null;
      } else if (this.state.sync.driveOnline === false) {
        if (snapshot) {
          json = snapshot.json;
        } else if (!this.onlyInThisBrowser(name, meta)) {
          throw Object.assign(
            new Error(`"${name}" was never downloaded to this browser and Drive is not reachable`),
            { status: 503 },
          );
        } // else: an empty scene that was never in Drive, nothing to download
      } else if (snapshot) {
        // show the local copy (no local changes) right away, check Drive in
        // the background; it is its own base
        json = snapshot.json;
        checkDrive = true;
      } else {
        // never opened here: Drive's version is all there is
        const latest = await this.loadFromHomeOrEmpty(name, meta);
        json = latest.json;
        loadedMd5 = latest.version;
      }

    return { json, baseline, loadedMd5, checkDrive };
  }

  /**
   * Switch the canvas to `name` (inside an operation of the queue). The new
   * scene is loaded first (from Drive if it was never here): if that fails,
   * the open scene stays as it is. The open scene is stashed right before the
   * new one is shown, with every edit made while the new one loaded.
   */
  private async openInner(name: string | null, { stash = true, force = false } = {}) {
      if (name === this.meta.current && !force) {
        return;
      }
      const { json, baseline, loadedMd5, checkDrive } = await this.loadOpeningScene(name);

      this.releaseOpenLock();
      ++this.openToken; // a pending check of the previous scene must not apply
      if (stash) {
        this.recomputeDirty(); // edits made while the new scene loaded (changes aren't tracked while loading)
        await this.stashCurrent();
      }
      this.applyScene(json, name);
      this.meta.current = name;
      this.meta.baseline = baseline;
      if (name !== null && loadedMd5) {
        const sceneMeta = this.sceneMeta(name);
        sceneMeta.baseMd5 = loadedMd5;
        sceneMeta.remoteMd5 = loadedMd5;
        sceneMeta.dirty = false;
      }
      this.persistMeta();
      this.refresh();
      if (name === null) {
        await deleteSnapshot(null);
      }
      if (baseline === null && name !== null && this.meta.scenes[name]?.baseMd5) {
        await this.setBaselineFromCanvas(name);
      } else {
        await editorYield();
        this.recomputeDirty();
      }
      if (loadedMd5) {
        await this.stashCurrent(); // its comments for a reload (see writeLocal)
      }
      const api = this.requireApi();
      const elements = api.getSceneElements();
      if (elements.length) {
        // with room around it: clear of the toolbars, not touching the edges
        const { width, height } = api.getAppState();
        const vertical = Math.max(72, Math.round(height * 0.1));
        const horizontal = Math.max(24, Math.round(width * 0.06));
        // 5% lower than centered: clear of the toolbar, with room for a frame's name above it
        const shift = Math.round(height * 0.05);
        api.setViewport({
          target: elements,
          fit: "scale-down",
          offsets: { top: vertical + shift, bottom: Math.max(48, vertical - shift), left: horizontal, right: horizontal },
        });
      }
      if (checkDrive && name !== null) {
        this.checkOpenedScene(name);
      }
  }

  /**
   * The scene's Drive file, for sharing: unsaved changes go to Drive first
   * (a scene that is only in this browser can't be shared).
   */
  readonly fileForSharing = (name: string) =>
    this.withBusy("saving", async () => {
      if (this.isLocalOnly(name)) {
        throw new Error(`"${name}" is kept in this browser only: sync it with Google Drive first`);
      }
      if (this.isDirty(name) || this.statusOf(name) !== "synced") {
        await this.pushScene(name, { manual: true });
      }
      await this.refreshListing();
      const fileId = this.listedOf(name)?.id;
      if (!fileId) {
        throw new Error(`"${name}" is not in Google Drive yet`);
      }
      return fileId;
    });

  /**
   * Online: this tab switches to another space (the page reloads into its
   * own storage). The open scene is kept, and the canvas is marked so the
   * other space doesn't take it for one of its scenes.
   */
  leaveForReload = () =>
    this.exclusive(async () => {
      await this.ready;
      await this.stashCurrent();
      this.persistMeta();
      const api = this.api;
      this.detach();
      api?.updateScene({ elements: [], appState: { name: "", kurviqPresentation: false } as any, captureUpdate: CaptureUpdateAction.NEVER });
    });

  /** create a new, empty named scene and switch to it */
  create = (name: string, options?: { localOnly?: boolean }) =>
    this.withBusy("loading", async () => {
      const localOnly = options?.localOnly ?? this.newScenesLocalOnly();
      this.validateName(name);
      if (this.exists(name)) {
        throw new Error(`A scene named "${name}" already exists`);
      }
      await this.stashCurrent();
      await deleteSnapshot(name);
      this.applyScene(null, name);
      this.meta.current = name;
      this.meta.baseline = null;
      this.meta.scenes[name] = localOnly
        ? { baseMd5: null, dirty: false, localOnly, ...(options?.localOnly === undefined ? this.madeSignedOut() : {}) }
        : this.claimName(name, false);
      this.persistMeta();
      await editorYield();
      this.refresh();
      this.recomputeDirty();
    });

  /**
   * Open a scene, or create it (empty) if it doesn't exist anywhere.
   * `elsewhere` (a scene link): before a missing scene is created, where else
   * it may be (a shared folder, see sceneElsewhere); the tab then goes there.
   * True if it was created (a new, empty scene).
   */
  openOrCreate = async (name: string, { elsewhere }: { elsewhere?: (name: string) => Promise<(() => void) | null> } = {}) => {
    if (name === this.meta.current) {
      return false;
    }
    // its name from the start (the link names it), not "Untitled" while it loads
    this.setState({ opening: name });
    let result: (() => void) | "created" | null = null;
    try {
      result = await this.openOrCreateInner(name, elsewhere);
    } finally {
      if (this.state.opening === name && typeof result !== "function") {
        this.setState({ opening: null });
      }
    }
    if (typeof result === "function") {
      await this.leaveForReload();
      result();
    }
    return result === "created";
  };

  private readonly openOrCreateInner = async (name: string, elsewhere?: (name: string) => Promise<(() => void) | null>) => {
    // online without Drive: there is nowhere else to look, a new scene right away
    if (!this.exists(name) && this.state.sync.notConnected) {
      await this.create(name);
      return "created" as const;
    }
    try {
      await this.open(name, { missingIsFine: true });
    } catch (error: any) {
      // not in Drive, or no Drive to look in (signed out, or not known yet at the first navigation): a new scene
      if (error.status !== 404 && !error.notConnected) {
        throw error;
      }
      const go = elsewhere && !error.notConnected ? await elsewhere(name).catch(() => null) : null;
      if (go) {
        return go;
      }
      await this.create(name);
      return "created" as const;
    }
    return null;
  };

  private exists(name: string) {
    return (
      Object.hasOwn(this.meta.scenes, name) ||
      (!!this.state.remote?.some((scene) => scene.name === name) &&
        !this.hiddenRemoteNames().has(name))
    );
  }

  /**
   * metadata for a new local scene. If a scene of that name was deleted here
   * and the deletion is not in Drive yet, the new scene simply replaces it
   * there (based on the deleted version) instead of deleting + re-adding.
   */
  private claimName(name: string, dirty: boolean): SceneMeta {
    const deletedMd5 = this.meta.pendingDeletes[name];
    if (deletedMd5) {
      delete this.meta.pendingDeletes[name];
      return { baseMd5: deletedMd5, remoteMd5: deletedMd5, dirty: true };
    }
    return { baseMd5: null, dirty };
  }

  private validateName(name: string) {
    const problem = sceneNameProblem(name);
    if (problem) {
      throw new Error(problem);
    }
  }

  private async saveAs(targetName: string, keepLocal: boolean, localOnly: boolean | undefined) {
    if (this.exists(targetName)) {
      throw new Error(`A scene named "${targetName}" already exists`);
    }
    const api = this.requireApi();
    const { json } = this.serializeCurrent();
    const wasUntitled = this.meta.current === null;
    if (wasUntitled) {
      await deleteSnapshot(null); // the untitled draft becomes a named scene
    } else {
      await this.stashCurrent(); // "save as": the previous scene keeps its state
    }
    await setSnapshot(targetName, { json, baseline: null, dirty: true });
    // no await from here on: the metadata is stored as one change
    if (wasUntitled) {
      delete this.meta.scenes[UNTITLED];
    }
    this.meta.current = targetName;
    this.meta.baseline = null;
    this.meta.scenes[targetName] = keepLocal
      ? { baseMd5: null, dirty: true, localOnly: true, ...(localOnly === undefined ? this.madeSignedOut() : {}) }
      : this.claimName(targetName, true);
    api.updateScene({ appState: { name: targetName }, captureUpdate: CaptureUpdateAction.NEVER });
    this.persistMeta();
    this.setState({ dirty: true });
  }

  /**
   * Push the active scene now. With `name`: name an untitled scene, or
   * "save as" under a new name.
   */
  save = (name?: string, { localOnly }: { localOnly?: boolean } = {}) =>
    this.withBusy("saving", async () => {
      const targetName = name ?? this.meta.current;
      // "save as" of a local-only scene stays local only (unless said otherwise)
      const keepLocal =
        localOnly ?? (this.meta.current === null ? this.newScenesLocalOnly() : this.isLocalOnly(this.meta.current));
      if (targetName === null) {
        throw new Error("Scene needs a name");
      }
      this.validateName(targetName);
      if (targetName !== this.meta.current) {
        await this.saveAs(targetName, keepLocal, localOnly);
      }
      if (this.isLocalOnly(targetName)) {
        return { name: targetName, localOnly: true }; // the browser keeps it, nothing to push
      }
      const result = await this.pushScene(targetName, { manual: true });
      if (this.meta.scenes[targetName]?.conflict) {
        throw new Error(
          `"${targetName}" has conflicting changes in Drive: resolve them in the Scenes sidebar`,
        );
      }
      return { name: targetName, ...result };
    });

  // ---------------------------------------------------------------------------
  // sync engine
  // ---------------------------------------------------------------------------

  private syncing = false;
  private syncAgain = false;

  /** Drive's listing: true if Drive answered (sync can go on) */
  private async refreshSyncListing(refresh: boolean) {
    let listing;
    try {
      listing = await this.drive.list(refresh);
    } catch (error: any) {
      if (error.notConnected) {
        this.setState({ sync: { ...this.state.sync, driveOnline: false, notConnected: true, lastError: null } });
        return false;
      }
      if (this.state.sync.driveOnline !== false) {
        this.log("error", `Drive not reachable: working locally (${error.message})`);
      }
      this.setState({ sync: { ...this.state.sync, driveOnline: false, lastError: error.message } });
      return false;
    }
    const wasOnline = this.state.sync.driveOnline;
    const { status } = listing;
    this.applyListing(listing.scenes);
    this.setState({
      sync: {
        ...this.state.sync,
        notConnected: false,
        readOnly: status.readOnly ?? null,
        driveOnline: status.online,
        lastCheckedAt: status.lastFetchAt,
        lastError: status.lastError,
      },
    });
    if (status.online === false) {
      if (wasOnline !== false) {
        this.log("error", `Drive not reachable: working locally (${status.lastError})`);
      }
      return false;
    }
    if (wasOnline === false) {
      this.log("info", "Drive reachable again");
    }
    return true;
  }

  private async pullReadOnlyScenes() {
    // Drive lets this user read the space, not change it: only pull
    for (const item of this.state.list) {
      if (item.name !== null && this.statusOf(item.name) === "behind" && !this.isDirty(item.name)) {
        await this.exclusive(() => this.pullScene(item.name!)); // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
      }
    }
  }

  private async pushListedScene(name: string, status: SyncStatus, adopt: boolean) {
    if (name === this.meta.current && !this.pushDue()) {
      return;
    }
    if (status === "local" && (await this.isEmptyHere(name))) {
      return; // don't publish empty new scenes automatically
    }
    await this.exclusive(() => this.pushScene(name));
    if (adopt && this.meta.scenes[name]?.baseMd5) {
      delete this.meta.scenes[name].adopt;
      this.persistMeta();
    }
  }

  private async syncListedScene(item: SceneListItem) {
    const name = item.name;
    if (name === null || !this.autoSyncFor(name)) {
      return;
    }
    const status = this.statusOf(name);
    if (this.penBlocks(name)) {
      // someone else holds the pen: this tab follows Drive, never writes
      if (status === "behind" || status === "diverged") {
        await this.exclusive(() => this.followDrive(name));
      }
      return;
    }
    const adopt = !!this.meta.scenes[name]?.adopt;
    if (adopt && status !== "local") {
      // Drive has it: its copy counts from now on (pulled below, or merged if changed here)
      delete this.meta.scenes[name].adopt;
      this.persistMeta();
    }
    if (status === "behind") {
      await this.exclusive(() => this.pullScene(name));
    } else if (status === "ahead" || (status === "local" && (this.isDirty(name) || adopt))) {
      await this.pushListedScene(name, status, adopt);
    } else if (status === "diverged") {
      await this.exclusive(() => this.mergeScene(name));
    } else if (status === "conflict" && this.conflictOutdated(name)) {
      // Drive moved on, or found by an older merge: maybe it merges now
      await this.exclusive(() => this.mergeScene(name));
    }
  }

  /** check Drive and (with auto-sync) push / pull / merge what's needed */
  syncNow = async ({ refresh = false }: { refresh?: boolean } = {}) => {
    await this.ready;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    this.setState({ sync: { ...this.state.sync, running: true } });
    try {
      if (!(await this.refreshSyncListing(refresh))) return;

      if (this.state.sync.readOnly) {
        await this.pullReadOnlyScenes();
        return;
      }

      // renames / deletions made here (e.g. while offline) go first: they
      // are explicit user actions, independent of auto-sync
      await this.exclusive(() => this.pushPendingOps());
      await this.exclusive(() => this.adoptEmptyLocalOnly());
      await this.exclusive(async () => this.dropScenesDeletedInDrive());

      for (const item of this.state.list) {
        await this.syncListedScene(item); // NOSONAR S9382: in order on purpose (each scene updates sync metadata)
      }
    } catch (error: any) {
      console.error(error);
      this.log("error", error.message);
    } finally {
      this.syncing = false;
      this.setState({ sync: { ...this.state.sync, running: false } });
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.syncNow();
      }
    }
  };

  /**
   * An empty local-only scene (e.g. opened by URL) whose name now exists on
   * Drive (an agent drew it): it takes the Drive version and syncs.
   */
  private async adoptEmptyLocalOnly() {
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (!meta.localOnly || !this.state.remote?.some((scene) => scene.name === name)) {
        continue;
      }
      if (!(await this.isEmptyHere(name))) { // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
        continue;
      }
      const record = this.meta.scenes[name]; // (looked up again: the metadata may have been taken over meanwhile)
      if (!record?.localOnly) {
        continue;
      }
      delete record.localOnly;
      record.baseMd5 = null;
      record.dirty = false;
      this.persistMeta();
      this.log("info", `"${name}" now exists in Drive, loading it`);
    }
    this.refresh();
  }

  private conflictOutdated(name: string) {
    const conflict = this.meta.scenes[name]?.conflict;
    const remote = this.remoteMd5Of(name);
    return (
      !!conflict &&
      (this.clashMode() === "newest" || conflict.v !== MERGE_VERSION || (!!remote && remote !== conflict.remoteMd5))
    );
  }

  private pushDue() {
    return this.pushCurrentNow || Date.now() - this.lastChangeAt >= IDLE_PUSH_MS;
  }

  private maybePushCurrent() {
    const name = this.meta.current;
    if (name !== null && this.state.dirty && this.autoSyncFor(name) && !this.penBlocks(name) && this.pushDue()) {
      void this.syncNow();
    }
  }

  private applyListing(scenes: ListedScene[]) {
    const remote = new Map(scenes.map((scene) => [scene.name, scene.version]));
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name !== UNTITLED) {
        meta.remoteMd5 = remote.get(driveNameOf(this.meta, name)) ?? null;
      }
    }
    this.persistMeta();
    this.setState({ remote: scenes });
  }

  private canPushToDrive(name: string, manual: boolean) {
    if (this.isLocalOnly(name)) {
      return false; // never leaves this browser
    }
    if (this.penBlocks(name)) {
      // someone else holds the pen: never a second writer
      if (manual) {
        throw new Error(this.penHolder ? `${this.penHolder} is editing "${name}": your view follows their changes` : `"${name}" is read only here: click "Edit" first`);
      }
      return false;
    }
    if (this.state.sync.readOnly) {
      if (manual) {
        throw new Error(`Saved in this browser only. Read only: ${this.state.sync.readOnly}`);
      }
      return false;
    }
    return true;
  }

  private canPushCanvas(name: string, manual: boolean, isCurrent: boolean) {
    if (isCurrent && this.requireApi().getAppState().name !== name) {
      // the canvas shows another scene's drawing: never push it under this name
      const message = `Not saved to Drive: this tab's canvas belongs to "${this.requireApi().getAppState().name}", not "${name}". Reload the tab.`;
      this.log("error", message);
      if (manual) {
        throw new Error(message);
      }
      return false;
    }
    return true;
  }

  private async handlePushError(name: string, manual: boolean, apiError: HomeError) {
    if (apiError.status === 409) {
      this.sceneMeta(name).remoteMd5 = apiError.remoteVersion ?? null;
      this.persistMeta();
      this.updateRemoteMd5(name, apiError.remoteVersion ?? null);
      this.log("info", `"${name}" changed in Drive meanwhile, merging`);
      await this.mergeScene(name, { pushAfter: true });
      return null;
    }
    if (apiError.notConnected) {
      this.setState({ sync: { ...this.state.sync, driveOnline: false, notConnected: true } });
      if (manual) {
        throw new Error("Saved in this browser. Sign in with Google to sync it");
      }
      return null;
    }
    if (apiError.readOnly) {
      // Drive refused for good (the sharing changed): stop pushing
      this.setState({ sync: { ...this.state.sync, readOnly: apiError.message.replace(/^Read only: /, "") } });
      this.log("error", apiError.message);
      if (manual) {
        throw new Error(`Saved in this browser only. ${apiError.message}`);
      }
      return null;
    }
    if (apiError.offline) {
      this.setState({ sync: { ...this.state.sync, driveOnline: false } });
      if (manual) {
        throw new Error(`Saved locally. Drive not reachable, will sync when back online`);
      }
      return null;
    }
    this.log("error", `Push of "${name}" failed: ${apiError.message}`);
    if (manual) {
      throw apiError;
    }
    return null;
  }

  /**
   * Drive has what was pushed: it is the scene's base. The record is looked
   * up again and stored before the next await (the metadata may have been
   * taken over from another tab during the push).
   */
  private async recordPushedScene(
    name: string, json: string,
    result: { version: HomeVersion; changed: boolean },
    canvas: ReturnType<ScenesController["serializeCurrent"]> | null,
  ) {
    const meta = this.sceneMeta(name);
    meta.baseMd5 = result.version;
    meta.remoteMd5 = result.version;
    meta.dirty = false;
    delete meta.conflict;
    this.persistMeta();
    this.updateRemoteMd5(name, result.version);
    if (name === this.meta.current && !this.fileIdOf(name)) {
      // just created in Drive: its file id (and so its relay) with a fresh listing, not the next poll
      this.refreshListing().catch(() => {});
    }
    if (canvas && name === this.meta.current) {
      // what was pushed is the new base; edits made during the push stay dirty
      this.meta.baseline = canvas.hash;
      this.pushCurrentNow = false;
      this.persistMeta();
      this.recomputeDirty();
      // the pen's holder: the others take this version as their base
      this.penHooks?.saved(name, result.version, canvas.hash);
    } else {
      const stored = await getSnapshot(name);
      if (stored && withSceneName(stored.json, name) !== json) {
        // edited while the push was on its way (and stashed by a switch):
        // the pushed version is the new base, the later edits stay
        await setSnapshot(name, { ...stored, baseline: hashJson(json), dirty: true });
        this.sceneMeta(name).dirty = true;
        this.persistMeta();
      } else {
        await setSnapshot(name, { json, baseline: hashJson(json), dirty: false });
      }
    }
    this.log("push", result.changed ? `Saved "${name}" to Drive` : `"${name}" already up to date`);
    this.refresh();
    return result;
  }

  private renameReachedDrive(name: string, manual: boolean) {
    if (this.meta.scenes[name]?.renamedFrom) {
      if (manual) {
        throw new Error(`Saved locally. The rename of "${name}" is not in Drive yet, will retry`);
      }
      return false;
    }
    return true;
  }

  /** push local content; on "Drive changed meanwhile" merge instead */
  private async pushScene(name: string, { manual = false } = {}) {
    if (!this.canPushToDrive(name, manual)) return null;
    if (this.meta.scenes[name]?.renamedFrom) {
      // the rename has to reach Drive before the content can
      await this.pushPendingRename(name);
      if (!this.renameReachedDrive(name, manual)) return null;
    }
    const isCurrent = name === this.meta.current;
    if (!this.canPushCanvas(name, manual, isCurrent)) return null;
    // serialized once per push (with pictures this is the expensive part)
    const canvas = isCurrent ? this.serializeCurrent() : null;
    const stored = canvas ? canvas.json : await this.localJson(name);
    if (stored === null) {
      return null;
    }
    const empty = canvas ? canvas.isEmpty : isEmptyJson(stored);
    if (!manual && empty && (await this.refuseEmptyPush(name))) {
      return null;
    }
    // the file names its scene (the server rejects content of another scene);
    // stored copies may still carry an old name (e.g. from before a rename)
    const json = withSceneName(stored, name);
    const remote = this.remoteMd5Of(name);
    const base = remote === null ? "none" : this.meta.scenes[name]?.baseMd5 ?? "none";
    let result;
    try {
      result = await this.drive.save(name, json, base);
    } catch (error) {
      return this.handlePushError(name, manual, error as HomeError);
    }
    return this.recordPushedScene(name, json, result, canvas);
  }

  /** Drive has a newer version and there are no local changes */
  private async pullScene(name: string) {
    if (this.statusOf(name) !== "behind") {
      return; // changed meanwhile
    }
    let latest;
    try {
      latest = await this.drive.load(name);
    } catch (error) {
      if (!(error as HomeError).offline) {
        this.log("error", `Download of "${name}" failed: ${(error as Error).message}`);
      }
      return;
    }
    if (this.isDirty(name)) {
      return; // the user started editing meanwhile; next round merges
    }
    const wasKnown = !!this.meta.scenes[name]?.baseMd5;
    await this.writeLocal(name, latest.json, { dirty: false });
    this.setBase(name, latest.version);
    this.log("pull", wasKnown ? `Updated "${name}" from Drive` : `Downloaded "${name}" from Drive`);
    this.refresh();
  }

  /**
   * Auto-sync never pushes an empty scene over one that has content on
   * Drive: an editor that lost its canvas (a crash, a broken load) looks
   * exactly like that. If nothing was deleted here in this session, Drive's
   * version comes back; otherwise the empty version stays local until the
   * user saves it on purpose.
   */
  private async refuseEmptyPush(name: string) {
    if (this.remoteMd5Of(name) === null) {
      return false;
    }
    let latest;
    try {
      latest = await this.drive.load(name);
    } catch {
      return true; // can't tell: rather not push
    }
    if (isEmptyJson(latest.json)) {
      return false;
    }
    const deletedHere =
      name === this.meta.current && this.api ? this.api.getSceneElementsIncludingDeleted().some((el) => el.isDeleted) : false;
    if (deletedHere) {
      this.log("error", `Not pushed: "${name}" is empty here but not in Drive. Save it in the sidebar if you really want to empty it.`);
      return true;
    }
    await this.writeLocal(name, latest.json, { dirty: false });
    this.setBase(name, latest.version, { settled: true });
    this.log("pull", `"${name}" was empty here (not by an edit): loaded it from Drive instead of pushing the empty version`);
    this.refresh();
    return true;
  }

  /** the version a scene's local copy is based on (null: unknown, everything that differs counts as changed) */
  private async mergeBase(name: string, baseVersion: HomeVersion | null | undefined) {
    if (!baseVersion) {
      return null;
    }
    try {
      return JSON.parse((await this.drive.load(name, baseVersion)).json);
    } catch {
      return null;
    }
  }

  private async applyMergedScene(
    name: string,
    { base, mine, theirsData, theirs, merged, unchanged, settled, pushAfter }: {
      base: any; mine: any; theirsData: any; theirs: { json: string; version: HomeVersion };
      merged: ReturnType<typeof mergeElements>; unchanged: () => Promise<boolean>;
      settled: string[]; pushAfter: boolean;
    },
  ) {
    await registerSceneFonts(theirsData);
    const appState = {
      ...mine.appState,
      // background and grid: whoever changed them (three-way, like the elements)
      ...mergeSceneSettings(base?.appState, mine.appState, theirsData.appState),
      ...mergePresentation(
        { ...mine.appState, kurviqPresentation: presentationOf(mine) },
        { ...theirsData.appState, kurviqPresentation: presentationOf(theirsData) },
      ),
    };
    const kurviqFonts = mergeFontLists(mine.kurviqFonts, theirsData.kurviqFonts);
    const kurviqComments = mergeComments(mine.kurviqComments, theirsData.kurviqComments);
    if (!(await unchanged())) {
      return null;
    }
    if (nothingOfMine(merged, settled, { appState, kurviqFonts, kurviqComments }, theirsData)) {
      // the merge is Drive's version (local "changes" were only how the editor writes the same
      // content): taken as it is, nothing to push
      await this.writeLocal(name, theirs.json, { dirty: false });
      this.setBase(name, theirs.version, { settled: true });
      this.log("pull", `Updated "${name}" from Drive (nothing of yours to merge)`);
      this.refresh();
      return null;
    }
    const mergedJson = JSON.stringify({
      ...mine,
      elements: merged.elements,
      appState,
      // only the pictures the merged scene still uses (deleted images leave no data behind)
      files: usedFiles(merged.elements, { ...theirsData.files, ...mine.files }),
      kurviqFonts,
      kurviqComments,
    });
    const meta = this.sceneMeta(name);
    meta.baseMd5 = theirs.version;
    delete meta.conflict;
    if (name === this.meta.current) {
      // base is now Drive's version: dirty = merged differs from it
      this.meta.baseline = hashJson(theirs.json);
      this.applyScene(mergedJson, name, { keepView: true });
      meta.dirty = true;
      this.persistMeta();
      await editorYield();
      this.recomputeDirty();
      this.sceneMeta(name).dirty = this.state.dirty;
      this.persistMeta();
      if (name === this.meta.current) {
        await this.stashCurrent(); // its comments for a reload (see writeLocal)
      }
    } else {
      meta.dirty = true;
      this.persistMeta();
      await setSnapshot(name, { json: mergedJson, baseline: hashJson(theirs.json), dirty: true });
    }
    const settledSuffix = settled.length > 5 ? ` (+${settled.length - 5})` : "";
    const parts = [
      merged.fromTheirs ? `${merged.fromTheirs} change(s) from Drive` : null,
      merged.fromMine ? `${merged.fromMine} of yours` : null,
      settled.length
        ? `changed on both sides, newer edit kept: ${settled.slice(0, 5).join(", ")}${settledSuffix}`
        : null,
    ].filter(Boolean);
    this.log("merge", `Merged "${name}": ${parts.join("; ") || "nothing new"}`);
    this.refresh();
    if (pushAfter && this.isDirty(name)) {
      return this.pushScene(name);
    }
    return null;
  }

  private async takeNonemptyMergeSource(name: string, theirs: { json: string; version: HomeVersion }, unchanged: () => Promise<boolean>) {
    if (!(await unchanged())) {
      return false;
    }
    await this.writeLocal(name, theirs.json, { dirty: false });
    this.setBase(name, theirs.version, { settled: true });
    this.log("pull", `"${name}" was empty here: took Drive's version`);
    this.refresh();
    return true;
  }

  private mergeWithPolicy(base: any, mine: any, theirsData: any, choices: Record<string, ClashChoice>) {
    let merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], choices);
    let settled: string[] = [];
    if (merged.clashes.length && this.clashMode() === "newest") {
      // like live collaboration: per element the newer edit wins
      const auto = newestWins(mine.elements || [], theirsData.elements || [], merged.clashes);
      settled = merged.clashes.map((id) => `${id}: ${auto[id] === "mine" ? "yours" : "Drive's"}`);
      merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], { ...auto, ...choices });
    }
    return { merged, settled };
  }

  /** both sides changed: three-way merge per element */
  private async mergeScene(
    name: string,
    {
      pushAfter = this.autoSyncFor(name),
      choices = {} as Record<string, ClashChoice>,
    } = {},
  ) {
    if (this.penBlocks(name)) {
      return null;
    }
    const mineJson = await this.localJson(name);
    let theirs;
    try {
      theirs = await this.drive.load(name);
    } catch (error) {
      if ((error as HomeError).status === 404 && mineJson) {
        // deleted in Drive meanwhile: ours becomes a new scene again
        const meta = this.sceneMeta(name);
        meta.baseMd5 = null;
        meta.remoteMd5 = null;
        this.persistMeta();
        return pushAfter ? this.pushScene(name) : null;
      }
      return null;
    }
    if (mineJson === null) {
      return this.pullScene(name);
    }
    const base = await this.mergeBase(name, this.meta.scenes[name]?.baseMd5);
    const mine = JSON.parse(mineJson);
    const theirsData = JSON.parse(theirs.json);
    // the merge is based on mineJson: if the scene changed while Drive was
    // asked (edited, or switched to/away), drop this round; the next sync merges
    const unchanged = async () =>
      name === this.meta.current
        ? this.serializeCurrent().json === mineJson
        : (await getSnapshot(name))?.json === mineJson;
    // a local copy without any elements never deletes Drive's content by a
    // merge (an editor that lost its canvas looks like "the user deleted everything")
    if (!getNonDeletedElements(mine.elements || []).length && getNonDeletedElements(theirsData.elements || []).length) {
      await this.takeNonemptyMergeSource(name, theirs, unchanged);
      return null;
    }
    const { merged, settled } = this.mergeWithPolicy(base, mine, theirsData, choices);
    const meta = this.sceneMeta(name);
    meta.remoteMd5 = theirs.version;
    if (merged.clashes.length) {
      meta.conflict = { remoteMd5: theirs.version, clashes: merged.clashes, v: MERGE_VERSION };
    }
    this.persistMeta();
    this.updateRemoteMd5(name, theirs.version);

    if (merged.clashes.length) {
      this.log(
        "conflict",
        `Conflict in "${name}": you and Drive changed the same ${merged.clashes.length} element(s). Choose how to resolve`,
      );
      this.refresh();
      return null;
    }

    return this.applyMergedScene(name, { base, mine, theirsData, theirs, merged, unchanged, settled, pushAfter });
  }

  private async pushPendingOps() {
    for (const name of Object.keys(this.meta.pendingDeletes)) {
      if ((await this.pushPendingDelete(name)) === "offline") { // NOSONAR S9382: in order on purpose (each one updates the sync metadata)
        return;
      }
    }
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (meta.renamedFrom && !(await this.pushPendingRename(name))) {
        return;
      }
    }
  }

  /** a delete made here (offline) goes to Drive now: "offline" if Drive is not reachable */
  private async pushPendingDelete(name: string): Promise<"done" | "offline" | "failed"> {
    const version = this.meta.pendingDeletes[name];
    if (!version) {
      return "done";
    }
    try {
      await this.drive.remove(name, version);
      this.log("push", `Deleted "${name}" in Drive`);
    } catch (error) {
      const apiError = error as HomeError;
      if (apiError.offline) {
        return "offline";
      }
      if (apiError.status === 409) {
        this.log("info", `"${name}" was changed in Drive after you deleted it, so it is kept in Drive`);
      } else if (apiError.status !== 404) {
        this.log("error", `Could not delete "${name}" in Drive: ${apiError.message}`);
        return "failed";
      }
    }
    delete this.meta.pendingDeletes[name];
    this.persistMeta();
    this.updateRemoteMd5(name, null);
    return "done";
  }

  /** returns false when Drive is not reachable */
  private async pushPendingRename(name: string) {
    const from = this.meta.scenes[name]?.renamedFrom;
    if (!from) {
      return true;
    }
    try {
      const result = await this.drive.rename(from, name);
      this.sceneMeta(name).remoteMd5 = result.version;
      this.renameRemote(from, name, result.version);
      this.log("push", `Renamed "${from}" to "${name}" in Drive`);
    } catch (error) {
      const apiError = error as HomeError;
      if (apiError.offline) {
        return false;
      }
      if (apiError.status !== 404) {
        this.log(
          "error",
          apiError.exists
            ? `Can't rename "${from}" to "${name}" in Drive: "${name}" exists there. Rename this scene again`
            : `Rename of "${from}" in Drive failed: ${apiError.message}`,
        );
        return true;
      }
      // gone from Drive meanwhile: ours is a new scene now
      Object.assign(this.sceneMeta(name), { baseMd5: null, remoteMd5: null, dirty: true });
    }
    delete this.sceneMeta(name).renamedFrom;
    this.persistMeta();
    this.refresh();
    return true;
  }

  /**
   * Scenes that were in Drive and are gone now (deleted or renamed elsewhere,
   * e.g. on another laptop). Unchanged local copies are removed too; with
   * local changes they are kept and pushed again (edits are never lost).
   */
  private async dropScenesDeletedInDrive() {
    const remote = new Set((this.state.remote ?? []).map((scene) => scene.name));
    for (const name of Object.keys(this.meta.scenes)) {
      const meta = this.meta.scenes[name]; // (looked up each time: the metadata may be taken over during an await)
      if (!meta) {
        continue;
      }
      if (meta.localOnly && meta.baseMd5 && !remote.has(driveNameOf(this.meta, name))) {
        // its old copy in Drive is gone: the local scene is all there is
        meta.baseMd5 = null;
        meta.dirty = true;
        this.persistMeta();
        continue;
      }
      if (
        name === UNTITLED ||
        meta.localOnly ||
        !meta.baseMd5 ||
        meta.renamedFrom ||
        meta.conflict ||
        remote.has(name)
      ) {
        continue;
      }
      if (this.isDirty(name)) {
        this.log("info", `"${name}" was deleted in Drive, but you changed it here, so it is kept`);
        meta.baseMd5 = null;
      } else if (name === this.meta.current) {
        this.log("info", `"${name}" was deleted in Drive, still open here as a local scene`);
        meta.baseMd5 = null;
        this.meta.baseline = null;
      } else {
        delete this.meta.scenes[name];
        this.persistMeta(); // (before the awaits: the metadata may be taken over meanwhile)
        await deleteSnapshot(name); // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
        await deleteAgentBaseline(name); // NOSONAR S9382: in order on purpose (scene reads and writes observe prior scene operations)
        this.log("pull", `"${name}" was deleted in Drive, removed here too`);
      }
      this.persistMeta();
    }
    this.refresh();
  }

  /** the listing's entry of `name` gets this version (null: it is gone from Drive) */
  private updateRemoteMd5(name: string, version: HomeVersion | null) {
    if (!this.state.remote) {
      return;
    }
    const others = this.state.remote.filter((scene) => scene.name !== name);
    const existing = this.state.remote.find((scene) => scene.name === name);
    this.setState({
      remote: version
        ? [...others, { ...existing, name, version, updatedAt: existing?.updatedAt ?? new Date().toISOString() }].sort(byName)
        : others,
    });
  }

  /** the listing's entry follows a rename in Drive: the same file (its id, public flag), under the new name */
  private renameRemote(from: string, to: string, version: HomeVersion) {
    if (!this.state.remote) {
      return;
    }
    const existing = this.state.remote.find((scene) => scene.name === from);
    const others = this.state.remote.filter((scene) => scene.name !== from && scene.name !== to);
    const renamed = { ...existing, name: to, version, updatedAt: existing?.updatedAt ?? new Date().toISOString() };
    this.setState({ remote: [...others, renamed].sort(byName) });
  }

  // ---------------------------------------------------------------------------
  // rename / delete / duplicate: applied here right away, in Drive right
  // away too when it is reachable, otherwise queued until it is
  // ---------------------------------------------------------------------------

  /** latest Drive listing before renaming / deleting / duplicating (best effort) */
  private async refreshListing() {
    try {
      this.applyListing((await this.drive.list()).scenes);
    } catch {
      // offline: work with what we know
    }
  }

  private requireScene(name: string) {
    if (!this.exists(name)) {
      throw Object.assign(new Error(`Scene "${name}" not found`), { status: 404 });
    }
  }

  private requireFreeName(name: string) {
    this.validateName(name);
    if (this.exists(name)) {
      throw Object.assign(new Error(`A scene named "${name}" already exists`), { status: 409 });
    }
  }

  private async hasLocalContent(name: string) {
    return name === this.meta.current || !!(await getSnapshot(name));
  }

  private async renameInDrive(driveName: string, from: string, to: string, next: SceneMeta) {
    try {
      const result = await this.drive.rename(driveName, to);
      next.remoteMd5 = result.version;
      this.renameRemote(driveName, to, result.version);
    } catch (error) {
      const apiError = error as HomeError;
      if (apiError.status === 404) {
        next.baseMd5 = null; // not in Drive (anymore): just a local scene
      } else if (!apiError.offline) {
        throw apiError;
      } else if (!(await this.hasLocalContent(from))) {
        throw new Error(`"${from}" was never downloaded to this browser and Drive is not reachable. Try again online`);
      } else {
        next.renamedFrom = driveName; // Drive follows when reachable
      }
    }
  }

  /**
   * A scene's local copy goes to a new name (renamed here or elsewhere): its
   * stored copy, its record (`record`), the canvas if it is open (the URL is
   * replaced, not pushed) and the agent's baseline.
   */
  private async moveLocalScene(from: string, to: string, record: SceneMeta) {
    if (from !== this.meta.current) {
      const snapshot = await getSnapshot(from);
      if (snapshot) {
        await setSnapshot(to, snapshot);
        await deleteSnapshot(from);
      }
    }
    // no await from here to the stored metadata
    delete this.meta.scenes[from];
    this.meta.scenes[to] = record;
    if (from === this.meta.current) {
      this.meta.current = to;
      this.urlMode = "replace";
      this.requireApi().updateScene({ appState: { name: to }, captureUpdate: CaptureUpdateAction.NEVER });
    }
    this.persistMeta();
    this.refresh();
    await moveAgentBaseline(from, to);
  }

  /**
   * A scene of this name was deleted here and the delete is not in Drive
   * yet (offline): before another scene takes the name in Drive, the delete
   * goes first; a scene that isn't in Drive takes the deleted version over
   * as its base instead (as claimName does)
   */
  private async settlePendingDelete(to: string, next: SceneMeta, inDrive: boolean) {
    const deleted = this.meta.pendingDeletes[to];
    if (!deleted || next.localOnly) {
      return; // (a local-only scene is renamed here only: the delete in Drive stays queued)
    }
    if (inDrive) {
      await this.pushPendingDelete(to); // offline: it stays queued and runs before the rename
      return;
    }
    Object.assign(next, { baseMd5: deleted, remoteMd5: deleted, dirty: true });
    delete this.meta.pendingDeletes[to];
  }

  rename = (from: string, to: string) =>
    this.withBusy("saving", async () => {
      to = to.trim();
      if (from === to) {
        return;
      }
      await this.refreshListing();
      this.requireScene(from);
      this.requireFreeName(to);
      const meta = this.meta.scenes[from];
      if (meta?.conflict) {
        throw new Error(`"${from}" has a conflict: resolve it first`);
      }
      // local-only scenes are renamed here only (a copy in Drive keeps its name)
      let driveName: string | null = null;
      if (!meta?.localOnly) {
        driveName = meta?.renamedFrom ?? (this.remoteMd5Of(from) ? from : null);
      }
      const next: SceneMeta = { ...(meta ?? { baseMd5: null, dirty: false }) };
      if (meta?.localOnly && meta.baseMd5) {
        next.baseMd5 = null; // no longer related to the Drive copy
        next.dirty = true;
      }
      delete next.renamedFrom;
      await this.settlePendingDelete(to, next, !!driveName);
      if (driveName) {
        await this.renameInDrive(driveName, from, to, next);
      }
      await this.moveLocalScene(from, to, next);
      const driveSuffix = driveName ? " (also in Drive)" : "";
      this.log(
        "info",
        next.renamedFrom
          ? `Renamed "${from}" to "${to}", in Drive once it is reachable`
          : `Renamed "${from}" to "${to}"${driveSuffix}`,
      );
    });

  /**
   * An agent is about to read or edit this scene: push its unpushed changes
   * now instead of after the idle delay (sync only, the canvas is untouched).
   * Scenes with auto-sync off stay as they are: the user decides.
   */
  flush = (name: string) =>
    this.exclusive(async () => {
      await this.ready;
      if (!this.meta.scenes[name] && name !== this.meta.current) {
        return { status: "unknown" as const, autoSync: true };
      }
      if (this.isLocalOnly(name)) {
        return { status: "local-only" as const, autoSync: false, localOnly: true, empty: await this.isEmptyHere(name) };
      }
      if (this.penBlocks(name)) {
        // someone else holds the pen: their tab saves it
        return { status: this.statusOf(name), autoSync: true, editing: this.penHolder };
      }
      const autoSync = this.autoSyncFor(name);
      const status = this.statusOf(name);
      if (autoSync && (status === "ahead" || (status === "local" && this.isDirty(name)))) {
        if (name === this.meta.current) {
          this.pushCurrentNow = true;
        }
        await this.pushScene(name);
      } else if (autoSync && status === "diverged") {
        await this.mergeScene(name);
      }
      return { status: this.statusOf(name), autoSync };
    });

  /** renamed elsewhere (an agent, another machine): move the local copy along */
  followRemoteRename = (from: string, to: string, md5: string | null) =>
    this.exclusive(async () => {
      await this.ready;
      const meta = this.meta.scenes[from];
      if (!meta || Object.hasOwn(this.meta.scenes, to) || meta.renamedFrom || meta.conflict || meta.localOnly) {
        return; // unknown here, or a local rename/conflict is pending: sync sorts it out
      }
      await this.moveLocalScene(from, to, meta); // same content, same version
      if (md5) {
        this.renameRemote(from, to, md5);
      } else {
        this.updateRemoteMd5(from, null);
      }
      this.log("info", `"${from}" was renamed to "${to}" in Drive`);
    });

  /** delete a scene here and in Drive (only the version you know of there) */
  remove = (name: string) =>
    this.withBusy("saving", async () => {
      await this.refreshListing();
      this.requireScene(name);
      const meta = this.meta.scenes[name];
      const driveName = driveNameOf(this.meta, name);
      // local-only scenes are deleted here only (a copy in Drive stays)
      const driveMd5 = meta?.localOnly ? null : this.remoteMd5Of(name) ?? meta?.conflict?.remoteMd5 ?? null;
      let queued = false;
      if (driveMd5) {
        try {
          await this.drive.remove(driveName, driveMd5);
          this.updateRemoteMd5(driveName, null);
        } catch (error) {
          const apiError = error as HomeError;
          if (apiError.status === 409) {
            throw new Error(`"${name}" was just changed in Drive, not deleted. Have a look at the new version first.`);
          } else if (apiError.offline) {
            this.meta.pendingDeletes[driveName] = driveMd5;
            this.persistMeta();
            queued = true;
          } else if (apiError.status !== 404) {
            throw apiError;
          }
        }
      }
      if (name === this.meta.current) {
        // leave it for the untitled draft (without stashing the deleted scene); the URL is replaced
        this.setState({ busy: "loading" });
        this.urlMode = "replace";
        await this.openInner(null, { stash: false });
        this.setState({ busy: "saving" });
      }
      delete this.meta.scenes[name];
      this.persistMeta();
      this.refresh();
      await deleteSnapshot(name);
      await deleteAgentBaseline(name);
      const driveSuffix = driveMd5 ? " (also in Drive)" : "";
      this.log(
        "info",
        queued
          ? `Deleted "${name}", in Drive once it is reachable`
          : `Deleted "${name}"${driveSuffix}`,
      );
    });

  /** copy a scene (incl. changes not pushed yet) under a new name */
  clone = (name: string, to: string, { open = true } = {}) =>
    this.withBusy("saving", async () => {
      to = to.trim();
      await this.refreshListing();
      this.requireScene(name);
      this.requireFreeName(to);
      let json = (await this.localJson(name)) ?? (await this.drive.load(driveNameOf(this.meta, name))).json;
      const data = JSON.parse(json);
      json = JSON.stringify({ ...data, appState: { ...data.appState, name: to } });
      await setSnapshot(to, { json, baseline: null, dirty: true });
      const { autoSync, localOnly } = this.meta.scenes[name] ?? {};
      this.meta.scenes[to] = localOnly
        ? { baseMd5: null, dirty: true, localOnly: true }
        : {
            ...this.claimName(to, true),
            ...(autoSync !== undefined ? { autoSync } : {}),
          };
      this.persistMeta();
      this.log("info", `Duplicated "${name}" as "${to}"`);
      if (open) {
        this.setState({ busy: "loading" });
        await this.openInner(to);
        this.setState({ busy: "saving" });
      }
      this.refresh();
      void this.syncNow(); // auto-sync pushes the copy
    });

  // ---------------------------------------------------------------------------
  // local-only scenes for agents: they exist only in this browser, so agents
  // read and edit them through this tab
  // ---------------------------------------------------------------------------

  private requireLocalOnly(name: string) {
    if (!this.isLocalOnly(name)) {
      throw Object.assign(new Error(`"${name}" is not a local-only scene`), { status: 404 });
    }
  }

  /** content of a local-only scene (the canvas if it is open) */
  localOnlyJson = (name: string) =>
    this.exclusive(async () => {
      await this.ready;
      this.requireLocalOnly(name);
      const json = await this.localJson(name);
      return withSceneName(json ?? serializeAsJSON([], { name } as any, {}, "local"), name);
    });

  /** replace a local-only scene's content (applied to the canvas if it is open) */
  writeLocalOnly = (name: string, json: string) =>
    this.exclusive(async () => {
      await this.ready;
      this.requireLocalOnly(name);
      await this.writeLocal(name, withSceneName(json, name), { dirty: true });
      this.persistMeta();
      this.refresh();
    });

  /** a new local-only scene with this content (replace: an existing local-only one) */
  createLocalOnly = (name: string, json: string, { replace = false } = {}) =>
    this.exclusive(async () => {
      await this.ready;
      this.validateName(name);
      if (this.exists(name) && !(replace && this.isLocalOnly(name))) {
        throw Object.assign(
          new Error(
            this.isLocalOnly(name)
              ? `A local-only scene named "${name}" already exists`
              : `A scene named "${name}" already exists (synced with Drive)`,
          ),
          { status: 409 },
        );
      }
      json = withSceneName(json, name);
      const isCurrent = name === this.meta.current;
      if (!isCurrent) {
        await setSnapshot(name, { json, baseline: null, dirty: true }); // its content first, then its record
      }
      this.meta.scenes[name] = { ...this.meta.scenes[name], baseMd5: null, dirty: true, localOnly: true };
      this.persistMeta();
      if (isCurrent) {
        await this.writeLocal(name, json, { dirty: true });
        this.persistMeta();
      }
      this.refresh();
      this.log("info", `Agent saved "${name}" (local only)`);
    });

  // ---------------------------------------------------------------------------
  // conflict resolution (user decides)
  // ---------------------------------------------------------------------------

  /** overwrite Drive with the local version */
  keepMine = (name: string) =>
    this.withBusy("saving", async () => {
      const meta = this.sceneMeta(name);
      if (!meta.conflict) {
        return;
      }
      meta.baseMd5 = meta.conflict.remoteMd5;
      delete meta.conflict;
      meta.dirty = true;
      this.persistMeta();
      this.log("info", `"${name}": keeping your version`);
      await this.pushScene(name, { manual: true });
    });

  /** discard the local version, take Drive's */
  readonly takeTheirs = (name: string) =>
    this.withBusy("loading", async () => {
      const latest = await this.drive.load(name);
      delete this.sceneMeta(name).conflict;
      this.persistMeta();
      await this.writeLocal(name, latest.json, { dirty: false });
      this.setBase(name, latest.version);
      this.log("pull", `"${name}": took the version from Drive`);
      this.refresh();
    });

  /** the three versions of a scene in conflict (for agents) */
  private async conflictVersions(name: string) {
    const meta = this.meta.scenes[name];
    if (!meta?.conflict) {
      throw new Error(`"${name}" has no conflict`);
    }
    const mineJson = await this.localJson(name);
    if (mineJson === null) {
      throw new Error(`"${name}" has no local version`);
    }
    const theirs = JSON.parse((await this.drive.load(name, meta.conflict.remoteMd5)).json);
    const base = await this.mergeBase(name, meta.baseMd5);
    return { meta, mine: JSON.parse(mineJson), theirs, base };
  }

  // ---------------------------------------------------------------------------
  // history: the scene's versions in its home (Drive's revisions), and
  // putting an older one back
  // ---------------------------------------------------------------------------

  history = async (name: string): Promise<HomeHistoryEntry[]> => (await this.homeOf(name).history?.(name)) ?? [];

  loadVersion = async (name: string, version: HomeHistoryEntry) => {
    const home = this.homeOf(name);
    if (!home.loadVersion) {
      throw new Error(`${home.label} keeps no older versions`);
    }
    return (await home.loadVersion(name, version)).json;
  };

  /**
   * An older version of the open scene back on the canvas, as a normal edit:
   * undoable with ⌘Z, and synced (or saved) like any other change. Elements
   * added since are deleted, the others get the old version's content.
   */
  restoreVersion = (json: string) => {
    const api = this.requireApi();
    const data = JSON.parse(json);
    registerSceneFonts(data).catch((error) => console.error("[scenes] could not load scene fonts", error));
    const old = restoreElements(data.elements, null, { repairBindings: true });
    const current = api.getSceneElementsIncludingDeleted();
    const byId = new Map(current.map((el) => [el.id, el]));
    const oldIds = new Set(old.map((el) => el.id));
    const now = Date.now();
    const bump = <T extends ExcalidrawElement>(el: T, base: ExcalidrawElement | undefined): T => ({
      ...el,
      version: Math.max(el.version, base?.version ?? 0) + 1,
      versionNonce: randomNonce(),
      updated: now,
    });
    const elements = [
      ...old.map((el) => bump(el, byId.get(el.id))),
      ...current.filter((el) => !el.isDeleted && !oldIds.has(el.id)).map((el) => bump({ ...el, isDeleted: true }, el)),
    ];
    const files = Object.values(data.files || {}) as BinaryFileData[];
    if (files.length) {
      api.addFiles(files);
    }
    api.updateScene({
      elements,
      appState: { viewBackgroundColor: restoreAppState(data.appState, null).viewBackgroundColor, ...restorePresentation(data, api.getAppState()) } as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  /** what clashes: per element the base, my and Drive's version */
  conflictInfo = async (name: string) => {
    const { meta, mine, theirs, base } = await this.conflictVersions(name);
    const merged = mergeElements(base?.elements, mine.elements || [], theirs.elements || []);
    const [b, m, t] = [live(base?.elements), live(mine.elements), live(theirs.elements)];
    return {
      scene: name,
      driveMd5: meta.conflict!.remoteMd5,
      baseKnown: !!base,
      autoMerged: { fromMine: merged.fromMine, fromDrive: merged.fromTheirs },
      clashes: merged.clashes.map((id) => {
        const [be, me, te] = [b.get(id), m.get(id), t.get(id)];
        return {
          id,
          base: be ?? null,
          mine: me ?? null,
          theirs: te ?? null,
          mineChanged: conflictChanges(be, me),
          theirsChanged: conflictChanges(be, te),
        };
      }),
    };
  };

  /** one side of a conflict as a scene, e.g. to render it */
  conflictScene = async (name: string, side: "mine" | "theirs") => {
    const versions = await this.conflictVersions(name);
    const data = versions[side];
    return { elements: data.elements || [], files: data.files || {}, appState: data.appState || {} };
  };

  /**
   * Settle a conflict element by element: merge both versions, take my or
   * Drive's version for each clashing element (choices, else `otherwise`),
   * and push. Elements changed on one side only are merged as usual.
   */
  resolveConflict = (
    name: string,
    choices: Record<string, ClashChoice>,
    otherwise?: ClashChoice,
  ) =>
    this.withBusy("saving", async () => {
      const meta = this.meta.scenes[name];
      if (!meta?.conflict) {
        throw new Error(`"${name}" has no conflict`);
      }
      const all = { ...choices };
      if (otherwise) {
        for (const id of meta.conflict.clashes) {
          all[id] ??= otherwise;
        }
      }
      const missing = meta.conflict.clashes.filter((id) => !all[id]);
      if (missing.length) {
        throw new Error(
          `No decision for ${missing.length} clashing element(s): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}. Pass a choice per id or "otherwise".`,
        );
      }
      await this.mergeScene(name, { pushAfter: true, choices: all });
      const left = this.meta.scenes[name]?.conflict;
      if (left) {
        // Drive changed again meanwhile and the new version clashes, too
        return { resolved: false, clashes: left.clashes };
      }
      this.log("info", `"${name}": conflict resolved element by element`);
      return { resolved: true, status: this.statusOf(name) };
    });

  /** keep the local version as a copy, take Drive's for this scene */
  keepBoth = async (name: string) => {
    const copy = await this.withBusy("saving", async () => {
      const json = await this.localJson(name);
      if (json === null) {
        return null;
      }
      // a valid name nobody has (two "keep both" in one minute: "(2)")
      const copyTo = copyName(name, ` (conflict ${timestamp()})`, (taken) => this.exists(taken));
      await setSnapshot(copyTo, { json: withSceneName(json, copyTo), baseline: null, dirty: true });
      this.meta.scenes[copyTo] = this.claimName(copyTo, true);
      this.persistMeta();
      this.log("info", `Your version of "${name}" was kept as "${copyTo}"`);
      return copyTo;
    });
    await this.takeTheirs(name);
    void this.syncNow();
    return copy;
  };
}

export const scenesController = new ScenesController();

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // handy for debugging and end-to-end tests (dev, and builds for the fake Google)
  (window as any).__scenes = scenesController;
}
