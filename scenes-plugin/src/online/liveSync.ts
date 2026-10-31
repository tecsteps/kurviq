// Live sync, the tab's side (docs/live-sync/PROTOCOL.md §7): every Drive
// scene saves through its own Durable Object (online/worker/scene.ts). The
// DO orders the changes of all tabs, re-stamps them, stores them, sends them
// to every open tab and writes grouped versions to Drive. This tab never
// writes such a scene to Drive itself: there is never a second writer.
//
// One LiveScene per open Drive scene (the canvas), plus headless ones for
// agent edits to scenes that aren't open and for queues a closed tab left.
// A LiveScene keeps two layers:
//   confirmed  the scene as the DO has it (its stamps: version, versionNonce)
//   pending    this tab's changes not answered yet (the draft of the next
//              batch, and the batches sent / queued)
// Local changes are found by diffing the canvas by version / versionNonce;
// they are queued in IndexedDB (liveQueue.ts) first, then sent in batches
// (every BATCH_MS, at once when a gesture ends). Everything one action
// changed travels in one batch. Changes from the DO are applied without an
// undo step and never sent back; an element the user is dragging or typing
// in keeps its draft and the base its gesture started from.
//
// Collisions (the DO refuses a change made on an older state):
//   live     the user's own properties go on top of the newer state and
//            are sent again; on the same property the later change wins and
//            the other author may restore theirs
//   offline  nothing of it is applied: the whole local scene is kept as a
//            new scene "<name> (offline changes)", and only changes whose
//            whole touching group is free of collisions are sent again

