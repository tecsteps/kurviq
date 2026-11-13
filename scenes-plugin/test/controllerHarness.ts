// The real scenes controller (src/controller.ts) in node: an in-memory editor,
// browser storage and Drive home, so its sync, open and rename logic can be
// tested without a browser.
import { createHash } from "node:crypto";

import { mergePresentation, presentationOf, restorePresentation } from "../../scenes-mcp/presentation.mjs";
import * as sceneComments from "../../scenes-mcp/sceneComments.mjs";
import * as sceneName from "../../scenes-mcp/sceneName.mjs";
import * as elementContent from "../../scenes-mcp/elementContent.mjs";
import { randomNonce } from "../src/editDiff";
import { browserHomeOf } from "../src/homes/browser";
import { databaseHomeOf } from "../src/homes/database/home";
import { writeSceneChanges } from "../src/homes/database/write";

import { fakeSceneRows } from "./fakeSceneRows";
import { OpQueue } from "../src/opQueue";
import { freeName, UNTITLED } from "../src/spaces";

import { runModule } from "./runModule";

export { UNTITLED };

const md5 = (text: string) => createHash("md5").update(text).digest("hex"); // NOSONAR S4790: emulates Drive's own md5Checksum of the content, nothing secret

/** a deterministic string hash (the editor's hashString stand-in) */
const hashString = (text: string) => {
  let hash = 0;
  for (const char of text) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  }
  return hash;
};

export const el = (id: string, props: Record<string, any> = {}) => ({
  id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, index: `a${id}`, ...props,
});

export const sceneJson = (name: string, elements: any[], appState: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "excalidraw", elements, appState: { name, viewBackgroundColor: "#ffffff", kurviqPresentation: false, kurviqPresentationAt: 0, ...appState }, files: {} });

/** a promise the test settles itself */
export const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const flush = async (times = 20) => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0)); // NOSONAR S9382: one turn after the other on purpose
  }
};

const homeError = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

/** Google Drive in memory: every version kept (a base for merges), ids and the public flag listed */
export class FakeDrive {
  readonly files = new Map<string, { id: string; json: string; version: string; public?: boolean }>();
  readonly versions = new Map<string, string>();
  /** the next call of this kind waits for the test (or fails) */
  readonly hold: Partial<Record<"load" | "save" | "remove" | "rename" | "list", Promise<unknown>>> = {};
  readonly fail: Partial<Record<"load" | "save" | "remove" | "rename" | "list", unknown>> = {};
  readonly calls: string[] = [];
  private nextId = 1;

  put(name: string, json: string, extra: { public?: boolean } = {}) {
    const version = md5(json);
    this.versions.set(version, json);
    const id = this.files.get(name)?.id ?? `file-${this.nextId++}`;
    this.files.set(name, { id, json, version, ...extra });
    return version;
  }

  private async gate(kind: keyof FakeDrive["hold"]) {
    this.calls.push(kind);
    const held = this.hold[kind];
    delete this.hold[kind];
    await held;
    const failure = this.fail[kind];
    if (failure) {
      delete this.fail[kind];
      throw failure;
    }
  }

  readonly home = {
    kind: "drive" as const,
    label: "Google Drive",
    capabilities: { sync: "merge", history: true, filesInline: true, commentsInline: true, presence: "pen", sharing: "drive", publicLinks: true, guests: false, moveMarker: true, needsSignIn: true },
    list: async () => {
      await this.gate("list");
      return {
        scenes: [...this.files].map(([name, file]) => ({ name, version: file.version, updatedAt: null, id: file.id, ...(file.public ? { public: true } : {}) })),
        status: { online: true, lastFetchAt: null, lastError: null, readOnly: null },
      };
    },
    load: async (name: string, version?: string) => {
      await this.gate("load");
      const file = this.files.get(name);
      if (!file) {
        throw homeError(404, `Scene not found: ${name}`);
      }
      const json = version ? this.versions.get(version) : file.json;
      if (json === undefined) {
        throw homeError(404, "no such version");
      }
      return { json, version: version ?? file.version };
    },
    save: async (name: string, json: string, base?: string) => {
      await this.gate("save");
      const file = this.files.get(name);
      if ((base === "none" && file) || (base && base !== "none" && file?.version !== base)) {
        throw homeError(409, "changed meanwhile", { remoteVersion: file?.version ?? null });
      }
      if (file?.json === json) {
        return { version: file.version, changed: false };
      }
      return { version: this.put(name, json), changed: true };
    },
    remove: async (name: string, base?: string | null) => {
      await this.gate("remove");
      const file = this.files.get(name);
      if (!file) {
        throw homeError(404, "not found");
      }
      if (base && file.version !== base) {
        throw homeError(409, "changed meanwhile", { remoteVersion: file.version });
      }
      this.files.delete(name);
    },
    rename: async (from: string, to: string) => {
      await this.gate("rename");
      const file = this.files.get(from);
      if (!file) {
        throw homeError(404, "not found");
      }
      if (this.files.has(to)) {
        throw homeError(409, "exists", { exists: true });
      }
      this.files.delete(from);
      this.files.set(to, file);
      return { version: file.version };
    },
  };
}

