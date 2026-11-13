// The live session of a database scene (docs/homes/CONCEPT.md, "Adding the
// database home", 2): while a database scene is open, everyone on it sees
// each other's strokes within a second, their pointers (name, color) and
// selections.
//
// - Changes: the canvas's changed elements are written as rows every
//   ~150 ms (each taken if it is newer: ./changes.ts, ./schema.sql) and, by
//   editors, broadcast on the scene's private realtime channel at the same
//   time, so others see them before the database confirms. The database
//   announces every write on the channel ("changed", its revision): the
//   others fetch the rows changed since the revision they have. Late
//   joiners load the rows, then follow the channel.
// - Pointers, selections, names: broadcast (editors) and presence; nothing
//   is written to tables.
// - Offline (or a paused database): the changes wait here (the canvas and
//   its stored copy keep them) and are written when the database answers;
//   per element the newer version wins.
// - The person's role on the scene (row-level security decides) is checked
//   when joining and every 30 s: viewers see it read only, commenters may
//   only comment; when access ends, the session stops.

import { CaptureUpdateAction, reconcileElements, restoreElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";

import { commentsOf, mergeComments } from "../../../../scenes-mcp/sceneComments.mjs";
import { TAB_ID } from "../../api";
import { commentStore } from "../../comments/store";
import { scenesController } from "../../controller";
import { registerSceneFonts, withFonts } from "../../fonts";
import { presentationOf, serializeAsJSON } from "../../presentation";

import { accessOf, canEdit, changedComments, colorOf, deletedVersion, localChanges, remoteWinners, settingsKey, stamp, vanished } from "./changes";
import { clientFor, connectionOf, databaseHome, databases } from "./connections";
import { PAUSED_MESSAGE } from "./rows";
import { splitScene } from "./sceneJson";

import type { HomeError, HomeLive } from "../types";
import type { DatabaseHome } from "./home";
import type { Role } from "./rows";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

/** changes are written (and broadcast) at most this often */
const FLUSH_MS = 150;
/** pointers at most this often (about 20 per second) */
const POINTER_MS = 50;
/** viewers' and commenters' pointers go through presence: less often */
const PRESENCE_POINTER_MS = 250;
/** the role is checked again, and missed changes fetched, this often */
const CHECK_MS = 30_000;
/** a failed write is tried again after this long (doubling up to a minute) */
const RETRY_MS = 3_000;
/** a milestone (a version in the history) at most this often while someone edits */
const MILESTONE_MS = 10 * 60_000;

type Peer = { name: string; color: string; x?: number; y?: number; selected?: string[] };

class Session {
  private alive = true;
  private sceneId: string | null = null;
  private role: Role | null = null;
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  /** id → the stamp (version:nonce) the database has */
  private readonly known = new Map<string, string>();
  /** id → the element as the database has it (to write a deleted version of one that vanished here) */
  private readonly knownData = new Map<string, Record<string, any>>();
  private readonly deletedThere = new Set<string>();
  private readonly knownComments = new Map<string, number>();
  private readonly uploaded = new Set<string>();
  private knownSettings = "";
  private lastRev = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MS;
  private flushing: Promise<void> | null = null;
  private again = false;
  private applying = false;
  private readonly peers = new Map<string, Peer>();
  private lastPointerAt = 0;
  private lastSelection = "";
  private wroteSince = false;
  private lastMilestoneAt = Date.now();
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly api: ExcalidrawImperativeAPI,
    readonly name: string,
    readonly ref: string,
    private readonly home: DatabaseHome,
  ) {
    this.start().catch((error) => this.problem(error));
  }

  private get me() {
    return databases.session(this.ref).email ?? "";
  }

  private open() {
    return this.alive && scenesController.getState().current === this.name;
  }

  private problem(error: unknown) {
    const homeError = error as HomeError;
    if (homeError?.offline) {
      scenesController.setHomePending(this.name, true);
      return;
    }
    if (homeError?.status === 403 || homeError?.status === 401) {
      void this.checkRole();
      return;
    }
    console.error("[database] live session:", error);
  }

  private async start() {
    const db = scenesController.databaseOf(this.name);
    if (!db) {
      return;
    }
    this.sceneId = db.id ?? null;
    if (!this.sceneId) {
      this.sceneId = await scenesController.ensureInDatabase(this.name);
    }
    if (!this.open()) {
      return;
    }
    await this.checkRole();
    if (!this.open() || this.role === null) {
      return;
    }
    await this.catchUp(true);
    this.listen();
    await this.join();
    this.schedule(); // changes made here while away
  }

  /** the role on the scene (and the canvas's lock): at the start and every CHECK_MS */
  private async checkRole() {
    if (!this.sceneId) {
      return;
    }
    let role: Role | null;
    try {
      role = await this.home.roleOn(this.sceneId);
    } catch (error) {
      if ((error as HomeError).offline) {
        return; // keeps what it had
      }
      throw error;
    }
    const scene = role ? null : await this.home.sceneById(this.sceneId).catch(() => null);
    this.role = role;
    scenesController.setHomeAccess(accessOf(role, scene?.public === "view"));
    if (!role && !scene) {
      this.stopChannel(); // the access ended: nothing more is heard or sent
    }
  }

  // ---------------------------------------------------------------------------
  // the database's rows into the canvas
  // ---------------------------------------------------------------------------

  /** rows changed since the last revision seen (all at the start) */
  private async catchUp(all = false) {
    const id = this.sceneId;
    if (!id) {
      return;
    }
    const since = all ? undefined : this.lastRev;
    const [elements, meta, comments] = await Promise.all([this.home.rows.elements(id, since), this.home.rows.meta(id), this.home.rows.comments(id, since)]);
    if (!this.open()) {
      return;
    }
    for (const row of [...elements, ...comments]) {
      this.lastRev = Math.max(this.lastRev, row.rev ?? 0);
    }
    this.applyElements(elements.map((row) => row.data));
    if (meta) {
      this.lastRev = Math.max(this.lastRev, meta.rev);
      await this.applyMeta(meta.envelope, Object.keys(meta.files));
    }
    this.applyComments(comments.map((row) => row.data));
    scenesController.setHomePending(this.name, this.hasPending());
  }

  private applyElements(remote: Record<string, any>[]) {
    if (!remote.length) {
      return;
    }
    for (const element of remote) {
      this.known.set(element.id, stamp(element as any));
      this.knownData.set(element.id, element);
      if (element.isDeleted) {
        this.deletedThere.add(element.id);
      } else {
        this.deletedThere.delete(element.id);
      }
    }
    const canvas = this.api.getSceneElementsIncludingDeleted();
    const winners = remoteWinners(remote as any[], new Map(canvas.map((element) => [element.id, element])));
    if (!winners.length) {
      return;
    }
    const restored = restoreElements(winners as any, null);
    const merged = reconcileElements(canvas as any, restored as any, this.api.getAppState());
    this.applying = true;
    try {
      this.api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    } finally {
      this.applying = false;
    }
    void this.fetchPictures(winners);
  }

  /** pictures of these elements this canvas doesn't have yet */
  private async fetchPictures(elements: readonly Record<string, any>[]) {
    const files = this.api.getFiles();
    const missing = [...new Set(elements.map((element) => element.fileId).filter((id) => typeof id === "string" && !files[id]))] as string[];
    for (const fileId of missing) {
      const picture = await this.home.files!.get(this.sceneId!, fileId).catch(() => null); // NOSONAR S9382: one at a time on purpose (pictures can be large)
      if (picture && this.open()) {
        this.uploaded.add(fileId);
        this.api.addFiles([{ id: fileId as any, mimeType: picture.mimeType as any, dataURL: picture.dataURL as any, created: Date.now() }]);
      }
    }
  }

  private async applyMeta(envelope: string, fileIds: string[]) {
    fileIds.forEach((fileId) => this.uploaded.add(fileId));
    let data: Record<string, any>;
    try {
      data = JSON.parse(envelope);
    } catch {
      return;
    }
    const appState = data.appState ?? {};
    const key = settingsKey(appState, data.kurviqFonts);
    if (key === this.knownSettings || key === this.settingsHere().key) {
      this.knownSettings = key;
      return;
    }
    this.knownSettings = key;
    await registerSceneFonts(data).catch(() => {});
    const patch: Record<string, unknown> = {};
    for (const field of ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "kurviqPresentation", "kurviqPresentationAt"]) {
      if (field in appState) {
        patch[field] = appState[field];
      }
    }
    this.applying = true;
    try {
      this.api.updateScene({ appState: patch as any, captureUpdate: CaptureUpdateAction.NEVER });
    } finally {
      this.applying = false;
    }
  }

  private applyComments(remote: Record<string, any>[]) {
    if (!remote.length) {
      return;
    }
    for (const comment of commentsOf(remote)) {
      this.knownComments.set(comment.id, Math.max(this.knownComments.get(comment.id) ?? -1, comment.u));
    }
    commentStore.fromLive(mergeComments(commentStore.editorList(), remote));
  }

  // ---------------------------------------------------------------------------
  // the canvas's changes into the database
  // ---------------------------------------------------------------------------

  /** the scene settings of the canvas (background, grid, presentation, fonts) and the envelope that carries them */
  private settingsHere() {
    const elements = this.api.getSceneElements();
    const appState = this.api.getAppState();
    const json = withFonts(serializeAsJSON([], { ...appState, kurviqPresentation: presentationOf({ elements, appState }) } as any, {}, "local"), elements);
    const envelope = splitScene(json).envelope;
    const data = JSON.parse(json);
    return { envelope, key: settingsKey(data.appState ?? {}, data.kurviqFonts) };
  }

  private changedHere(): Record<string, any>[] {
    const elements = this.api.getSceneElementsIncludingDeleted() as unknown as Record<string, any>[];
    const changed = localChanges(elements as any[], this.known) as unknown as Record<string, any>[];
    const gone = vanished(elements as any[], this.known, this.deletedThere).map((id) => deletedVersion(this.knownData.get(id) ?? { id, version: 1 }));
    return [...changed, ...gone];
  }

  private hasPending() {
    if (!canEdit(this.role)) {
      return false;
    }
    return this.changedHere().length > 0 || changedComments(commentStore.editorList(), this.knownComments).length > 0;
  }

  private readonly onChange = () => {
    if (this.applying || !this.open()) {
      return;
    }
    this.sendSelection();
    this.schedule();
  };

  private schedule(delay = FLUSH_MS) {
    if (this.flushTimer || !this.alive) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  /** one write at a time; a change meanwhile: once more after it */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.write()
      .then(() => {
        this.retryMs = RETRY_MS;
      })
      .catch((error) => {
        this.problem(error);
        this.schedule(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 60_000);
      })
      .finally(() => {
        this.flushing = null;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      });
    return this.flushing;
  }

  private async write() {
    const id = this.sceneId;
    if (!id || !this.open() || !this.role) {
      return;
    }
    if (canEdit(this.role)) {
      await this.writeElements(id);
      await this.writeSettings(id);
    }
    if (this.role !== "viewer") {
      await this.writeComments(id);
    }
    scenesController.setHomePending(this.name, this.hasPending(), this.lastRev);
  }

  private async writeElements(id: string) {
    const changed = this.changedHere();
    if (!changed.length) {
      return;
    }
    await this.uploadPictures(id, changed);
    if (this.subscribed) {
      this.channel?.send({ type: "broadcast", event: "els", payload: { tab: TAB_ID, elements: changed } }).catch(() => {});
    }
    scenesController.setHomePending(this.name, true);
    const revision = await this.home.rows.putElements(id, changed);
    for (const element of changed) {
      this.known.set(element.id, stamp(element as any));
      this.knownData.set(element.id, element);
      if (element.isDeleted) {
        this.deletedThere.add(element.id);
      }
    }
    this.wroteSince = true;
    this.lastRev = Math.max(this.lastRev, revision);
  }

  private async uploadPictures(id: string, elements: readonly Record<string, any>[]) {
    const files = this.api.getFiles();
    const index: Record<string, { mimeType: string; created?: number }> = {};
    for (const fileId of new Set(elements.map((element) => element.fileId))) {
      const file = typeof fileId === "string" ? files[fileId] : undefined;
      if (file && !this.uploaded.has(fileId)) {
        await this.home.rows.putFile(id, fileId, file.dataURL, file.mimeType); // NOSONAR S9382: one at a time on purpose (pictures can be large)
        this.uploaded.add(fileId);
        index[fileId] = { mimeType: file.mimeType, created: file.created };
      }
    }
    if (Object.keys(index).length) {
      await this.home.rows.putMeta(id, null, index);
    }
  }

  private async writeSettings(id: string) {
    const here = this.settingsHere();
    if (here.key === this.knownSettings) {
      return;
    }
    const revision = await this.home.rows.putMeta(id, here.envelope, {});
    this.knownSettings = here.key;
    this.lastRev = Math.max(this.lastRev, revision);
  }

  private async writeComments(id: string) {
    const changed = changedComments(commentStore.editorList(), this.knownComments);
    if (!changed.length) {
      return;
    }
    try {
      await this.home.rows.putComments(id, changed);
      commentStore.setProblem(null);
    } catch (error: any) {
      if (error?.code === "42501" || error?.status === 403) {
        commentStore.setProblem(error.message ?? "Not allowed");
        changed.forEach((comment) => this.knownComments.set(comment.id, comment.u)); // refused: not tried again
        return;
      }
      throw error;
    }
    changed.forEach((comment) => this.knownComments.set(comment.id, comment.u));
    this.wroteSince = true;
  }

  // ---------------------------------------------------------------------------
  // the channel: changes, the database's announcements, pointers, presence
  // ---------------------------------------------------------------------------

  private listen() {
    this.cleanups.push(this.api.onChange(this.onChange));
    this.cleanups.push(commentStore.subscribe(this.onChange));
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("online", this.onOnline);
    this.cleanups.push(() => {
      window.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("online", this.onOnline);
    });
    const check = setInterval(() => {
      void this.checkRole().catch(() => {});
      void this.catchUp().catch((error) => this.problem(error));
      if (this.wroteSince && Date.now() - this.lastMilestoneAt > MILESTONE_MS) {
        void this.milestone();
      }
    }, CHECK_MS);
    this.cleanups.push(() => clearInterval(check));
  }

  private readonly onOnline = () => {
    void this.catchUp().catch((error) => this.problem(error));
    void this.flush();
  };

  private async join() {
    const client = await clientFor(this.ref);
    await client.realtime.setAuth();
    if (!this.open()) {
      return;
    }
    const channel = client.channel(`kurviq:${this.sceneId}`, { config: { private: true, broadcast: { self: false }, presence: { key: TAB_ID } } });
    channel
      .on("broadcast", { event: "els" }, ({ payload }) => {
        if (payload?.tab !== TAB_ID && Array.isArray(payload?.elements) && this.open()) {
          this.applyElements(payload.elements);
        }
      })
      .on("broadcast", { event: "changed" }, () => this.catchUpSoon())
      .on("broadcast", { event: "scene" }, ({ payload }) => this.onSceneChanged(payload))
      .on("broadcast", { event: "pointer" }, ({ payload }) => this.onPeer(payload?.tab, payload))
      .on("presence", { event: "sync" }, () => this.onPresence(channel))
      .subscribe((status) => {
        this.subscribed = status === "SUBSCRIBED";
        if (this.subscribed) {
          void channel.track(this.presence()).catch(() => {});
          void this.catchUp().catch((error) => this.problem(error)); // what happened while (re)connecting
          void this.flush();
        }
      });
    this.channel = channel;
  }

  private catchUpSoon() {
    if (this.catchUpTimer) {
      return;
    }
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      void this.catchUp().catch((error) => this.problem(error));
    }, 120);
  }

  /** renamed, made public, deleted or moved in the database */
  private onSceneChanged(payload: Record<string, any> | undefined) {
    if (payload?.deleted || payload?.moved) {
      void scenesController.refreshDatabases();
      return;
    }
    if (typeof payload?.name === "string" && payload.name !== this.name) {
      void scenesController.refreshDatabases();
    }
  }

  private presence(extra: Partial<Peer> = {}) {
    const email = this.me;
    return { name: email.split("@")[0] || "Someone", color: colorOf(email || TAB_ID), ...extra };
  }

  private onPresence(channel: RealtimeChannel) {
    const state = channel.presenceState() as Record<string, Peer[]>;
    for (const tab of [...this.peers.keys()]) {
      if (!state[tab]) {
        this.peers.delete(tab);
      }
    }
    for (const [tab, metas] of Object.entries(state)) {
      if (tab !== TAB_ID && metas[0]) {
        this.onPeer(tab, metas[0], false);
      }
    }
    this.showPeers();
  }

  private onPeer(tab: unknown, payload: Partial<Peer> | undefined, show = true) {
    if (typeof tab !== "string" || tab === TAB_ID || !payload) {
      return;
    }
    const before = this.peers.get(tab) ?? { name: "Someone", color: colorOf(tab) };
    this.peers.set(tab, {
      ...before,
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.color === "string" ? { color: payload.color } : {}),
      ...(Number.isFinite(payload.x) && Number.isFinite(payload.y) ? { x: payload.x, y: payload.y } : {}),
      ...(Array.isArray(payload.selected) ? { selected: payload.selected.slice(0, 200) } : {}),
    });
    if (show) {
      this.showPeers();
    }
  }

  private showPeers() {
    if (!this.open()) {
      return;
    }
    const collaborators = new Map<any, any>();
    for (const [tab, peer] of this.peers) {
      collaborators.set(tab, {
        id: tab,
        socketId: tab,
        username: peer.name,
        color: { background: peer.color, stroke: peer.color },
        ...(peer.x === undefined ? {} : { pointer: { x: peer.x, y: peer.y, tool: "pointer" } }),
        selectedElementIds: Object.fromEntries((peer.selected ?? []).map((id) => [id, true])),
      });
    }
    this.api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private selectedIds() {
    return Object.keys(this.api.getAppState().selectedElementIds ?? {}).slice(0, 200);
  }

  private send(extra: Partial<Peer>) {
    if (!this.subscribed || !this.channel) {
      return;
    }
    if (canEdit(this.role)) {
      this.channel.send({ type: "broadcast", event: "pointer", payload: { tab: TAB_ID, ...this.presence(extra) } }).catch(() => {});
    } else {
      void this.channel.track(this.presence(extra)).catch(() => {});
    }
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const now = Date.now();
    if (!this.open() || now - this.lastPointerAt < (canEdit(this.role) ? POINTER_MS : PRESENCE_POINTER_MS)) {
      return;
    }
    this.lastPointerAt = now;
    const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, this.api.getAppState());
    this.send({ x: Math.round(x), y: Math.round(y), selected: this.selectedIds() });
  };

  private sendSelection() {
    const selected = this.selectedIds();
    const key = selected.join(",");
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.send({ selected });
    }
  }

  // ---------------------------------------------------------------------------

  /** a version kept in the history (an editor's, while editing and when leaving) */
  private async milestone() {
    const id = this.sceneId;
    if (!id || !canEdit(this.role) || !this.wroteSince) {
      return;
    }
    this.wroteSince = false;
    this.lastMilestoneAt = Date.now();
    await this.home.rows.addVersion(id, this.lastRev, scenesController.currentSceneJson()).catch(() => {});
  }

  private stopChannel() {
    const channel = this.channel;
    this.channel = null;
    this.subscribed = false;
    if (channel) {
      void channel.unsubscribe().catch(() => {});
    }
  }

  /** the scene is left: what waits is written (best effort), the channel and the others' pointers go */
  leave() {
    if (!this.alive) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const last = this.open() ? this.write().then(() => this.milestone()) : Promise.resolve();
    this.alive = false;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
    }
    void last.catch(() => {}).finally(() => this.stopChannel());
    this.peers.clear();
    this.api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER });
    scenesController.setHomeAccess(null);
  }
}

