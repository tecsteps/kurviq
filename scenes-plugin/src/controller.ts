// Scenes: switching, saving and syncing with Drive. Talks to the editor only
// through the public ExcalidrawImperativeAPI.
//
// Offline-first: the browser (localStorage + IndexedDB) is the source of
// truth. Drive is a sync target — when it (or the scenes server) is not
// reachable, everything keeps working locally and syncs later.
//
// Per scene we track the Drive version (MD5 of its content) the local copy is based
// on. Compared with the latest sha in Drive and the local dirty flag this
// gives a visible status: synced / ahead / behind / diverged / conflict / local.
// Auto-sync (default on, per-scene override) pushes after 10s idle, pulls clean
// scenes, merges element-wise on divergence and stops on real clashes.

import {
  CaptureUpdateAction,
  getNonDeletedElements,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import { hashElementsVersion, hashString } from "@excalidraw/element";

import { mergeFontLists, registerSceneFonts, withFonts } from "./fonts";
import { scenesApi } from "./api";
import { connection, driveScenes, listPermissions, setLiveWriters, sharedFileId } from "./online/drive";
import { liveDifference } from "./online/liveMerge";
import { liveSync } from "./online/liveSync";
import { isSceneName } from "../../scenes-mcp/sceneName.mjs";
import { changedFields, live, mergeElements, MERGE_VERSION, newestWins } from "./merge";
import type { ClashChoice } from "./merge";
import {
  META_KEY,
  UNTITLED,
  deleteAgentBaseline,
  deleteSnapshot,
  getCheckpoint,
  getSnapshot,
  loadMeta,
  moveAgentBaseline,
  saveMeta,
  setCheckpoint,
  setSnapshot,
} from "./storage";

import type { ApiError, RemoteScene, SceneVersion } from "./api";
import type { SceneMeta, ScenesMeta } from "./storage";
import type { LiveScene, LiveStage } from "./online/liveSync";
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
  /** both changed — will be merged */
  | "diverged"
  /** both changed the same elements — needs a decision */
  | "conflict"
  /** never pushed */
  | "local"
  /** kept only in this browser on purpose: never synced */
  | "local-only"
  /** not named yet */
  | "untitled"
  /** live sync: the latest change is being stored in this browser */
  | "live-saving"
  /** live sync (the scene's Durable Object saves it): the latest change is in this browser only */
  | "live-browser"
  /** …on Kurviq's server, not in Drive yet */
  | "live-server"
  /** …in Drive */
  | "live-drive"
  /** …nowhere: this browser could not store it (export it) */
  | "live-unsaved";

const LIVE_STATUS: Record<LiveStage, SyncStatus> = {
  saving: "live-saving",
  browser: "live-browser",
  server: "live-server",
  drive: "live-drive",
  unsaved: "live-unsaved",
};

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
  /** saves through live sync */
  live?: boolean;
};

export type Activity = {
  at: number;
  kind: "push" | "pull" | "merge" | "conflict" | "error" | "info";
  text: string;
};

export type SyncInfo = {
  /** scenes server reachable (null = not tried yet) */
  serverReachable: boolean | null;
  /** Drive reachable at the server's last attempt */
  driveOnline: boolean | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  running: boolean;
  /** not signed in with Google (or no Drive access) — everything stays in this browser */
  notConnected: boolean;
  /** a shared scene Drive lets this user read, not change (why) — nothing is pushed */
  readOnly: string | null;
};

export type ScenesState = {
  current: string | null;
  dirty: boolean;
  busy: null | "loading" | "saving";
  error: string | null;
  remote: RemoteScene[] | null;
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
export const POLL_MS = 60_000;
/** a just-opened local copy is read-only at most this long while Drive is asked */
const CHECK_LOCK_MS = 3_000;

/**
 * Live sync runs wherever scenes are in Drive: kurviq.com and the local
 * install (which signs in through kurviq.com with its sealed session), not
 * in the local install's hidden renderer tab.
 */
const LIVE_CAPABLE = typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("scenes-renderer");

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
) =>
  hashString(
    JSON.stringify([
      appState.viewBackgroundColor,
      getNonDeletedElements(elements).map(
        ({ version, versionNonce, updated, index, ...rest }) => rest,
      ),
    ]),
  );

const hashJson = (json: string) => {
  const data = JSON.parse(json);
  return sceneHash(
    restoreElements(data.elements, null, { repairBindings: true }),
    { viewBackgroundColor: data.appState?.viewBackgroundColor ?? "#ffffff" },
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
  return JSON.stringify({ ...data, appState: { ...(data.appState || {}), name } });
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

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 50));