export const offline = () => homeError(0, "Google Drive is not reachable", { offline: true });

/** the editor in memory: updateScene changes it and tells the listeners */
export class FakeEditor {
  elements: any[] = [];
  appState: Record<string, any> = { name: "", viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false, viewModeEnabled: false, isLoading: false, width: 1000, height: 800 };
  files: Record<string, any> = {};
  isDestroyed = false;
  private readonly listeners = new Set<(elements: any[], appState: any) => void>();

  getSceneElements = () => this.elements.filter((el) => !el.isDeleted);
  getSceneElementsIncludingDeleted = () => this.elements;
  getAppState = () => this.appState;
  getFiles = () => this.files;
  addFiles = (files: any[]) => files.forEach((file) => (this.files[file.id] = file));
  setViewport = () => {};
  onChange = (listener: (elements: any[], appState: any) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  updateScene = ({ elements, appState }: { elements?: any[]; appState?: Record<string, any> }) => {
    if (elements) {
      this.elements = elements;
    }
    if (appState) {
      this.appState = { ...this.appState, ...appState };
    }
    this.listeners.forEach((listener) => listener(this.elements, this.appState));
  };
  /** the user draws */
  draw(element: any) {
    this.updateScene({ elements: [...this.elements, element] });
  }
}

/** the browser's storage for the controller: metadata and stored copies */
export class FakeStorage {
  saved: any = null;
  readonly snapshots = new Map<string, { json: string; baseline: number | null; dirty: boolean }>();
  readonly module = {
    META_KEY: "excalidraw-scenes",
    loadMeta: () => {
      const meta = this.saved ? structuredClone(this.saved) : { current: null, baseline: null, autoSync: true, scenes: {}, pendingDeletes: {} };
      meta.scenes = Object.assign(Object.create(null), meta.scenes);
      meta.pendingDeletes = Object.assign(Object.create(null), meta.pendingDeletes);
      return meta;
    },
    saveMeta: (meta: any) => {
      this.saved = structuredClone({ ...meta, scenes: { ...meta.scenes }, pendingDeletes: { ...meta.pendingDeletes } });
    },
    getSnapshot: (name: string | null) => Promise.resolve(this.snapshots.get(name ?? UNTITLED)),
    setSnapshot: (name: string | null, snapshot: any) => {
      this.snapshots.set(name ?? UNTITLED, snapshot);
      return Promise.resolve();
    },
    deleteSnapshot: (name: string | null) => {
      this.snapshots.delete(name ?? UNTITLED);
      return Promise.resolve();
    },
    deleteAgentBaseline: async () => {},
    moveAgentBaseline: async () => {},
  };
}

/** a window with listeners the test can fire */
class FakeWindow {
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, event: any = {}) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
  setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number;
  clearTimeout = (id: number) => clearTimeout(id);
  setInterval = () => 0;
}

const mergeModule = runModule(new URL("../src/merge.ts", import.meta.url), {
  "@excalidraw/element": { syncInvalidIndices: () => {} },
  "../../scenes-mcp/elementContent.mjs": elementContent,
});

export type Harness = Awaited<ReturnType<typeof controllerHarness>>;

