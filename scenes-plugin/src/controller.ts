// Scenes: switching, saving and syncing with GitHub. Talks to the editor only
// through the public ExcalidrawImperativeAPI.
//
// Offline-first: the browser (localStorage + IndexedDB) is the source of
// truth. GitHub is a sync target — when it (or the scenes server) is not
// reachable, everything keeps working locally and syncs later.
//
// Per scene we track the GitHub version (git blob sha) the local copy is based
// on. Compared with the latest sha on GitHub and the local dirty flag this
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
import { scenesApi, SCENE_NAME_RE } from "./api";
import { changedFields, live, mergeElements, MERGE_VERSION, newestWins } from "./merge";
import type { ClashChoice } from "./merge";
import {
  META_KEY,
  UNTITLED,
  deleteAgentBaseline,
  deleteSnapshot,
  getSnapshot,
  loadMeta,
  moveAgentBaseline,
  saveMeta,
  setSnapshot,
} from "./storage";

import type { ApiError, RemoteScene, SceneVersion } from "./api";
import type { SceneMeta, ScenesMeta } from "./storage";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

export type SyncStatus =
  /** same as on GitHub */
  | "synced"
  /** local changes not pushed yet */
  | "ahead"
  /** GitHub has a newer version, no local changes */
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
  | "untitled";

export type SceneListItem = {
  /** null = untitled draft */
  name: string | null;
  status: SyncStatus;
  dirty: boolean;
  onGitHub: boolean;
  autoSync: boolean;
  /** kept only in this browser, never synced to GitHub */
  localOnly: boolean;
  updatedAt?: string | null;
  /** renamed here, not yet on GitHub: the name it still has there */
  pendingRename?: string;
  /** online: in the space's public repository (everyone can read it) */
  public?: boolean;
};

export type Activity = {
  at: number;
  kind: "push" | "pull" | "merge" | "conflict" | "error" | "info";
  text: string;
};

export type SyncInfo = {
  /** scenes server reachable (null = not tried yet) */
  serverReachable: boolean | null;
  /** GitHub reachable at the server's last attempt */
  githubOnline: boolean | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  running: boolean;
  /** online (Kurviq): GitHub not connected or no repo chosen — everything stays in this browser */
  notConnected: boolean;
  /** online: GitHub lets this user read the space, not change it (why) — nothing is pushed */
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
  /** the open scene is a local copy being checked against GitHub (read-only) */
  checking: boolean;
};

