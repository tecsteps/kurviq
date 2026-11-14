// The pen: one editor at a time on a Drive scene (docs/relay/CONCEPT.md).
//
// The open Drive scene's tab joins the scene's relay (online/worker/relay.ts,
// memory only) with a short-lived ticket. The relay decides who holds the
// pen; this module does the rest in the tab:
//
//   - the holder edits as usual and saves through the controller's normal
//     Drive sync; its changes (elements, images, settings, comments) and its
//     pointer go to the others through the relay, encrypted with the scene's
//     key (./sceneKey.ts), and a newcomer gets what isn't saved yet
//     (catch-up). It saves before handing the pen over or stopping.
//   - everyone else sees the scene read only, follows the holder's changes
//     live and Drive's saves, and may ask for the pen ("Ask to edit"), take
//     it over when the holder is idle or gone, or take it when it is free.
//   - a tab that can't reach the relay goes by the mark on the Drive file
//     (appProperties.kurviqPen, renewed every minute by whoever edits):
//     someone else's fresh mark makes the scene read only, a stale or no
//     mark lets this tab edit (and set the mark).
//   - edits made without the pen (offline) are merged into Drive with the
//     controller's element-by-element merge before this tab turns read only.
//
// Agents edit only through the holder's tab (penRefusal); commenters' tabs
// send comment operations to the holder (sendCommenterOps / onCommenterOps).