/** follows the editor's open scene: a session while it is a database scene this browser is signed in to */
class DatabaseLive implements HomeLive {
  private api: ExcalidrawImperativeAPI | null = null;
  private session: Session | null = null;
  private key: string | null = null;

  attach(api: ExcalidrawImperativeAPI) {
    if (this.api === api) {
      return;
    }
    this.api = api;
    scenesController.subscribe(() => this.follow());
    databases.subscribe(() => this.follow());
    this.follow();
  }

  private follow() {
    const api = this.api;
    const name = scenesController.getState().current;
    const db = scenesController.databaseOf(name);
    const status = db ? databases.session(db.ref).status : null;
    const key = api && db && name && connectionOf(db.ref) ? `${db.ref}|${name}|${status}` : null;
    if (key === this.key) {
      return;
    }
    this.key = key;
    this.session?.leave();
    this.session = null;
    if (!key || !api || !db || !name) {
      return;
    }
    if (status !== "signed-in") {
      void clientFor(db.ref).catch(() => {}); // its sign-in state, then follow() again
      scenesController.setHomeAccess({
        readOnly: status === "unknown" ? "Connecting to the database…" : `Sign in to ${databaseHome(db.ref).label} to work on this scene`,
        comment: false,
      });
      return;
    }
    const problem = databases.session(db.ref).problem;
    if (problem === PAUSED_MESSAGE) {
      scenesController.setHomeAccess({ readOnly: PAUSED_MESSAGE, comment: false });
    }
    this.session = new Session(api, name, db.ref, databaseHome(db.ref));
  }

  /** what waits to be written, now (an agent reads the scene, the tab is hidden) */
  flush() {
    return this.session?.flush() ?? Promise.resolve();
  }
}

export const databaseLive = new DatabaseLive();