/** a controller on a fresh editor, storage and Drive; `setup` fills them before it starts */
export const controllerHarness = async ({ online = false, setup }: { online?: boolean; setup?: (parts: { drive: FakeDrive; storage: FakeStorage; editor: FakeEditor }) => void } = {}) => {
  const drive = new FakeDrive();
  // one connected database (signed in), over the fake database of schema.sql's rules
  const database = fakeSceneRows();
  const databaseHome = databaseHomeOf(database.rows, { ref: "abcdefghijklmnopqrst", label: "Team space" });
  const connections = [{ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_publishable_x", name: "Team space", addedAt: "" }];
  const storage = new FakeStorage();
  const editor = new FakeEditor();
  const window = new FakeWindow();
  setup?.({ drive, storage, editor });
  const document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
  const loaded = runModule(new URL("../src/controller.ts", import.meta.url), {
    "./editorYield": { editorYield: () => Promise.resolve() },
    "../../scenes-mcp/presentation.mjs": { mergePresentation, restorePresentation },
    "./presentation": {
      presentationOf,
      serializeAsJSON: (elements: any[], appState: any, files: any) =>
        JSON.stringify({
          type: "excalidraw",
          elements,
          appState: { name: appState.name, viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize, gridStep: appState.gridStep, gridModeEnabled: appState.gridModeEnabled, ...(typeof appState.kurviqPresentation === "boolean" ? { kurviqPresentation: appState.kurviqPresentation, kurviqPresentationAt: appState.kurviqPresentationAt ?? 0 } : {}) },
          files,
        }),
    },
    "@excalidraw/excalidraw": {
      CaptureUpdateAction: { NEVER: "never", IMMEDIATELY: "immediately" },
      getNonDeletedElements: (elements: any[]) => elements.filter((item) => !item.isDeleted),
      restoreAppState: (appState: any) => ({ viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false, name: "", ...appState }),
      restoreElements: (elements: any[] | undefined) => structuredClone(elements ?? []),
    },
    "@excalidraw/element": {
      hashElementsVersion: (elements: any[]) => hashString(JSON.stringify(elements.map((item) => [item.id, item.version, item.isDeleted]))),
      hashString,
    },
    "./fonts": { mergeFontLists: (a: unknown, b: unknown) => a ?? b, registerSceneFonts: async () => {}, withFonts: (json: string) => json },
    "./comments/store": { commentStore: { setWriter: () => {}, load: () => {}, editorKey: () => "", editorList: () => [] } },
    "../../scenes-mcp/sceneComments.mjs": sceneComments,
    "./api": { IS_ONLINE: online },
    "./online/drive": { sharedFileId: null },
    "../../scenes-mcp/sceneName.mjs": sceneName,
    "./editDiff": { randomNonce },
    "./homes/browser": { browserHomeOf },
    "./homes/drive": { driveHome: drive.home },
    "./homes/database/connections": {
      databaseHome: () => databaseHome,
      databases: { list: () => connections, session: () => ({ status: "signed-in", email: "me@example.com" }), subscribe: () => () => {} },
    },
    "./homes/database/write": { writeSceneChanges },
    "./merge": mergeModule,
    "./opQueue": { OpQueue },
    "./spaces": { freeName, UNTITLED },
    "./storage": storage.module,
  }, { window, document, location: { origin: "https://kurviq.com" }, sessionStorage: { getItem: () => null, removeItem: () => {} } });

  const controller = new (loaded.scenesController.constructor as any)();
  controller.attach(editor);
  await controller.ready;
  return { controller, drive, storage, editor, window, exports: loaded, database, databaseHome };
};

/** a synced scene: in Drive and stored here with Drive's version as its base */
export const syncedScene = (parts: { drive: FakeDrive; storage: FakeStorage }, name: string, elements: any[]) => {
  const json = sceneJson(name, elements);
  const version = parts.drive.put(name, json);
  parts.storage.snapshots.set(name, { json, baseline: null, dirty: false });
  parts.storage.saved ??= { current: null, baseline: null, autoSync: true, scenes: {}, pendingDeletes: {} };
  parts.storage.saved.scenes[name] = { baseMd5: version, remoteMd5: version, dirty: false };
  return version;
};