const timestamp = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}.${pad(d.getMinutes())}`;
};

class ScenesController {
  private api: ExcalidrawImperativeAPI | null = null;
  private unsubscribeChange: (() => void) | null = null;
  private meta: ScenesMeta = loadMeta();
  private listeners = new Set<() => void>();
  private lastVersionKey = "";
  private lastLiveKey = "";
  private lastChangeAt = 0;
  private pushCurrentNow = false;
  private timers: number[] = [];

  state: ScenesState = {
    current: this.meta.current,
    dirty: false,
    busy: null,
    error: null,
    remote: null,
    list: [],
    autoSync: this.meta.autoSync,
    sync: {
      serverReachable: null,
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
    if (LIVE_CAPABLE) {
      liveSync.setHost({
        renamed: (fileId, to) => this.liveRenamed(fileId, to),
        lifecycle: (fileId, state) => this.liveLifecycle(fileId, state),
        saveCopy: (name, json) => this.saveLiveCopy(name, json),
        changed: () => this.liveChanged(),
      });
      // agents' writes to a live scene go through its Durable Object, never to Drive directly
      setLiveWriters({
        write: (write) => this.liveWrite(write.fileId, write.name, write.json, write.baseSha, write.source),
        // straight to the live session: called from inside controller operations (a pending
        // rename of a file that became live), so never through the controller's queue again
        rename: async ({ fileId, from, to }) => {
          const session = await liveSync.session(fileId, from);
          session.rename(to);
        },
        remove: ({ fileId, name }) => this.liveTrash(fileId, name),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // store plumbing (for useSyncExternalStore)
  // ---------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private setState(patch: Partial<ScenesState>) {
    this.state = { ...this.state, ...patch };
    if (this.state.opening !== null && this.state.current === this.state.opening) {
      this.state.opening = null; // it is open
    }
    this.state.list = this.buildList();
    const current = this.meta.current;
    const conflict = current !== null ? this.meta.scenes[current]?.conflict : undefined;
    this.state.conflict = conflict ? { clashes: conflict.clashes } : null;
    this.listeners.forEach((listener) => listener());
  }

  private refresh() {
    this.setState({});
  }

  private persistMeta() {
    saveMeta(this.meta);
  }

  private log(kind: Activity["kind"], text: string) {
    if (this.state.activity[0]?.text === text) {
      return; // e.g. the same error on every poll
    }
    this.setState({
      activity: [{ at: Date.now(), kind, text }, ...this.state.activity].slice(0, 30),
    });
  }

  /** one thing at a time: user actions and sync steps never interleave */
  private chain: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  private readyDeferred = (() => {
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

  attach(api: ExcalidrawImperativeAPI) {
    if (this.api === api) {
      return;
    }
    if (api.isDestroyed) {
      this.editorGone();
      return;
    }
    // the app loads its initial scene asynchronously — switching scenes
    // before that would get overwritten
    const waitForLoad = () =>
      api.getAppState().isLoading
        ? setTimeout(waitForLoad, 100)
        : this.adoptInitialCanvas()
            .then(() => this.connectInitial())
            .finally(() => this.readyDeferred.resolve());
    waitForLoad();
    this.unsubscribeChange?.();
    this.api = api;
    this.unsubscribeChange = api.onChange((elements, appState) =>
      this.onSceneChange(elements, appState),
    );
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("storage", this.onStorage);
    document.addEventListener("visibilitychange", this.onVisibility);
    if (LIVE_CAPABLE) {
      liveSync.start();
    }
    this.onSceneChange(api.getSceneElementsIncludingDeleted(), api.getAppState());
  }

  /**
   * The app restores the canvas the browser saved last — possibly by another
   * tab showing another scene. The canvas says which scene it is
   * (appState.name); if that isn't this tab's scene, load the right one.
   */
  private async adoptInitialCanvas() {
    const current = this.meta.current;
    const shown = this.api?.getAppState().name;
    if (current === null || shown === current) {
      return;
    }
    try {
      await this.openInner(current, { stash: false, force: true });
      this.log("info", `Loaded "${current}" (the restored canvas belonged to "${shown}")`);
    } catch (error) {
      console.error("[scenes] could not load the current scene", error);
    }
  }

  /** the restored canvas is the current scene: a live one connects now */
  private async connectInitial() {
    this.connectLive();
  }

  /** start polling / auto-sync (not in the hidden renderer tab) */
  startSync() {
    if (this.timers.length) {
      return;
    }
    this.ready.then(() => this.syncNow({ refresh: true }));
    this.timers.push(
      window.setInterval(() => this.syncNow({ refresh: true }), POLL_MS),
      window.setInterval(() => this.maybePushCurrent(), 5_000),
    );
  }

  /**
   * The editor unmounted (e.g. it crashed while rendering). Its API then
   * reads an emptied scene: nothing may be read, stored or pushed from it any
   * more, or the empty canvas would be synced over the scene.
   */
  editorGone() {
    if (!this.api) {
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
    if (LIVE_CAPABLE) {
      liveSync.detachCanvas();
    }
  }

  /** other tabs may have changed scene metadata; this tab keeps its own scene */
  private onFocus = () => {
    const { current, baseline } = this.meta;
    this.meta = { ...loadMeta(), current, baseline };
    this.lastVersionKey = "";
    if (this.api) {
      this.onSceneChange(this.api.getSceneElementsIncludingDeleted(), this.api.getAppState());
    }
    this.setState({ current: this.meta.current, autoSync: this.meta.autoSync });
  };

  /**
   * another tab changed the scene metadata (e.g. renamed / deleted a scene):
   * take it over, so this tab doesn't write its stale copy back. The scene
   * this tab shows stays (it is reloaded on focus, like the canvas).
   */
  private onStorage = (event: StorageEvent) => {
    if (event.key !== META_KEY) {
      return;
    }
    const { current, baseline } = this.meta;
    this.meta = { ...loadMeta(), current, baseline };
    this.refresh();
  };

  private onOnline = () => this.syncNow({ refresh: true });

  /** leaving the tab: push right away instead of waiting for idle */
  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      liveSync.current()?.flush();
    }
    if (document.visibilityState === "hidden" && this.state.dirty) {
      this.pushCurrentNow = true;
      this.syncNow();
    }
  };

  private onSceneChange(
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    { force = false } = {},
  ) {
    // while a scene is being loaded the canvas is in flux — recomputeDirty()
    // forces an update once it's done
    if (this.state.busy === "loading" && !force) {
      return;
    }
    // cheap check first, onChange fires on every pointer move
    const versionKey = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}`;
    if (LIVE_CAPABLE && liveSync.current() && liveSync.current()!.fileId === this.fileIdOf(this.meta.current)) {
      // live sync diffs the canvas when something changed or a gesture started / ended
      const liveKey = [
        versionKey,
        appState.gridSize,
        appState.gridModeEnabled,
        appState.selectedElementsAreBeingDragged,
        appState.isResizing,
        appState.isRotating,
        appState.editingTextElement?.id,
        appState.newElement?.id,
        appState.multiElement?.id,
      ].join(":");
      if (liveKey !== this.lastLiveKey) {
        this.lastLiveKey = liveKey;
        liveSync.onCanvasChange();
      }
    }
    if (versionKey === this.lastVersionKey) {
      return;
    }
    this.lastVersionKey = versionKey;
    this.lastChangeAt = Date.now();

    const hash = sceneHash(elements, appState);
    if (this.meta.baseline === null) {
      if (this.meta.current === null || !this.meta.scenes[this.meta.current]?.baseSha) {
        // untitled / never pushed: dirty as soon as there's something on the canvas
        const dirty = getNonDeletedElements(elements).length > 0;
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
    return (this.meta.scenes[name] ??= { baseSha: null, dirty: false });
  }

  /** per-scene override (undefined = follows the global switch) */
  sceneAutoSyncOverride(name: string) {
    return this.meta.scenes[name]?.autoSync;
  }

  isLocalOnly(name: string | null) {
    return name !== null && !!this.meta.scenes[name]?.localOnly;
  }

  autoSyncFor(name: string | null) {
    if (name === null || this.isLocalOnly(name)) {
      return false;
    }
    return this.meta.scenes[name]?.autoSync ?? this.meta.autoSync;
  }

  /** latest known sha in Drive: string, null (not there) or undefined (unknown) */
  private remoteShaOf(name: string): string | null | undefined {
    // renamed here but not in Drive yet: it still has the old name there
    const driveName = this.meta.scenes[name]?.renamedFrom ?? name;
    if (this.state.remote) {
      return this.state.remote.find((scene) => scene.name === driveName)?.sha ?? null;
    }
    return this.meta.scenes[name]?.remoteSha;
  }

  /**
   * Drive names that are deleted / renamed here, but not in Drive yet —
   * hidden from the list (unless a local scene took the name again)
   */
  private hiddenRemoteNames() {
    const hidden = new Set(Object.keys(this.meta.pendingDeletes));
    for (const meta of Object.values(this.meta.scenes)) {
      if (meta.renamedFrom) {
        hidden.add(meta.renamedFrom);
      }
    }
    // a live scene renamed here: Drive's file keeps the old name until the scene's next save
    const liveNames = new Map(Object.entries(this.meta.scenes).flatMap(([name, meta]) => (meta.live ? [[meta.live.fileId, name]] : [])));
    for (const scene of this.state.remote ?? []) {
      const name = scene.fileId ? liveNames.get(scene.fileId) : undefined;
      if (name !== undefined && name !== scene.name) {
        hidden.add(scene.name);
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
    if (this.isLive(name)) {
      return LIVE_STATUS[liveSync.stageOf(this.fileIdOf(name)) ?? "drive"];
    }
    if (meta?.conflict) {
      return "conflict";
    }
    if (meta?.renamedFrom) {
      return "ahead";
    }
    const dirty = this.isDirty(name);
    const base = meta?.baseSha ?? null;
    const remote = this.remoteShaOf(name);
    if (remote === undefined) {
      // Drive state unknown (offline since start)
      return base ? (dirty ? "ahead" : "synced") : "local";
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
    if (this.state.current !== null) {
      names.add(this.state.current);
    }
    const list: SceneListItem[] = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const meta = this.meta.scenes[name];
        const driveName = meta?.renamedFrom ?? name;
        const remote = this.state.remote?.find((scene) => scene.name === driveName);
        return {
          name,
          status: this.statusOf(name),
          dirty: this.isDirty(name),
          inDrive: remote ? true : !!meta?.remoteSha,
          autoSync: this.autoSyncFor(name),
          localOnly: !!meta?.localOnly,
          updatedAt: remote?.updatedAt,
          ...(meta?.renamedFrom ? { pendingRename: meta.renamedFrom } : {}),
          ...(remote?.public ? { public: true } : {}),
          ...(remote?.fileId ? { fileId: remote.fileId } : {}),
          ...(this.isLive(name) ? { live: true, inDrive: true } : {}),
        };
      });
    if (this.state.current === null || this.meta.scenes[UNTITLED]) {
      list.unshift({
        name: null,
        status: "untitled",
        dirty: this.state.current === null ? this.state.dirty : true,
        inDrive: false,
        autoSync: false,
        localOnly: false,
      });
    }
    return list;
  }

  /** number of scenes with changes waiting to be pushed */
  pendingCount() {
    return this.state.list.filter((item) =>
      ["ahead", "diverged", "conflict", "live-saving", "live-browser", "live-unsaved"].includes(item.status) ||
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
    const changed = this.signedIn !== on;
    this.signedIn = on;
    if (changed) {
      this.ready.then(() => this.connectLive());
    }
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
      const json = await this.localJson(name);
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
    if (this.isLive(name)) {
      return this.keepOnlyHereLive(name);
    }
    const status = this.statusOf(name);
    if (status === "behind" || status === "diverged" || status === "conflict") {
      throw new Error(`Drive has changes to "${name}" that aren't here yet: sync it first`);
    }
    const driveName = this.meta.scenes[name]?.renamedFrom ?? name;
    const inDrive = !!this.remoteShaOf(driveName);
    await this.setLocalOnly(name, true);
    if (inDrive) {
      await scenesApi.remove(driveName);
    }
    const meta = this.sceneMeta(name);
    meta.baseSha = null;
    meta.keptLocal = true;
    delete meta.remoteSha;
    delete meta.renamedFrom;
    this.persistMeta();
    this.refresh();
    this.log("info", `"${name}" is only in this browser now${inDrive ? " (removed from Google Drive)" : ""}`);
    this.syncNow({ refresh: true });
  };

  /**
   * "Keep only here" for a live scene, by the closing handshake: refused for
   * a shared scene (or others' unsaved changes: the DO says so); the DO
   * closes the scene and hands over its final state, which is stored here
   * with every image and font before the DO deletes it and the file goes to
   * Drive's trash.
   */
  private async keepOnlyHereLive(name: string) {
    const fileId = this.fileIdOf(name);
    if (!fileId) {
      throw new Error(`"${name}" is not in Drive`);
    }
    const session = await liveSync.session(fileId, name);
    // the Worker checks with Drive that it is yours and shared with nobody; the DO that nobody else works on it
    const answer = await session.keepLocal().catch((error) => {
      session.resumeEditing();
      throw error;
    });
    if (!answer.ok) {
      session.resumeEditing(); // refused: the scene goes on as before
      throw Object.assign(
        new Error(
          answer.reason === "shared"
            ? `"${name}" is shared with others (or not yours): it can't be taken out of Drive. "Keep a local copy" makes a copy only in this browser instead.`
            : answer.reason === "connected"
            ? `"${name}" is open somewhere else right now: close it there first, or keep a local copy`
            : answer.reason === "others-pending"
            ? `Someone else's changes to "${name}" aren't in Drive yet: try again in a minute, or keep a local copy`
            : answer.reason === "offline"
            ? "Kurviq's server is not reachable: try again online"
            : answer.reason === "unsent"
            ? `Your latest changes to "${name}" aren't on Kurviq's server yet: try again in a moment`
            : `"${name}" can't be taken out of Drive now (${answer.reason})`,
        ),
        { keepLocalCopy: answer.reason !== "offline" && answer.reason !== "unsent" },
      );
    }
    // the final state is stored here (read back) before the DO may delete it
    session.stopEditing();
    await this.exclusive(async () => {
      const json = withSceneName(answer.json, name);
      // complete: every picture and font the scene uses is in it
      const data = JSON.parse(json);
      const fonts = new Set((data.kurviqFonts || []).map((font: any) => font.id));
      const incomplete = (data.elements || []).some(
        (el: any) =>
          !el.isDeleted &&
          ((el.type === "image" && el.fileId && !data.files?.[el.fileId]?.dataURL) || (el.fontFamily >= 2000 && el.fontFamily < 9000 && !fonts.has(el.fontFamily))),
      );
      if (incomplete) {
        throw new Error(`Not every picture or font of "${name}" is in this browser yet: it stays in Drive (open it, wait until everything shows, try again)`);
      }
      // stored in IndexedDB and read back, also for the open scene (the canvas alone is not durable)
      await setSnapshot(name, { json, baseline: null, dirty: true });
      if ((await getSnapshot(name))?.json !== json) {
        throw new Error(`"${name}" could not be stored in this browser: it stays in Drive`);
      }
      // only now the scene is this browser's (nothing was deleted anywhere yet)
      const meta = this.sceneMeta(name);
      meta.localOnly = true;
      meta.keptLocal = true;
      meta.baseSha = null;
      delete meta.remoteSha;
      delete meta.live;
      if (name === this.meta.current) {
        this.applyScene(json, name, { keepView: true });
      }
      this.persistMeta();
    }).catch((error) => {
      session.resumeEditing(); // the DO's closing runs out; the scene stays in Drive
      throw error;
    });
    session.keepLocalDone();
    // the DO closes the scene ("local") once it deleted its content
    await session.waitFor(() => session.lifecycle === "local" || session.stopped, 15_000, "").catch(() => {});
    if (liveSync.current() === session) {
      liveSync.detachCanvas();
    }
    await session.forgetAll();
    await driveScenes.trashFile(fileId).catch((error) => this.log("error", `"${name}" stays in Drive's folder: ${error.message}`));
    this.forgetRemoteFile(fileId);
    this.refresh();
    this.log("info", `"${name}" is only in this browser now (removed from Google Drive)`);
  }

  /** the user puts a scene in Drive (the cloud icon): local only or not, it is uploaded now */
  putInDrive = async (name: string) => {
    await this.ready;
    if (this.isLocalOnly(name)) {
      await this.setLocalOnly(name, false);
      return;
    }
    const meta = this.sceneMeta(name);
    if (!meta.baseSha) {
      meta.adopt = true;
      this.persistMeta();
    }
    if (name === this.meta.current) {
      this.pushCurrentNow = true;
    }
    this.syncNow();
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
      await this.putInDrive(name).catch((error) => this.log("error", `"${name}" not put in Drive: ${error.message}`));
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
      this.syncNow(); // open conflicts settle now
    }
  };

  setGlobalAutoSync = (on: boolean) => {
    this.meta.autoSync = on;
    this.persistMeta();
    this.setState({ autoSync: on });
    this.log("info", `Auto-sync ${on ? "on" : "off"}`);
    if (on) {
      this.syncNow({ refresh: true });
    }
  };

  /**
   * What this browser knew about the remote side is void: another Google
   * account signed in (its Drive is another one), or the first sign-in after
   * GitHub (versions there were git's). Scenes keep their content; with
   * `keepDirty`, a scene without local changes takes Drive's version (the
   * GitHub copies were moved to Drive as they were) and only scenes changed
   * here are merged. Otherwise every scene with content counts as changed
   * here, so it is saved to (or merged with) the new Drive — nothing local is
   * lost or overwritten.
   */
  /**
   * A browser never signed in with Google: what it knows about the remote
   * side is from GitHub (before 30 Oct 2026), so its scenes aren't "in Drive".
   * They are only here (local only); the user picks which go to Drive at sign-in.
   */
  forgetGitHubState = async () => {
    await this.ready;
    let changed = false;
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name === UNTITLED || (!meta.baseSha && !meta.remoteSha && !meta.adopt)) {
        continue;
      }
      meta.baseSha = null;
      delete meta.remoteSha;
      delete meta.conflict;
      delete meta.renamedFrom;
      delete meta.adopt;
      meta.localOnly = true;
      changed = true;
    }
    if (!changed) {
      return;
    }
    this.meta.pendingDeletes = {};
    this.persistMeta();
    this.setState({ remote: null, conflict: null });
    this.recomputeDirty();
    this.refresh();
  };

  /**
   * Signed in with a Google account this browser didn't sync with (the first
   * one, or another): what it knew about Drive is void. Its scenes stay in
   * this browser (local only) until the user puts them in Drive.
   */
  resetRemoteState = async () => {
    await this.ready;
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name === UNTITLED) {
        continue;
      }
      meta.baseSha = null;
      delete meta.remoteSha;
      delete meta.conflict;
      delete meta.renamedFrom;
      delete meta.adopt;
      delete meta.keptLocal;
      delete meta.live;
      meta.localOnly = true;
    }
    this.meta.pendingDeletes = {};
    this.meta.baseline = null;
    this.persistMeta();
    this.setState({ remote: null, conflict: null });
    this.recomputeDirty();
    this.refresh();
    this.syncNow({ refresh: true });
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
      this.syncNow();
    }
  };

  /**
   * Keep a scene only in this browser (never pushed or pulled), or sync it
   * again. A copy already in Drive stays there unchanged meanwhile; when
   * syncing is turned on again, both versions are merged as usual.
   */
  setLocalOnly = (name: string, on: boolean) =>
    this.exclusive(async () => {
      await this.ready;
      const meta = this.sceneMeta(name);
      if (on === !!meta.localOnly) {
        return;
      }
      if (on && meta.conflict) {
        throw new Error(`"${name}" has a conflict — resolve it first`);
      }
      if (on && meta.renamedFrom) {
        throw new Error(`The rename of "${name}" is not in Drive yet — try again once it is`);
      }
      if (on && this.isLive(name)) {
        throw new Error(`"${name}" saves live: use "Keep only here" (the cloud icon) to take it out of Drive`);
      }
      // the user's own choice: not "made while signed out" any more
      delete meta.moveOnSignIn;
      if (on) {
        meta.localOnly = true;
      } else {
        delete meta.localOnly;
        delete meta.keptLocal;
        if (!meta.baseSha) {
          // not in Drive: uploaded with the next sync even without changes
          meta.adopt = true;
        }
      }
      this.persistMeta();
      this.refresh();
      this.log(
        "info",
        on
          ? `"${name}" is local only now — not synced to Drive${this.remoteShaOf(name) ? " (the copy there stays as it is)" : ""}`
          : `"${name}" is synced with Drive again`,
      );
    }).then(() => {
      if (!on && this.autoSyncFor(name)) {
        if (name === this.meta.current) {
          this.pushCurrentNow = true;
        }
        this.syncNow();
      }
    });

  // ---------------------------------------------------------------------------
  // live sync: a Drive scene whose ticket said "enabled" saves only through
  // its Durable Object (online/liveSync.ts). The controller then never
  // pushes, pulls or merges it (no second writer); its local snapshot stays
  // as the offline copy. Scenes are named here, live sync knows file ids.
  // ---------------------------------------------------------------------------

  /** the Drive file of a scene (its shared space's file, the listing's, or the one live sync knows) */
  fileIdOf(name: string | null) {
    if (name === null) {
      return undefined;
    }
    const driveName = this.meta.scenes[name]?.renamedFrom ?? name;
    return (
      this.meta.scenes[name]?.live?.fileId ??
      this.state.remote?.find((scene) => scene.name === driveName)?.fileId ??
      (sharedFileId && !this.meta.scenes[name]?.localOnly ? sharedFileId : undefined)
    );
  }

  /**
   * Saves through live sync (never pushed / pulled / merged here): the
   * ticket said so (remembered), the Drive file is marked, or the open
   * scene's ticket is still being asked for (nothing writes it meanwhile;
   * "disabled" brings today's sync back at once).
   */
  isLive(name: string | null) {
    if (!LIVE_CAPABLE || name === null || this.meta.scenes[name]?.localOnly) {
      return false;
    }
    const driveName = this.meta.scenes[name]?.renamedFrom ?? name;
    if (this.meta.scenes[name]?.live || this.state.remote?.find((scene) => scene.name === driveName)?.live) {
      return true;
    }
    const scene = liveSync.current();
    return name === this.meta.current && !!scene && scene.fileId === this.fileIdOf(name) && scene.enabled !== false;
  }

  /** a live scene's file id (for the agent's requests through this tab), else null */
  liveFileId(name: string) {
    return this.isLive(name) ? this.fileIdOf(name) ?? null : null;
  }

  /** the open scene's live connection, if it is live */
  liveCurrent(): LiveScene | null {
    const scene = liveSync.current();
    return scene && scene.fileId === this.fileIdOf(this.meta.current) && this.isLive(this.meta.current) ? scene : null;
  }

  /** the open scene is a Drive scene: connect it to its Durable Object (or disconnect) */
  private connectLive() {
    if (!LIVE_CAPABLE || !this.api) {
      return;
    }
    const name = this.meta.current;
    const fileId = this.fileIdOf(name);
    // signed in with Drive (also in a shared scene's space, where "signedIn" is about new scenes)
    if (name === null || !fileId || !connection.isActive() || this.isLocalOnly(name) || this.meta.scenes[name]?.renamedFrom) {
      liveSync.detachCanvas();
      return;
    }
    const connected = liveSync.current();
    const driveName = this.meta.scenes[name]?.renamedFrom ?? name;
    const marked = !!this.state.remote?.find((scene) => scene.name === driveName)?.live;
    // the same scene: kept, unless it stopped for a reason a new try may fix (a new sign-in, or
    // the file became live meanwhile, e.g. access granted with the Picker)
    if (connected?.fileId === fileId && (!connected.stopped || (connected.enabled === false && !marked))) {
      return;
    }
    this.lastLiveKey = "";
    const baseSha = this.meta.scenes[name]?.baseSha;
    liveSync.attachCanvas(this.api, fileId, name, async () => {
      // the Drive version the local copy is based on: its changes are found against it
      if (!baseSha) {
        return null;
      }
      const json = await driveScenes.loadFileVersion(fileId, baseSha).catch(() => null);
      return json ? restoreElements(JSON.parse(json).elements, null, { repairBindings: true }) : null;
    });
  }

  /** the engine's state changed: the ticket's answer decides whether a scene is live */
  private liveChanged() {
    const scene = liveSync.current();
    const name = this.meta.current;
    if (scene && name !== null && scene.fileId === this.fileIdOf(name)) {
      const meta = this.sceneMeta(name);
      if (scene.enabled === true && !meta.localOnly && meta.live?.fileId !== scene.fileId) {
        meta.live = { fileId: scene.fileId };
        delete meta.adopt;
        this.persistMeta();
        this.log("info", `"${name}" saves live through Kurviq's server now`);
      } else if (scene.enabled === false && meta.live) {
        delete meta.live;
        this.persistMeta();
      }
    }
    this.refresh();
  }

  /**
   * Delete a live scene: the file goes to Drive's trash, its Durable Object
   * is told (it checks Drive and stops saving), and the browser's queue of it
   * is let go (the user deleted it).
   */
  private liveTrash = async (fileId: string, name: string) => {
    const session = await liveSync.session(fileId, name).catch(() => null);
    if (!session) {
      throw new Error(`"${name}" can't be deleted while Kurviq's server is not reachable: try again online`);
    }
    // Drive's trash first (the DO believes only Drive), then the DO hears of it and stops saving
    await driveScenes.trashFile(fileId);
    await session.trash();
    await session.forgetAll();
    this.forgetRemoteFile(fileId);
  };

  /** a live scene left Drive: the listing's entry of its file goes (it may still carry an older name) */
  private forgetRemoteFile(fileId: string) {
    if (this.state.remote) {
      this.setState({ remote: this.state.remote.filter((scene) => scene.fileId !== fileId) });
    }
  }

  private sceneOfFile(fileId: string) {
    return (
      Object.entries(this.meta.scenes).find(([, meta]) => meta.live?.fileId === fileId)?.[0] ??
      this.state.remote?.find((scene) => scene.fileId === fileId)?.name ??
      null
    );
  }

  private liveRenamed(fileId: string, to: string) {
    const from = this.sceneOfFile(fileId);
    if (from && from !== to && isSceneName(to)) {
      this.followRemoteRename(from, to, this.remoteShaOf(from) ?? null).catch(() => {});
    }
  }

  private liveLifecycle(fileId: string, state: string) {
    const name = this.sceneOfFile(fileId) ?? "this scene";
    const text =
      state === "trashed"
        ? `"${name}" is in Drive's trash: it isn't saved any more (Save as… keeps your version as a new scene)`
        : state === "deleted"
        ? `"${name}" was deleted for good in Drive (Save as… keeps your version as a new scene)`
        : state === "access"
        ? `You no longer have access to "${name}" in Drive: your changes stay in this browser`
        : state === "local"
        ? `"${name}" is kept only in a browser now`
        : `"${name}": ${state}`;
    this.log("error", text);
  }

  /** an offline copy / local copy: a new local-only scene under a free name */
  private async saveLiveCopy(name: string, json: string) {
    let free = name;
    for (let i = 2; this.exists(free); i++) {
      free = `${name} ${i}`;
    }
    await this.createLocalOnly(free, json);
    // read back: the live engine drops the original changes only once the copy is really stored
    const stored = await getSnapshot(free);
    if (!stored || stored.json !== withSceneName(json, free)) {
      throw new Error(`The copy "${free}" could not be stored in this browser`);
    }
    return free;
  }

  /**
   * An agent (or a whole-scene save) writes a live scene: the difference to
   * the live state goes through the scene's Durable Object as the agent's change.
   */
  liveWrite = async (fileId: string, name: string, json: string, baseSha?: string, source?: string) => {
    const session = await liveSync.session(fileId, name);
    const conflict = (clashes?: string[]) =>
      Object.assign(new Error(`"${name}" was changed in the meantime`), { status: 409, remoteSha: session.revision(), ...(clashes ? { clashes } : {}) });
    if (baseSha === "none" && session.elements().some((el) => !el.isDeleted)) {
      throw conflict();
    }
    // the exact document the writer read: only its own changes against that count (others' stay)
    let base: any = null;
    if (baseSha && baseSha !== "none") {
      const stored = baseSha.startsWith("live-") ? await this.liveRevision(fileId, baseSha) : null;
      if (!stored) {
        throw conflict(); // a version this browser doesn't know: read the scene again
      }
      base = JSON.parse(stored);
    }
    const data = JSON.parse(json);
    await registerSceneFonts(data);
    const next = restoreElements(data.elements || [], null, { repairBindings: true });
    const changed = liveDifference(session.elements(), next, base ? restoreElements(base.elements || [], null, { repairBindings: true }) : null);
    if (changed.clashes.length) {
      throw conflict(changed.clashes);
    }
    const files = Object.values(data.files || {}) as BinaryFileData[];
    // scene settings (background, grid): those the writer changed against what it read, on top of the current ones
    const settingsOf = (appState: any) => {
      const restored = restoreAppState(appState, null);
      return {
        viewBackgroundColor: restored.viewBackgroundColor,
        gridSize: restored.gridSize,
        gridStep: restored.gridStep,
        gridModeEnabled: restored.gridModeEnabled,
      } as Record<string, unknown>;
    };
    const current = session.settings() as Record<string, unknown>;
    let settings: Record<string, unknown> | null = null;
    if (data.appState) {
      const wanted = settingsOf(data.appState);
      const read = base ? settingsOf(base.appState) : current;
      const mine = Object.keys(wanted).filter((key) => JSON.stringify(wanted[key]) !== JSON.stringify(read[key]));
      if (mine.length) {
        settings = { ...current };
        for (const key of mine) {
          settings[key] = wanted[key];
        }
      }
    }
    await session.agentEdit(changed, files, undefined, settings as any);
    const after = await this.rememberLiveSnapshot(session, { agent: !!source?.startsWith("agent") });
    return { sha: after, commit: after, changed: changed.length > 0 || !!settings };
  };

  /** the session's current document under its exact revision id (agents name it as their base) */
  rememberLiveSnapshot = async (session: LiveScene, { agent = false } = {}) => {
    const { revision, json } = session.snapshot();
    await this.rememberLiveRevision(session.fileId, revision, json, { agent });
    return revision;
  };

  /**
   * Revisions of a live scene for agents ("live-<seq>"): the content as it
   * was, kept in this browser (Drive gets it a minute later). The agent's
   * last edit counts as its baseline until then, so read_scene never reports
   * the agent's own edit as the user's.
   */
  rememberLiveRevision = async (fileId: string, revision: string, json: string, { agent = false } = {}) => {
    await setCheckpoint(`live-rev:${fileId}:${revision}`, json).catch(() => {});
    if (agent) {
      await setCheckpoint(`live-agent:${fileId}`, { sha: revision, commit: revision, at: new Date().toISOString() }).catch(() => {});
    }
  };

  liveRevision = async (fileId: string, revision: string) => ((await getCheckpoint(`live-rev:${fileId}:${revision}`).catch(() => null)) as string | null) ?? null;

  liveAgentVersion = async (fileId: string) =>
    ((await getCheckpoint(`live-agent:${fileId}`).catch(() => null)) as { sha: string; commit: string; at: string } | null) ?? null;

  /** a live scene's session (the canvas if open, else headless) for agents; null: not live */
  liveSessionFor = async (name: string) => {
    const fileId = this.liveFileId(name) ?? (LIVE_CAPABLE ? await driveScenes.liveFileOf(name).catch(() => null) : null);
    if (!fileId) {
      return null;
    }
    return liveSync.session(fileId, name);
  };

  /**
   * "Keep a local copy" (a shared scene, or others' unsaved changes): a new
   * local-only scene, complete with every image and font it uses; the
   * shared scene is not touched.
   */
  keepLocalCopy = async (name: string) => {
    await this.ready;
    const json = await this.localJson(name);
    if (json === null) {
      throw new Error(`"${name}" was never opened in this browser`);
    }
    const data = JSON.parse(json);
    const missing = (data.elements || []).filter((el: any) => !el.isDeleted && el.type === "image" && el.fileId && !data.files?.[el.fileId]?.dataURL);
    if (missing.length) {
      throw new Error(`${missing.length} picture(s) of "${name}" aren't in this browser yet: open the scene and wait until they show, then try again`);
    }
    const copy = await this.saveLiveCopy(`${name} (local copy)`, json);
    this.log("info", `"${name}" is kept as "${copy}" in this browser (the shared scene stays as it is)`);
    return copy;
  };

  // ---------------------------------------------------------------------------
  // local content
  // ---------------------------------------------------------------------------

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
      json: withFonts(serializeAsJSON(elements, appState, api.getFiles(), "local"), elements),
      hash: sceneHash(elements, appState),
      isEmpty: elements.length === 0,
    };
  }

  /** the open scene as a file download (when the browser can't store it) */
  exportCurrent = () => {
    const { json } = this.serializeCurrent();
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${this.meta.current ?? "Untitled"}.excalidraw`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /** current content of a scene: the canvas if active, else its snapshot */
  private async localJson(name: string): Promise<string | null> {
    if (name === this.meta.current) {
      return this.serializeCurrent().json;
    }
    return (await getSnapshot(name))?.json ?? null;
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
        this.meta.scenes[UNTITLED] = { baseSha: null, dirty: true };
      }
      return;
    }
    await setSnapshot(name, { json, baseline: this.meta.baseline, dirty: this.state.dirty });
    this.sceneMeta(name).dirty = this.state.dirty;
  }

  private applyScene(json: string | null, name: string | null, { keepView = false } = {}) {
    const api = this.requireApi();
    const data = json ? JSON.parse(json) : {};
    // its custom fonts (the canvas redraws once they are loaded)
    registerSceneFonts(data);
    const elements = restoreElements(data.elements, null, { repairBindings: true });
    const restoredAppState = restoreAppState(data.appState, null);
    const files: BinaryFiles = data.files || {};

    const sceneAppState = {
      name: name ?? restoredAppState.name,
      viewBackgroundColor: restoredAppState.viewBackgroundColor,
      gridSize: restoredAppState.gridSize,
      gridStep: restoredAppState.gridStep,
      gridModeEnabled: restoredAppState.gridModeEnabled,
    };
    if (keepView) {
      api.updateScene({ elements, appState: sceneAppState, captureUpdate: CaptureUpdateAction.NEVER });
    } else {
      api.updateScene({
        elements,
        appState: { ...sceneAppState, selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    const fileList = Object.values(files) as BinaryFileData[];
    if (fileList.length) {
      api.addFiles(fileList);
    }
    if (!keepView) {
      api.history.clear();
    }
  }

  /** after loading a base version into the canvas: it is the new baseline */
  private async setBaselineFromCanvas() {
    await nextFrame();
    const api = this.requireApi();
    this.meta.baseline = sceneHash(api.getSceneElements(), api.getAppState());
    this.persistMeta();
    this.recomputeDirty();
  }

  /** store a scene's content locally (canvas if active, else snapshot) */
  private async writeLocal(name: string, json: string, { dirty }: { dirty: boolean }) {
    if (name === this.meta.current) {
      this.applyScene(json, name, { keepView: true });
      if (dirty) {
        await nextFrame();
        this.recomputeDirty();
      } else {
        await this.setBaselineFromCanvas();
      }
    } else {
      await setSnapshot(name, { json, baseline: dirty ? null : hashJson(json), dirty });
    }
    this.sceneMeta(name).dirty = dirty;
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
   * switch to a scene (null = untitled draft). Not queued behind sync steps
   * (a push can hang for seconds on a bad connection) — those re-check
   * afterwards whether the scene is still the open one. Opens run one at a time.
   */
  open = (name: string | null, { missingIsFine = false }: { missingIsFine?: boolean } = {}) => {
    if (name !== null && name !== this.meta.current) {
      this.setState({ opening: name });
    }
    const run = this.openChain.then(async () => {
      await this.ready;
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
    });
    this.openChain = run.catch(() => {});
    return run;
  };

  private openChain: Promise<unknown> = Promise.resolve();

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
    scenesApi
      .load(name)
      .then(async (latest) => {
        if (this.openToken !== token || this.meta.current !== name || this.isDirty(name) || this.isLive(name)) {
          return; // switched on, or edited after the unlock, or live: sync (or the scene's DO) takes it from here
        }
        const meta = this.sceneMeta(name);
        this.updateRemoteSha(name, latest.sha);
        if (latest.sha === meta.baseSha) {
          return; // the local copy is up to date
        }
        this.applyScene(latest.json, name, { keepView: true });
        Object.assign(meta, { baseSha: latest.sha, remoteSha: latest.sha, dirty: false });
        delete meta.legacy;
        this.persistMeta();
        await this.setBaselineFromCanvas();
        this.log("pull", `Updated "${name}" from Drive`);
        this.refresh();
      })
      .catch(() => {}) // offline: the local copy it is
      .finally(() => {
        window.clearTimeout(timer);
        release();
      });
  }

  private async openInner(name: string | null, { stash = true, force = false } = {}) {
      if (name === this.meta.current && !force) {
        return;
      }
      this.releaseOpenLock();
      ++this.openToken; // a pending check of the previous scene must not apply
      if (stash) {
        await this.stashCurrent();
      }
      // the canvas is about to show another scene: the previous scene's live connection lets go first
      liveSync.detachCanvas();

      const snapshot = await getSnapshot(name);
      let json: string | null = null;
      let baseline: number | null = null;
      let loadedSha: string | null = null;
      let checkDrive = false;
      const meta = name === null ? undefined : this.meta.scenes[name];

      if (name === null || (snapshot && (snapshot.dirty || meta?.conflict))) {
        // local changes win — sync takes care of Drive
        json = snapshot?.json ?? null;
        baseline = snapshot?.baseline ?? null;
      } else if (this.state.sync.driveOnline === false || this.state.sync.serverReachable === false) {
        if (!snapshot) {
          throw Object.assign(
            new Error(`"${name}" was never downloaded to this browser and Drive is not reachable`),
            { status: 503 },
          );
        }
        json = snapshot.json;
      } else if (snapshot) {
        // show the local copy (no local changes) right away, check Drive in
        // the background; it is its own base
        json = snapshot.json;
        checkDrive = true;
      } else {
        // never opened here: Drive's version is all there is
        const latest = await scenesApi.load(name);
        json = latest.json;
        loadedSha = latest.sha;
      }

      this.applyScene(json, name);
      this.meta.current = name;
      this.meta.baseline = baseline;
      if (name === null) {
        delete this.meta.scenes[UNTITLED];
        await deleteSnapshot(null);
      } else {
        const sceneMeta = this.sceneMeta(name);
        if (loadedSha) {
          sceneMeta.baseSha = loadedSha;
          sceneMeta.remoteSha = loadedSha;
          sceneMeta.dirty = false;
          delete sceneMeta.legacy;
        }
      }
      this.persistMeta();
      this.setState({ current: name });
      if (baseline === null && name !== null && this.meta.scenes[name]?.baseSha) {
        await this.setBaselineFromCanvas();
      } else {
        await nextFrame();
        this.recomputeDirty();
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
      if (checkDrive && name !== null && !this.isLive(name)) {
        this.checkOpenedScene(name);
      }
      this.connectLive();
  }

  /**
   * The scene's Drive file, for sharing: unsaved changes go to Drive first
   * (a scene that is only in this browser can't be shared).
   */
  fileForSharing = (name: string) =>
    this.withBusy("saving", async () => {
      if (this.isLocalOnly(name)) {
        throw new Error(`"${name}" is kept in this browser only: sync it with Google Drive first`);
      }
      if (!this.isLive(name) && (this.isDirty(name) || this.statusOf(name) !== "synced")) {
        await this.pushScene(name, { manual: true });
      }
      await this.refreshListing();
      const fileId = this.state.remote?.find((scene) => scene.name === name)?.fileId;
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
      api?.updateScene({ elements: [], appState: { name: "" }, captureUpdate: CaptureUpdateAction.NEVER });
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
      liveSync.detachCanvas();
      this.applyScene(null, name);
      this.meta.current = name;
      this.meta.baseline = null;
      this.meta.scenes[name] = localOnly
        ? { baseSha: null, dirty: false, localOnly, ...(options?.localOnly === undefined ? this.madeSignedOut() : {}) }
        : this.claimName(name, false);
      this.persistMeta();
      await nextFrame();
      this.setState({ current: name });
      this.recomputeDirty();
    });

  /** open a scene, or create it (empty, local) if it doesn't exist anywhere */
  openOrCreate = async (name: string) => {
    if (name === this.meta.current) {
      return;
    }
    // its name from the start (the link names it), not "Untitled" while it loads
    this.setState({ opening: name });
    try {
      await this.openOrCreateInner(name);
    } finally {
      if (this.state.opening === name) {
        this.setState({ opening: null });
      }
    }
  };

  private openOrCreateInner = async (name: string) => {
    // online without Drive: there is nowhere else to look, a new scene right away
    if (!this.exists(name) && this.state.sync.notConnected) {
      await this.create(name);
      return;
    }
    try {
      await this.open(name, { missingIsFine: true });
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
      await this.create(name);
    }
  };

  private exists(name: string) {
    return (
      !!this.meta.scenes[name] ||
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
    const deletedSha = this.meta.pendingDeletes[name];
    if (deletedSha) {
      delete this.meta.pendingDeletes[name];
      return { baseSha: deletedSha, remoteSha: deletedSha, dirty: true };
    }
    return { baseSha: null, dirty };
  }

  private validateName(name: string) {
    if (!isSceneName(name)) {
      throw new Error("Invalid name. Use letters, numbers, spaces and _ . ( ) - (max 100 chars).");
    }
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
        if (this.exists(targetName)) {
          throw new Error(`A scene named "${targetName}" already exists`);
        }
        const api = this.requireApi();
        const { json } = this.serializeCurrent();
        if (this.meta.current === null) {
          // the untitled draft becomes a named scene
          delete this.meta.scenes[UNTITLED];
          await deleteSnapshot(null);
        } else {
          // "save as": the previous scene keeps its state
          await this.stashCurrent();
        }
        this.meta.current = targetName;
        this.meta.baseline = null;
        this.meta.scenes[targetName] = keepLocal
          ? { baseSha: null, dirty: true, localOnly: true, ...(localOnly === undefined ? this.madeSignedOut() : {}) }
          : this.claimName(targetName, true);
        // "save as": the copy is a new scene, the live connection stays with the original
        liveSync.detachCanvas();
        api.updateScene({ appState: { name: targetName }, captureUpdate: CaptureUpdateAction.NEVER });
        await setSnapshot(targetName, { json, baseline: null, dirty: true });
        this.persistMeta();
        this.setState({ current: targetName, dirty: true });
      }
      if (this.isLocalOnly(targetName)) {
        return { name: targetName, localOnly: true }; // the browser keeps it, nothing to push
      }
      if (this.isLive(targetName)) {
        // saved through its Durable Object: what is collected goes out now
        await this.liveCurrent()?.flushNow();
        return { name: targetName, live: true };
      }
      const result = await this.pushScene(targetName, { manual: true });
      if (this.meta.scenes[targetName]?.conflict) {
        throw new Error(
          `"${targetName}" has conflicting changes in Drive — resolve them in the Scenes sidebar`,
        );
      }
      return { name: targetName, ...(result || {}) };
    });

  // ---------------------------------------------------------------------------
  // sync engine
  // ---------------------------------------------------------------------------

  private syncing = false;
  private syncAgain = false;

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
      let listing;
      try {
        listing = await scenesApi.list(refresh);
      } catch (error: any) {
        if (error.notConnected) {
          this.setState({
            sync: { ...this.state.sync, serverReachable: true, driveOnline: false, notConnected: true, lastError: null },
          });
          return;
        }
        if (this.state.sync.serverReachable !== false) {
          this.log("error", "Scenes server not reachable — working locally");
        }
        this.setState({
          sync: { ...this.state.sync, serverReachable: false, lastError: error.message },
        });
        return;
      }
      const wasOnline = this.state.sync.driveOnline;
      this.applyListing(listing.scenes);
      this.setState({
        sync: {
          ...this.state.sync,
          serverReachable: true,
          notConnected: false,
          readOnly: listing.remote.readOnly ?? null,
          driveOnline: listing.remote.online,
          lastCheckedAt: listing.remote.lastFetchAt,
          lastError: listing.remote.lastError,
        },
      });
      if (listing.remote.online === false) {
        if (wasOnline !== false) {
          this.log("error", `Drive not reachable — working locally (${listing.remote.lastError})`);
        }
        return;
      }
      if (wasOnline === false) {
        this.log("info", "Drive reachable again");
      }

      if (this.state.sync.readOnly) {
        // Drive lets this user read the space, not change it: only pull
        for (const item of this.state.list) {
          if (item.name !== null && !this.isLive(item.name) && this.statusOf(item.name) === "behind" && !this.isDirty(item.name)) {
            await this.exclusive(() => this.pullScene(item.name!));
          }
        }
        return;
      }

      // renames / deletions made here (e.g. while offline) go first — they
      // are explicit user actions, independent of auto-sync
      await this.exclusive(() => this.pushPendingOps());
      await this.exclusive(() => this.adoptEmptyLocalOnly());
      await this.exclusive(async () => this.dropScenesDeletedInDrive());

      for (const item of this.state.list) {
        const name = item.name;
        if (name === null || !this.autoSyncFor(name) || this.isLive(name)) {
          continue; // live scenes save through their Durable Object
        }
        const status = this.statusOf(name);
        const adopt = !!this.meta.scenes[name]?.adopt;
        if (adopt && status !== "local") {
          // Drive has it: its copy counts from now on (pulled below, or merged if changed here)
          delete this.meta.scenes[name].adopt;
          this.persistMeta();
        }
        if (status === "behind") {
          await this.exclusive(() => this.pullScene(name));
        } else if (status === "ahead" || (status === "local" && (this.isDirty(name) || adopt))) {
          if (name === this.meta.current && !this.pushDue()) {
            continue;
          }
          const json = await this.localJson(name);
          if (status === "local" && json && isEmptyJson(json)) {
            continue; // don't publish empty new scenes automatically
          }
          await this.exclusive(() => this.pushScene(name));
          if (adopt && this.meta.scenes[name]?.baseSha) {
            delete this.meta.scenes[name].adopt;
            this.persistMeta();
          }
        } else if (status === "diverged") {
          await this.exclusive(() => this.mergeScene(name));
        } else if (status === "conflict" && this.conflictOutdated(name)) {
          // Drive moved on, or found by an older merge: maybe it merges now
          await this.exclusive(() => this.mergeScene(name));
        }
      }
    } catch (error: any) {
      console.error(error);
      this.log("error", error.message);
    } finally {
      this.syncing = false;
      this.setState({ sync: { ...this.state.sync, running: false } });
      if (this.syncAgain) {
        this.syncAgain = false;
        this.syncNow();
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
      const json = await this.localJson(name);
      if (json && !isEmptyJson(json)) {
        continue;
      }
      delete meta.localOnly;
      meta.baseSha = null;
      meta.dirty = false;
      this.persistMeta();
      this.log("info", `"${name}" now exists in Drive — loading it`);
    }
    this.refresh();
  }

  private conflictOutdated(name: string) {
    const conflict = this.meta.scenes[name]?.conflict;
    const remote = this.remoteShaOf(name);
    return (
      !!conflict &&
      (this.clashMode() === "newest" || conflict.v !== MERGE_VERSION || (!!remote && remote !== conflict.remoteSha))
    );
  }

  private pushDue() {
    return this.pushCurrentNow || Date.now() - this.lastChangeAt >= IDLE_PUSH_MS;
  }

  private maybePushCurrent() {
    const name = this.meta.current;
    if (name !== null && this.state.dirty && this.autoSyncFor(name) && !this.isLive(name) && this.pushDue()) {
      this.syncNow();
    }
  }

  private applyListing(scenes: RemoteScene[]) {
    const remote = new Map(scenes.map((scene) => [scene.name, scene.sha]));
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name === UNTITLED) {
        continue;
      }
      meta.remoteSha = remote.get(meta.renamedFrom ?? name) ?? null;
      if (meta.legacy) {
        // metadata from before the sync engine: assume based on the latest version
        meta.baseSha = remote.get(name) ?? null;
        delete meta.legacy;
        delete meta.inRepo;
      }
    }
    this.persistMeta();
    this.setState({ remote: scenes });
    this.connectLive();
  }

  /** push local content; on "Drive changed meanwhile" merge instead */
  private async pushScene(name: string, { manual = false } = {}) {
    if (this.isLocalOnly(name)) {
      return null; // never leaves this browser
    }
    if (this.isLive(name)) {
      return null; // its Durable Object saves it: never a second writer
    }
    if (this.state.sync.readOnly) {
      if (manual) {
        throw new Error(`Saved in this browser only. Read only: ${this.state.sync.readOnly}`);
      }
      return null;
    }
    if (this.meta.scenes[name]?.renamedFrom) {
      // the rename has to reach Drive before the content can
      await this.pushPendingRename(name);
      if (this.meta.scenes[name]?.renamedFrom) {
        if (manual) {
          throw new Error(`Saved locally — the rename of "${name}" is not in Drive yet, will retry`);
        }
        return null;
      }
    }
    const isCurrent = name === this.meta.current;
    if (isCurrent && this.requireApi().getAppState().name !== name) {
      // the canvas shows another scene's drawing: never push it under this name
      const message = `Not saved to Drive: this tab's canvas belongs to "${this.requireApi().getAppState().name}", not "${name}". Reload the tab.`;
      this.log("error", message);
      if (manual) {
        throw new Error(message);
      }
      return null;
    }
    const canvas = isCurrent ? this.serializeCurrent() : null;
    const stored = canvas ? canvas.json : await this.localJson(name);
    if (stored === null) {
      return null;
    }
    if (!manual && isEmptyJson(stored) && (await this.refuseEmptyPush(name))) {
      return null;
    }
    // the file names its scene (the server rejects content of another scene);
    // stored copies may still carry an old name (e.g. from before a rename)
    const json = withSceneName(stored, name);
    const meta = this.sceneMeta(name);
    const remote = this.remoteShaOf(name);
    const base = remote === null ? "none" : meta.baseSha ?? "none";
    let result;
    try {
      result = await scenesApi.save(name, json, base);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.status === 409) {
        meta.remoteSha = apiError.remoteSha ?? null;
        this.updateRemoteSha(name, apiError.remoteSha ?? null);
        this.log("info", `"${name}" changed in Drive meanwhile — merging`);
        await this.mergeScene(name, { pushAfter: true });
        return null;
      }
      if (apiError.notConnected) {
        this.setState({ sync: { ...this.state.sync, driveOnline: false, notConnected: true } });
        if (manual) {
          throw new Error("Saved in this browser — sign in with Google to sync it");
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
        this.setState({
          sync: { ...this.state.sync, driveOnline: apiError.status === 0 ? this.state.sync.driveOnline : false, serverReachable: apiError.status === 0 ? false : true },
        });
        if (manual) {
          throw new Error(`Saved locally — Drive not reachable, will sync when back online`);
        }
        return null;
      }
      this.log("error", `Push of "${name}" failed: ${apiError.message}`);
      if (manual) {
        throw apiError;
      }
      return null;
    }
    meta.baseSha = result.sha;
    meta.remoteSha = result.sha;
    meta.dirty = false;
    delete meta.conflict;
    this.updateRemoteSha(name, result.sha);
    if (LIVE_CAPABLE && name === this.meta.current && !this.fileIdOf(name)) {
      // just created in Drive: its file id (and so live sync) with a fresh listing, not the next poll
      this.refreshListing().catch(() => {});
    }
    if (canvas && name === this.meta.current) {
      // what was pushed is the new base; edits made during the push stay dirty
      this.meta.baseline = canvas.hash;
      this.pushCurrentNow = false;
      this.persistMeta();
      this.recomputeDirty();
    } else {
      const stored = await getSnapshot(name);
      if (stored && withSceneName(stored.json, name) !== json) {
        // edited while the push was on its way (and stashed by a switch):
        // the pushed version is the new base, the later edits stay
        await setSnapshot(name, { ...stored, baseline: hashJson(json), dirty: true });
        meta.dirty = true;
      } else {
        await setSnapshot(name, { json, baseline: hashJson(json), dirty: false });
      }
    }
    this.persistMeta();
    this.log("push", result.changed ? `Pushed "${name}" (${result.commit?.slice(0, 7)})` : `"${name}" already up to date`);
    this.refresh();
    return result;
  }

  /** Drive has a newer version and there are no local changes */
  private async pullScene(name: string) {
    if (this.isLive(name) || this.statusOf(name) !== "behind") {
      return; // changed meanwhile
    }
    let latest;
    try {
      latest = await scenesApi.load(name);
    } catch (error) {
      if (!(error as ApiError).offline) {
        this.log("error", `Download of "${name}" failed: ${(error as Error).message}`);
      }
      return;
    }
    if (this.isDirty(name)) {
      return; // the user started editing meanwhile — next round merges
    }
    await this.writeLocal(name, latest.json, { dirty: false });
    const meta = this.sceneMeta(name);
    const wasKnown = !!meta.baseSha;
    meta.baseSha = latest.sha;
    meta.remoteSha = latest.sha;
    delete meta.legacy;
    this.persistMeta();
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
    if (this.remoteShaOf(name) === null) {
      return false;
    }
    let latest;
    try {
      latest = await scenesApi.load(name);
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
    const meta = this.sceneMeta(name);
    await this.writeLocal(name, latest.json, { dirty: false });
    meta.baseSha = latest.sha;
    meta.remoteSha = latest.sha;
    delete meta.conflict;
    this.persistMeta();
    this.log("pull", `"${name}" was empty here (not by an edit): loaded it from Drive instead of pushing the empty version`);
    this.refresh();
    return true;
  }

  /** both sides changed: three-way merge per element */
  private async mergeScene(
    name: string,
    {
      pushAfter = this.autoSyncFor(name),
      choices = {} as Record<string, ClashChoice>,
    } = {},
  ) {
    if (this.isLive(name)) {
      return null;
    }
    const mineJson = await this.localJson(name);
    let theirs;
    try {
      theirs = await scenesApi.load(name);
    } catch (error) {
      if ((error as ApiError).status === 404 && mineJson) {
        // deleted in Drive meanwhile: ours becomes a new scene again
        this.sceneMeta(name).baseSha = null;
        this.sceneMeta(name).remoteSha = null;
        this.persistMeta();
        return pushAfter ? this.pushScene(name) : null;
      }
      return null;
    }
    if (mineJson === null) {
      return this.pullScene(name);
    }
    const meta = this.sceneMeta(name);
    let base: any = null;
    if (meta.baseSha) {
      try {
        base = JSON.parse((await scenesApi.load(name, meta.baseSha)).json);
      } catch {
        base = null; // unknown base: everything that differs counts as changed
      }
    }
    const mine = JSON.parse(mineJson);
    const theirsData = JSON.parse(theirs.json);
    // the merge is based on mineJson: if the scene changed while Drive was
    // asked (edited, or switched to/away), drop this round — the next sync merges
    const unchanged = async () =>
      name === this.meta.current
        ? this.serializeCurrent().json === mineJson
        : (await getSnapshot(name))?.json === mineJson;
    // a local copy without any elements never deletes Drive's content by a
    // merge (an editor that lost its canvas looks like "the user deleted everything")
    if (!getNonDeletedElements(mine.elements || []).length && getNonDeletedElements(theirsData.elements || []).length) {
      if (!(await unchanged())) {
        return null;
      }
      await this.writeLocal(name, theirs.json, { dirty: false });
      meta.baseSha = theirs.sha;
      meta.remoteSha = theirs.sha;
      delete meta.conflict;
      this.persistMeta();
      this.log("pull", `"${name}" was empty here: took Drive's version`);
      this.refresh();
      return null;
    }
    let merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], choices);
    let settled: string[] = [];
    if (merged.clashes.length && this.clashMode() === "newest") {
      // like live collaboration: per element the newer edit wins
      const auto = newestWins(mine.elements || [], theirsData.elements || [], merged.clashes);
      settled = merged.clashes.map((id) => `${id}: ${auto[id] === "mine" ? "yours" : "Drive's"}`);
      merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], { ...auto, ...choices });
    }
    meta.remoteSha = theirs.sha;
    this.updateRemoteSha(name, theirs.sha);

    if (merged.clashes.length) {
      meta.conflict = { remoteSha: theirs.sha, clashes: merged.clashes, v: MERGE_VERSION };
      this.persistMeta();
      this.log(
        "conflict",
        `Conflict in "${name}": you and Drive changed the same ${merged.clashes.length} element(s) — choose how to resolve`,
      );
      this.refresh();
      return null;
    }

    await registerSceneFonts(theirsData);
    const mergedJson = JSON.stringify({
      ...mine,
      elements: merged.elements,
      // only the pictures the merged scene still uses (deleted images leave no data behind)
      files: usedFiles(merged.elements, { ...(theirsData.files || {}), ...(mine.files || {}) }),
      kurviqFonts: mergeFontLists(mine.kurviqFonts, theirsData.kurviqFonts),
    });
    if (!(await unchanged())) {
      return null;
    }
    meta.baseSha = theirs.sha;
    delete meta.conflict;
    if (name === this.meta.current) {
      // base is now Drive's version: dirty = merged differs from it
      this.meta.baseline = hashJson(theirs.json);
      this.applyScene(mergedJson, name, { keepView: true });
      await nextFrame();
      this.recomputeDirty();
      meta.dirty = this.state.dirty;
    } else {
      await setSnapshot(name, { json: mergedJson, baseline: hashJson(theirs.json), dirty: true });
      meta.dirty = true;
    }
    this.persistMeta();
    const parts = [
      merged.fromTheirs ? `${merged.fromTheirs} change(s) from Drive` : null,
      merged.fromMine ? `${merged.fromMine} of yours` : null,
      settled.length
        ? `changed on both sides, newer edit kept: ${settled.slice(0, 5).join(", ")}${settled.length > 5 ? ` (+${settled.length - 5})` : ""}`
        : null,
    ].filter(Boolean);
    this.log("merge", `Merged "${name}": ${parts.join("; ") || "nothing new"}`);
    this.refresh();
    if (pushAfter && this.isDirty(name)) {
      return this.pushScene(name);
    }
    return null;
  }

  private async pushPendingOps() {
    for (const [name, sha] of Object.entries(this.meta.pendingDeletes)) {
      try {
        await scenesApi.remove(name, sha);
        this.log("push", `Deleted "${name}" in Drive`);
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.offline) {
          return;
        }
        if (apiError.status === 409) {
          this.log("info", `"${name}" was changed in Drive after you deleted it — kept in Drive`);
        } else if (apiError.status !== 404) {
          this.log("error", `Could not delete "${name}" in Drive: ${apiError.message}`);
          continue;
        }
      }
      delete this.meta.pendingDeletes[name];
      this.updateRemoteSha(name, null);
      this.persistMeta();
    }
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (meta.renamedFrom && !(await this.pushPendingRename(name))) {
        return;
      }
    }
  }

  /** returns false when Drive is not reachable */
  private async pushPendingRename(name: string) {
    const meta = this.meta.scenes[name];
    const from = meta?.renamedFrom;
    if (!from) {
      return true;
    }
    try {
      const result = await scenesApi.rename(from, name);
      meta.remoteSha = result.sha;
      this.updateRemoteSha(from, null);
      this.updateRemoteSha(name, result.sha);
      this.log("push", `Renamed "${from}" to "${name}" in Drive`);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.offline) {
        return false;
      }
      if (apiError.status === 404) {
        // gone from Drive meanwhile: ours is a new scene now
        meta.baseSha = null;
        meta.remoteSha = null;
        meta.dirty = true;
      } else {
        this.log(
          "error",
          apiError.exists
            ? `Can't rename "${from}" to "${name}" in Drive: "${name}" exists there — rename this scene again`
            : `Rename of "${from}" in Drive failed: ${apiError.message}`,
        );
        return true;
      }
    }
    delete meta.renamedFrom;
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
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (meta.localOnly && meta.baseSha && !remote.has(meta.renamedFrom ?? name)) {
        // its old copy in Drive is gone: the local scene is all there is
        meta.baseSha = null;
        meta.dirty = true;
        this.persistMeta();
        continue;
      }
      if (meta.live && (name === this.meta.current || liveSync.stageOf(meta.live.fileId) !== null)) {
        continue; // its Durable Object tells what happened (trashed, deleted), with changes still to keep
      }
      if (
        name === UNTITLED ||
        meta.localOnly ||
        !meta.baseSha ||
        meta.renamedFrom ||
        meta.conflict ||
        remote.has(name)
      ) {
        continue;
      }
      if (this.isDirty(name)) {
        this.log("info", `"${name}" was deleted in Drive — you changed it here, so it is kept`);
        meta.baseSha = null;
      } else if (name === this.meta.current) {
        this.log("info", `"${name}" was deleted in Drive — still open here as a local scene`);
        meta.baseSha = null;
        this.meta.baseline = null;
      } else {
        await deleteSnapshot(name);
        await deleteAgentBaseline(name);
        delete this.meta.scenes[name];
        this.log("pull", `"${name}" was deleted in Drive — removed here too`);
      }
      this.persistMeta();
    }
    this.refresh();
  }

  private updateRemoteSha(name: string, sha: string | null) {
    if (!this.state.remote) {
      return;
    }
    const others = this.state.remote.filter((scene) => scene.name !== name);
    const existing = this.state.remote.find((scene) => scene.name === name);
    this.setState({
      remote: sha
        ? [...others, { ...existing, name, sha, updatedAt: existing?.updatedAt ?? new Date().toISOString() }].sort((a, b) =>
            a.name.localeCompare(b.name),
          )
        : others,
    });
  }

  // ---------------------------------------------------------------------------
  // rename / delete / duplicate — applied here right away, in Drive right
  // away too when it is reachable, otherwise queued until it is
  // ---------------------------------------------------------------------------

  /** latest Drive listing before renaming / deleting / duplicating (best effort) */
  private async refreshListing() {
    try {
      this.applyListing((await scenesApi.list()).scenes);
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
        throw new Error(`"${from}" has a conflict — resolve it first`);
      }
      // local-only scenes are renamed here only (a copy in Drive keeps its name)
      const liveFile = this.liveFileId(from);
      // a live scene's rename is an event like any other: its DO renames the file
      const driveName = meta?.localOnly || liveFile ? null : meta?.renamedFrom ?? (this.remoteShaOf(from) ? from : null);
      if (liveFile) {
        const session = from === this.meta.current ? this.liveCurrent() : await liveSync.session(liveFile, from).catch(() => null);
        if (!session) {
          throw new Error(`"${from}" can't be renamed while Kurviq's server is not reachable: try again online`);
        }
        session.rename(to);
        const remote = this.state.remote?.find((scene) => scene.name === from);
        if (remote) {
          this.setState({ remote: this.state.remote!.map((scene) => (scene === remote ? { ...scene, name: to } : scene)) });
        }
      }
      const next: SceneMeta = { ...(meta ?? { baseSha: null, dirty: false }) };
      if (meta?.localOnly && meta.baseSha) {
        next.baseSha = null; // no longer related to the Drive copy
        next.dirty = true;
      }
      delete next.renamedFrom;

      if (driveName) {
        try {
          const result = await scenesApi.rename(driveName, to);
          next.remoteSha = result.sha;
          this.updateRemoteSha(driveName, null);
          this.updateRemoteSha(to, result.sha);
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError.status === 404) {
            next.baseSha = null; // not in Drive (anymore): just a local scene
          } else if (!apiError.offline) {
            throw apiError;
          } else if (!(await this.hasLocalContent(from))) {
            throw new Error(`"${from}" was never downloaded to this browser and Drive is not reachable — try again online`);
          } else {
            next.renamedFrom = driveName; // Drive follows when reachable
          }
        }
      }

      if (from !== this.meta.current) {
        const snapshot = await getSnapshot(from);
        if (snapshot) {
          await setSnapshot(to, snapshot);
          await deleteSnapshot(from);
        }
      }
      delete this.meta.scenes[from];
      this.meta.scenes[to] = next;
      delete this.meta.pendingDeletes[to];
      if (from === this.meta.current) {
        this.meta.current = to;
        this.requireApi().updateScene({ appState: { name: to }, captureUpdate: CaptureUpdateAction.NEVER });
      }
      await moveAgentBaseline(from, to);
      this.persistMeta();
      this.setState({ current: this.meta.current });
      this.log(
        "info",
        next.renamedFrom
          ? `Renamed "${from}" to "${to}" — in Drive once it is reachable`
          : `Renamed "${from}" to "${to}"${driveName ? " (also in Drive)" : ""}`,
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
        const json = await this.localJson(name);
        return { status: "local-only" as const, autoSync: false, localOnly: true, empty: !json || isEmptyJson(json) };
      }
      if (this.isLive(name)) {
        // live: the latest changes are on the server once answered; agents read the live state
        if (name === this.meta.current) {
          await this.liveCurrent()?.flushNow();
        }
        return { status: this.statusOf(name), autoSync: true, live: true };
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
  followRemoteRename = (from: string, to: string, sha: string | null) =>
    this.exclusive(async () => {
      await this.ready;
      const meta = this.meta.scenes[from];
      if (!meta || this.meta.scenes[to] || meta.renamedFrom || meta.conflict || meta.localOnly) {
        return; // unknown here, or a local rename/conflict is pending: sync sorts it out
      }
      if (from !== this.meta.current) {
        const snapshot = await getSnapshot(from);
        if (snapshot) {
          await setSnapshot(to, snapshot);
          await deleteSnapshot(from);
        }
      }
      delete this.meta.scenes[from];
      this.meta.scenes[to] = meta; // same content, same blob sha
      if (from === this.meta.current) {
        this.meta.current = to;
        this.requireApi().updateScene({ appState: { name: to }, captureUpdate: CaptureUpdateAction.NEVER });
      }
      await moveAgentBaseline(from, to);
      this.updateRemoteSha(from, null);
      this.updateRemoteSha(to, sha);
      this.persistMeta();
      this.setState({ current: this.meta.current });
      this.log("info", `"${from}" was renamed to "${to}" in Drive`);
      this.refresh();
    });

  /** delete a scene here and in Drive (only the version you know of there) */
  remove = (name: string) =>
    this.withBusy("saving", async () => {
      await this.refreshListing();
      this.requireScene(name);
      const meta = this.meta.scenes[name];
      const driveName = meta?.renamedFrom ?? name;
      // local-only scenes are deleted here only (a copy in Drive stays)
      const driveSha = meta?.localOnly ? null : this.remoteShaOf(name) ?? meta?.conflict?.remoteSha ?? null;
      let queued = false;
      const liveFile = this.liveFileId(name);
      if (liveFile) {
        await this.liveTrash(liveFile, driveName);
        this.updateRemoteSha(driveName, null);
      } else if (driveSha) {
        try {
          await scenesApi.remove(driveName, driveSha);
          this.updateRemoteSha(driveName, null);
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError.status === 409) {
            throw new Error(`"${name}" was just changed in Drive — not deleted. Have a look at the new version first.`);
          } else if (apiError.offline) {
            this.meta.pendingDeletes[driveName] = driveSha;
            queued = true;
          } else if (apiError.status !== 404) {
            throw apiError;
          }
        }
      }
      if (name === this.meta.current) {
        liveSync.detachCanvas();
        // leave it for the untitled draft (without stashing the deleted scene)
        this.setState({ busy: "loading" });
        await this.openInner(null, { stash: false });
        this.setState({ busy: "saving" });
      }
      delete this.meta.scenes[name];
      await deleteSnapshot(name);
      await deleteAgentBaseline(name);
      this.persistMeta();
      this.refresh();
      this.log(
        "info",
        queued
          ? `Deleted "${name}" — in Drive once it is reachable`
          : `Deleted "${name}"${driveSha ? " (also in Drive)" : ""}`,
      );
    });

  /** copy a scene (incl. changes not pushed yet) under a new name */
  clone = (name: string, to: string, { open = true } = {}) =>
    this.withBusy("saving", async () => {
      to = to.trim();
      await this.refreshListing();
      this.requireScene(name);
      this.requireFreeName(to);
      let json = await this.localJson(name);
      if (json === null) {
        json = (await scenesApi.load(this.meta.scenes[name]?.renamedFrom ?? name)).json;
      }
      const data = JSON.parse(json);
      json = JSON.stringify({ ...data, appState: { ...(data.appState || {}), name: to } });
      await setSnapshot(to, { json, baseline: null, dirty: true });
      const { autoSync, localOnly } = this.meta.scenes[name] ?? {};
      this.meta.scenes[to] = localOnly
        ? { baseSha: null, dirty: true, localOnly: true }
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
      this.syncNow(); // auto-sync pushes the copy
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
      this.meta.scenes[name] = { ...(this.meta.scenes[name] ?? {}), baseSha: null, dirty: true, localOnly: true };
      if (name === this.meta.current) {
        await this.writeLocal(name, json, { dirty: true });
      } else {
        await setSnapshot(name, { json, baseline: null, dirty: true });
      }
      this.persistMeta();
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
      meta.baseSha = meta.conflict.remoteSha;
      delete meta.conflict;
      meta.dirty = true;
      this.persistMeta();
      this.log("info", `"${name}": keeping your version`);
      await this.pushScene(name, { manual: true });
    });

  /** discard the local version, take Drive's */
  takeTheirs = (name: string) =>
    this.withBusy("loading", async () => {
      const latest = await scenesApi.load(name);
      const meta = this.sceneMeta(name);
      delete meta.conflict;
      await this.writeLocal(name, latest.json, { dirty: false });
      meta.baseSha = latest.sha;
      meta.remoteSha = latest.sha;
      this.persistMeta();
      this.log("pull", `"${name}": took the version from Drive`);
      this.refresh();
    });

  /** throw away local changes of a scene, load the latest version from Drive */
  discardLocal = (name: string) => this.takeTheirs(name);

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
    const theirs = JSON.parse((await scenesApi.load(name, meta.conflict.remoteSha)).json);
    let base: any = null;
    if (meta.baseSha) {
      try {
        base = JSON.parse((await scenesApi.load(name, meta.baseSha)).json);
      } catch {
        base = null;
      }
    }
    return { meta, mine: JSON.parse(mineJson), theirs, base };
  }

  /** what clashes: per element the base, my and Drive's version */
  // ---------------------------------------------------------------------------
  // history: the scene's versions in git, and putting an older one back
  // ---------------------------------------------------------------------------

  history = (name: string) => scenesApi.history(name);

  loadVersion = async (name: string, version: SceneVersion) => (await scenesApi.loadVersion(name, version)).json;

  /**
   * An older version of the open scene back on the canvas, as a normal edit:
   * undoable with ⌘Z, and synced (or saved) like any other change. Elements
   * added since are deleted, the others get the old version's content.
   */
  restoreVersion = (json: string) => {
    const api = this.requireApi();
    const data = JSON.parse(json);
    registerSceneFonts(data);
    const old = restoreElements(data.elements, null, { repairBindings: true });
    const current = api.getSceneElementsIncludingDeleted();
    const byId = new Map(current.map((el) => [el.id, el]));
    const oldIds = new Set(old.map((el) => el.id));
    const now = Date.now();
    const bump = <T extends ExcalidrawElement>(el: T, base: ExcalidrawElement | undefined): T => ({
      ...el,
      version: Math.max(el.version, base?.version ?? 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
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
      appState: { viewBackgroundColor: restoreAppState(data.appState, null).viewBackgroundColor },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  conflictInfo = async (name: string) => {
    const { meta, mine, theirs, base } = await this.conflictVersions(name);
    const merged = mergeElements(base?.elements, mine.elements || [], theirs.elements || []);
    const [b, m, t] = [live(base?.elements), live(mine.elements), live(theirs.elements)];
    return {
      scene: name,
      driveSha: meta.conflict!.remoteSha,
      baseKnown: !!base,
      autoMerged: { fromMine: merged.fromMine, fromDrive: merged.fromTheirs },
      clashes: merged.clashes.map((id) => {
        const [be, me, te] = [b.get(id), m.get(id), t.get(id)];
        return {
          id,
          base: be ?? null,
          mine: me ?? null,
          theirs: te ?? null,
          mineChanged: me ? (be ? changedFields(be, me) : ["added"]) : ["deleted"],
          theirsChanged: te ? (be ? changedFields(be, te) : ["added"]) : ["deleted"],
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
    const copyName = `${name} (conflict ${timestamp()})`;
    await this.withBusy("saving", async () => {
      const json = await this.localJson(name);
      if (json === null) {
        return;
      }
      await setSnapshot(copyName, { json, baseline: null, dirty: true });
      this.meta.scenes[copyName] = { baseSha: null, dirty: true };
      this.persistMeta();
      this.log("info", `Your version of "${name}" was kept as "${copyName}"`);
    });
    await this.takeTheirs(name);
    this.syncNow();
    return copyName;
  };
}

export const scenesController = new ScenesController();

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // handy for debugging and end-to-end tests (dev, and builds for the fake Google)
  (window as any).__scenes = scenesController;
}