/** push the active scene after this long without changes */
export const IDLE_PUSH_MS = 10_000;
/** check GitHub for changes this often */
export const POLL_MS = 60_000;
/** a just-opened local copy is read-only at most this long while GitHub is asked */
const CHECK_LOCK_MS = 3_000;

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
      githubOnline: null,
      lastCheckedAt: null,
      lastError: null,
      running: false,
      notConnected: false,
      readOnly: null,
    },
    activity: [],
    conflict: null,
    checking: false,
  };

  constructor() {
    this.state.list = this.buildList();
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
        : this.adoptInitialCanvas().finally(() => this.readyDeferred.resolve());
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

  /** latest known sha on GitHub: string, null (not there) or undefined (unknown) */
  private remoteShaOf(name: string): string | null | undefined {
    // renamed here but not on GitHub yet: it still has the old name there
    const githubName = this.meta.scenes[name]?.renamedFrom ?? name;
    if (this.state.remote) {
      return this.state.remote.find((scene) => scene.name === githubName)?.sha ?? null;
    }
    return this.meta.scenes[name]?.remoteSha;
  }

  /**
   * GitHub names that are deleted / renamed here, but not on GitHub yet —
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
    const dirty = this.isDirty(name);
    const base = meta?.baseSha ?? null;
    const remote = this.remoteShaOf(name);
    if (remote === undefined) {
      // GitHub state unknown (offline since start)
      return base ? (dirty ? "ahead" : "synced") : "local";
    }
    if (!remote) {
      return base && dirty ? "ahead" : "local";
    }
    if (!base) {
      // on GitHub, never synced locally
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
        const githubName = meta?.renamedFrom ?? name;
        const remote = this.state.remote?.find((scene) => scene.name === githubName);
        return {
          name,
          status: this.statusOf(name),
          dirty: this.isDirty(name),
          onGitHub: remote ? true : !!meta?.remoteSha,
          autoSync: this.autoSyncFor(name),
          localOnly: !!meta?.localOnly,
          updatedAt: remote?.updatedAt,
          ...(meta?.renamedFrom ? { pendingRename: meta.renamedFrom } : {}),
          ...(remote?.public ? { public: true } : {}),
        };
      });
    if (this.state.current === null || this.meta.scenes[UNTITLED]) {
      list.unshift({
        name: null,
        status: "untitled",
        dirty: this.state.current === null ? this.state.dirty : true,
        onGitHub: false,
        autoSync: false,
        localOnly: false,
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

  /** scenes deleted here whose deletion on GitHub is still pending */
  pendingDeletes() {
    return Object.keys(this.meta.pendingDeletes);
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------

  /** new scenes start local only (default) until published */
  newScenesLocalOnly() {
    return this.meta.newLocalOnly ?? true;
  }

  setNewScenesLocalOnly = (on: boolean) => {
    this.meta.newLocalOnly = on;
    this.persistMeta();
    this.refresh();
  };

  /** same element changed here and on GitHub: newest edit wins, or ask */
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
   * Online: another repo (or account) was connected. What this browser knew
   * about GitHub belonged to the old repo: every scene with content counts as
   * changed here, so it is pushed to (or merged with) the new repo — nothing
   * local is lost or overwritten.
   */
  resetGitHubState = async () => {
    await this.ready;
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (name === UNTITLED) {
        continue;
      }
      meta.baseSha = null;
      delete meta.remoteSha;
      delete meta.conflict;
      delete meta.renamedFrom;
      if (name !== this.meta.current) {
        const json = await this.localJson(name);
        meta.dirty = !!json && !isEmptyJson(json);
      }
    }
    this.meta.pendingDeletes = {};
    this.meta.baseline = null;
    this.persistMeta();
    this.setState({ remote: null, conflict: null });
    this.recomputeDirty();
    this.refresh();
    this.log("info", "Connected another GitHub repo — your scenes sync with it now");
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
   * again. A copy already on GitHub stays there unchanged meanwhile; when
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
        throw new Error(`The rename of "${name}" is not on GitHub yet — try again once it is`);
      }
      if (on) {
        meta.localOnly = true;
      } else {
        delete meta.localOnly;
      }
      this.persistMeta();
      this.refresh();
      this.log(
        "info",
        on
          ? `"${name}" is local only now — not synced to GitHub${this.remoteShaOf(name) ? " (the copy there stays as it is)" : ""}`
          : `"${name}" is synced with GitHub again`,
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
  open = (name: string | null) => {
    const run = this.openChain.then(async () => {
      await this.ready;
      this.setState({ busy: "loading", error: null });
      try {
        return await this.openInner(name);
      } catch (error: any) {
        console.error(error);
        this.setState({ error: error.message });
        throw error;
      } finally {
        this.setState({ busy: null });
      }
    });
    this.openChain = run.catch(() => {});
    return run;
  };

  private openChain: Promise<unknown> = Promise.resolve();

  /** editing is locked while a just-opened local copy is checked against GitHub */
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
   * The local copy is on screen (read-only); ask GitHub for a newer version.
   * Editing unlocks when GitHub answers, or after CHECK_LOCK_MS at the latest
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
        if (this.openToken !== token || this.meta.current !== name || this.isDirty(name)) {
          return; // switched on, or edited after the unlock: sync takes it from here
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
        this.log("pull", `Updated "${name}" from GitHub`);
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

      const snapshot = await getSnapshot(name);
      let json: string | null = null;
      let baseline: number | null = null;
      let loadedSha: string | null = null;
      let checkGitHub = false;
      const meta = name === null ? undefined : this.meta.scenes[name];

      if (name === null || (snapshot && (snapshot.dirty || meta?.conflict))) {
        // local changes win — sync takes care of GitHub
        json = snapshot?.json ?? null;
        baseline = snapshot?.baseline ?? null;
      } else if (this.state.sync.githubOnline === false || this.state.sync.serverReachable === false) {
        if (!snapshot) {
          throw Object.assign(
            new Error(`"${name}" was never downloaded to this browser and GitHub is not reachable`),
            { status: 503 },
          );
        }
        json = snapshot.json;
      } else if (snapshot) {
        // show the local copy (no local changes) right away, check GitHub in
        // the background; it is its own base
        json = snapshot.json;
        checkGitHub = true;
      } else {
        // never opened here: GitHub's version is all there is
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
        api.setViewport({ target: elements, fit: "scale-down", offsets: { top: vertical, bottom: vertical, left: horizontal, right: horizontal } });
      }
      if (checkGitHub && name !== null) {
        this.checkOpenedScene(name);
      }
  }

  /**
   * Online: make a scene public (it moves to the space's public repository)
   * or private again. Unpushed changes go to GitHub first.
   */
  setPublic = (name: string, on: boolean) =>
    this.withBusy("saving", async () => {
      if (!scenesApi.setPublic) {
        throw new Error("Public scenes need Kurviq online");
      }
      if (this.isLocalOnly(name)) {
        throw new Error(`"${name}" is kept in this browser only: sync it with GitHub first`);
      }
      if (this.isDirty(name) || this.statusOf(name) !== "synced") {
        await this.pushScene(name, { manual: true });
      }
      await scenesApi.setPublic(name, on);
      await this.refreshListing();
      this.log("push", on ? `"${name}" is public now` : `"${name}" is private again`);
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
  create = (name: string, { localOnly = this.newScenesLocalOnly() }: { localOnly?: boolean } = {}) =>
    this.withBusy("loading", async () => {
      this.validateName(name);
      if (this.exists(name)) {
        throw new Error(`A scene named "${name}" already exists`);
      }
      await this.stashCurrent();
      await deleteSnapshot(name);
      this.applyScene(null, name);
      this.meta.current = name;
      this.meta.baseline = null;
      this.meta.scenes[name] = localOnly ? { baseSha: null, dirty: false, localOnly } : this.claimName(name, false);
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
    // online without GitHub: there is nowhere else to look, a new scene right away
    if (!this.exists(name) && this.state.sync.notConnected) {
      await this.create(name);
      return;
    }
    try {
      await this.open(name);
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
   * and the deletion is not on GitHub yet, the new scene simply replaces it
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
    if (!SCENE_NAME_RE.test(name) || name.includes("..")) {
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
          ? { baseSha: null, dirty: true, localOnly: true }
          : this.claimName(targetName, true);
        api.updateScene({ appState: { name: targetName }, captureUpdate: CaptureUpdateAction.NEVER });
        await setSnapshot(targetName, { json, baseline: null, dirty: true });
        this.persistMeta();
        this.setState({ current: targetName, dirty: true });
      }
      if (this.isLocalOnly(targetName)) {
        return { name: targetName, localOnly: true }; // the browser keeps it, nothing to push
      }
      const result = await this.pushScene(targetName, { manual: true });
      if (this.meta.scenes[targetName]?.conflict) {
        throw new Error(
          `"${targetName}" has conflicting changes on GitHub — resolve them in the Scenes sidebar`,
        );
      }
      return { name: targetName, ...(result || {}) };
    });

  // ---------------------------------------------------------------------------
  // sync engine
  // ---------------------------------------------------------------------------

  private syncing = false;
  private syncAgain = false;

  /** check GitHub and (with auto-sync) push / pull / merge what's needed */
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
            sync: { ...this.state.sync, serverReachable: true, githubOnline: false, notConnected: true, lastError: null },
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
      const wasOnline = this.state.sync.githubOnline;
      this.applyListing(listing.scenes);
      this.setState({
        sync: {
          ...this.state.sync,
          serverReachable: true,
          notConnected: false,
          readOnly: listing.remote.readOnly ?? null,
          githubOnline: listing.remote.online,
          lastCheckedAt: listing.remote.lastFetchAt,
          lastError: listing.remote.lastError,
        },
      });
      if (listing.remote.online === false) {
        if (wasOnline !== false) {
          this.log("error", `GitHub not reachable — working locally (${listing.remote.lastError})`);
        }
        return;
      }
      if (wasOnline === false) {
        this.log("info", "GitHub reachable again");
      }

      if (this.state.sync.readOnly) {
        // GitHub lets this user read the space, not change it: only pull
        for (const item of this.state.list) {
          if (item.name !== null && this.statusOf(item.name) === "behind" && !this.isDirty(item.name)) {
            await this.exclusive(() => this.pullScene(item.name!));
          }
        }
        return;
      }

      // renames / deletions made here (e.g. while offline) go first — they
      // are explicit user actions, independent of auto-sync
      await this.exclusive(() => this.pushPendingOps());
      await this.exclusive(() => this.adoptEmptyLocalOnly());
      await this.exclusive(async () => this.dropScenesDeletedOnGitHub());

      for (const item of this.state.list) {
        const name = item.name;
        if (name === null || !this.autoSyncFor(name)) {
          continue;
        }
        const status = this.statusOf(name);
        if (status === "behind") {
          await this.exclusive(() => this.pullScene(name));
        } else if (status === "ahead" || (status === "local" && this.isDirty(name))) {
          if (name === this.meta.current && !this.pushDue()) {
            continue;
          }
          const json = await this.localJson(name);
          if (status === "local" && json && isEmptyJson(json)) {
            continue; // don't publish empty new scenes automatically
          }
          await this.exclusive(() => this.pushScene(name));
        } else if (status === "diverged") {
          await this.exclusive(() => this.mergeScene(name));
        } else if (status === "conflict" && this.conflictOutdated(name)) {
          // GitHub moved on, or found by an older merge: maybe it merges now
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
   * GitHub (an agent drew it): it takes the GitHub version and syncs.
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
      this.log("info", `"${name}" now exists on GitHub — loading it`);
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
    if (name !== null && this.state.dirty && this.autoSyncFor(name) && this.pushDue()) {
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
  }

  /** push local content; on "GitHub changed meanwhile" merge instead */
  private async pushScene(name: string, { manual = false } = {}) {
    if (this.isLocalOnly(name)) {
      return null; // never leaves this browser
    }
    if (this.state.sync.readOnly) {
      if (manual) {
        throw new Error(`Saved in this browser only. Read only: ${this.state.sync.readOnly}`);
      }
      return null;
    }
    if (this.meta.scenes[name]?.renamedFrom) {
      // the rename has to reach GitHub before the content can
      await this.pushPendingRename(name);
      if (this.meta.scenes[name]?.renamedFrom) {
        if (manual) {
          throw new Error(`Saved locally — the rename of "${name}" is not on GitHub yet, will retry`);
        }
        return null;
      }
    }
    const isCurrent = name === this.meta.current;
    if (isCurrent && this.requireApi().getAppState().name !== name) {
      // the canvas shows another scene's drawing: never push it under this name
      const message = `Not pushed: this tab's canvas belongs to "${this.requireApi().getAppState().name}", not "${name}". Reload the tab.`;
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
        this.log("info", `"${name}" changed on GitHub meanwhile — merging`);
        await this.mergeScene(name, { pushAfter: true });
        return null;
      }
      if (apiError.notConnected) {
        this.setState({ sync: { ...this.state.sync, githubOnline: false, notConnected: true } });
        if (manual) {
          throw new Error("Saved in this browser — connect GitHub to sync it");
        }
        return null;
      }
      if (apiError.readOnly) {
        // GitHub refused for good (permissions, archived, protected branch): stop pushing
        this.setState({ sync: { ...this.state.sync, readOnly: apiError.message.replace(/^Read only: /, "") } });
        this.log("error", apiError.message);
        if (manual) {
          throw new Error(`Saved in this browser only. ${apiError.message}`);
        }
        return null;
      }
      if (apiError.offline) {
        this.setState({
          sync: { ...this.state.sync, githubOnline: apiError.status === 0 ? this.state.sync.githubOnline : false, serverReachable: apiError.status === 0 ? false : true },
        });
        if (manual) {
          throw new Error(`Saved locally — GitHub not reachable, will sync when back online`);
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

  /** GitHub has a newer version and there are no local changes */
  private async pullScene(name: string) {
    if (this.statusOf(name) !== "behind") {
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
    this.log("pull", wasKnown ? `Updated "${name}" from GitHub` : `Downloaded "${name}" from GitHub`);
    this.refresh();
  }

  /**
   * Auto-sync never pushes an empty scene over one that has content on
   * GitHub: an editor that lost its canvas (a crash, a broken load) looks
   * exactly like that. If nothing was deleted here in this session, GitHub's
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
      this.log("error", `Not pushed: "${name}" is empty here but not on GitHub. Save it in the sidebar if you really want to empty it.`);
      return true;
    }
    const meta = this.sceneMeta(name);
    await this.writeLocal(name, latest.json, { dirty: false });
    meta.baseSha = latest.sha;
    meta.remoteSha = latest.sha;
    delete meta.conflict;
    this.persistMeta();
    this.log("pull", `"${name}" was empty here (not by an edit): loaded it from GitHub instead of pushing the empty version`);
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
    const mineJson = await this.localJson(name);
    let theirs;
    try {
      theirs = await scenesApi.load(name);
    } catch (error) {
      if ((error as ApiError).status === 404 && mineJson) {
        // deleted on GitHub meanwhile: ours becomes a new scene again
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
    // the merge is based on mineJson: if the scene changed while GitHub was
    // asked (edited, or switched to/away), drop this round — the next sync merges
    const unchanged = async () =>
      name === this.meta.current
        ? this.serializeCurrent().json === mineJson
        : (await getSnapshot(name))?.json === mineJson;
    // a local copy without any elements never deletes GitHub's content by a
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
      this.log("pull", `"${name}" was empty here: took GitHub's version`);
      this.refresh();
      return null;
    }
    let merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], choices);
    let settled: string[] = [];
    if (merged.clashes.length && this.clashMode() === "newest") {
      // like live collaboration: per element the newer edit wins
      const auto = newestWins(mine.elements || [], theirsData.elements || [], merged.clashes);
      settled = merged.clashes.map((id) => `${id}: ${auto[id] === "mine" ? "yours" : "GitHub's"}`);
      merged = mergeElements(base?.elements, mine.elements || [], theirsData.elements || [], { ...auto, ...choices });
    }
    meta.remoteSha = theirs.sha;
    this.updateRemoteSha(name, theirs.sha);

    if (merged.clashes.length) {
      meta.conflict = { remoteSha: theirs.sha, clashes: merged.clashes, v: MERGE_VERSION };
      this.persistMeta();
      this.log(
        "conflict",
        `Conflict in "${name}": you and GitHub changed the same ${merged.clashes.length} element(s) — choose how to resolve`,
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
      // base is now GitHub's version: dirty = merged differs from it
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
      merged.fromTheirs ? `${merged.fromTheirs} change(s) from GitHub` : null,
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
        this.log("push", `Deleted "${name}" on GitHub`);
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.offline) {
          return;
        }
        if (apiError.status === 409) {
          this.log("info", `"${name}" was changed on GitHub after you deleted it — kept on GitHub`);
        } else if (apiError.status !== 404) {
          this.log("error", `Could not delete "${name}" on GitHub: ${apiError.message}`);
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

  /** returns false when GitHub is not reachable */
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
      this.log("push", `Renamed "${from}" to "${name}" on GitHub`);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.offline) {
        return false;
      }
      if (apiError.status === 404) {
        // gone from GitHub meanwhile: ours is a new scene now
        meta.baseSha = null;
        meta.remoteSha = null;
        meta.dirty = true;
      } else {
        this.log(
          "error",
          apiError.exists
            ? `Can't rename "${from}" to "${name}" on GitHub: "${name}" exists there — rename this scene again`
            : `Rename of "${from}" on GitHub failed: ${apiError.message}`,
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
   * Scenes that were on GitHub and are gone now (deleted or renamed elsewhere,
   * e.g. on another laptop). Unchanged local copies are removed too; with
   * local changes they are kept and pushed again (edits are never lost).
   */
  private async dropScenesDeletedOnGitHub() {
    const remote = new Set((this.state.remote ?? []).map((scene) => scene.name));
    for (const [name, meta] of Object.entries(this.meta.scenes)) {
      if (meta.localOnly && meta.baseSha && !remote.has(meta.renamedFrom ?? name)) {
        // its old copy on GitHub is gone: the local scene is all there is
        meta.baseSha = null;
        meta.dirty = true;
        this.persistMeta();
        continue;
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
        this.log("info", `"${name}" was deleted on GitHub — you changed it here, so it is kept`);
        meta.baseSha = null;
      } else if (name === this.meta.current) {
        this.log("info", `"${name}" was deleted on GitHub — still open here as a local scene`);
        meta.baseSha = null;
        this.meta.baseline = null;
      } else {
        await deleteSnapshot(name);
        await deleteAgentBaseline(name);
        delete this.meta.scenes[name];
        this.log("pull", `"${name}" was deleted on GitHub — removed here too`);
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
  // rename / delete / duplicate — applied here right away, on GitHub right
  // away too when it is reachable, otherwise queued until it is
  // ---------------------------------------------------------------------------

  /** latest GitHub listing before renaming / deleting / duplicating (best effort) */
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
      // local-only scenes are renamed here only (a copy on GitHub keeps its name)
      const githubName = meta?.localOnly ? null : meta?.renamedFrom ?? (this.remoteShaOf(from) ? from : null);
      const next: SceneMeta = { ...(meta ?? { baseSha: null, dirty: false }) };
      if (meta?.localOnly && meta.baseSha) {
        next.baseSha = null; // no longer related to the GitHub copy
        next.dirty = true;
      }
      delete next.renamedFrom;

      if (githubName) {
        try {
          const result = await scenesApi.rename(githubName, to);
          next.remoteSha = result.sha;
          this.updateRemoteSha(githubName, null);
          this.updateRemoteSha(to, result.sha);
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError.status === 404) {
            next.baseSha = null; // not on GitHub (anymore): just a local scene
          } else if (!apiError.offline) {
            throw apiError;
          } else if (!(await this.hasLocalContent(from))) {
            throw new Error(`"${from}" was never downloaded to this browser and GitHub is not reachable — try again online`);
          } else {
            next.renamedFrom = githubName; // GitHub follows when reachable
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
          ? `Renamed "${from}" to "${to}" — on GitHub once it is reachable`
          : `Renamed "${from}" to "${to}"${githubName ? " (also on GitHub)" : ""}`,
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
      this.log("info", `"${from}" was renamed to "${to}" on GitHub`);
      this.refresh();
    });

  /** delete a scene here and on GitHub (only the version you know of there) */
  remove = (name: string) =>
    this.withBusy("saving", async () => {
      await this.refreshListing();
      this.requireScene(name);
      const meta = this.meta.scenes[name];
      const githubName = meta?.renamedFrom ?? name;
      // local-only scenes are deleted here only (a copy on GitHub stays)
      const githubSha = meta?.localOnly ? null : this.remoteShaOf(name) ?? meta?.conflict?.remoteSha ?? null;
      let queued = false;
      if (githubSha) {
        try {
          await scenesApi.remove(githubName, githubSha);
          this.updateRemoteSha(githubName, null);
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError.status === 409) {
            throw new Error(`"${name}" was just changed on GitHub — not deleted. Have a look at the new version first.`);
          } else if (apiError.offline) {
            this.meta.pendingDeletes[githubName] = githubSha;
            queued = true;
          } else if (apiError.status !== 404) {
            throw apiError;
          }
        }
      }
      if (name === this.meta.current) {
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
          ? `Deleted "${name}" — on GitHub once it is reachable`
          : `Deleted "${name}"${githubSha ? " (also on GitHub)" : ""}`,
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
              : `A scene named "${name}" already exists (synced with GitHub)`,
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

  /** overwrite GitHub with the local version */
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

  /** discard the local version, take GitHub's */
  takeTheirs = (name: string) =>
    this.withBusy("loading", async () => {
      const latest = await scenesApi.load(name);
      const meta = this.sceneMeta(name);
      delete meta.conflict;
      await this.writeLocal(name, latest.json, { dirty: false });
      meta.baseSha = latest.sha;
      meta.remoteSha = latest.sha;
      this.persistMeta();
      this.log("pull", `"${name}": took the version from GitHub`);
      this.refresh();
    });

  /** throw away local changes of a scene, load the latest version from GitHub */
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

  /** what clashes: per element the base, my and GitHub's version */
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
      githubSha: meta.conflict!.remoteSha,
      baseKnown: !!base,
      autoMerged: { fromMine: merged.fromMine, fromGitHub: merged.fromTheirs },
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
   * GitHub's version for each clashing element (choices, else `otherwise`),
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
        // GitHub changed again meanwhile and the new version clashes, too
        return { resolved: false, clashes: left.clashes };
      }
      this.log("info", `"${name}": conflict resolved element by element`);
      return { resolved: true, status: this.statusOf(name) };
    });

  /** keep the local version as a copy, take GitHub's for this scene */
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

if (import.meta.env.DEV) {
  // handy for debugging and end-to-end tests
  (window as any).__scenes = scenesController;
}