import { CaptureUpdateAction, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";

import { scenesController } from "../controller";
import { commentStore } from "../comments/store";
import { authPost, connection, readPenMark, relaySocketUrl, writePenMark } from "./drive";
import { importSceneKey, openPayload, sealPayload } from "./sceneKey";
import type { SceneKey } from "./sceneKey";
import {
  Assembler,
  MARK_RENEW_MS,
  connectionDead,
  dropSocket,
  editingRefusal,
  markHolder,
  markText,
  parseMark,
  rememberSent,
  socketGone,
  splitBody,
  unsentElements,
  withIncoming,
} from "./penSync";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type PenHolder = { name: string; color: string };

export type PenState = {
  /** who holds the pen (null: nobody) */
  holder: PenHolder | null;
  /** what this tab is on the open scene */
  me: "holder" | "viewer" | "commenter" | "none";
  relay: "connected" | "offline";
};

export type CommenterAuthor = { name: string; email?: string; key: string };
export type CommenterOpsResult = "applied" | { refused: string };
export type CommenterOpsHandler = (ops: unknown[], author: CommenterAuthor) => Promise<CommenterOpsResult>;

type Role = "edit" | "comment" | "read";
type Person = { id: string; name: string; color: string; role: Role };
type Holder = PenHolder & { id: string; who: string };

/** what the pen bar shows (./penUI.tsx) */
export type PenView = PenState & {
  role: Role | null;
  /** the holder was idle 5 minutes (others may take over) */
  idle: boolean;
  /** the holder's tab: who asks for the pen */
  askers: Person[];
  /** this tab asked and waits for the answer */
  asked: boolean;
  /** "Take over" is offered (the holder is idle, or it is this account's other tab) */
  canTakeOver: boolean;
  /** how many others have the scene open */
  others: number;
  /** the relay is not reachable: the mark on the Drive file decides */
  byMark: boolean;
  /** a short note for the user (dismissable) */
  notice: string | null;
  /** saving before a handover, stop or take-over */
  busy: boolean;
};

/** this tab, in the mark on the Drive file */
const TAB = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`).replaceAll("-", "").slice(0, 16);
const PING_MS = 25_000;
const TICK_MS = 5_000;
const WELCOME_WITHIN_MS = 15_000;
const MARK_CHECK_MS = 30_000;
const SEND_DELAY_MS = 60;
const POINTER_MS = 50;
const ACTIVE_MS = 30_000;
const OPS_ANSWER_MS = 15_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SETTINGS_KEYS = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "kurviqPresentation", "kurviqPresentationAt"] as const;

class Session {
  ws: WebSocket | null = null;
  /** this tab's id at the relay */
  id: string | null = null;
  role: Role | null = null;
  self: { name: string; color: string; who: string } | null = null;
  key: SceneKey | null = null;
  holder: Holder | null = null;
  idle = false;
  people: Person[] = [];
  asking: string[] = [];
  relay: "connecting" | "connected" | "offline" = "connecting";
  /** someone else's fresh mark on the Drive file (the relay is not reachable) */
  markHolder: string | null = null;
  markCheckedAt = 0;
  markWrittenAt = 0;
  /** the first state after joining (or after a reconnect of the holder): take the pen if it is free */
  claimOnState = true;
  asked = false;
  failures = 0;
  /** a ticket or socket is on its way (./pen.ts connect) */
  connecting = false;
  closed = false;
  /** no ticket for this file (no access, signed out): nothing to do until this time */
  dormantUntil = 0;
  /** what this tab was when its role was last applied */
  lastMe: PenState["me"] = "none";
  /** this tab's user changed the canvas while it could edit (saved before it turns read only) */
  ownEdits = false;
  lastMessageAt = 0;
  lastPingAt = 0;
  bufferedBefore = 0;
  welcomeBy = 0;
  /** what the viewers have of this tab's canvas (the holder's) */
  readonly sent = new Map<string, string>();
  readonly sentFiles = new Set<string>();
  sentSettings = "";
  sentComments = "";
  readonly assembler = new Assembler();
  /** a commenter's sent operations waiting for the holder's answer */
  readonly waiting = new Map<string, { done: (result: "sent" | "no-editor" | Error) => void; timer: number }>();
  /** incoming messages, one at a time (decrypting is asynchronous) */
  inbox: Promise<unknown> = Promise.resolve();
  /** outgoing payloads in order */
  outbox: Promise<unknown> = Promise.resolve();
  retryTimer = 0;
  sendTimer = 0;

  constructor(
    readonly fileId: string,
    public scene: string,
  ) {}

  holderIsMe() {
    return !!this.holder && this.holder.id === this.id;
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** what this tab is on the scene */
const meOf = (s: Session | null, readOnly: boolean): PenState["me"] => {
  if (!s || s.dormantUntil) {
    return "none";
  }
  if (s.role === "comment") {
    return "commenter";
  }
  if (s.relay === "connected") {
    return s.holderIsMe() ? "holder" : "viewer";
  }
  // the relay is not reachable: the mark decides (who may edit is Drive's word)
  if (s.role === "read" || readOnly || s.markHolder) {
    return "viewer";
  }
  return s.relay === "offline" ? "holder" : "none";
};

/** the session goes on for this target: the same file, and not put to sleep a while ago */
const keepsSession = (s: Session, target: { fileId: string }) =>
  s.fileId === target.fileId && (!s.dormantUntil || Date.now() < s.dormantUntil);

class Pen {
  private api: ExcalidrawImperativeAPI | null = null;
  session: Session | null = null;
  private readonly listeners = new Set<() => void>();
  private view: PenView = { holder: null, me: "none", relay: "offline", role: null, idle: false, askers: [], asked: false, canTakeOver: false, others: 0, byMark: false, notice: null, busy: false };
  private commenterHandler: CommenterOpsHandler | null = null;
  /** the view mode was switched on by the pen (and is switched off again by it) */
  private lockedView = false;
  private notice: string | null = null;
  private busy = false;
  private started = false;
  private apiUnsubscribe: (() => void) | null = null;
  private lastPointerAt = 0;
  private lastActiveAt = 0;
  private reqCounter = 0;
  /** the account whose old live sync scenes were asked to drain in this page */
  private drained: string | null = null;
  private following = false;

  // ---------------------------------------------------------------------------
  // attaching to the editor and following the open scene
  // ---------------------------------------------------------------------------

  attach(api: ExcalidrawImperativeAPI) {
    if (this.api === api) {
      return;
    }
    this.apiUnsubscribe?.();
    this.api = api;
    this.apiUnsubscribe = api.onChange(() => this.onCanvasChange());
    if (!this.started) {
      this.started = true;
      scenesController.subscribe(() => this.follow());
      connection.subscribe(() => this.follow());
      scenesController.penHooks = {
        saved: (name, md5, hash) => this.onSaved(name, md5, hash),
        pulled: (name) => this.onPulled(name),
      };
      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      window.addEventListener("offline", this.onOffline);
      window.addEventListener("online", this.onOnline);
      for (const type of ["pointerdown", "keydown"]) {
        window.addEventListener(type, this.onActivity, { capture: true, passive: true });
      }
      window.setInterval(() => this.tick(), TICK_MS);
    }
    this.follow();
  }

  /** the open scene's Drive file, while signed in (null: no relay for it) */
  private target() {
    const { current } = scenesController.getState();
    if (!this.api || current === null || scenesController.isLocalOnly(current) || !connection.isActive()) {
      return null;
    }
    const fileId = scenesController.fileIdOf(current);
    return fileId ? { fileId, scene: current } : null;
  }

  private follow() {
    if (this.following) {
      return; // leaving a scene changes the controller's state, which calls this again
    }
    this.following = true;
    try {
      this.drainOnce();
      this.switchTo(this.target());
    } finally {
      this.following = false;
    }
    this.publish();
  }

  private switchTo(target: { fileId: string; scene: string } | null) {
    const s = this.session;
    if (s && target && keepsSession(s, target)) {
      s.scene = target.scene; // renamed: the same file
      return;
    }
    if (s) {
      this.leave(s);
    }
    if (target) {
      this.session = new Session(target.fileId, target.scene);
      void this.connect(this.session);
    }
  }

  /**
   * The retired live sync: once per account (and again while something is
   * kept), the account's old scene objects save what they still hold to
   * Drive and delete everything (online/worker/scene.ts)
   */
  private drainOnce() {
    const email = connection.getState().user?.email;
    if (!email || !connection.isActive() || this.drained === email) {
      return;
    }
    this.drained = email;
    const key = `kurviq-live-drained:${email}`;
    try {
      if (localStorage.getItem(key)) {
        return;
      }
    } catch {}
    authPost("/live/drain", {})
      .then((answer: { results?: { state: string }[] }) => {
        if ((answer.results ?? []).every((result) => result.state !== "kept")) {
          try {
            localStorage.setItem(key, new Date().toISOString());
          } catch {}
        }
      })
      .catch(() => {
        this.drained = null; // tried again on the next change
      });
  }

  private leave(s: Session) {
    s.closed = true;
    clearTimeout(s.retryTimer);
    clearTimeout(s.sendTimer);
    if (s.holderIsMe()) {
      this.sendRaw(s, { t: "release" });
    }
    if (s.markWrittenAt) {
      void this.clearOwnMark(s);
    }
    s.waiting.forEach(({ done, timer }) => {
      clearTimeout(timer);
      done("no-editor");
    });
    s.ws?.close(1000, "left");
    this.session = null;
    this.setPointer(null);
    this.unlockView();
    scenesController.setPenLock(null);
  }

  // ---------------------------------------------------------------------------
  // the relay connection
  // ---------------------------------------------------------------------------

  /** one connection attempt at a time (a retry and the network coming back may meet) */
  private async connect(s: Session) {
    if (s.connecting) {
      return;
    }
    s.connecting = true;
    try {
      await this.openSocket(s);
    } finally {
      s.connecting = false;
    }
  }

  private async openSocket(s: Session) {
    let ticket: any;
    try {
      ticket = await authPost(`/relay/${encodeURIComponent(s.fileId)}/ticket`, {});
    } catch (error: any) {
      if (this.session === s && !s.closed) {
        await this.connectFailed(s, error);
      }
      return;
    }
    if (this.session !== s || s.closed) {
      return;
    }
    await this.takeTicket(s, ticket);
    let ws: WebSocket;
    try {
      ws = new WebSocket(relaySocketUrl(s.fileId, ticket.ticket));
    } catch {
      await this.offline(s);
      return;
    }
    s.ws = ws;
    s.lastMessageAt = Date.now();
    s.welcomeBy = Date.now() + WELCOME_WITHIN_MS;
    ws.onmessage = (event) => {
      s.inbox = s.inbox.then(() => this.receive(s, event.data)).catch((error) => console.error("[pen] message failed", error));
    };
    ws.onclose = () => this.socketClosed(s, ws);
    ws.onerror = () => this.drop(s, ws);
  }

  /** this tab gives up on the socket: offline at once, not when (or if) the close handshake ends */
  private drop(s: Session, ws: WebSocket) {
    if (s.ws === ws) {
      dropSocket(ws, () => this.socketClosed(s, ws));
    }
  }

  /** the browser lost the network: the relay socket is dead, the mark decides (and the next try waits for the network) */
  private readonly onOffline = () => {
    const s = this.session;
    if (s?.ws && !s.closed) {
      this.drop(s, s.ws);
    }
  };

  /** the network is back: the relay is tried again now, not after the retry's wait */
  private readonly onOnline = () => {
    const s = this.session;
    if (s && !s.ws && !s.closed && s.relay === "offline") {
      clearTimeout(s.retryTimer);
      s.retryTimer = window.setTimeout(() => {
        if (this.session === s && !s.closed && !s.ws) {
          void this.connect(s);
        }
      }, 0);
    }
  };

  private async takeTicket(s: Session, ticket: any) {
    s.role = ticket.role;
    s.self = { name: ticket.name, color: ticket.color, who: ticket.who };
    if (ticket.key && ticket.keyId && ticket.keyId !== s.key?.keyId) {
      s.key = await importSceneKey(ticket.key, ticket.keyId, s.fileId);
    }
  }

  /** no ticket: signed out or no access (nothing to do here), or the relay is not reachable (the mark decides) */
  private async connectFailed(s: Session, error: any) {
    if (error?.status === 401 || error?.status === 403) {
      // asked again a minute later at the earliest (a sign-in, or the Picker, may change it)
      s.dormantUntil = Date.now() + 60_000;
      this.publish();
      return;
    }
    await this.offline(s);
  }

  private socketClosed(s: Session, ws: WebSocket) {
    if (s.ws !== ws) {
      return;
    }
    s.ws = null;
    const wasHolder = s.holderIsMe();
    s.id = null;
    s.holder = null;
    s.people = [];
    s.asking = [];
    s.asked = false;
    this.setPointer(null);
    if (s.closed) {
      return;
    }
    // the holder takes the pen again when it is back (if it is still free)
    s.claimOnState = wasHolder || meOf(s, this.readOnly()) === "holder";
    void this.offline(s);
  }

  /** the relay is not reachable: the mark decides, and it is tried again (1 s … 30 s) */
  private async offline(s: Session) {
    s.relay = "offline";
    s.failures++;
    clearTimeout(s.retryTimer);
    s.retryTimer = window.setTimeout(() => {
      if (this.session === s && !s.closed) {
        void this.connect(s);
      }
    }, RETRY_MS[Math.min(s.failures - 1, RETRY_MS.length - 1)]);
    await this.checkMark(s);
  }

  private readOnly() {
    return !!scenesController.getState().sync.readOnly;
  }

  private sendRaw(s: Session, msg: Record<string, unknown>) {
    if (s.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** an encrypted payload (in parts if big), after those sent before it */
  private sendPayload(s: Session, kind: string, value: unknown, extra: { to?: string; req?: string } = {}) {
    const run = async () => {
      if (!s.key) {
        return;
      }
      const parts = splitBody(await sealPayload(s.key, kind, value));
      const req = extra.req ?? (parts.length > 1 ? this.nextReq() : undefined);
      parts.forEach((body, part) =>
        this.sendRaw(s, { t: "send", kind, body, ...(extra.to ? { to: extra.to } : {}), ...(req ? { req } : {}), ...(parts.length > 1 ? { part, parts: parts.length } : {}) }),
      );
    };
    s.outbox = s.outbox.then(run).catch((error) => console.error("[pen] sending failed", error));
    return s.outbox;
  }

  private nextReq() {
    this.reqCounter++;
    return `${TAB}-${this.reqCounter}`;
  }

  private async receive(s: Session, raw: unknown) {
    if (this.session !== s || typeof raw !== "string") {
      return;
    }
    const msg = JSON.parse(raw);
    s.lastMessageAt = Date.now();
    switch (msg.t) {
      case "welcome":
        s.id = msg.you;
        s.relay = "connected";
        s.failures = 0;
        s.markHolder = null;
        break;
      case "state":
        await this.onState(s, msg);
        break;
      case "declined":
        s.asked = false;
        this.note(`${msg.by} keeps editing for now`);
        break;
      case "granted":
        this.note(`${msg.from} handed the pen to you: you can edit now`);
        break;
      case "taken":
        this.note(`${msg.by} took over editing`);
        break;
      case "refused":
        this.onRefused(s, msg);
        break;
      case "no-editor":
        this.answerWaiting(s, msg.req, "no-editor");
        break;
      case "msg":
        await this.onMessage(s, msg);
        break;
      default:
        break;
    }
    this.publish();
  }

  private onRefused(s: Session, msg: any) {
    if (msg.action === "claim") {
      // someone else was quicker (the relay decides): read only here
      void this.applyRole(s);
    }
    if (msg.action === "ask" || msg.action === "takeover" || msg.action === "claim") {
      s.asked = false;
      this.note(msg.why === "not-idle" ? "You can take over once the editor has been idle for 5 minutes" : "Someone else is editing now");
    }
  }

  // ---------------------------------------------------------------------------
  // who holds the pen
  // ---------------------------------------------------------------------------

  private async onState(s: Session, msg: any) {
    const before = s.holder?.id ?? null;
    s.holder = msg.holder;
    s.idle = !!msg.idle;
    s.people = Array.isArray(msg.people) ? msg.people : [];
    s.asking = Array.isArray(msg.asking) ? msg.asking : [];
    if (s.holderIsMe()) {
      s.asked = false;
    }
    if (s.claimOnState) {
      s.claimOnState = false;
      if (!s.holder && s.role === "edit" && !this.readOnly()) {
        this.sendRaw(s, { t: "claim" }); // whoever opens the scene first edits it
        return;
      }
    }
    const holderId = s.holder?.id ?? null;
    if (holderId !== before) {
      this.setPointer(null);
      if (s.holder && !s.holderIsMe()) {
        this.askCatchUp(s);
      }
    }
    await this.applyRole(s);
  }

  /** what this tab is now, applied: editable and sending, or read only and following */
  private async applyRole(s: Session) {
    const before = s.lastMe;
    const me = meOf(s, this.readOnly());
    s.lastMe = me;
    if (me === "holder") {
      this.becomeHolder(s, before);
    } else if (me !== "none") {
      await this.becomeViewer(s, before);
    }
  }

  private becomeHolder(s: Session, before: PenState["me"]) {
    this.unlockView();
    scenesController.setPenLock(null);
    if (s.relay !== "connected") {
      s.claimOnState = true; // editing by the mark: back at the relay, this tab takes the pen if it is free
    }
    if (before !== "holder") {
      // the others have this canvas (catch-up, or the handover): only what changes from now on goes out
      this.rememberCanvas(s);
      this.lastActiveAt = Date.now();
      void this.renewMark(s, true);
      void this.ensureKey(s);
    }
  }

  private async becomeViewer(s: Session, before: PenState["me"]) {
    this.lockView();
    // edits made here without the pen (offline, the relay unreachable, or before this page) go into Drive
    // first: nothing is lost. A viewer's canvas also differs from Drive by the holder's unsaved changes:
    // those are the holder's to save, never this tab's
    const own = before === "none" || (before === "holder" && s.ownEdits);
    if (own && s.role !== "read" && s.role !== "comment" && scenesController.getState().dirty) {
      await scenesController.penFlushOwn().catch((error) => this.note(`Your changes could not be saved yet: ${error.message}`));
    }
    s.ownEdits = false;
    if (s.markWrittenAt && s.markHolder === null) {
      s.markWrittenAt = 0;
      void this.clearOwnMark(s);
    }
    const holder = s.holder?.name ?? s.markHolder ?? "";
    scenesController.setPenLock(holder);
  }

  /** the holder's tab without the scene's key yet: it makes one (only the holder does, so never two) */
  private async ensureKey(s: Session) {
    if (s.key) {
      return;
    }
    try {
      await this.takeTicket(s, await authPost(`/relay/${encodeURIComponent(s.fileId)}/ticket`, { createKey: true }));
    } catch {
      return;
    }
    if (s.key && this.session === s) {
      this.sendRaw(s, { t: "send", kind: "key", body: "ready" });
      this.scheduleSend(s);
    }
  }

  /** a viewer: the scene's key came (the holder made it), read with a fresh ticket */
  private async fetchKey(s: Session) {
    try {
      await this.takeTicket(s, await authPost(`/relay/${encodeURIComponent(s.fileId)}/ticket`, {}));
    } catch {
      return;
    }
    if (s.key) {
      this.askCatchUp(s);
    }
  }

  private askCatchUp(s: Session) {
    if (s.key) {
      void this.sendPayload(s, "catchup-req", {});
    }
  }

  // ---------------------------------------------------------------------------
  // the mark on the Drive file
  // ---------------------------------------------------------------------------

  /** the relay is not reachable: someone else's fresh mark makes this tab read only */
  private async checkMark(s: Session) {
    s.markCheckedAt = Date.now();
    try {
      const { mark } = await readPenMark(s.fileId);
      s.markHolder = markHolder(parseMark(mark), TAB, Date.now());
    } catch {
      // Drive not reachable either: as it was (a tab that edits goes on, its edits are merged later)
    }
    if (this.session !== s || s.relay === "connected") {
      return;
    }
    await this.applyRole(s);
    this.publish();
  }

  /** whoever edits renews the mark every minute (metadata only: no new Drive version) */
  private async renewMark(s: Session, now = false) {
    if (!now && Date.now() - s.markWrittenAt < MARK_RENEW_MS) {
      return;
    }
    s.markWrittenAt = Date.now();
    const name = s.self?.name ?? connection.getState().user?.name ?? connection.getState().user?.email?.split("@")[0] ?? "Someone";
    await writePenMark(s.fileId, markText({ n: name, t: Date.now(), i: TAB })).catch(() => {});
  }

  /** this tab's mark goes (not the next holder's, written meanwhile) */
  private async clearOwnMark(s: Session) {
    try {
      if (parseMark((await readPenMark(s.fileId)).mark)?.i === TAB) {
        await writePenMark(s.fileId, null);
      }
    } catch {
      // stale after 2 minutes anyway
    }
  }

  private tick() {
    const s = this.session;
    if (!s || s.closed) {
      return;
    }
    const now = Date.now();
    s.assembler.sweep(now);
    if (s.ws && (socketGone(s.ws.readyState) || (s.relay !== "connected" && now > s.welcomeBy))) {
      this.drop(s, s.ws); // closing (its handshake may hang), or no welcome: the socket is over
    }
    if (s.ws && s.relay === "connected") {
      this.keepAlive(s, now);
    }
    if (s.relay === "offline" && now - s.markCheckedAt >= MARK_CHECK_MS) {
      void this.checkMark(s);
    }
    if (meOf(s, this.readOnly()) === "holder") {
      void this.renewMark(s);
    }
  }

  /** ping / pong both ways; a connection that neither answers nor drains is closed (and opened again) */
  private keepAlive(s: Session, now: number) {
    const ws = s.ws!;
    if (connectionDead(now, s.lastMessageAt, ws.bufferedAmount, s.bufferedBefore)) {
      this.drop(s, ws);
      return;
    }
    s.bufferedBefore = ws.bufferedAmount;
    if (now - s.lastPingAt >= PING_MS) {
      s.lastPingAt = now;
      this.sendRaw(s, { t: "ping" });
    }
  }

  // ---------------------------------------------------------------------------
  // the holder's changes
  // ---------------------------------------------------------------------------

  private settingsOf() {
    const appState = this.api!.getAppState() as any;
    return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, appState[key] ?? null]));
  }

  private rememberCanvas(s: Session) {
    const api = this.api;
    if (!api) {
      return;
    }
    s.sent.clear();
    rememberSent(s.sent, api.getSceneElementsIncludingDeleted() as any);
    Object.keys(api.getFiles()).forEach((id) => s.sentFiles.add(id));
    s.sentSettings = JSON.stringify(this.settingsOf());
    s.sentComments = commentStore.editorKey();
  }

  private onCanvasChange() {
    const s = this.session;
    if (!s) {
      return;
    }
    if (this.lockedView && this.api && !this.api.getAppState().viewModeEnabled) {
      queueMicrotask(() => this.lockView(true)); // read only while someone else holds the pen
    }
    if (s.holderIsMe()) {
      this.scheduleSend(s);
    }
    if (s.lastMe === "holder") {
      s.ownEdits = true;
    }
  }

  private scheduleSend(s: Session) {
    if (!s.sendTimer) {
      s.sendTimer = window.setTimeout(() => {
        s.sendTimer = 0;
        this.sendChanges(s);
      }, SEND_DELAY_MS);
    }
  }

  /** what changed on the holder's canvas since the last send */
  private changes(s: Session) {
    const api = this.api!;
    const els = unsentElements(api.getSceneElementsIncludingDeleted() as any, s.sent);
    const allFiles = api.getFiles();
    const files = els.flatMap((el: any) => (el.fileId && !s.sentFiles.has(el.fileId) && allFiles[el.fileId]?.dataURL ? [allFiles[el.fileId]] : []));
    const settings = this.settingsOf();
    const settingsKey = JSON.stringify(settings);
    const commentsKey = commentStore.editorKey();
    return { els, files, settings: settingsKey === s.sentSettings ? null : settings, settingsKey, comments: commentsKey === s.sentComments ? null : commentStore.editorList(), commentsKey };
  }

  private sendChanges(s: Session) {
    if (this.session !== s || !s.holderIsMe() || !this.api || !s.key) {
      return;
    }
    const change = this.changes(s);
    rememberSent(s.sent, change.els);
    change.files.forEach((file: any) => s.sentFiles.add(file.id));
    s.sentSettings = change.settingsKey;
    s.sentComments = change.commentsKey;
    const nothing = !change.els.length && !change.files.length && !change.settings && !change.comments;
    if (nothing || s.people.length < 2) {
      return; // alone: nothing to send (a newcomer asks for everything)
    }
    void this.sendPayload(s, "change", {
      els: change.els,
      ...(change.files.length ? { files: change.files } : {}),
      ...(change.settings ? { set: change.settings } : {}),
      ...(change.comments ? { cmts: change.comments } : {}),
    });
  }

  /** a newcomer (or a viewer that lost track) asked: the whole canvas, and the version it is based on in Drive */
  private sendCatchUp(s: Session, to: string) {
    const api = this.api;
    if (!api || !s.holderIsMe()) {
      return;
    }
    const els = api.getSceneElementsIncludingDeleted();
    const all = api.getFiles();
    const files = [...new Set(els.flatMap((el: any) => (!el.isDeleted && el.fileId ? [el.fileId] : [])))].flatMap((id) => (all[id]?.dataURL ? [all[id]] : []));
    void this.sendPayload(s, "catchup", { els, files, set: this.settingsOf(), cmts: commentStore.editorList(), saved: scenesController.penSavedVersion() }, { to });
  }

  private onSaved(name: string, md5: string, hash: number | null) {
    const s = this.session;
    if (s?.holderIsMe() && s.scene === name && s.people.length > 1) {
      void this.sendPayload(s, "saved", { md5, hash });
    }
  }

  /** a viewer pulled Drive's newer version: the holder's unsaved changes come again */
  private onPulled(name: string) {
    const s = this.session;
    if (s?.scene === name && s.holder && !s.holderIsMe()) {
      this.askCatchUp(s);
    }
  }

  // ---------------------------------------------------------------------------
  // payloads from others
  // ---------------------------------------------------------------------------

  private async onMessage(s: Session, msg: any) {
    if (msg.kind === "key") {
      await this.fetchKey(s);
      return;
    }
    const from = msg.from ?? {};
    const body = s.assembler.add(`${from.id}:${msg.req ?? ""}:${msg.kind}`, Number(msg.part ?? 0), Number(msg.parts ?? 1), String(msg.body ?? ""), Date.now());
    if (body === null || !s.key) {
      return;
    }
    let value: any;
    try {
      value = await openPayload(s.key, msg.kind, body);
    } catch {
      return; // another key (a copy's), or changed on the way
    }
    await this.onPayload(s, msg.kind, value, from, msg.req);
  }

  private async onPayload(s: Session, kind: string, value: any, from: any, req: string | undefined) {
    if (s.holder && from.id === s.holder.id && !s.holderIsMe()) {
      this.onHolderPayload(s, kind, value);
    } else if (kind === "catchup-req" && s.holderIsMe()) {
      this.sendCatchUp(s, from.id);
    } else if (kind === "ops" && s.holderIsMe()) {
      await this.applyOps(s, value, from, req);
    } else if (kind === "result" && req) {
      this.answerWaiting(s, req, value?.refused ? new Error(String(value.refused)) : "sent");
    }
  }

  /** what the holder sends this read-only tab: its changes, its saves, its pointer */
  private onHolderPayload(s: Session, kind: string, value: any) {
    if (kind === "change" || kind === "catchup") {
      this.applyChange(value);
    }
    const saved = kind === "catchup" ? value?.saved : value;
    if ((kind === "catchup" || kind === "saved") && typeof saved?.md5 === "string") {
      scenesController.penAdoptSaved(saved.md5, typeof saved.hash === "number" ? saved.hash : null);
    } else if (kind === "pointer") {
      this.setPointer(value, s.holder);
    }
  }

  /** the holder's elements, images, settings and comments onto this read-only canvas (not in the undo history) */
  private applyChange(value: any) {
    const api = this.api;
    if (!api || !value) {
      return;
    }
    if (Array.isArray(value.files) && value.files.length) {
      api.addFiles(value.files);
    }
    const elements = Array.isArray(value.els) ? withIncoming(api.getSceneElementsIncludingDeleted() as any[], value.els) : null;
    const settings = value.set && typeof value.set === "object" ? Object.fromEntries(SETTINGS_KEYS.filter((key) => value.set[key] !== null && value.set[key] !== undefined).map((key) => [key, value.set[key]])) : null;
    if (elements || settings) {
      api.updateScene({ ...(elements ? { elements } : {}), ...(settings ? { appState: settings as any } : {}), captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (Array.isArray(value.cmts)) {
      commentStore.load(value.cmts);
    }
  }

  // ---------------------------------------------------------------------------
  // pointers
  // ---------------------------------------------------------------------------

  private readonly onPointerMove = (event: PointerEvent) => {
    const s = this.session;
    const api = this.api;
    if (!s || !api || !s.holderIsMe() || s.people.length < 2 || !s.key) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPointerAt < POINTER_MS) {
      return;
    }
    this.lastPointerAt = now;
    const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState());
    void this.sendPayload(s, "pointer", { x: Math.round(x), y: Math.round(y) });
  };

  /** the holder's pointer on this canvas, with name and color (null: none) */
  private setPointer(value: { x: number; y: number } | null, holder?: Holder | null) {
    const api = this.api;
    if (!api) {
      return;
    }
    const collaborators = new Map<any, any>();
    if (value && holder && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      collaborators.set(holder.id, {
        id: holder.who,
        socketId: holder.id,
        username: holder.name,
        color: { background: holder.color, stroke: holder.color },
        pointer: { x: value.x, y: value.y, tool: "pointer" },
      });
    } else if (!api.getAppState().collaborators.size) {
      return;
    }
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private readonly onActivity = () => {
    const s = this.session;
    if (s?.holderIsMe() && Date.now() - this.lastActiveAt >= ACTIVE_MS) {
      this.lastActiveAt = Date.now();
      this.sendRaw(s, { t: "active" });
    }
  };

  // ---------------------------------------------------------------------------
  // the view mode
  // ---------------------------------------------------------------------------

  private lockView(force = false) {
    const api = this.api;
    if (!api || (this.lockedView && !force)) {
      return;
    }
    this.lockedView = true;
    if (!api.getAppState().viewModeEnabled) {
      api.updateScene({ appState: { viewModeEnabled: true }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }

  private unlockView() {
    if (!this.lockedView) {
      return;
    }
    this.lockedView = false;
    // read only for another reason (Drive's word): stays so
    if (this.api && !this.readOnly()) {
      this.api.updateScene({ appState: { viewModeEnabled: false }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }

  // ---------------------------------------------------------------------------
  // commenters
  // ---------------------------------------------------------------------------

  private async applyOps(s: Session, value: any, from: any, req: string | undefined) {
    const handler = this.commenterHandler;
    const ops = Array.isArray(value?.ops) ? value.ops : [];
    let result: CommenterOpsResult;
    try {
      result = handler
        ? await handler(ops, { name: String(from.name ?? "Someone"), ...(from.email ? { email: String(from.email) } : {}), key: String(from.key ?? "") })
        : { refused: "The editor's Kurviq can't take comments right now" };
    } catch (error: any) {
      result = { refused: error?.message ?? "The comment could not be added" };
    }
    if (req && typeof from.id === "string") {
      void this.sendPayload(s, "result", result === "applied" ? { ok: true } : result, { to: from.id, req });
    }
  }

  private answerWaiting(s: Session, req: string | undefined, result: "sent" | "no-editor" | Error) {
    const waiting = req ? s.waiting.get(req) : undefined;
    if (waiting) {
      s.waiting.delete(req!);
      clearTimeout(waiting.timer);
      waiting.done(result);
    }
  }

  sendOps(ops: unknown[]): Promise<"sent" | "no-editor"> {
    const s = this.session;
    if (s?.relay !== "connected" || !s.key || !s.holder || s.holderIsMe()) {
      return Promise.resolve("no-editor");
    }
    const req = this.nextReq();
    return new Promise<"sent" | "no-editor">((resolve, reject) => {
      const timer = window.setTimeout(() => this.answerWaiting(s, req, "no-editor"), OPS_ANSWER_MS);
      s.waiting.set(req, { done: (result) => (result instanceof Error ? reject(result) : resolve(result)), timer });
      void this.sendPayload(s, "ops", { ops }, { req });
    });
  }

  /** null with `only`: unregisters only if that handler is still the one */
  setCommenterHandler(handler: CommenterOpsHandler | null, only?: CommenterOpsHandler) {
    if (handler !== null || only === undefined || this.commenterHandler === only) {
      this.commenterHandler = handler;
    }
  }

  // ---------------------------------------------------------------------------
  // what the user does (the pen bar)
  // ---------------------------------------------------------------------------

  claim() {
    const s = this.session;
    if (s) {
      this.sendRaw(s, { t: "claim" });
    }
  }

  ask() {
    const s = this.session;
    if (s && this.sendRaw(s, { t: "ask" })) {
      s.asked = true;
      this.publish();
    }
  }

  takeOver() {
    const s = this.session;
    if (s) {
      this.sendRaw(s, { t: "takeover" });
    }
  }

  keep(to: string) {
    const s = this.session;
    if (s) {
      this.sendRaw(s, { t: "decline", to });
    }
  }

  /** the holder's changes are saved to Drive first, then the pen goes to `to` */
  handOver(to: string) {
    return this.afterSaving((s) => this.sendRaw(s, { t: "handover", to }));
  }

  /** the holder saves and lets the pen go (anyone may take it) */
  stopEditing() {
    return this.afterSaving((s) => this.sendRaw(s, { t: "release" }));
  }

  private async afterSaving(then: (s: Session) => void) {
    const s = this.session;
    if (!s?.holderIsMe() || this.busy) {
      return;
    }
    this.busy = true;
    this.publish();
    try {
      this.sendChanges(s);
      await scenesController.penSaveNow();
      if (this.session === s && s.holderIsMe()) {
        then(s);
      }
    } catch (error: any) {
      this.note(`Not saved to Drive, so you keep the pen: ${error?.message ?? error}`);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  dismissNotice() {
    this.notice = null;
    this.publish();
  }

  private note(text: string) {
    this.notice = text;
    this.publish();
  }

  /** an agent's edit of `name` through this tab: null if allowed, else who is editing */
  async refusal(name: string): Promise<string | null> {
    const s = this.session;
    if (s?.scene === name) {
      return this.openSceneRefusal(s);
    }
    const fileId = scenesController.fileIdOf(name);
    if (!fileId || scenesController.isLocalOnly(name) || !connection.isActive()) {
      return null;
    }
    try {
      const holder = markHolder(parseMark((await readPenMark(fileId)).mark), TAB, Date.now());
      return holder ? editingRefusal(holder) : null;
    } catch {
      return null; // Drive not reachable: the save itself will say so
    }
  }

  /** the open scene: the holder's tab edits; with a free pen this tab takes it for the agent */
  private async openSceneRefusal(s: Session) {
    const me = meOf(s, this.readOnly());
    if (me === "holder" || me === "none") {
      return null; // this tab edits (or the pen isn't known yet: the save decides as before)
    }
    if (me === "viewer" && s.relay === "connected" && !s.holder && s.role === "edit") {
      this.claim();
      const deadline = Date.now() + 3_000;
      while (!s.holderIsMe() && !s.holder && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100)); // NOSONAR S9382: polls the relay's answer in order on purpose
      }
      if (s.holderIsMe()) {
        return null;
      }
    }
    const holder = s.holder?.name ?? s.markHolder;
    if (holder) {
      return editingRefusal(holder);
    }
    // a commenter's or reader's agent: Drive's read-only answer applies (comments go their own way)
    return me === "commenter" || s.role === "read" ? null : editingRefusal("Someone else");
  }

  // ---------------------------------------------------------------------------
  // state for the bar and for others
  // ---------------------------------------------------------------------------

  private publish() {
    const s = this.session;
    const me = meOf(s, this.readOnly());
    const holder = s?.holder ? { name: s.holder.name, color: s.holder.color } : null;
    const byMark = !!s && s.relay !== "connected" && !!s.markHolder;
    const next: PenView = {
      holder: holder ?? (byMark ? { name: s!.markHolder!, color: "#868e96" } : null),
      me,
      relay: s?.relay === "connected" ? "connected" : "offline",
      role: s?.role ?? null,
      idle: !!s?.idle,
      askers: s ? s.people.filter((person) => s.asking.includes(person.id)) : [],
      asked: !!s?.asked,
      canTakeOver: !!s && s.relay === "connected" && s.role === "edit" && !!s.holder && !s.holderIsMe() && (s.idle || s.holder.who === s.self?.who),
      others: s ? Math.max(0, s.people.length - 1) : 0,
      byMark,
      notice: this.notice,
      busy: this.busy,
    };
    if (sameJson(next, this.view)) {
      return;
    }
    this.view = next;
    this.listeners.forEach((listener) => listener());
  }

  getView = () => this.view;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const pen = new Pen();

/** the pen on the open scene */
export const penState = (): PenState => {
  const { holder, me, relay } = pen.getView();
  return { holder, me, relay };
};

/** called on every change of penState(); returns the unsubscribe */
export const onPenChange = (cb: (state: PenState) => void) => {
  let last = JSON.stringify(penState());
  return pen.subscribe(() => {
    const now = JSON.stringify(penState());
    if (now !== last) {
      last = now;
      cb(penState());
    }
  });
};

/**
 * A commenter's tab: comment operations to the pen holder through the relay.
 * "no-editor": nobody holds the pen, the relay is unreachable, or the holder
 * didn't answer within 15 seconds (then the Drive comments mailbox takes
 * over; operations carry their comment ids, so one that arrives twice is the
 * same comment). The holder's refusal comes back as a rejected promise with
 * its reason.
 */
export const sendCommenterOps = (ops: unknown[]): Promise<"sent" | "no-editor"> => pen.sendOps(ops);

/** the holder's tab: applies commenters' operations (one handler; returns the unregister) */
export const onCommenterOps = (handler: CommenterOpsHandler) => {
  pen.setCommenterHandler(handler);
  return () => pen.setCommenterHandler(null, handler);
};

/** an agent's edit of a scene through this tab: null if allowed, else who is editing (./tabServer.ts, ../live.ts) */
export const penRefusal = (name: string) => pen.refusal(name);

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // dev and fake-Google builds (local QA, the e2e scripts): the pen and the controller in the console
  (window as any).__pen = pen;
  (window as any).__scenes = scenesController;
}