import { CaptureUpdateAction, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import { HistoryDelta } from "@excalidraw/excalidraw/history";
import { hashString } from "@excalidraw/element";
import { createStore, get, set } from "idb-keyval";


import { addFont, customFonts, isCustomFontId, withFonts } from "../fonts";

import { authPost, connection, driveScenes, liveSocketUrl, signOutListeners } from "./drive";
import { createReceiver, sendMessage } from "./frames";
import { decodeEvent, encodeEvent, importSceneKey } from "./liveCrypto";
import {
  ValueAuthors,
  byIndex,
  changedKeys,
  contentEqual,
  reapplyChain,
  components,
  groupIndex,
  inReceipt,
  rebase,
  sameState,
  stampOf,
  touchedBy,
  withoutDanglingRefs,
} from "./liveMerge";
import {
  ACK_TIMEOUT_MS,
  BATCH_MS,
  DECIDE_AFTER_MS,
  LIVE_PROTOCOL,
  NAME_ID,
  PROOF_RENEW_MS,
  REPLAY_HORIZON_MS,
  SETTINGS_ID,
  eventKey,
  fontHash,
} from "./liveProtocol";
import {
  batchesOf,
  claimTab,
  newTabId,
  commandRecord,
  deleteBatch,
  forgetFile,
  holdTab,
  moveAccount,
  nextCounter,
  orphanQueues,
  putBatch,
  recordCommand,
} from "./liveQueue";

import type { CustomFont } from "../fonts";
import type { HeldTab, QueuedBatch, QueuedChange } from "./liveQueue";
import type { SceneKey } from "./liveCrypto";
import type {
  Base,
  BlockedAuthor,
  EventKind,
  Lifecycle,
  Presence,
  Receipt,
  RefuseReason,
  Role,
  ServerMessage,
  StampedBatch,
  TicketAnswer,
  WireEvent,
  WireScene,
} from "./liveProtocol";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type El = { id: string; version: number; versionNonce: number; isDeleted?: boolean; [key: string]: any };

export type Settings = { viewBackgroundColor: string; gridSize: number | null; gridStep: number; gridModeEnabled: boolean };

/** where the user's latest change is: in this browser, on the server, in Drive (or nowhere: storage failed) */
export type LiveStage = "saving" | "browser" | "server" | "drive" | "unsaved";

export type LiveNote = { at: number; text: string };

export type LiveLoser = { id: string; by: string | null; until: number; event: WireEvent };

export type LiveInfo = {
  fileId: string;
  name: string;
  /** null: not decided yet (no ticket answer so far) */
  enabled: boolean | null;
  connected: boolean;
  stage: LiveStage;
  role: Role | null;
  lifecycle: Lifecycle | "access" | null;
  presence: Presence[];
  blocked: BlockedAuthor[];
  /** the DO's last error ("drive-full", …) or this tab's */
  error: string | null;
  /** edits wait in this browser until an editor's tab created the scene's key */
  waitingForKey: boolean;
  losers: LiveLoser[];
  notes: LiveNote[];
  /** the scene's last save to Drive (ms) */
  savedAt: number | null;
};

/** what the controller does for live sync (registered by it: no import cycle) */
export type LiveHost = {
  /** the scene was renamed (by an event of another tab, or in Drive) */
  renamed: (fileId: string, to: string) => void;
  /** a lifecycle change the user has to see (trashed, closed, access gone) */
  lifecycle: (fileId: string, state: Lifecycle | "access") => void;
  /** store a scene's whole content as a new local-only scene; returns the name it got */
  saveCopy: (name: string, json: string) => Promise<string>;
  /** the scene (by file id) the browser's copy of it, as last known: for open checks */
  changed: () => void;
};

const SETTINGS_KEY = eventKey("set", SETTINGS_ID);
const NAME_KEY = eventKey("name", NAME_ID);
const keyOf = (k: EventKind, id: string) => eventKey(k, id);

const settingsOf = (appState: any): Settings => ({
  viewBackgroundColor: appState?.viewBackgroundColor ?? "#ffffff",
  gridSize: appState?.gridSize ?? null,
  gridStep: appState?.gridStep ?? 5,
  gridModeEnabled: !!appState?.gridModeEnabled,
});

/** a reference refusal's detail "<element id>:<field>:<target>" */
const referenceOf = (detail: string | undefined) => {
  const match = /^([^:]+):([A-Za-z]+):(.+)$/.exec(detail ?? "");
  return match ? { id: match[1], field: match[2], target: match[3] } : null;
};

/** the element ids a refusal says the DO doesn't know ("unknown: a,b") */
const unknownIds = (detail: string | undefined) => (/^unknown: /.test(detail ?? "") ? detail!.slice(9).split(",").filter(Boolean) : []);

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// -----------------------------------------------------------------------------
// surfaces: where a LiveScene's local state lives (the canvas, or memory)
// -----------------------------------------------------------------------------

type Surface = {
  elements(): readonly El[];
  files(): Record<string, BinaryFileData>;
  settings(): Settings;
  /** the DO's state into the local copy: no undo step, never sent back */
  apply(change: { elements?: El[]; files?: BinaryFileData[]; settings?: Settings | null }): void;
  /** an agent's edit: an undoable step on the canvas */
  edit(change: { elements: El[]; files?: BinaryFileData[]; settings?: Settings }): void;
  /** ids in a gesture (dragged, resized, being typed in, being drawn) */
  gesture(): Set<string>;
  destroy(): void;
};

const canvasSurface = (api: ExcalidrawImperativeAPI, scene: () => LiveScene | null): Surface => {
  const merge = (elements: El[]) => {
    const byId = new Map(api.getSceneElementsIncludingDeleted().map((el) => [el.id, el as unknown as El]));
    for (const el of elements) {
      byId.set(el.id, { ...el });
    }
    // the editor orders deleted elements too: one holding the index of a live element (the DO
    // gives indices of deleted elements away) makes way, else the editor would move the live one
    const liveIndices = new Set([...byId.values()].filter((el) => !el.isDeleted && el.index).map((el) => el.index));
    for (const [id, el] of byId) {
      if (el.isDeleted && el.index && liveIndices.has(el.index)) {
        byId.set(id, { ...el, index: null });
      }
    }
    return byIndex([...byId.values()]) as any[];
  };
  // undo and redo: only properties still holding the user's value (see LiveScene.collect)
  const unsubscribe = api.onIncrement((increment: any) => {
    if (increment?.delta instanceof HistoryDelta) {
      scene()?.markUndo();
    }
  });
  // the editor changes element objects in place (dragging, its own index repairs): the engine
  // never shares an object with it, in either direction
  return {
    elements: () => api.getSceneElementsIncludingDeleted().map((el) => ({ ...el })) as unknown as El[],
    files: () => api.getFiles() as Record<string, BinaryFileData>,
    settings: () => settingsOf(api.getAppState()),
    apply: ({ elements, files, settings }) => {
      if (files?.length) {
        api.addFiles(files);
      }
      if (elements?.length || settings) {
        api.updateScene({
          ...(elements?.length ? { elements: merge(elements) } : {}),
          ...(settings ? { appState: settings as any } : {}),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    },
    edit: ({ elements, files, settings }) => {
      if (files?.length) {
        api.addFiles(files);
      }
      api.updateScene({
        elements: merge(elements),
        ...(settings ? { appState: settings as any } : {}),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    gesture: () => {
      const state: any = api.getAppState();
      const ids = new Set<string>();
      if (state.selectedElementsAreBeingDragged || state.isResizing || state.isRotating) {
        Object.keys(state.selectedElementIds || {}).forEach((id) => ids.add(id));
      }
      for (const el of [state.editingTextElement, state.newElement, state.multiElement, state.resizingElement]) {
        if (el?.id) {
          ids.add(el.id);
          if (el.containerId) {
            ids.add(el.containerId);
          }
        }
      }
      const linear = state.selectedLinearElement;
      if (linear?.elementId && (linear.isDragging || linear.pointerDownState?.prevSelectedPointsIndices)) {
        ids.add(linear.elementId);
      }
      return ids;
    },
    destroy: () => unsubscribe(),
  };
};

const memorySurface = (): Surface & { load(elements: El[], files: Record<string, BinaryFileData>, settings: Settings): void } => {
  let elements = new Map<string, El>();
  let files: Record<string, BinaryFileData> = {};
  let settings: Settings = settingsOf(null);
  const put = (list: El[] | undefined, more: BinaryFileData[] | undefined) => {
    for (const el of list ?? []) {
      elements.set(el.id, el);
    }
    for (const file of more ?? []) {
      files = { ...files, [file.id]: file };
    }
  };
  return {
    elements: () => byIndex([...elements.values()]),
    files: () => files,
    settings: () => settings,
    apply: ({ elements: list, files: more, settings: next }) => {
      put(list, more);
      if (next) {
        settings = next;
      }
    },
    edit: ({ elements: list, files: more, settings: next }) => {
      put(list, more);
      if (next) {
        settings = next;
      }
    },
    gesture: () => new Set(),
    destroy: () => {},
    load: (list, more, next) => {
      elements = new Map(list.map((el) => [el.id, el]));
      files = { ...more };
      settings = next;
    },
  };
};

// -----------------------------------------------------------------------------
// the confirmed state a browser last had, kept for the next session: local
// changes made while no LiveScene ran (e.g. signed out) are found against it
// -----------------------------------------------------------------------------

type StoredBase = {
  /** the last stamps the DO gave each element */
  stamps?: [string, string[]][];
  generation: string | null;
  seq: number;
  epoch: number;
  elements: El[];
  settings: { value: Settings; stamp: Base | null } | null;
  files: string[];
  fonts: [string, number][];
};

let baseStore: ReturnType<typeof createStore> | null = null;
const bases = () => (baseStore ??= createStore("kurviq-live-base", "scenes"));

// -----------------------------------------------------------------------------
// a scene's live connection
// -----------------------------------------------------------------------------

type Draft = {
  k: EventKind;
  id: string;
  value: any;
  /** every change merged into it was made while live (connected and up to date) */
  live: boolean;
  via: "user" | "agent";
  command?: string;
  fontId?: number;
};

type Flight = { at: number; ids: Set<string> };

type Phase = "idle" | "connecting" | "handshake" | "seeding" | "waiting" | "ready" | "offline" | "disabled" | "closed";

export class LiveScene {
  readonly fileId: string;
  name: string;
  readonly headless: boolean;
  private surface: Surface;
  private sub: string;
  private host: () => LiveHost | null;

  private tab: HeldTab | null = null;
  private key: SceneKey | null = null;
  private ticket: Extract<TicketAnswer, { enabled: true }> | null = null;
  role: Role | null = null;
  enabled: boolean | null = null;
  private phase: Phase = "idle";
  private ws: WebSocket | null = null;
  private openToken = "";
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceSentAt = 0;

  // the DO's state
  private generation: string | null = null;
  private epoch = 0;
  private seq = 0;
  private confirmed = new Map<string, El>();
  private confirmedSettings: { value: Settings; stamp: Base | null } | null = null;
  private confirmedFiles = new Set<string>();
  private confirmedFonts = new Map<string, number>();
  private receipts: Record<string, Receipt> = {};
  private baseLoaded = false;

  // this tab's side
  /** per element (and "set:settings", "name:name"): the DO state the local copy derives from */
  private synced = new Map<string, { stamp: Base | null; el: any }>();
  /** canvas stamps already accounted for (sent, or written by us) */
  private known = new Map<string, Base>();
  private draft = new Map<string, Draft>();
  private batches: QueuedBatch[] = [];
  private inFlight = new Map<number, Flight>();
  /**
   * who set the values properties have (undo changes only the user's own); per property the last
   * 1000 values (completed gestures, not drag frames): more steps of one property than that are
   * beyond what an undo in practice reaches back to
   */
  private authors = new ValueAuthors(1000);
  /** an element's state when its current gesture began */
  private stepStart = new Map<string, El>();
  private lastCanvas = new Map<string, El>();
  /** local edits kept against every incoming change (their recovery copy could not be stored) */
  private protectedIds = new Set<string>();
  /** elements another tab of this account has queued (not this tab's to send) */
  private othersPending = new Map<string, Set<string>>();
  /**
   * The browser's other tabs of this scene (they share the canvas storage: a
   * reloaded tab may show another tab's unsent change): which elements each
   * has pending, so none is taken for this tab's own
   */
  private channel: BroadcastChannel | null = null;
  private peers = new Map<string, { ids: string[]; at: number }>();
  private announced = "";

  private openChannel() {
    if (this.headless || this.viewOnly || typeof BroadcastChannel === "undefined" || this.channel) {
      return;
    }
    // by file only: the account's id may still be its email stand-in in one tab and not in another
    this.channel = new BroadcastChannel(`kurviq-live-pending:${this.fileId}`);
    this.channel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.tab === this.tab?.tab) {
        return;
      }
      if (data.type === "ask") {
        // always answered (also with nothing pending): the asking tab learns that this one is open
        this.peers.set(data.tab, { ids: [], at: Date.now() });
        this.announced = [...this.pendingIds()].sort().join(",");
        this.channel?.postMessage({ type: "pending", tab: this.tab?.tab, ids: [...this.pendingIds()] });
      } else if (data.type === "pending" && Array.isArray(data.ids)) {
        this.peers.set(data.tab, { ids: data.ids, at: Date.now() });
        // that tab says what it has pending now: its claims read from the queue are as old as that read
        this.othersPending.delete(data.tab);
      } else if (data.type === "bye") {
        this.peers.delete(data.tab);
      }
    };
    this.channel.postMessage({ type: "ask", tab: this.tab?.tab });
    // a reload or a closed tab: the others hear it at once (the next one may get another tab id)
    window.addEventListener("pagehide", this.sayBye);
  }

  private sayBye = () => {
    this.channel?.postMessage({ type: "bye", tab: this.tab?.tab });
  };

  private announcePending() {
    if (!this.channel || this.phase === "closed") {
      return;
    }
    const ids = [...this.pendingIds()].sort();
    const key = ids.join(",");
    if (key !== this.announced) {
      this.announced = key;
      this.channel.postMessage({ type: "pending", tab: this.tab?.tab, ids });
    }
  }

  /** elements this browser's other tabs have pending (or queued) */
  private othersHave(id: string) {
    if ([...this.othersPending.values()].some((ids) => ids.has(id))) {
      return true;
    }
    for (const [tab, peer] of this.peers) {
      if (Date.now() - peer.at > 15_000) {
        this.peers.delete(tab);
      } else if (peer.ids.includes(id)) {
        return true;
      }
    }
    return false;
  }
  private lastGesture = new Set<string>();
  private undoing = false;
  private agentMark: { command?: string } | null = null;
  /** the local copy's base for the first reconciliation (persisted confirmed state, or the Drive version) */
  private localBase: Map<string, El> | null = null;
  private driveBase: (() => Promise<El[] | null>) | null;
  private signedOutEdits = false;
  private storageFailed = false;
  private offlineCopy: Promise<string> | null = null;
  private seeded = false;
  private waiters: { resolve: () => void; reject: (error: Error) => void; until: () => boolean }[] = [];
  /** the canvas shows another scene now: nothing is applied to it any more (the queue is still flushed) */
  private detached = false;

  detach() {
    this.detached = true;
    this.conn++; // a message being handled stops at its next check
  }

  /** dev and fake-Google builds: how the confirmed layer changed (for tests) */
  private trace: string[] | null = import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE ? [] : null;

  /** per element, the last stamps the DO gave it (a canvas element with one is the DO's, not a local edit) */
  private doStamps = new Map<string, string[]>();

  private rememberStamp(el: El) {
    const list = this.doStamps.get(el.id) ?? [];
    const stamp = `${el.version}:${el.versionNonce}`;
    if (!list.includes(stamp)) {
      list.push(stamp);
      this.doStamps.set(el.id, list.slice(-8));
    }
  }

  private isDoStamp(el: El) {
    return !!this.doStamps.get(el.id)?.includes(`${el.version}:${el.versionNonce}`);
  }

  /** dev and fake-Google builds: why recovery copies were made (kept across reloads, for tests) */
  private debugCopy(info: Record<string, unknown>) {
    if (!this.trace) {
      return;
    }
    try {
      const list = JSON.parse(localStorage.getItem("kurviq-live-debug-copies") || "[]");
      list.push({ tab: this.tab?.tab, at: Date.now(), ...info });
      localStorage.setItem("kurviq-live-debug-copies", JSON.stringify(list.slice(-50)));
    } catch {}
  }

  private setConfirmed(id: string, el: El, source: string) {
    this.rememberStamp(el);
    if (this.trace && source === "refused") {
      this.traced(source, el);
    }
    this.confirmed.set(id, el);
  }

  private traced(source: string, el: El) {
    if (this.trace) {
      this.trace.push(`${source} ${el.id.slice(0, 6)} ${el.index} v${el.version}${el.isDeleted ? " del" : ""} seq${this.seq}`);
      if (this.trace.length > 5000) {
        this.trace.splice(0, 1000);
      }
    }
  }

  /** messages are handled one after the other */
  private inbox: Promise<void> = Promise.resolve();
  /** the connection (counted) and the one whose message is being handled */
  private conn = 0;
  private activeConn = 0;

  // shown to the user
  presence: Presence[] = [];
  blocked: BlockedAuthor[] = [];
  lifecycle: Lifecycle | "access" | null = null;
  error: string | null = null;
  losers: LiveLoser[] = [];
  notes: LiveNote[] = [];
  savedAt: number | null = null;
  private listeners = new Set<() => void>();

  constructor(options: {
    fileId: string;
    name: string;
    sub: string;
    surface: Surface;
    headless: boolean;
    host: () => LiveHost | null;
    driveBase?: () => Promise<El[] | null>;
    signedOutEdits?: boolean;
    /** a closed tab's queue to send under its own tab id */
    tab?: HeldTab;
    /** the shared-link viewer: shows the DO's state live, never sends, seeds or keeps anything */
    viewOnly?: boolean;
  }) {
    this.fileId = options.fileId;
    this.name = options.name;
    this.sub = options.sub;
    // a closed session never writes into the editor again (it may show another scene by then)
    const surface = options.surface;
    const open = () => this.phase !== "closed" && !this.detached;
    this.surface = {
      ...surface,
      apply: (change) => {
        if (open()) {
          surface.apply(change);
        }
      },
      edit: (change) => {
        if (open()) {
          surface.edit(change);
        }
      },
    };
    this.headless = options.headless;
    this.host = options.host;
    this.driveBase = options.driveBase ?? null;
    this.signedOutEdits = !!options.signedOutEdits;
    this.tab = options.tab ?? null;
    this.viewOnly = !!options.viewOnly;
  }

  readonly viewOnly: boolean;

  // ---------------------------------------------------------------------------
  // state for the UI
  // ---------------------------------------------------------------------------

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    this.announcePending();
    this.listeners.forEach((listener) => listener());
    for (const waiter of [...this.waiters]) {
      if (waiter.until()) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  private note(text: string) {
    this.notes = [{ at: Date.now(), text }, ...this.notes].slice(0, 5);
    this.changed();
  }

  dismissNote(at: number) {
    this.notes = this.notes.filter((note) => note.at !== at);
    this.changed();
  }

  get connected() {
    return this.phase === "ready";
  }

  /** a state of the DO is known (from this session or the last one): changes can be queued */
  get hasBase() {
    return this.baseLoaded;
  }

  /** stopped for good in this session (closed, or the ticket was refused) */
  get stopped() {
    return this.phase === "closed" || this.phase === "disabled";
  }

  stage(): LiveStage {
    if (this.storageFailed) {
      return "unsaved";
    }
    // "in this browser" only once IndexedDB committed it (the draft and batches being written are not yet)
    if (this.draft.size || this.unstored.size) {
      return "saving";
    }
    if (this.batches.some((batch) => batch.state === "queued")) {
      return "browser";
    }
    if (this.batches.some((batch) => batch.state === "acked")) {
      return "server";
    }
    return "drive";
  }

  info(): LiveInfo {
    return {
      fileId: this.fileId,
      name: this.name,
      enabled: this.enabled,
      connected: this.connected,
      stage: this.stage(),
      role: this.role,
      lifecycle: this.lifecycle,
      presence: this.presence,
      blocked: this.blocked,
      error: this.error,
      waitingForKey: this.enabled === true && this.role === "edit" && !this.key,
      losers: this.losers.filter((loser) => loser.until > Date.now()),
      notes: this.notes,
      savedAt: this.savedAt,
    };
  }

  /** resolves once `until` holds (checked on every change), rejects after `ms` */
  waitFor(until: () => boolean, ms: number, what: string) {
    if (until()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, until };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error(what));
        }
      }, ms);
    });
  }

  // ---------------------------------------------------------------------------
  // connecting
  // ---------------------------------------------------------------------------

  /** ticket, then the WebSocket; tries again with growing pauses */
  async start() {
    if (this.phase !== "idle") {
      return;
    }
    await this.loadQueue();
    if ((this.phase as Phase) === "closed") {
      this.tab?.release(); // closed while starting: a lock taken meanwhile goes too
      return;
    }
    this.openChannel();
    this.watchdog = setInterval(() => this.checkAcks(), 1000);
    this.connect();
  }

  private async loadQueue() {
    if (this.viewOnly) {
      // a viewer has no queue and no stored state: a tab id of its own (the same for this file in this
      // browser: the DO allows an account only so many), the whole state at the handshake
      const key = `kurviq-live-viewer-tab:${this.fileId}`;
      let known: string | null = null;
      try {
        known = localStorage.getItem(key);
      } catch {}
      this.tab = (known ? await holdTab(this.fileId, known) : null) ?? (await holdTab(this.fileId, newTabId())) ?? { tab: newTabId(), release: () => {} };
      try {
        localStorage.setItem(key, this.tab.tab);
      } catch {}
      return;
    }
    try {
      if (!this.tab) {
        this.tab = await claimTab(this.sub, this.fileId);
      }
      if (this.phase === "closed") {
        return;
      }
      const all = await batchesOf(this.sub, this.fileId);
      this.batches = all.filter((batch) => batch.tab === this.tab!.tab).sort((a, b) => a.counter - b.counter);
      // other tabs' changes of this scene (they share this browser's canvas storage): theirs to send
      for (const batch of all) {
        if (batch.tab !== this.tab.tab && batch.state === "queued") {
          const ids = this.othersPending.get(batch.tab) ?? new Set<string>();
          batch.changes.forEach((change) => change.k === "el" && ids.add(change.id));
          this.othersPending.set(batch.tab, ids);
        }
      }
      const stored = await get<StoredBase>([this.sub, this.fileId], bases()).catch(() => undefined);
      if (stored) {
        stored.elements.forEach((el) => this.traced(`stored${stored.seq}`, el));
        this.generation = stored.generation;
        this.seq = stored.seq;
        this.epoch = stored.epoch;
        this.confirmed = new Map(stored.elements.map((el) => [el.id, el]));
        this.confirmedSettings = stored.settings;
        this.confirmedFiles = new Set(stored.files);
        this.confirmedFonts = new Map(stored.fonts);
        this.doStamps = new Map(stored.stamps ?? []);
        stored.elements.forEach((el) => this.rememberStamp(el));
        this.localBase = new Map(this.confirmed);
        this.baseLoaded = true;
      }
    } catch (error) {
      console.error("[live] the browser's queue could not be read", error);
      this.storageFailed = true;
      this.tab ??= { tab: Math.random().toString(36).slice(2, 12), release: () => {} };
    }
    if (!this.localBase && this.driveBase) {
      const elements = await this.driveBase().catch(() => null);
      this.localBase = elements ? new Map(elements.map((el) => [el.id, el])) : null;
    }
    // what the canvas shows now counts as seen; reconcile() sorts out what
    // differs from the DO's state. Changes made from now on are queued, on
    // the stamps of the last known state (also while offline)
    for (const el of this.confirmed.values()) {
      this.synced.set(el.id, { stamp: stampOf(el), el });
    }
    if (this.confirmedSettings) {
      this.synced.set(SETTINGS_KEY, { stamp: this.confirmedSettings.stamp, el: this.confirmedSettings.value });
    }
    for (const el of this.surface.elements()) {
      this.lastCanvas.set(el.id, el);
      this.known.set(el.id, stampOf(el));
    }
    this.changed();
  }

  private scheduleRetry(at?: number) {
    if (this.phase === "closed" || this.phase === "disabled" || this.retryTimer) {
      return;
    }
    const wait = at ?? Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  /** the network is back (the browser said so): try now */
  wake() {
    if (this.phase === "offline") {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.retry = 0;
      this.connect();
    }
  }

  private async connect() {
    if (this.phase === "closed" || this.phase === "disabled") {
      return;
    }
    this.phase = "connecting";
    let answer: TicketAnswer;
    try {
      answer = await authPost(`/scene/${encodeURIComponent(this.fileId)}/ticket`, { protocol: LIVE_PROTOCOL });
    } catch (error: any) {
      if ((this.phase as Phase) === "closed") {
        return;
      }
      if (error?.code === "no-access") {
        // Kurviq may not open the file (the Picker grants it): today's sync explains it
        this.enabled = false;
        this.phase = "disabled";
        this.error = error.code;
        this.changed();
        return;
      }
      if (error?.status === 401) {
        // signed out / sign in again: changes stay queued, nothing is sent until the next sign-in
        this.phase = "disabled";
        this.error = error.code ?? "signed-out";
        this.changed();
        return;
      }
      // everything else is for now (Google or Kurviq unreachable, the key being made): tried again
      this.phase = "offline";
      this.error = error?.code ?? null;
      this.changed();
      this.scheduleRetry(error?.status >= 400 && error?.status < 500 ? 60_000 : undefined);
      return;
    }
    if ((this.phase as Phase) === "closed") {
      return;
    }
    if (!answer.enabled && answer.code === "no-key-yet") {
      // a viewer before any editor made the scene's key: today's sync until then, asked again later
      this.enabled = false;
      this.phase = "offline";
      this.error = answer.code;
      this.changed();
      this.scheduleRetry(60_000);
      return;
    }
    if (!answer.enabled) {
      this.enabled = false;
      this.phase = "disabled";
      this.error = answer.code ?? null;
      if (this.batches.length) {
        this.note("Live sync is off for this scene: changes kept in this browser wait until it is on again.");
      }
      this.changed();
      return;
    }
    this.enabled = true;
    this.ticket = answer;
    this.proof = answer.proof;
    this.role = answer.role;
    if (answer.sub && answer.sub !== this.sub) {
      const email = connection.getState().user?.email;
      if (this.sub.startsWith("email:") && this.sub === `email:${email}` && liveSync.mayMoveTo(email!, answer.sub)) {
        // the queue was keyed by a stand-in (this account's email) until its id was known
        await liveSync.accountKnown(this.sub, answer.sub);
        this.sub = answer.sub;
        if ((this.phase as Phase) === "closed") {
          return;
        }
      } else {
        // the browser's sign-in is another account now (another tab switched it): this
        // session's queue stays its own account's, never sent as the new one
        this.close();
        liveSync.accountSwitched();
        return;
      }
    }
    try {
      this.key = answer.key && answer.keyId ? await importSceneKey(answer.key, answer.keyId, this.fileId) : null;
    } catch {
      this.key = null;
      this.error = "key-invalid";
    }
    if ((this.phase as Phase) === "closed") {
      return; // closed while the key was imported: never reopened
    }
    this.openSocket(answer.ticket);
  }

  private openSocket(ticket: string) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveSocketUrl(this.fileId, ticket));
    } catch {
      this.phase = "offline";
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.phase = "handshake";
    const conn = ++this.conn;
    const receive = createReceiver();
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      this.openToken = Math.random().toString(36).slice(2, 14);
      this.send({
        type: "hello",
        protocol: LIVE_PROTOCOL,
        tab: this.tab!.tab,
        openToken: this.openToken,
        revision: null,
        seq: this.baseLoaded && !this.headless ? this.seq : 0,
        generation: this.baseLoaded && !this.headless ? this.generation : null,
      });
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    };
    ws.onmessage = (message) => {
      if (message.data === "pong" || this.ws !== ws) {
        return;
      }
      let parsed: ServerMessage | null;
      try {
        parsed = receive(String(message.data));
      } catch (error) {
        console.error("[live] dropped a malformed message", error);
        return;
      }
      if (parsed) {
        // one message at a time, in order: a welcome being decrypted is never overtaken by events
        const message = parsed;
        this.inbox = this.inbox
          .then(() => {
            if (this.ws !== ws || this.phase === "closed" || this.detached) {
              return; // for a connection (or session) that is gone
            }
            this.activeConn = conn;
            return this.receive(message);
          })
          .catch((error) => {
            console.error("[live] could not apply a message", error);
            this.error = error?.message ?? String(error);
            this.changed();
          });
      }
    };
    let welcomed = false;
    this.onWelcomed = () => {
      welcomed = true;
      this.refusedOpens = 0;
    };
    ws.onclose = (event) => {
      if (ping) {
        clearInterval(ping);
      }
      if (this.ws === ws) {
        // refused by the scene's limits (too many tabs, too many connections of this account):
        // said in the banner, and tried again only slowly
        if (!welcomed) {
          this.refusedOpens++;
          if (event.reason === "too many tabs" || this.refusedOpens >= 3) {
            this.error = event.reason === "too many tabs" ? "too-many-tabs" : "too-many-connections";
            this.retry = 6; // the longest pause
            this.changed();
          }
        }
        this.dropConnection();
      }
    };
    ws.onerror = () => {};
  }

  /** connections in a row that closed before a welcome (refused by the scene's limits, most likely) */
  private refusedOpens = 0;
  private onWelcomed: (() => void) | null = null;

  /** the connection is gone: unanswered batches are sent again after the next handshake */
  private dropConnection() {
    const ws = this.ws;
    this.ws = null;
    this.conn++; // a message of the old connection still being handled stops at its next check
    try {
      ws?.close();
    } catch {}
    this.inFlight.clear();
    this.offlineCopy = null;
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.phase !== "closed" && this.phase !== "disabled") {
      this.phase = "offline";
      this.changed();
      this.scheduleRetry();
    }
  }

  /** the message being handled belongs to a connection (or session) that is gone: stop applying it */
  private stale() {
    return this.phase === "closed" || this.detached || this.activeConn !== this.conn;
  }

  private send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      sendMessage(this.ws, message);
      return true;
    }
    return false;
  }

  /** a batch unanswered for ACK_TIMEOUT_MS: the connection counts as dead */
  private checkAcks() {
    const now = Date.now();
    if (now - this.othersReadAt > 15_000 && !this.viewOnly) {
      // other tabs' queued changes: claims only while their batches are still queued
      this.othersReadAt = now;
      batchesOf(this.sub, this.fileId)
        .then((all) => {
          const claims = new Map<string, Set<string>>();
          for (const batch of all) {
            if (batch.tab !== this.tab?.tab && batch.state === "queued") {
              const ids = claims.get(batch.tab) ?? new Set<string>();
              batch.changes.forEach((change) => change.k === "el" && ids.add(change.id));
              claims.set(batch.tab, ids);
            }
          }
          this.othersPending = claims;
        })
        .catch(() => {});
    }
    if (this.phase === "ready" && now - this.caughtUpAt > 5000) {
      this.caughtUpAt = now;
      this.catchUp();
      // still open: the browser's other tabs of this scene keep knowing it
      this.channel?.postMessage({ type: "pending", tab: this.tab?.tab, ids: [...this.pendingIds()] });
    }
    for (const flight of this.inFlight.values()) {
      if (now - flight.at > ACK_TIMEOUT_MS) {
        this.retry = 0;
        this.dropConnection();
        return;
      }
    }
  }

  /** the access proof: renewed with the previous one every PROOF_RENEW_MS (the Worker tells the DO) */
  private proof: string | null = null;

  private async renew() {
    if (!this.proof) {
      return;
    }
    try {
      const answer = await authPost(`/scene/${encodeURIComponent(this.fileId)}/renew`, { tab: this.tab?.tab, proof: this.proof });
      this.proof = answer.proof ?? this.proof;
      if (answer.role && answer.role !== this.role) {
        this.role = answer.role;
        this.changed();
      }
    } catch (error: any) {
      if (error?.code === "no-access" || error?.status === 403 || error?.status === 404) {
        this.lifecycle = "access";
        this.host()?.lifecycle(this.fileId, "access");
        this.changed();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // messages from the Durable Object
  // ---------------------------------------------------------------------------

  private async receive(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        return this.onWelcome(message);
      case "ack":
        return this.onAck(message);
      case "refused":
        return this.onRefused(message);
      case "events":
        return this.onEvents(message);
      case "saved":
        this.savedAt = message.at;
        this.receipts = { ...this.receipts, ...message.receipts };
        await this.dropSaved();
        this.changed();
        return;
      case "status":
        this.blocked = message.blocked;
        this.error = message.error;
        this.presence = message.presence;
        this.setLifecycle(message.lifecycle);
        if (message.driveName) {
          const to = message.driveName.replace(/\.excalidraw$/, "");
          if (this.sentName !== null) {
            // our rename isn't in Drive yet: Drive's old name is no news
            if (to === this.sentName) {
              this.sentName = null;
            }
          } else if (to !== this.name) {
            this.name = to;
            this.host()?.renamed(this.fileId, to);
          }
        }
        this.changed();
        return;
      case "seed-refused":
        if (message.reason === "old") {
          // Drive moved on since the ticket: a new ticket carries the new head
          this.retry = 0;
          this.dropConnection();
        } else if (message.reason !== "seeded") {
          this.phase = "waiting";
          this.error = `seed-${message.reason}`;
          this.changed();
        }
        return;
      case "renew-now":
        return this.renew();
      case "need-token":
        await authPost(`/scene/${encodeURIComponent(this.fileId)}/reconcile`, { tab: this.tab?.tab }).catch(() => {});
        return;
      case "keep-local":
        this.keepLocalAnswer?.(message);
        return;
      case "lost":
        this.losers = [...this.losers.filter((loser) => loser.id !== message.id), message];
        this.changed();
        return;
      case "closed":
        this.setLifecycle(message.reason === "replaced" ? null : message.reason);
        if (message.reason === "replaced") {
          // another tab took this tab id over: this one stops
          this.close();
          return;
        }
        if (message.reason === "access" || message.reason === "deleted" || message.reason === "local") {
          this.phase = "disabled";
          this.ws?.close();
        }
        this.changed();
        return;
    }
  }

  private setLifecycle(state: Lifecycle | "access" | null) {
    if (state === this.lifecycle || (state === "active" && this.lifecycle === null)) {
      this.lifecycle = state === "active" ? null : state;
      return;
    }
    this.lifecycle = state === "active" ? null : state;
    if (this.lifecycle) {
      this.host()?.lifecycle(this.fileId, this.lifecycle);
    }
  }

  private async decode(event: WireEvent, previous?: any) {
    if (!this.key) {
      throw new Error("The scene's key is missing");
    }
    return decodeEvent(this.key, event, previous);
  }

  /** a whole scene from the DO -> the confirmed layer */
  private async loadState(state: WireScene) {
    const elements = new Map<string, El>();
    let settings: { value: Settings; stamp: Base | null } | null = null;
    const files: BinaryFileData[] = [];
    for (const event of state.events) {
      if (event.k === "el") {
        const el = await this.decode(event, this.confirmed.get(event.id));
        if (el) {
          elements.set(el.id, el);
        }
      } else if (event.k === "set") {
        settings = { value: settingsOf(await this.decode(event)), stamp: event.v ?? null };
      } else if (event.k === "file") {
        if (!this.confirmedFiles.has(event.id) || !this.surface.files()[event.id]) {
          files.push(await this.decode(event));
        }
      } else if (event.k === "font") {
        await this.takeFont(event);
      } else if (event.k === "name") {
        await this.takeName(event);
      }
    }
    this.confirmed = elements;
    elements.forEach((el) => {
      this.traced("state", el);
      this.rememberStamp(el);
    });
    this.confirmedSettings = settings;
    this.confirmedFiles = new Set(state.events.filter((event) => event.k === "file").map((event) => event.id));
    if (files.length) {
      this.surface.apply({ files });
    }
  }

  /** a font of the scene, under the number the DO keeps for it (another than its own after a clash) */
  private async takeFont(event: WireEvent) {
    const font = (await this.decode(event)) as CustomFont;
    const id = event.fontId ?? font.id;
    this.confirmedFonts.set(event.id, id);
    // by its bytes, not its number: another font of this browser with the same number makes way
    const known = customFonts.get(id);
    if (!known || JSON.stringify(known.faces) !== JSON.stringify(font.faces)) {
      // the page has one font registry: only the open scene's own session may replace a font in it
      // (a headless session or the viewer would take it from the scene on the canvas)
      await addFont({ ...font, id }, { replace: !this.headless && !this.viewOnly }).catch(() => {});
    }
  }

  private async takeName(event: WireEvent) {
    const value = await this.decode(event);
    const to = typeof value?.name === "string" ? value.name : null;
    this.synced.set(NAME_KEY, { stamp: event.v ?? null, el: value });
    if (to && to !== this.name) {
      this.name = to;
      this.host()?.renamed(this.fileId, to);
    }
  }

  private async onWelcome(welcome: Extract<ServerMessage, { type: "welcome" }>) {
    if (welcome.openToken !== this.openToken || welcome.fileId !== this.fileId) {
      return; // an answer for another open (this tab switched scenes meanwhile)
    }
    this.onWelcomed?.();
    if (this.error === "too-many-tabs" || this.error === "too-many-connections") {
      this.error = null;
    }
    this.role = welcome.role;
    this.presence = welcome.presence;
    this.setLifecycle(welcome.lifecycle);
    if (welcome.keyId && this.key && welcome.keyId !== this.key.keyId) {
      this.error = "key-changed";
    }
    if (welcome.mode === "seed") {
      return this.seed();
    }
    if (welcome.mode === "wait") {
      this.phase = "waiting";
      this.changed();
      return;
    }
    if (!this.key) {
      // nothing can be read or sent without the key: edits wait in this browser
      this.phase = "waiting";
      this.changed();
      return;
    }
    if (welcome.mode === "state" && welcome.state) {
      await this.loadState(welcome.state);
    }
    for (const batch of welcome.events ?? []) {
      if (this.stale()) {
        return;
      }
      await this.takeStamped(batch, { toCanvas: false });
    }
    if (this.stale()) {
      return;
    }
    // the DO lost its data (a new generation): unanswered batches may be in Drive already too
    const lostData = this.generation !== null && welcome.generation !== this.generation;
    this.generation = welcome.generation;
    this.seq = Math.max(welcome.mode === "state" ? 0 : this.seq, welcome.seq);
    this.receipts = { ...this.receipts, ...welcome.receipts };
    this.baseLoaded = true;

    // this tab's batches against what the DO and Drive have: the DO has them
    // (answers lost) -> on the server; neither has them (the DO lost its data:
    // a new generation) -> sent again, also those answered before
    const known = new Set(welcome.known);
    const receipt = this.receipts[this.tab?.tab ?? ""];
    for (const batch of this.batches) {
      const doHas = batch.counter <= welcome.knownMark || known.has(batch.counter);
      if (batch.state === "queued" && doHas) {
        batch.state = "acked";
        await this.persist(batch);
      } else if ((batch.state === "acked" || (lostData && batch.state === "queued")) && !doHas && !inReceipt(receipt, batch.counter)) {
        // lost by the DO and not recorded in Drive: by content. What the DO's
        // state (Drive's) already has is done; the rest is sent again as offline
        // work: if it clashes it goes into a copy, never over newer work
        const has = (change: QueuedChange) => {
          const key = keyOf(change.k, change.id);
          if (change.k === "el") {
            const now = this.confirmed.get(change.id);
            const stamp = batch.stamps?.[key];
            return !!now && (contentEqual(now, change.value) || (!!stamp && now.version === stamp.v && now.versionNonce === stamp.n));
          }
          if (change.k === "file") {
            return this.confirmedFiles.has(change.id);
          }
          if (change.k === "font") {
            return this.confirmedFonts.has(change.id);
          }
          return sameJson(this.synced.get(key)?.el, change.value);
        };
        if (batch.changes.every(has)) {
          await this.forget(batch);
          continue;
        }
        batch.state = "queued";
        batch.live = false;
        batch.stamps = undefined;
        await this.persist(batch);
      }
    }
    await this.dropSaved();
    // batches that may never be replayed (too old, or from before the scene was restored from the trash)
    const stale = this.batches.filter(
      (batch) => batch.state === "queued" && (Date.now() - batch.made > REPLAY_HORIZON_MS || (batch.epoch ?? welcome.epoch) < welcome.epoch),
    );
    this.epoch = welcome.epoch;
    this.parked.clear();
    await this.reconcile(stale);
    if (this.stale()) {
      return;
    }
    this.phase = "ready";
    this.retry = 0;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => this.renew(), PROOF_RENEW_MS);
    }
    this.persistBaseSoon();
    this.changed();
    this.pump();
  }

  /** an empty DO asked for the scene: the Drive version the ticket names, if this tab can load exactly that one */
  private async seed() {
    if (this.viewOnly || this.role !== "edit" || !this.key || !this.ticket) {
      this.phase = "waiting";
      this.changed();
      return;
    }
    this.phase = "seeding";
    const head = this.ticket.head;
    const json = head.md5 ? await driveScenes.loadFileVersion(this.fileId, head.md5).catch(() => null) : null;
    if (json === null) {
      // Drive changed since the ticket (or can't be read now): a new ticket, and then again
      this.dropConnection();
      return;
    }
    const data = JSON.parse(json);
    const elements = restoreElements(data.elements, null, { repairBindings: true }) as unknown as El[];
    const events: WireEvent[] = [];
    for (const el of elements) {
      events.push(await encodeEvent(this.key, "el", el.id, el, null));
    }
    // settings and name get their first stamp here (the DO keeps it), so later changes name it as base
    const settingsStamp: Base = { v: 1, n: Math.floor(Math.random() * 2 ** 31) };
    const nameStamp: Base = { v: 1, n: Math.floor(Math.random() * 2 ** 31) };
    events.push({ ...(await encodeEvent(this.key, "set", SETTINGS_ID, settingsOf(data.appState), null)), v: settingsStamp });
    events.push({ ...(await encodeEvent(this.key, "name", NAME_ID, { name: this.name }, null)), v: nameStamp });
    this.synced.set(NAME_KEY, { stamp: nameStamp, el: { name: this.name } });
    const used = new Set(elements.filter((el) => !el.isDeleted && el.fileId).map((el) => el.fileId));
    for (const [id, file] of Object.entries<any>(data.files || {})) {
      if (used.has(id)) {
        events.push(await encodeEvent(this.key, "file", id, file, null));
      }
    }
    for (const font of Array.isArray(data.kurviqFonts) ? data.kurviqFonts : []) {
      events.push(await encodeEvent(this.key, "font", await fontHash(font), font, null, { fontId: font.id }));
    }
    if (this.stale()) {
      return;
    }
    if (this.headless) {
      // a headless copy has nothing else to show: the seed's images and fonts are its view too
      this.surface.apply({ files: Object.values<any>(data.files || {}).filter((file) => used.has(file.id)) });
      for (const font of Array.isArray(data.kurviqFonts) ? data.kurviqFonts : []) {
        await addFont(font).catch(() => {});
      }
    }
    // the local copy's changes are found against this version (unless a newer base is known)
    this.localBase ??= new Map(elements.map((el) => [el.id, el]));
    // the DO's state is the seed now (its welcome brings what changed since)
    this.confirmed = new Map(elements.map((el) => [el.id, el]));
    elements.forEach((el) => this.rememberStamp(el));
    this.confirmedSettings = { value: settingsOf(data.appState), stamp: settingsStamp };
    this.confirmedFiles = new Set(used as Set<string>);
    this.confirmedFonts = new Map();
    for (const font of Array.isArray(data.kurviqFonts) ? data.kurviqFonts : []) {
      this.confirmedFonts.set(await fontHash(font), font.id);
    }
    this.baseLoaded = true;
    this.generation = null;
    this.seq = 0;
    this.seeded = true;
    // (the file's receipts and attribution the DO reads from Drive itself)
    this.send({ type: "seed", scene: { revision: head.revision, md5: head.md5, events } });
    // the DO answers with a welcome
  }

  /**
   * After the handshake: the local copy against the DO's state. Elements the
   * user didn't change take the DO's version; changes made while no
   * LiveScene ran (not in the queue) are queued now, unless the DO's element
   * changed too (then: offline copy).
   */
  private async reconcile(stale: QueuedBatch[]) {
    if (this.headless) {
      // a headless copy shows the DO's state with the queue's changes on top
      // (a closed tab's, sent from here), images and settings included: what
      // a recovery copy below must contain
      const latest = new Map<string, El>(this.confirmed);
      const files: BinaryFileData[] = [];
      let settings = this.confirmedSettings?.value ?? null;
      for (const batch of this.batches) {
        if (batch.state !== "queued") {
          continue; // answered ones are in the DO's state already (maybe changed by others since)
        }
        for (const change of batch.changes) {
          if (change.k === "el") {
            latest.set(change.id, change.value);
          } else if (change.k === "file") {
            files.push(change.value);
          } else if (change.k === "set") {
            settings = change.value;
          } else if (change.k === "font") {
            await addFont({ ...change.value, id: change.fontId ?? change.value.id }).catch(() => {});
          }
        }
      }
      this.surface.apply({ elements: [...latest.values()], files, settings });
      for (const el of this.surface.elements()) {
        this.known.set(el.id, stampOf(el));
        this.lastCanvas.set(el.id, el);
      }
    }
    const pendingIds = this.pendingIds();
    const base = this.localBase;
    const toApply: El[] = [];
    const unqueued: { el: El; from: El | null }[] = [];
    const clashes = new Set<string>();
    const canvas = this.surface.elements();
    const onCanvas = new Set<string>();
    for (const el of canvas) {
      onCanvas.add(el.id);
      if (pendingIds.has(el.id) || this.othersHave(el.id)) {
        continue;
      }
      const theirs = this.confirmed.get(el.id) ?? null;
      if (theirs && contentEqual(el, theirs)) {
        this.synced.set(el.id, { stamp: stampOf(theirs), el: theirs });
        if (el.version !== theirs.version || el.versionNonce !== theirs.versionNonce) {
          toApply.push(theirs);
        }
        continue;
      }
      const before = base?.get(el.id) ?? null;
      // a stamp the DO gave it: an older state of the DO's (the canvas copy is older than the
      // stored state, e.g. written by another tab), not an edit made here
      // the DO's version as this browser had it: its stamp, or (not in the stored state yet) only the DO's index repair missing
      const sameStampAsTheirs =
        !!theirs &&
        ((el.version === theirs.version && el.versionNonce === theirs.versionNonce) || (!before && contentEqual({ ...el, index: theirs.index }, theirs)));
      const unchangedHere = !base || sameStampAsTheirs || this.isDoStamp(el) || (before ? contentEqual(el, before) : !!el.isDeleted);
      if (unchangedHere) {
        if (theirs) {
          toApply.push(theirs);
          this.synced.set(el.id, { stamp: stampOf(theirs), el: theirs });
        } else if (!el.isDeleted && this.baseLoaded) {
          // gone from the DO's scene, not changed here: gone here too
          toApply.push({ ...el, isDeleted: true });
        }
        continue;
      }
      // (another tab's claimed change was skipped above: only an explicit claim makes it another tab's)
      if (this.role !== "edit" || this.viewOnly) {
        if (theirs) {
          toApply.push(theirs);
          this.synced.set(el.id, { stamp: stampOf(theirs), el: theirs });
        }
        continue;
      }
      if (!theirs || (before && contentEqual(theirs, before)) || (!before && !theirs)) {
        unqueued.push({ el, from: before });
        this.synced.set(el.id, { stamp: theirs ? stampOf(theirs) : null, el: before ?? theirs });
      } else {
        clashes.add(el.id);
      }
    }
    for (const el of this.confirmed.values()) {
      if (!onCanvas.has(el.id) && !el.isDeleted) {
        toApply.push(el);
        this.synced.set(el.id, { stamp: stampOf(el), el });
      }
    }
    const copyNeeded = clashes.size > 0 || stale.length > 0 || (this.signedOutEdits && unqueued.length > 0);
    if (copyNeeded) {
      this.debugCopy({
        at: "reconcile",
        clashes: [...clashes].map((id) => {
          const el = canvas.find((item) => item.id === id)!;
          const theirs = this.confirmed.get(id);
          const before = base?.get(id);
          return `${id.slice(0, 6)} canvas v${el.version}/${el.index} theirs v${theirs?.version}/${theirs?.index} base v${before?.version} vsTheirs[${changedKeys(theirs, el)}] vsBase[${before ? changedKeys(before, el) : "-"}]`;
        }),
        stale: stale.map((batch) => batch.counter),
        signedOut: this.signedOutEdits,
        peers: [...this.peers].map(([tab, peer]) => `${tab}:${Date.now() - peer.at}ms:${peer.ids.length}`),
        channel: !!this.channel,
      });
    }
    // nothing local is replaced or dropped unless the copy holding it is stored
    const copied = copyNeeded
      ? await this.makeOfflineCopy(
          stale.length
            ? "Changes kept in this browser were too old to send"
            : this.signedOutEdits
            ? "Changes made while you were signed out"
            : "Changes made here while offline clashed with newer ones",
        )
      : true;
    if (this.stale()) {
      return;
    }
    if (copied) {
      for (const batch of stale) {
        this.skipped.push(batch.counter);
        await this.forget(batch);
      }
    } else {
      // kept as they are (and not sent): the user can export the scene
      stale.forEach((batch) => this.parked.add(batch.counter));
    }
    // the DO's version where it wins (only once the user's version is safe in the copy)
    const losing = !copied ? [] : this.signedOutEdits ? unqueued.map((entry) => entry.el.id) : [...clashes];
    if (!copied) {
      clashes.forEach((id) => this.protectedIds.add(id)); // left as they are on the canvas
      if (this.signedOutEdits) {
        unqueued.forEach(({ el }) => this.protectedIds.add(el.id));
      }
    }
    for (const id of losing) {
      const theirs = this.confirmed.get(id);
      const el = canvas.find((item) => item.id === id)!;
      toApply.push(theirs ?? { ...el, isDeleted: true });
      if (theirs) {
        this.synced.set(id, { stamp: stampOf(theirs), el: theirs });
      }
    }
    const settingsPending = this.draft.has(SETTINGS_KEY) || this.batches.some((batch) => batch.changes.some((change) => change.k === "set"));
    const settings = this.confirmedSettings && !settingsPending && !sameJson(this.surface.settings(), this.confirmedSettings.value) ? this.confirmedSettings.value : null;
    if (this.confirmedSettings) {
      this.synced.set(SETTINGS_KEY, { stamp: this.confirmedSettings.stamp, el: this.confirmedSettings.value });
    }
    this.applyToSurface(toApply, settings);
    if (!this.signedOutEdits) {
      for (const { el } of unqueued) {
        this.addDraft("el", el.id, el, { live: false });
      }
    }
    if (this.signedOutEdits && copied) {
      // separated (or nothing to separate): the next open is a normal one
      liveSync.signedOutHandled(this.sub, this.fileId);
      this.signedOutEdits = false;
    }
    this.localBase = null;
    // images the scene uses that the DO doesn't have yet
    for (const el of this.surface.elements()) {
      this.draftAssets(el, false);
    }
    if (this.draft.size) {
      await this.flush();
    }
  }

  /** write the DO's elements into the local copy; the stamps they get there count as seen */
  private applyToSurface(elements: El[], settings: Settings | null = null) {
    if (!elements.length && !settings) {
      return;
    }
    const before = new Map(this.surface.elements().map((el) => [el.id, stampOf(el)]));
    this.surface.apply({ elements, settings });
    const pending = this.pendingIds();
    for (const el of this.surface.elements()) {
      const was = before.get(el.id);
      const applied = elements.some((item) => item.id === el.id);
      // our own write, or a repair the editor made while applying it (index
      // clashes): never sent back, only the DO repairs indices
      if (applied || (was && (was.v !== el.version || was.n !== el.versionNonce) && !pending.has(el.id))) {
        this.known.set(el.id, stampOf(el));
        this.lastCanvas.set(el.id, el);
      }
    }
  }

  /**
   * Catch up with the DO's state: an element that is not pending here, not
   * in a gesture and not another tab's pending change shows the DO's version.
   * Covers the editor's own index repairs (only the DO repairs, they are
   * never sent), changes held back while another tab claimed an element, and
   * anything else that drifted. The tab's own changes were collected first,
   * so nothing of the user's is overwritten.
   */
  private catchUp() {
    if (this.headless || !this.baseLoaded) {
      return;
    }
    this.collect();
    const pending = this.pendingIds();
    const gesture = this.surface.gesture();
    const back: El[] = [];
    const now = Date.now();
    for (const el of this.surface.elements()) {
      const theirs = this.confirmed.get(el.id);
      if (pending.has(el.id) || gesture.has(el.id) || this.othersHave(el.id)) {
        this.unknownSince.delete(el.id);
        continue;
      }
      if (!theirs) {
        // not the DO's and nobody's pending change (after a grace for queues of closed tabs): gone here too
        if (!el.isDeleted) {
          const since = this.unknownSince.get(el.id) ?? now;
          this.unknownSince.set(el.id, since);
          if (now - since > 15_000) {
            this.unknownSince.delete(el.id);
            back.push({ ...el, isDeleted: true });
          }
        }
        continue;
      }
      this.unknownSince.delete(el.id);
      // by content and order (an image's loading state and stamps are the editor's own business)
      if (!contentEqual(el, theirs) || el.index !== theirs.index || !!el.isDeleted !== !!theirs.isDeleted) {
        back.push(theirs);
        this.synced.set(el.id, { stamp: stampOf(theirs), el: theirs });
      } else if (el.version !== theirs.version || el.versionNonce !== theirs.versionNonce) {
        // the same, under the editor's own stamp: the next change builds on the DO's
        this.synced.set(el.id, { stamp: stampOf(theirs), el: theirs });
      }
    }
    if (back.length) {
      this.applyToSurface(back);
    }
  }

  private caughtUpAt = 0;
  private othersReadAt = Date.now();
  private unknownSince = new Map<string, number>();

  /** a batch of someone else's changes (or this tab's own, if its answer was lost) */
  private async onEvents(batch: Extract<ServerMessage, { type: "events" }>) {
    if (this.phase !== "ready") {
      return; // a welcome is on its way and carries it
    }
    await this.takeStamped(batch, { toCanvas: true });
    this.catchUp();
    this.seq = Math.max(this.seq, batch.seq);
    this.persistBaseSoon();
    this.changed();
  }

  private async takeStamped(batch: StampedBatch, { toCanvas }: { toCanvas: boolean }) {
    if (batch.tab === this.tab?.tab && batch.counter !== undefined) {
      const own = this.batches.find((entry) => entry.counter === batch.counter);
      if (own && own.state === "queued") {
        // its answer was lost: the streamed batch is it, with the DO's repairs (index, font numbers)
        const stamps: Record<string, Base> = {};
        const repairs: Record<string, string> = {};
        const fontIds: Record<string, number> = {};
        for (const event of batch.events) {
          const key = eventKey(event.k, event.id);
          stamps[key] = event.r ? { v: event.r.version, n: event.r.versionNonce } : event.v ?? { v: 0, n: 0 };
          const sent = own.changes.find((change) => change.k === event.k && change.id === event.id);
          if (event.r && sent && event.r.index && sent.value.index !== event.r.index) {
            repairs[key] = event.r.index;
          }
          if (event.k === "font" && sent && event.fontId !== undefined && event.fontId !== sent.value.id) {
            fontIds[event.id] = event.fontId;
          }
        }
        await this.onAck({
          type: "ack",
          counter: batch.counter,
          seq: batch.seq,
          stamps,
          ...(Object.keys(repairs).length ? { repairs } : {}),
          ...(Object.keys(fontIds).length ? { fontIds } : {}),
        });
        // elements whose font number the DO changed: its readable copy is in force
        for (const event of batch.events) {
          const now = event.r ? this.confirmed.get(event.id) : undefined;
          if (now && event.r!.fontFamily !== null && now.fontFamily !== event.r!.fontFamily) {
            this.setConfirmed(event.id, { ...now, fontFamily: event.r!.fontFamily }, "ack");
          }
        }
        return;
      }
    }
    const pending = this.pendingIds();
    const gesture = this.surface.gesture();
    const toApply: El[] = [];
    let settings: Settings | null = null;
    const files: BinaryFileData[] = [];
    for (const event of batch.events) {
      if (event.k === "el") {
        const previous = this.confirmed.get(event.id);
        const el = await this.decode(event, previous ?? this.lastCanvas.get(event.id));
        if (!el) {
          continue;
        }
        this.setConfirmed(el.id, el, "ev");
        this.traced(`ev${batch.seq}${batch.origin === "user" ? "" : batch.origin}`, el);
        for (const key of changedKeys(previous, el) ?? Object.keys(el)) {
          this.authors.set(el.id, key, el[key], "remote");
        }
        if (toCanvas && !pending.has(el.id) && !gesture.has(el.id)) {
          toApply.push(el);
          this.synced.set(el.id, { stamp: stampOf(el), el });
        }
      } else if (event.k === "set") {
        const value = settingsOf(await this.decode(event));
        this.confirmedSettings = { value, stamp: event.v ?? null };
        if (toCanvas && !this.isPending(SETTINGS_KEY)) {
          settings = value;
          this.synced.set(SETTINGS_KEY, { stamp: event.v ?? null, el: value });
        }
      } else if (event.k === "file") {
        this.confirmedFiles.add(event.id);
        if (!this.surface.files()[event.id]) {
          files.push(await this.decode(event));
        }
      } else if (event.k === "font") {
        await this.takeFont(event);
      } else if (event.k === "name") {
        await this.takeName(event);
      }
    }
    if (this.stale()) {
      return;
    }
    if (files.length) {
      this.surface.apply({ files });
    }
    if (toCanvas) {
      this.applyToSurface(toApply, settings);
    }
  }

  // ---------------------------------------------------------------------------
  // local changes
  // ---------------------------------------------------------------------------

  /** the next change is an undo / redo (the canvas tells before onChange) */
  markUndo() {
    this.undoing = true;
  }

  private pendingIds() {
    // edits whose recovery copy failed stay as they are on the canvas until saved some other way
    const ids = new Set<string>(this.protectedIds);
    for (const draft of this.draft.values()) {
      if (draft.k === "el") {
        ids.add(draft.id);
      }
    }
    for (const batch of this.batches) {
      if (batch.state === "queued") {
        batch.changes.forEach((change) => change.k === "el" && ids.add(change.id));
      }
    }
    return ids;
  }

  private isPending(key: string) {
    return (
      this.draft.has(key) ||
      this.batches.some((batch) => batch.state === "queued" && batch.changes.some((change) => keyOf(change.k, change.id) === key))
    );
  }

  /** the user's latest version of something: the draft, else the newest batch, else what the DO had */
  private viewOf(key: string) {
    const draft = this.draft.get(key);
    if (draft) {
      return draft.value;
    }
    // only unanswered batches: an answered one is in the DO's state (maybe changed by others since)
    for (let i = this.batches.length - 1; i >= 0; i--) {
      if (this.batches[i].state !== "queued") {
        continue;
      }
      const change = this.batches[i].changes.find((item) => keyOf(item.k, item.id) === key);
      if (change) {
        return change.value;
      }
    }
    return this.synced.get(key)?.el ?? null;
  }

  private canEdit() {
    return !this.viewOnly && this.role !== "read" && this.phase !== "closed" && this.phase !== "disabled" && !this.lifecycle && !this.editsStopped;
  }

  /** the scene is being handed over ("Keep only here"): nothing local is sent any more, messages still come */
  private editsStopped = false;

  stopEditing() {
    this.editsStopped = true;
  }

  resumeEditing() {
    this.editsStopped = false;
  }

  /**
   * The local copy changed (the canvas's onChange, or an agent's edit in
   * memory): what differs from what was accounted for goes into the draft.
   */
  collect() {
    // without any known state of the DO, changes are found by reconcile() after the handshake
    if (!this.canEdit() || this.phase === "idle" || !this.baseLoaded) {
      return;
    }
    const elements = this.surface.elements();
    const gesture = this.surface.gesture();
    const fixes: El[] = [];
    let skipped = 0;
    for (const raw of elements) {
      const seen = this.known.get(raw.id);
      if (seen && seen.v === raw.version && seen.n === raw.versionNonce) {
        continue;
      }
      let el = raw;
      this.known.set(el.id, stampOf(el));
      const before = this.lastCanvas.get(el.id);
      const keys = before ? changedKeys(before, el) ?? [] : [];
      if (this.undoing && before) {
        // undo / redo reverse only what still holds the user's value (each
        // step on its own: a value an undo brings back keeps its author)
        const step = this.authors.historyStep(el.id, before, el, keys);
        if (step.skipped.length) {
          el = { ...el, version: el.version + 1 };
          for (const key of step.skipped) {
            el[key] = before[key];
          }
          fixes.push(el);
          skipped += step.skipped.length;
        }
      } else if (!gesture.has(el.id)) {
        // a gesture's frames are no steps of their own: its end is (one history entry)
        for (const key of changedKeys(this.stepStart.get(el.id) ?? before, el) ?? []) {
          this.authors.set(el.id, key, el[key], "user");
        }
        this.stepStart.delete(el.id);
      } else if (!this.stepStart.has(el.id) && before) {
        this.stepStart.set(el.id, before);
      }
      this.lastCanvas.set(el.id, el);
      const view = this.viewOf(el.id);
      if (this.trace && el.isDeleted && !(view && sameState(view, el)) && !view) {
        this.trace.push(`collect-skip-deleted ${el.id.slice(0, 6)}`);
      }
      if ((view && sameState(view, el)) || (!view && el.isDeleted)) {
        continue; // a new stamp, same content (or made and removed before it was ever sent)
      }
      this.addDraft("el", el.id, el, {});
      this.draftAssets(el, true);
    }
    if (fixes.length) {
      this.surface.apply({ elements: fixes });
      for (const el of fixes) {
        this.known.set(el.id, stampOf(el));
      }
      this.note(`Undo left ${skipped === 1 ? "one change" : `${skipped} changes`} as they are: someone else changed ${skipped === 1 ? "it" : "them"} since.`);
    }
    this.undoing = false;
    const settings = this.surface.settings();
    const viewSettings = this.viewOf(SETTINGS_KEY);
    if (viewSettings && !sameJson(viewSettings, settings)) {
      this.addDraft("set", SETTINGS_ID, settings, {});
    }
    const gestureEnded = this.lastGesture.size > 0 && gesture.size === 0;
    const released = [...this.lastGesture].filter((id) => !gesture.has(id));
    this.lastGesture = gesture;
    if (released.length) {
      // changes of others to elements in the gesture waited; the user changed nothing there: theirs now
      const pending = this.pendingIds();
      const catchUp = released
        .filter((id) => !pending.has(id))
        .map((id) => [this.confirmed.get(id), this.surface.elements().find((el) => el.id === id)] as const)
        .filter(([theirs, shown]) => theirs && shown && (theirs.version !== shown.version || theirs.versionNonce !== shown.versionNonce))
        .map(([theirs]) => theirs!);
      for (const el of catchUp) {
        this.synced.set(el.id, { stamp: stampOf(el), el });
      }
      this.applyToSurface(catchUp);
    }
    if (this.draft.size) {
      this.changed();
      if (gestureEnded || this.agentMark) {
        this.flush();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          this.flush();
        }, BATCH_MS);
      }
    }
  }

  private addDraft(k: EventKind, id: string, value: any, { live, fontId }: { live?: boolean; fontId?: number }) {
    const key = keyOf(k, id);
    const made = live ?? this.connected;
    const previous = this.draft.get(key);
    const via = this.agentMark ? "agent" : "user";
    if (previous && previous.via !== via) {
      // an agent's change never shares a batch with the user's: the user's goes first
      this.draft.delete(key);
      this.enqueue([previous]);
    }
    this.draft.set(key, {
      k,
      id,
      value,
      live: (previous && previous.via === via ? previous.live : true) && made,
      via,
      ...(this.agentMark?.command ? { command: this.agentMark.command } : {}),
      ...(fontId !== undefined ? { fontId } : {}),
    });
  }

  /** an element's image and font: events of their own, sent before the element */
  private draftAssets(el: El, live: boolean) {
    if (el.isDeleted) {
      return;
    }
    if (el.fileId && !this.confirmedFiles.has(el.fileId) && !this.isPending(keyOf("file", el.fileId))) {
      const file = this.surface.files()[el.fileId];
      if (file?.dataURL) {
        this.addDraft("file", el.fileId, file, { live });
      }
    }
    if (isCustomFontId(el.fontFamily)) {
      // by its bytes: the scene may have another font under this number (then the DO gives this one another)
      const font = customFonts.get(el.fontFamily);
      if (font && !this.fontDrafting.has(font.id)) {
        this.fontDrafting.add(font.id);
        fontHash(font).then((hash) => {
          if (!this.confirmedFonts.has(hash) && !this.isPending(keyOf("font", hash))) {
            const { family, id, faces, source } = font;
            this.addDraft("font", hash, { family, id, faces, source }, { live, fontId: id });
            this.flush();
          }
        });
      }
    }
  }

  private fontDrafting = new Set<number>();

  private flushing: Promise<void> = Promise.resolve();

  /** the draft into batches: now (gesture end, agents) or after BATCH_MS; one flush at a time, in order */
  flush({ all = false } = {}) {
    const run = this.flushing.then(() => this.flushDraft(all));
    this.flushing = run.catch(() => {});
    return run;
  }

  private async flushDraft(all = false) {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (!this.draft.size) {
      return;
    }
    // held back: what is part of a gesture, and everything connected to it
    const gesture = all ? new Set<string>() : this.surface.gesture();
    const held = new Set<string>();
    if (gesture.size) {
      const ids = [...this.draft.values()].filter((draft) => draft.k === "el").map((draft) => draft.id);
      const members = groupIndex(this.surface.elements());
      const parts = components(ids, (id) => touchedBy(this.draft.get(id)?.value ?? { id, version: 0, versionNonce: 0 }, members));
      for (const part of parts) {
        if ([...part].some((id) => gesture.has(id))) {
          part.forEach((id) => held.add(id));
        }
      }
    }
    const ready = [...this.draft.entries()].filter(([, draft]) => draft.k !== "el" || !held.has(draft.id));
    if (!ready.length) {
      return;
    }
    ready.forEach(([key]) => this.draft.delete(key));
    const drafts = ready.map(([, draft]) => draft);
    // per author kind (user / agent command), assets first (uploaded before the elements that use them)
    const groups = new Map<string, Draft[]>();
    for (const draft of drafts) {
      const group = `${draft.via}:${draft.command ?? ""}`;
      groups.set(group, [...(groups.get(group) ?? []), draft]);
    }
    for (const group of groups.values()) {
      if (group[0].command) {
        // an agent's command: one batch (assets first in it), one IndexedDB write: a retry finds
        // the whole command or nothing of it, never half
        await this.enqueue([...group.filter((d) => d.k === "file" || d.k === "font"), ...group.filter((d) => d.k !== "file" && d.k !== "font")]);
        continue;
      }
      const assets = group.filter((draft) => draft.k === "file" || draft.k === "font");
      const rest = group.filter((draft) => draft.k !== "file" && draft.k !== "font");
      if (assets.length) {
        await this.enqueue(assets);
      }
      if (rest.length) {
        await this.enqueue(rest);
      }
    }
  }

  private async enqueue(drafts: Draft[]) {
    let counter: number;
    try {
      counter = await nextCounter(this.sub, this.fileId, this.tab!.tab);
    } catch {
      this.storageFailed = true;
      counter = Math.max(0, ...this.batches.map((batch) => batch.counter)) + 1;
    }
    const changes: QueuedChange[] = drafts.map((draft) => {
      const key = keyOf(draft.k, draft.id);
      const earlier = [...this.batches]
        .reverse()
        .find((batch) => batch.state === "queued" && batch.changes.some((change) => keyOf(change.k, change.id) === key));
      const from = this.viewOfBatches(key) ?? this.synced.get(key)?.el ?? null;
      return {
        k: draft.k,
        id: draft.id,
        value: draft.value,
        // a change on top of an own unanswered batch takes that batch's stamp once it is answered
        base: earlier ? null : this.synced.get(key)?.stamp ?? null,
        ...(earlier ? { after: earlier.counter } : {}),
        // what the user changed (elements and settings: a rebase keeps only these)
        keys: draft.k === "el" || draft.k === "set" ? changedKeys(from, draft.value) : null,
        ...(draft.fontId !== undefined ? { fontId: draft.fontId } : {}),
      };
    });
    const batch: QueuedBatch = {
      sub: this.sub,
      fileId: this.fileId,
      tab: this.tab!.tab,
      counter,
      made: Date.now(),
      live: drafts.every((draft) => draft.live),
      via: drafts[0].via,
      ...(drafts[0].command ? { command: drafts[0].command } : {}),
      changes,
      state: "queued",
      epoch: this.epoch,
    };
    this.batches.push(batch);
    await this.persist(batch);
    this.changed();
    this.pump();
  }

  private viewOfBatches(key: string) {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      if (this.batches[i].state !== "queued") {
        continue;
      }
      const change = this.batches[i].changes.find((item) => keyOf(item.k, item.id) === key);
      if (change) {
        return change.value;
      }
    }
    return null;
  }

  /** batches whose IndexedDB write has not committed yet */
  private unstored = new Set<number>();

  private async persist(batch: QueuedBatch) {
    this.unstored.add(batch.counter);
    try {
      await putBatch(batch);
      this.unstored.delete(batch.counter);
    } catch (error) {
      console.error("[live] a change could not be kept in this browser", error);
      if (!this.storageFailed) {
        this.storageFailed = true;
        this.note("This browser could not store your latest changes: export the scene to keep a copy.");
      }
    }
  }

  private async forget(batch: QueuedBatch) {
    this.trace?.push(`forget#${batch.counter} ${batch.state} [${batch.changes.map((c) => `${c.k}:${c.id.slice(0, 6)}`).join(",")}]`);
    this.batches = this.batches.filter((entry) => entry !== batch);
    await deleteBatch(batch).catch(() => {});
  }

  /** acked batches Drive has (per the receipts): done */
  private async dropSaved() {
    const receipt = this.receipts[this.tab?.tab ?? ""];
    for (const batch of [...this.batches]) {
      if (batch.state === "acked" && inReceipt(receipt, batch.counter)) {
        await this.forget(batch);
      }
    }
  }

  /** what touches an element or asset change (for "a batch waits for the one before it") */
  private touchedOf(batch: QueuedBatch) {
    const ids = new Set<string>();
    for (const change of batch.changes) {
      if (change.k === "el") {
        touchedBy(change.value).forEach((id) => ids.add(id));
      } else if (change.k === "font") {
        ids.add(`font:${change.fontId ?? change.id}`); // elements name a font by its number
      } else {
        ids.add(`${change.k}:${change.id}`);
      }
    }
    return ids;
  }

  /**
   * Send what can go now, in counter order: a batch waits while an earlier
   * one touching the same elements is unanswered (its stamps are its base).
   */
  private pump() {
    if (this.phase !== "ready" || !this.key || this.role !== "edit" || this.lifecycle) {
      return;
    }
    const busy = new Set<string>();
    for (const [counter] of this.inFlight) {
      const batch = this.batches.find((entry) => entry.counter === counter);
      if (batch) {
        this.touchedOf(batch).forEach((id) => busy.add(id));
      }
    }
    for (const batch of this.batches) {
      if (batch.state !== "queued" || this.inFlight.has(batch.counter) || this.parked.has(batch.counter)) {
        if (batch.state === "queued") {
          this.touchedOf(batch).forEach((id) => busy.add(id));
        }
        continue;
      }
      const touched = this.touchedOf(batch);
      if ([...touched].some((id) => busy.has(id))) {
        touched.forEach((id) => busy.add(id));
        continue;
      }
      touched.forEach((id) => busy.add(id));
      this.sendBatch(batch).catch((error) => {
        console.error("[live] a batch could not be sent", error);
        this.inFlight.delete(batch.counter);
      });
    }
  }

  /** the stamp a change is made on: its own, or the answer to the earlier batch of the same thing */
  private baseOf(batch: QueuedBatch, change: QueuedChange): Base | null {
    const key = keyOf(change.k, change.id);
    if (change.k === "file" || change.k === "font") {
      return null;
    }
    if (change.after === undefined) {
      return change.base;
    }
    // resolved when that batch was answered (onAck); else it is gone: the DO's state is the base
    const earlier = this.batches.find((entry) => entry.counter === change.after);
    return earlier?.stamps?.[key] ?? this.synced.get(key)?.stamp ?? change.base;
  }

  private async sendBatch(batch: QueuedBatch, extra: { losers?: WireEvent[] } = {}) {
    this.inFlight.set(batch.counter, { at: Date.now(), ids: new Set(batch.changes.map((change) => change.id)) });
    const events: WireEvent[] = [];
    for (const change of batch.changes) {
      events.push(
        await encodeEvent(this.key!, change.k, change.id, change.value, this.baseOf(batch, change), change.fontId !== undefined ? { fontId: change.fontId } : {}),
      );
    }
    if (!this.inFlight.has(batch.counter)) {
      return; // the connection went meanwhile
    }
    const sent = this.send({
      type: "batch",
      counter: batch.counter,
      live: batch.live,
      made: batch.made,
      via: batch.via,
      ...(batch.command ? { command: batch.command } : {}),
      ...(extra.losers?.length ? { losers: extra.losers } : {}),
      ...(this.skipped.length ? { skip: this.skipped } : {}),
      events,
    });
    if (sent) {
      this.skipped = [];
    } else {
      this.inFlight.delete(batch.counter);
    }
  }

  /** counters given up (moved into an offline copy): the next batch tells the DO, so receipts skip them */
  private skipped: number[] = [];

  /** refused for a reason that a resend can't fix right now (limit, role, key, …): until the next handshake */
  private parked = new Set<number>();

  private async onAck(ack: Extract<ServerMessage, { type: "ack" }>) {
    const batch = this.batches.find((entry) => entry.counter === ack.counter);
    this.inFlight.delete(ack.counter);
    this.rebases.delete(ack.counter);
    if (!batch) {
      return;
    }
    batch.state = "acked";
    batch.seq = ack.seq;
    batch.stamps = ack.stamps;
    const restamp: El[] = [];
    const canvas = new Map(this.surface.elements().map((el) => [el.id, el]));
    for (const change of batch.changes) {
      const key = keyOf(change.k, change.id);
      const stamp = ack.stamps[key];
      if (change.k === "el") {
        if (!stamp) {
          continue; // a duplicate the DO saved already: the catch-up state has it
        }
        const repaired = ack.repairs?.[key];
        const font = typeof change.value.fontFamily === "number" ? this.assignedFont(change.value.fontFamily, batch, ack.fontIds) : undefined;
        const stamped = {
          ...change.value,
          version: stamp.v,
          versionNonce: stamp.n,
          ...(repaired ? { index: repaired } : {}),
          ...(font !== undefined ? { fontFamily: font } : {}),
        };
        this.setConfirmed(change.id, stamped, "ack");
        this.traced(`ack${ack.seq}${ack.duplicate ? "dup" : ""}`, stamped);
        this.synced.set(key, { stamp, el: stamped });
        const shown = canvas.get(change.id);
        // re-stamped on the canvas only if it is still what was sent
        if (shown && shown.version === change.value.version && shown.versionNonce === change.value.versionNonce) {
          restamp.push({ ...shown, version: stamp.v, versionNonce: stamp.n, ...(repaired ? { index: repaired } : {}) });
        } else if (shown && repaired) {
          restamp.push({ ...shown, index: repaired });
        }
      } else if (change.k === "set") {
        this.confirmedSettings = { value: change.value, stamp: stamp ?? null };
        this.synced.set(key, { stamp: stamp ?? null, el: change.value });
      } else if (change.k === "name") {
        this.synced.set(key, { stamp: stamp ?? null, el: change.value });
      } else if (change.k === "file") {
        this.confirmedFiles.add(change.id);
      } else if (change.k === "font") {
        this.confirmedFonts.set(change.id, ack.fontIds?.[change.id] ?? change.value.id);
      }
    }
    if (restamp.length) {
      this.applyToSurface(restamp);
    }
    // later batches made on top of this one take its stamps as their base now
    for (const later of this.batches) {
      let touched = false;
      for (const change of later.changes) {
        if (change.after === batch.counter) {
          change.base = ack.stamps[keyOf(change.k, change.id)] ?? this.synced.get(keyOf(change.k, change.id))?.stamp ?? null;
          delete change.after;
          touched = true;
        }
      }
      if (touched) {
        await this.persist(later);
      }
    }
    if (ack.fontIds) {
      await this.remapFonts(batch, ack.fontIds);
    }
    this.seq = Math.max(this.seq, ack.seq);
    this.catchUp();
    await this.persist(batch);
    await this.dropSaved();
    this.persistBaseSoon();
    this.changed();
    this.pump();
  }

  /**
   * The DO gave a font another number (two fonts in the scene had the same
   * one): it is registered under that number (as "<family> <number>"), and
   * every element of this tab using the old number follows — on the canvas,
   * in the draft and in batches not sent yet. The DO already moved the
   * elements of the batch it answered.
   */
  private async remapFonts(batch: QueuedBatch, fontIds: Record<string, number>) {
    for (const change of batch.changes) {
      const assigned = fontIds[change.id];
      if (change.k !== "font" || assigned === undefined || assigned === change.value.id) {
        continue;
      }
      const from = change.value.id as number;
      await addFont({ ...change.value, id: assigned }).catch(() => {});
      this.fontRemap.set(from, assigned);
      // only this tab's own elements of that font: others' text with the old number is another font
      const own = new Set<string>([...this.pendingIds(), ...batch.changes.filter((item) => item.k === "el").map((item) => item.id)]);
      const move = (el: El) => (el && el.fontFamily === from ? { ...el, fontFamily: assigned } : el);
      for (const entry of this.batches) {
        if (entry.state !== "queued") {
          continue;
        }
        let touched = false;
        for (const item of entry.changes) {
          if (item.k === "el" && item.value.fontFamily === from) {
            item.value = move(item.value);
            touched = true;
          }
        }
        if (touched) {
          await this.persist(entry);
        }
      }
      for (const draft of this.draft.values()) {
        if (draft.k === "el") {
          draft.value = move(draft.value);
        }
      }
      for (const id of own) {
        const el = this.confirmed.get(id);
        if (el?.fontFamily === from) {
          this.setConfirmed(id, move(el), "font");
          this.synced.set(id, { stamp: stampOf(el), el: move(el) });
        }
      }
      const shown = this.surface.elements().filter((el) => el.fontFamily === from && !el.isDeleted && own.has(el.id));
      // on the canvas with the same stamp: the same content as the DO's (which already moved it)
      this.applyToSurface(shown.map(move));
    }
  }

  /** the number the DO uses for a font this batch's elements name (undefined: unchanged) */
  private assignedFont(id: number, batch: QueuedBatch, fontIds?: Record<string, number>) {
    for (const change of batch.changes) {
      if (change.k === "font" && change.value.id === id && fontIds?.[change.id] !== undefined && fontIds[change.id] !== id) {
        return fontIds[change.id];
      }
    }
    return undefined;
  }

  /** fonts whose number the DO changed in this scene (old -> new) */
  private fontRemap = new Map<number, number>();

  private async onRefused(refusal: Extract<ServerMessage, { type: "refused" }>) {
    const batch = this.batches.find((entry) => entry.counter === refusal.counter);
    if (!batch) {
      this.inFlight.delete(refusal.counter);
      return;
    }
    // stays "in flight" while it is settled, so nothing sends it meanwhile
    this.inFlight.set(batch.counter, { at: Date.now(), ids: new Set() });
    const reason: RefuseReason = refusal.reason;
    this.trace?.push(`refused#${batch.counter} ${reason} ${refusal.detail ?? ""} live=${batch.live} [${batch.changes.map((c) => `${c.k}:${c.id.slice(0, 6)}${c.value?.isDeleted ? "(del)" : ""}`).join(",")}] current=[${refusal.current.map((e) => e.id.slice(0, 6))}]`);
    if (reason === "token") {
      await this.renew();
      this.inFlight.delete(batch.counter);
      this.pump();
      return;
    }
    if (reason === "old" && refusal.detail === "not seeded") {
      this.inFlight.delete(batch.counter);
      this.dropConnection(); // the handshake seeds first
      return;
    }
    if (reason === "font-id") {
      // every font number of the scene is taken: kept here, not sent again (the banner says why)
      this.error = "font-full";
      this.inFlight.delete(batch.counter);
      this.parked.add(batch.counter);
      this.changed();
      return;
    }
    if (reason === "key" || reason === "role" || reason === "lifecycle" || reason === "limit") {
      // kept in this browser: nothing is cut off silently
      this.error =
        reason === "limit"
          ? `Too big to save at once${refusal.detail ? ` (${refusal.detail})` : ""}: split it up, or remove large pictures`
          : reason === "role"
          ? "You can only view this scene now: your changes stay in this browser"
          : reason === "key"
          ? "Waiting for the scene's key"
          : "This scene can't be changed now";
      if (reason === "role") {
        this.role = "read";
      }
      this.inFlight.delete(batch.counter);
      this.parked.add(batch.counter);
      this.changed();
      return;
    }
    const current = new Map<string, El>();
    /** event keys the DO named as newer than this batch's base */
    const colliding = new Set<string>();
    for (const event of refusal.current) {
      colliding.add(keyOf(event.k, event.id));
      if (event.k === "el") {
        const el = await this.decode(event, this.confirmed.get(event.id));
        if (el) {
          current.set(el.id, el);
          this.setConfirmed(el.id, el, "refused");
        }
      } else if (event.k === "set") {
        this.confirmedSettings = { value: settingsOf(await this.decode(event)), stamp: event.v ?? null };
        this.synced.set(SETTINGS_KEY, { stamp: event.v ?? null, el: this.confirmedSettings.value });
      } else if (event.k === "name") {
        this.synced.set(NAME_KEY, { stamp: event.v ?? null, el: await this.decode(event) });
      }
    }
    if (this.stale()) {
      return;
    }
    // a live batch is settled and sent again; refused again and again, it takes the offline way
    const tries = (this.rebases.get(batch.counter) ?? 0) + 1;
    this.rebases.set(batch.counter, tries);
    if ((reason === "collision" || reason === "reference") && batch.live && tries <= 3) {
      await this.rebaseLive(batch, current, reason, refusal.detail);
      return;
    }
    // elements the DO no longer knows (deleted and forgotten) collide too, and what a reference names
    unknownIds(refusal.detail).forEach((id) => colliding.add(id));
    const ref = referenceOf(refusal.detail);
    if (reason === "reference" && ref) {
      colliding.add(ref.id);
      if (!ref.target.startsWith("file:") && !ref.target.startsWith("font#")) {
        colliding.add(ref.target);
      }
    }
    this.debugCopy({ at: "refused", reason, detail: refusal.detail, counter: batch.counter, live: batch.live, tries, colliding: [...colliding].slice(0, 10) });
    // after offline (or discarded, invalid): nothing of it is applied, the whole local scene becomes a copy
    const copied = await this.makeOfflineCopy(
      reason === "discarded"
        ? "Changes another editor discarded"
        : reason === "old"
        ? "Changes kept in this browser were too old to send"
        : reason === "invalid"
        ? "Changes the server could not take"
        : "Changes made here while offline clashed with newer ones",
    );
    this.inFlight.delete(batch.counter);
    if (!copied) {
      // the queue and the canvas stay as they are (not sent again): the user can export the scene
      this.parked.add(batch.counter);
      batch.changes.forEach((change) => change.k === "el" && this.protectedIds.add(change.id));
      this.changed();
      return;
    }
    await this.dropColliding(batch, colliding, reason === "discarded" || reason === "invalid" || reason === "old");
  }

  /** refusals per batch (a batch refused again and again takes the offline way) */
  private rebases = new Map<number, number>();

  /** a live collision: the user's properties on top of the newer state, sent again (same counter) */
  private async rebaseLive(batch: QueuedBatch, current: Map<string, El>, reason: RefuseReason, detail?: string) {
    const losers: WireEvent[] = [];
    const ref = reason === "reference" ? referenceOf(detail) : null;
    if (ref && (ref.field === "fileId" || ref.field === "fontFamily")) {
      // the picture or font is missing on the server: it goes along in this very batch
      const el = batch.changes.find((change) => change.k === "el" && change.id === ref.id)?.value as El | undefined;
      if (el?.fileId && ref.field === "fileId" && !batch.changes.some((change) => change.k === "file" && change.id === el.fileId)) {
        const file = this.surface.files()[el.fileId];
        if (file) {
          this.confirmedFiles.delete(el.fileId);
          batch.changes.unshift({ k: "file", id: el.fileId, value: file, base: null, keys: null });
        }
      }
      if (el && ref.field === "fontFamily" && isCustomFontId(el.fontFamily)) {
        const font = customFonts.get(el.fontFamily);
        if (font) {
          const { family, id, faces, source } = font;
          const hash = await fontHash(font);
          this.confirmedFonts.delete(hash);
          if (!batch.changes.some((change) => change.k === "font" && change.id === hash)) {
            batch.changes.unshift({ k: "font", id: hash, value: { family, id, faces, source }, base: null, keys: null, fontId: id });
          }
        }
      }
    } else if (ref && !batch.changes.some((change) => change.k === "el" && change.id === ref.id)) {
      // someone's element still points at what this batch deletes: the pointer goes (part of the same action)
      const other = this.confirmed.get(ref.id);
      if (other && !other.isDeleted) {
        const fixed = withoutDanglingRefs(other, (id) => id !== ref.target);
        batch.changes.push({ k: "el", id: other.id, value: { ...fixed, version: other.version + 1 }, base: stampOf(other), keys: changedKeys(other, fixed) });
      }
    }
    // elements the DO no longer knows (deleted and forgotten) with a base: someone deleted them, they stay deleted
    const unknown = new Set(unknownIds(detail));
    if (unknown.size) {
      const gone: El[] = [];
      for (const change of batch.changes.filter((item) => item.k === "el" && unknown.has(item.id))) {
        const shown = this.surface.elements().find((el) => el.id === change.id);
        if (shown && !shown.isDeleted) {
          gone.push({ ...shown, isDeleted: true, version: shown.version + 1 });
        }
        this.synced.delete(change.id);
      }
      batch.changes = batch.changes.filter((item) => !(item.k === "el" && unknown.has(item.id)));
      this.applyToSurface(gone);
      if (gone.length) {
        this.note("Someone deleted what you were changing: it stays deleted.");
      }
      if (!batch.changes.length) {
        this.inFlight.delete(batch.counter);
        this.skipped.push(batch.counter);
        await this.forget(batch);
        this.changed();
        this.pump();
        return;
      }
    }
    // settings: the user's own settings on top of the current ones; name: the later change wins
    for (const change of batch.changes) {
      if (change.k === "set" || change.k === "name") {
        const now = this.synced.get(keyOf(change.k, change.id));
        change.base = now?.stamp ?? change.base;
        if (change.k === "set" && now?.el) {
          const before = change.value;
          const next = { ...now.el };
          for (const key of change.keys ?? Object.keys(change.value)) {
            next[key] = change.value[key];
          }
          change.value = next;
          change.keys = changedKeys(now.el, next);
          // later settings changes (batches, the draft) keep only their own keys on top of it; the
          // canvas shows the result, so nothing re-queues the old value
          let previous: Settings = before;
          let current: Settings = next;
          const later = [
            ...this.batches.filter((entry) => entry.counter > batch.counter && entry.state === "queued").flatMap((entry) => entry.changes.filter((item) => item.k === "set")),
            ...[...this.draft.values()].filter((draft) => draft.k === "set"),
          ];
          for (const step of later) {
            const own = changedKeys(previous, step.value) ?? [];
            const value = { ...current };
            own.forEach((key) => ((value as any)[key] = step.value[key]));
            previous = step.value;
            step.value = value;
            current = value;
          }
          if (!sameJson(this.surface.settings(), current)) {
            this.surface.apply({ settings: current });
          }
        }
        delete change.after;
      }
    }
    const exists = (id: string) => {
      const el = this.confirmed.get(id) ?? this.surface.elements().find((item) => item.id === id);
      return !!el && !el.isDeleted;
    };
    const restamp: El[] = [];
    for (const change of batch.changes) {
      if (change.k !== "el") {
        continue;
      }
      const theirs = current.get(change.id);
      let el = change.value as El;
      if (theirs) {
        const base = this.synced.get(change.id)?.el ?? null;
        const result = rebase(theirs, el, change.keys, base);
        el = result.el;
        if (result.overlaps.length) {
          // the same property on both sides: the later change (this one) wins, they may restore theirs
          losers.push(await encodeEvent(this.key!, "el", theirs.id, theirs, stampOf(theirs)));
        }
        change.base = stampOf(theirs);
        this.synced.set(change.id, { stamp: stampOf(theirs), el: theirs });
      }
      if (reason === "reference") {
        el = withoutDanglingRefs(el, exists);
      }
      // the user's later versions of it (later batches, the draft, the canvas) move along:
      // each keeps only the properties it changed, never the ones the rebase took over
      const before = change.value as El;
      const later = this.batches.filter((entry) => entry.counter > batch.counter && entry.state === "queued");
      const steps = later.flatMap((entry) => entry.changes.filter((item) => item.k === "el" && item.id === change.id));
      const draft = this.draft.get(change.id);
      const shown = this.surface.elements().find((item) => item.id === change.id);
      const lastLocal = (draft?.value ?? steps[steps.length - 1]?.value ?? before) as El;
      const showsLast = !!shown && shown.version === lastLocal.version && shown.versionNonce === lastLocal.versionNonce;
      const chain = reapplyChain(before, el, [...steps.map((step) => step.value as El), ...(draft ? [draft.value as El] : [])]);
      steps.forEach((step, i) => (step.value = chain[i]));
      if (draft) {
        draft.value = chain[chain.length - 1];
      }
      if (showsLast) {
        restamp.push(chain.length ? chain[chain.length - 1] : el); // the canvas shows the rebased result
      }
      change.value = el;
      change.keys = changedKeys(this.synced.get(change.id)?.el, el);
      for (const entry of later) {
        if (entry.changes.some((item) => item.k === "el" && item.id === change.id)) {
          await this.persist(entry);
        }
      }
    }
    // the batch builds on the DO's state now (its changes carry that base)
    batch.rebased = true;
    if (restamp.length) {
      this.applyToSurface(restamp);
    }
    await this.persist(batch);
    this.inFlight.delete(batch.counter);
    if (this.phase === "ready") {
      this.sendBatch(batch, { losers });
    }
  }

  /**
   * After an offline collision: only changes whose whole touching group has
   * no colliding element are sent again; the rest went into the copy and
   * the canvas takes the DO's state for them.
   */
  private async dropColliding(batch: QueuedBatch, collidingKeys: Set<string>, all: boolean) {
    // element ids are their own event keys; settings and name collide as themselves
    const colliding = new Set([...collidingKeys].filter((key) => !key.startsWith("set:") && !key.startsWith("name:")));
    const otherKeys = new Set([...collidingKeys].filter((key) => key.startsWith("set:") || key.startsWith("name:")));
    const unsent = this.batches.filter((entry) => entry.state === "queued");
    const changes = unsent.flatMap((entry) => entry.changes.filter((change) => change.k === "el"));
    const byId = new Map(changes.map((change) => [change.id, change.value as El]));
    const members = groupIndex(byId.values(), this.confirmed.values());
    const parts = components(byId.keys(), (id) => {
      const mine = byId.get(id)!;
      const theirs = this.confirmed.get(id);
      return new Set([...touchedBy(mine, members), ...(theirs ? touchedBy(theirs, members) : [])]);
    });
    const dropped = new Set<string>();
    for (const part of parts) {
      if (all || [...part].some((id) => colliding.has(id))) {
        part.forEach((id) => dropped.add(id));
      }
    }
    colliding.forEach((id) => dropped.add(id));
    const revert: El[] = [];
    for (const entry of unsent) {
      const kept = entry.changes.filter((change) =>
        change.k === "el" ? !dropped.has(change.id) : !(all && entry === batch) && !otherKeys.has(keyOf(change.k, change.id)),
      );
      if (kept.length === entry.changes.length && entry !== batch) {
        continue;
      }
      if (kept.length) {
        entry.changes = kept;
        await this.persist(entry);
      } else {
        this.skipped.push(entry.counter);
        await this.forget(entry);
      }
    }
    for (const id of dropped) {
      const theirs = this.confirmed.get(id);
      const shown = this.surface.elements().find((el) => el.id === id);
      if (theirs) {
        revert.push(theirs);
        this.synced.set(id, { stamp: stampOf(theirs), el: theirs });
      } else if (shown && !shown.isDeleted) {
        revert.push({ ...shown, isDeleted: true, version: shown.version + 1 });
      }
      this.draft.delete(id);
    }
    let settings: Settings | null = null;
    if (otherKeys.has(SETTINGS_KEY) && this.confirmedSettings) {
      settings = this.confirmedSettings.value;
      this.draft.delete(SETTINGS_KEY);
    }
    this.applyToSurface(revert, settings);
    this.changed();
    this.pump();
  }

  /**
   * The whole local scene (with images and fonts) as a new local-only scene;
   * once per episode. Resolves true only once the copy is stored (and read
   * back): only then may anything of the local version be replaced.
   */
  private makeOfflineCopy(why: string): Promise<boolean> {
    // the canvas with every change of the queue and the draft on top (the newer version wins: after
    // a crash the restored canvas can be older than what the queue already holds)
    const byId = new Map(this.surface.elements().map((el) => [el.id, el]));
    const files: Record<string, BinaryFileData> = { ...this.surface.files() };
    let settings = this.surface.settings();
    const take = (change: { k: EventKind; id: string; value: any }) => {
      if (change.k === "el") {
        const shown = byId.get(change.id);
        if (!shown || shown.version < change.value.version) {
          byId.set(change.id, change.value);
        }
      } else if (change.k === "file") {
        files[change.id] = change.value;
      } else if (change.k === "set" && !sameJson(change.value, settings)) {
        settings = { ...settings, ...change.value };
      }
    };
    this.batches.filter((batch) => batch.state === "queued").forEach((batch) => batch.changes.forEach(take));
    this.draft.forEach(take);
    const elements = [...byId.values()].filter((el) => !el.isDeleted);
    // complete or not at all: every picture and font the elements use must be in it
    const missingFile = elements.find((el) => el.fileId && el.type === "image" && !files[el.fileId]?.dataURL);
    const missingFont = elements.find((el) => isCustomFontId(el.fontFamily) && !customFonts.get(el.fontFamily));
    if (missingFile || missingFont) {
      this.failCopy(new Error(missingFile ? `picture of ${missingFile.id} missing` : `font ${missingFont!.fontFamily} missing`));
      return Promise.resolve(false);
    }
    const json = withFonts(serializeAsJSON(byIndex(elements) as any, settings as any, files as any, "local"), elements);
    // a copy covers exactly what it contains: the same content again needs no new one
    if (this.offlineCopy && this.offlineCopyJson === json) {
      return this.offlineCopy.then(
        () => true,
        () => false,
      );
    }
    this.offlineCopyJson = json;
    const copy = (async () => {
      const host = this.host();
      if (!host) {
        throw new Error("no host");
      }
      const name = await host.saveCopy(`${this.name} (offline changes)`, json);
      this.note(`${why}: the whole scene as you had it is kept as "${name}" (only in this browser).`);
      return name;
    })();
    this.offlineCopy = copy;
    copy.catch((error) => {
      if (this.offlineCopy === copy) {
        this.offlineCopy = null;
        this.offlineCopyJson = null;
      }
      this.failCopy(error);
    });
    return copy.then(
      () => true,
      () => false,
    );
  }

  private offlineCopyJson: string | null = null;

  private failCopy(error: unknown) {
    console.error("[live] the offline copy could not be stored", error);
    this.storageFailed = true;
    this.note("Your offline changes could not be kept as a copy: export the scene now (they stay on your canvas meanwhile).");
  }

  // ---------------------------------------------------------------------------
  // the confirmed state, kept for the next session
  // ---------------------------------------------------------------------------

  private baseTimer: ReturnType<typeof setTimeout> | null = null;

  private persistBaseSoon() {
    if (this.baseTimer || this.viewOnly) {
      return;
    }
    this.baseTimer = setTimeout(() => {
      this.baseTimer = null;
      const stored: StoredBase = {
        generation: this.generation,
        seq: this.seq,
        epoch: this.epoch,
        elements: [...this.confirmed.values()],
        settings: this.confirmedSettings,
        files: [...this.confirmedFiles],
        fonts: [...this.confirmedFonts],
        stamps: [...this.doStamps].filter(([id]) => this.confirmed.has(id)),
      };
      set([this.sub, this.fileId], stored, bases()).catch(() => {});
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------------------

  /** presence: the user is active (sent at most every 20 s) */
  activity() {
    if (Date.now() - this.presenceSentAt > 20_000 && this.connected) {
      this.presenceSentAt = Date.now();
      this.send({ type: "presence", activeAt: Date.now() });
    }
  }

  /** the scene's current state as this tab sees it (confirmed + its own pending changes) */
  sceneJson() {
    const elements = this.headless ? this.surface.elements() : this.surface.elements();
    const visible = elements.filter((el) => !el.isDeleted);
    return withFonts(serializeAsJSON(visible as any, { ...this.surface.settings(), name: this.name } as any, this.surface.files() as any, "local"), visible);
  }

  elements() {
    return this.surface.elements();
  }

  settings() {
    return this.surface.settings();
  }

  files() {
    return this.surface.files();
  }

  revision() {
    return this.snapshot().revision;
  }

  /**
   * The scene as this tab has it now, with its own pending changes, and an id
   * naming exactly this document ("live-<seq>-<hash>"): an agent's write
   * names it as its base, and is compared against exactly what it read.
   */
  snapshot() {
    const json = this.sceneJson();
    const visible = this.surface
      .elements()
      .filter((el) => !el.isDeleted)
      .map((el) => [el.id, el.version, el.versionNonce]);
    const revision = `live-${this.seq}-${(hashString(JSON.stringify([visible, this.surface.settings()])) >>> 0).toString(36)}`;
    return { revision, json };
  }

  /** this account's pseudonym in the scene (from the ticket) */
  pseudonym() {
    return this.ticket?.pseudonym ?? null;
  }

  /**
   * An agent's change: applied as its own step (on the canvas: undoable),
   * sent as a batch of its own marked via "agent" with the command id;
   * resolves once the DO has it.
   */
  async agentEdit(elements: El[], files: BinaryFileData[], command?: string, settings?: Settings | null) {
    if (!this.baseLoaded) {
      // without the DO's state nothing could be queued: wait for the handshake
      await this.ready();
    }
    if (!this.canEdit() || !this.baseLoaded) {
      throw new Error(this.role === "read" ? "This scene can only be viewed" : "This scene can't be changed now");
    }
    if (!command) {
      return this.applyAgentEdit(elements, files, undefined, settings);
    }
    // exactly once, also across tabs and reloads: one tab at a time per command; the
    // durably queued batches carrying the command id are its journal
    const run = async () => {
      const own = this.batches.filter((batch) => batch.command === command);
      if (own.length) {
        await this.waitForCommand(command);
        return this.revision();
      }
      const queued = await batchesOf(this.sub, this.fileId).catch(() => [] as QueuedBatch[]);
      if (queued.some((batch) => batch.command === command)) {
        // another tab of this browser applied it and sends it: done once the DO has it
        for (let i = 0; i < 40; i++) {
          const left = (await batchesOf(this.sub, this.fileId).catch(() => [] as QueuedBatch[])).filter(
            (batch) => batch.command === command && batch.state === "queued",
          );
          if (!left.length) {
            return this.revision();
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("The edit is kept in the user's browser (another tab sends it); the Kurviq server has not confirmed it yet");
      }
      const done = await commandRecord(this.sub, this.fileId, command).catch(() => undefined);
      if (done) {
        return done.revision ?? this.revision(); // applied and answered before (maybe in Drive by now)
      }
      return this.applyAgentEdit(elements, files, command, settings);
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks ? ((await locks.request(`kurviq-live-command:${this.fileId}:${command}`, run)) as unknown as string) : run();
  }

  private async applyAgentEdit(elements: El[], files: BinaryFileData[], command: string | undefined, settings?: Settings | null) {
    await this.flush();
    this.agentMark = { command };
    try {
      this.surface.edit({ elements, files, ...(settings ? { settings } : {}) });
      this.collect();
      await this.flush();
    } finally {
      this.agentMark = null;
    }
    if (this.storageFailed) {
      throw new Error("The edit could not be kept in the user's browser (storage failed): try again");
    }
    await this.waitForCommand(command);
    const revision = this.revision();
    if (command) {
      // answered: remembered past the queue (its batches go once Drive has them)
      await recordCommand(this.sub, this.fileId, command, { at: Date.now(), revision }).catch(() => {});
    }
    return revision;
  }

  /** an agent command's batches answered by the DO */
  private async waitForCommand(command: string | undefined) {
    const counters = this.batches.filter((batch) => batch.via === "agent" && batch.command === command && batch.state === "queued").map((batch) => batch.counter);
    await this.waitFor(
      () => counters.every((counter) => this.batches.find((batch) => batch.counter === counter)?.state !== "queued"),
      20_000,
      "The edit is kept in the user's browser, the Kurviq server has not confirmed it yet",
    ).catch((error) => {
      if (!this.connected) {
        throw new Error("Saved in the user's browser only: Kurviq's server is not reachable right now, it is sent once it is");
      }
      throw error;
    });
  }

  /** an agent wants to see the user's latest work: what is collected goes out now */
  async flushNow(timeout = 5000) {
    this.collect();
    await this.flush();
    await this.waitFor(() => !this.batches.some((batch) => batch.state === "queued"), timeout, "not answered").catch(() => {});
  }

  /** wait until the DO's state is here (headless sessions before reading) */
  ready(timeout = 15_000) {
    return this.waitFor(
      () => this.phase === "ready" || this.phase === "disabled",
      timeout,
      "Kurviq's server is not reachable: the scene can't be read live right now",
    );
  }

  /** a rename sent, not in Drive yet */
  private sentName: string | null = null;

  rename(to: string) {
    this.name = to;
    this.sentName = to;
    if (!this.canEdit()) {
      return;
    }
    this.addDraft("name", NAME_ID, { name: to }, {});
    this.flush();
  }

  /** restore the user's version after losing a live collision */
  async restoreLoser(id: string) {
    const loser = this.losers.find((entry) => entry.id === id);
    if (!loser) {
      return;
    }
    this.losers = this.losers.filter((entry) => entry !== loser);
    const mine = await this.decode(loser.event);
    const shown = this.surface.elements().find((el) => el.id === id);
    if (mine && shown) {
      this.surface.edit({ elements: [{ ...shown, ...mine, version: shown.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }] });
      this.collect();
    }
    this.changed();
  }

  dismissLoser(id: string) {
    this.losers = this.losers.filter((entry) => entry.id !== id);
    this.changed();
  }

  /** an editor's decision on an author whose changes can't be saved as theirs */
  decide(author: string, action: "accept" | "discard") {
    this.send({ type: "decide", author, action });
  }

  /** Kurviq's Delete: the DO stops saving first; the caller trashes the Drive file */
  /**
   * Kurviq's Delete, after the file went to Drive's trash: the DO is told (a hint, it checks Drive
   * itself) and stops saving; resolves once it says so, or after a while (Drive's trash decides)
   */
  async trash() {
    if (this.send({ type: "trash" })) {
      await this.waitFor(() => this.lifecycle === "trashed" || this.stopped, 10_000, "").catch(() => {});
    }
  }

  private keepLocalAnswer: ((answer: Extract<ServerMessage, { type: "keep-local" }>) => void) | null = null;

  /**
   * "Keep only here": the DO closes the scene and hands over its final
   * state; resolves with it (refused while others are connected or have
   * unsaved changes). The caller stores it, then calls keepLocalDone().
   */
  async keepLocal(): Promise<{ ok: true; json: string } | { ok: false; reason: string }> {
    await this.flushNow(10_000);
    if (!this.connected) {
      return { ok: false, reason: "offline" };
    }
    // only a scene whose every change is on the server: the final state must contain them all
    if (this.draft.size || this.batches.some((batch) => batch.state === "queued")) {
      return { ok: false, reason: "unsent" };
    }
    // nothing new from here on (the handover's final state is what this browser keeps)
    this.stopEditing();
    // the Worker checks with Drive that you own it and it is shared with nobody (the DO can't see sharing)
    try {
      await authPost(`/scene/${encodeURIComponent(this.fileId)}/keep-local`, {});
    } catch (error: any) {
      return { ok: false, reason: error?.code === "shared" ? "shared" : error?.offline ? "offline" : error?.code ?? "refused" };
    }
    const answer = await new Promise<Extract<ServerMessage, { type: "keep-local" }>>((resolve, reject) => {
      this.keepLocalAnswer = resolve;
      this.send({ type: "keep-local" });
      setTimeout(() => reject(new Error("The Kurviq server did not answer")), 30_000);
    }).finally(() => {
      this.keepLocalAnswer = null;
    });
    if (!answer.ok || !answer.state) {
      return { ok: false, reason: answer.reason ?? "refused" };
    }
    await this.loadState(answer.state);
    const elements = byIndex([...this.confirmed.values()].filter((el) => !el.isDeleted));
    const json = withFonts(
      serializeAsJSON(elements as any, { ...(this.confirmedSettings?.value ?? this.surface.settings()), name: this.name } as any, this.surface.files() as any, "local"),
      elements,
    );
    return { ok: true, json };
  }

  keepLocalDone() {
    this.send({ type: "keep-local-done" });
  }

  /** the scene left Drive (kept only here, or deleted): its queue and stored state go */
  async forgetAll() {
    for (const batch of [...this.batches]) {
      await this.forget(batch);
    }
    this.draft.clear();
    await forgetFile(this.sub, this.fileId).catch(() => {});
    this.changed();
  }

  /**
   * Stop after the draft is in the browser's queue (also a gesture's): an
   * account switch then resets the canvas without losing anything — the
   * queue stays the departing account's.
   */
  async shutdown(options: { resetToConfirmed?: boolean } = {}) {
    if (this.phase === "closed") {
      return;
    }
    if (this.baseLoaded) {
      this.collect();
      await this.flush({ all: true });
    }
    if (this.storageFailed && options.resetToConfirmed) {
      // not stored: the canvas keeps the edits (they are never sent as the other account)
      this.close();
      return;
    }
    this.close(options);
  }

  /** stop: the connection closes, the queue stays in the browser */
  close({ resetToConfirmed = false } = {}) {
    if (this.phase === "closed") {
      return;
    }
    if (resetToConfirmed) {
      // another account takes over this browser: the canvas shows only what the DO has
      const pending = this.pendingIds();
      const revert = [...pending].map((id) => {
        const theirs = this.confirmed.get(id);
        const shown = this.surface.elements().find((el) => el.id === id)!;
        return theirs ?? { ...shown, isDeleted: true, version: shown.version + 1 };
      });
      this.draft.clear();
      this.surface.apply({ elements: revert });
    }
    this.phase = "closed";
    for (const timer of [this.retryTimer, this.batchTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
    }
    if (this.baseTimer) {
      clearTimeout(this.baseTimer);
      this.baseTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.surface.destroy();
    this.channel?.postMessage({ type: "bye", tab: this.tab?.tab });
    this.channel?.close();
    window.removeEventListener("pagehide", this.sayBye);
    this.channel = null;
    this.tab?.release();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("closed"));
    }
    this.changed();
  }

  /** nothing unanswered or waiting: a headless session may close */
  idle() {
    return !this.draft.size && !this.batches.some((batch) => batch.state === "queued");
  }
}

// -----------------------------------------------------------------------------
// all live scenes of this tab
// -----------------------------------------------------------------------------

/** headless sessions close after this long without use (and nothing pending) */
const HEADLESS_IDLE_MS = 2 * 60_000;

class LiveSync {
  private host: LiveHost | null = null;
  private canvas: LiveScene | null = null;
  private headless = new Map<string, { scene: LiveScene; usedAt: number; starting: Promise<LiveScene> }>();
  private listeners = new Set<() => void>();
  /** file id -> stage of scenes not open (from the browser's queue) */
  private queued = new Map<string, LiveStage>();
  private account: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private version = 0;

  setHost(host: LiveHost) {
    this.host = host;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  private changed = () => {
    this.version++;
    this.listeners.forEach((listener) => listener());
    this.host?.changed();
  };

  /** the signed-in account (its sub; its email until the Worker sends the sub) */
  accountId() {
    const user = connection.getState().user;
    if (!user || !connection.getState().drive) {
      return null;
    }
    if (user.sub) {
      return user.sub;
    }
    try {
      const known = localStorage.getItem(`kurviq-live-sub:${user.email}`);
      if (known) {
        return known;
      }
    } catch {}
    return `email:${user.email}`;
  }

  /** the ticket named the account's id: queues keyed by its stand-in move over */
  async accountKnown(from: string, to: string) {
    const user = connection.getState().user;
    if (user) {
      try {
        localStorage.setItem(`kurviq-live-sub:${user.email}`, to);
      } catch {}
    }
    await moveAccount(from, to).catch(() => {});
    this.account = to;
  }

  /** start: follow sign-in, sign-out and account switches; send queues closed tabs left */
  start() {
    if (this.sweepTimer) {
      return;
    }
    connection.subscribe(() => this.followAccount());
    signOutListeners.add(() => this.signedOut());
    window.addEventListener("online", () => {
      this.canvas?.wake();
      this.headless.forEach(({ scene }) => scene.wake());
      this.replays.forEach((scene) => scene.wake());
    });
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.followAccount();
  }

  /**
   * A ticket named `sub` for this email: the email stood in for it (queues
   * move over) unless the email is known as another account already.
   */
  mayMoveTo(email: string, sub: string) {
    try {
      const known = localStorage.getItem(`kurviq-live-sub:${email}`);
      return !known || known === sub;
    } catch {
      return false;
    }
  }

  /** a ticket said the signed-in account changed (another tab switched it): follow it */
  accountSwitched() {
    this.account = null;
    this.followAccount(true);
  }

  private followAccount(force = false) {
    const account = this.accountId();
    if ((account === this.account && !force) || !account) {
      return;
    }
    const previous = this.account;
    const email = connection.getState().user?.email;
    // the email stood in for the account's id until the Worker named it: same person
    const same = !force && (!previous || previous === `email:${email}`);
    this.account = account;
    if (!same) {
      // another account: the old one's connections close first (its draft queued
      // as its own), the canvas shows only what the DO had
      this.closeAll({ resetToConfirmed: true }).then(() => this.host?.changed());
    }
    this.sweep();
  }

  private signedOut() {
    if (this.account) {
      // every scene of the account: edits made while signed out never reach it silently
      try {
        localStorage.setItem(`kurviq-live-signed-out:${this.account}`, JSON.stringify({ at: Date.now(), seen: [] }));
      } catch {}
    }
    this.closeAll({ resetToConfirmed: false });
    this.account = null;
  }

  /** the first open of a scene since a sign-out of this account (each scene once) */
  private signedOutBefore(account: string, fileId: string) {
    try {
      const raw = localStorage.getItem(`kurviq-live-signed-out:${account}`);
      if (!raw) {
        return false;
      }
      const mark = JSON.parse(raw) as { at: number; seen: string[] };
      return !!mark && !mark.seen?.includes(fileId);
    } catch {
      return false;
    }
  }

  /** a scene's edits made while signed out are separated (or there were none): its protection ends */
  signedOutHandled(account: string, fileId: string) {
    try {
      const raw = localStorage.getItem(`kurviq-live-signed-out:${account}`);
      const mark = raw ? (JSON.parse(raw) as { at: number; seen: string[] }) : null;
      if (mark && !mark.seen?.includes(fileId)) {
        mark.seen = [...(mark.seen ?? []), fileId].slice(-500);
        localStorage.setItem(`kurviq-live-signed-out:${account}`, JSON.stringify(mark));
      }
    } catch {}
  }

  private async closeAll(options: { resetToConfirmed: boolean }) {
    const scenes = [this.canvas, ...[...this.headless.values()].map((entry) => entry.scene), ...this.replays.values()];
    this.canvas = null;
    this.headless.clear();
    this.replays.clear();
    this.changed();
    await Promise.all(scenes.map((scene) => scene?.shutdown(scene === scenes[0] ? options : {}).catch(() => scene.close())));
  }

  /** closed tabs' queues, sent from here under their own tab ids (also of scenes open here) */
  private replays = new Map<string, LiveScene>();

  /** queues no open tab holds go out from this one; idle headless sessions close */
  private async sweep() {
    const account = this.account;
    if (!account) {
      return;
    }
    for (const [fileId, entry] of this.headless) {
      if (entry.scene.idle() && Date.now() - entry.usedAt > HEADLESS_IDLE_MS) {
        entry.scene.close();
        this.headless.delete(fileId);
      }
    }
    for (const [key, scene] of this.replays) {
      if (scene.idle() || scene.stopped) {
        scene.close();
        this.replays.delete(key);
      }
    }
    try {
      const orphans = await orphanQueues(account);
      for (const { fileId, tab } of orphans) {
        const key = `${fileId}#${tab}`;
        if (this.replays.has(key)) {
          continue;
        }
        const held = await holdTab(fileId, tab);
        if (!held) {
          continue;
        }
        // its own session (tab id), next to the scene's session here if it is open
        const scene = new LiveScene({ fileId, name: "", sub: account, surface: memorySurface(), headless: true, host: () => this.host, tab: held });
        scene.subscribe(this.changed);
        this.replays.set(key, scene);
        scene.start();
      }
      // stages of scenes not open
      const stages = new Map<string, LiveStage>();
      for (const batch of await batchesOf(account)) {
        const stage: LiveStage = batch.state === "queued" ? "browser" : "server";
        if (stages.get(batch.fileId) !== "browser") {
          stages.set(batch.fileId, stage);
        }
      }
      if (JSON.stringify([...stages]) !== JSON.stringify([...this.queued])) {
        this.queued = stages;
        this.changed();
      }
    } catch {}
  }

  private startHeadless(fileId: string, name: string, tab?: HeldTab) {
    const surface = memorySurface();
    const scene = new LiveScene({ fileId, name, sub: this.account!, surface, headless: true, host: () => this.host, ...(tab ? { tab } : {}) });
    scene.subscribe(this.changed);
    const starting = (async () => {
      await scene.start();
      return scene;
    })();
    // the headless copy follows the DO's state (apply writes into memory)
    this.headless.set(fileId, { scene, usedAt: Date.now(), starting });
    return starting;
  }

  /** the open scene is a Drive scene: connect it (the controller decides with `enabled` what syncs it) */
  attachCanvas(api: ExcalidrawImperativeAPI, fileId: string, name: string, driveBase: () => Promise<El[] | null>) {
    const account = this.account ?? this.accountId();
    if (!account) {
      return null;
    }
    this.account = account;
    if (this.canvas?.fileId === fileId && !this.canvas.stopped) {
      return this.canvas;
    }
    this.detachCanvas();
    const idle = this.headless.get(fileId);
    if (idle) {
      // its queue (tab id) is taken over by the canvas
      idle.scene.close();
      this.headless.delete(fileId);
    }
    const signedOutEdits = this.signedOutBefore(account, fileId);
    let scene: LiveScene | null = null;
    scene = new LiveScene({
      fileId,
      name,
      sub: account,
      surface: canvasSurface(api, () => scene),
      headless: false,
      host: () => this.host,
      driveBase,
      signedOutEdits,
    });
    scene.subscribe(this.changed);
    this.canvas = scene;
    scene.start();
    this.changed();
    return scene;
  }

  /** the shared-link viewer's read-only canvas: live while connected (null: not signed in) */
  private viewerScene: LiveScene | null = null;

  attachViewer(api: ExcalidrawImperativeAPI, fileId: string, name: string) {
    const account = this.account ?? this.accountId();
    if (!account) {
      return null;
    }
    this.detachViewer();
    let scene: LiveScene | null = null;
    scene = new LiveScene({ fileId, name, sub: account, surface: canvasSurface(api, () => scene), headless: false, host: () => this.host, viewOnly: true });
    scene.subscribe(this.changed);
    this.viewerScene = scene;
    scene.start();
    return scene;
  }

  detachViewer() {
    const scene = this.viewerScene;
    this.viewerScene = null;
    if (scene) {
      scene.detach();
      scene.close();
    }
  }

  /** the viewer shows the DO's state live right now (the shared link's polling may rest) */
  viewerLive(fileId: string) {
    return this.viewerScene?.fileId === fileId && this.viewerScene.connected;
  }

  detachCanvas() {
    if (this.canvas) {
      const scene = this.canvas;
      this.canvas = null;
      // the last edits before the canvas shows something else; nothing is applied to it any more
      scene.collect();
      scene.detach();
      scene.flush({ all: true }).finally(() => scene.close());
      this.changed();
    }
  }

  current() {
    return this.canvas;
  }

  /** the open scene's onChange */
  onCanvasChange() {
    this.canvas?.collect();
    this.canvas?.activity();
  }

  /** a live scene's session: the canvas if it is open, else a headless one (started on demand) */
  async session(fileId: string, name: string): Promise<LiveScene> {
    if (this.canvas?.fileId === fileId) {
      // ready, or at least with a known state of the DO (offline: changes queue)
      const canvas = this.canvas;
      await canvas.ready().catch((error) => {
        if (!canvas.hasBase) {
          throw error;
        }
      });
      if (canvas.enabled === false) {
        throw Object.assign(new Error("not live"), { notLive: true });
      }
      return canvas;
    }
    if (!this.account) {
      throw new Error("Not signed in with Google: the scene can't be reached live");
    }
    const entry = this.headless.get(fileId);
    const scene = entry ? await entry.starting : await this.startHeadless(fileId, name);
    const current = this.headless.get(fileId);
    if (current) {
      current.usedAt = Date.now();
    }
    scene.name ||= name;
    await scene.ready();
    if (scene.enabled === false) {
      throw Object.assign(new Error("not live"), { notLive: true });
    }
    return scene;
  }

  /** the stage of a scene for the scene list */
  stageOf(fileId: string | undefined): LiveStage | null {
    if (!fileId) {
      return null;
    }
    if (this.canvas?.fileId === fileId) {
      return this.canvas.stage();
    }
    const headless = this.headless.get(fileId)?.scene;
    if (headless) {
      return headless.stage();
    }
    return this.queued.get(fileId) ?? null;
  }

  info(fileId: string | undefined): LiveInfo | null {
    if (!fileId) {
      return null;
    }
    if (this.canvas?.fileId === fileId) {
      return this.canvas.info();
    }
    return this.headless.get(fileId)?.scene.info() ?? null;
  }
}

export const liveSync = new LiveSync();

/** decidable after DECIDE_AFTER_MS: shown to editors (the DO says when) */
export const DECIDE_AFTER_HOURS = DECIDE_AFTER_MS / 3600_000;

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // dev and fake-Google builds (local QA): the engine's state in the console
  (window as any).__live = liveSync;
}
