// Live sync: one Durable Object per Drive scene (named by its file id), the
// only place that orders and stores the scene's changes
// (docs/live-sync/CONCEPT.md, PROTOCOL.md).
//
// Tabs connect with a WebSocket (hibernating: pings are answered without
// waking the object), say hello, get one coherent starting point and then
// send batches of encrypted changes. Each batch is checked against the
// element versions the tab saw, re-stamped, written to SQLite and only then
// answered and sent to the other tabs (the output gate holds messages until
// the write is durable). A batch costs two rows: its insert and its delete
// once Drive has it (seq and per-tab counters are derived from the rows and
// checkpointed when saving).
//
// Saving: every minute while changes are pending (and when the last tab
// leaves) a save round writes grouped, per-author versions to Drive with each
// author's own Google access, one upload at a time, crash-safe: the operation
// (id, checksum, base) is recorded before uploading and stays until its
// post-upload audit is done; every job in the `schedule` table stays until
// it completed, so an alarm retried after a crash finds it again. No
// setTimeout, setInterval, waitUntil or detached fetches here (they would
// keep the object billed, or get lost).
//
// Content stays encrypted with the scene's key (on the Drive file); the
// object decrypts only while saving or merging, with the key fetched by the
// author's access, and forgets it after the round. Names (the scene's, the
// people's) are kept in memory only. Nothing here logs content or tokens.

import { DurableObject } from "cloudflare:workers";

import { sendMessage } from "../../scenes-plugin/src/online/frames";
import {
  AUTO_ACCEPT_AFTER_MS,
  DECIDE_AFTER_MS,
  LIMITS,
  LIVE_MARKER,
  LIVE_PROTOCOL,
  MAX_VERSIONS_PER_ROUND,
  NAME_ID,
  PROOF_VALID_MS,
  REPLAY_HORIZON_MS,
  SAVE_EVERY_MS,
  SETTINGS_ID,
  contentOf,
  eventKey,
  fontHash,
  parseKeyProperty,
  readableOf,
  referencesOf,
  sameBase,
  KEY_PROPERTY,
} from "../../scenes-plugin/src/online/liveProtocol";
import type {
  Base,
  BlockedAuthor,
  EventKind,
  Lifecycle,
  Presence,
  Readable,
  Receipt,
  RefuseReason,
  Role,
  StampedBatch,
  WireEvent,
  WireScene,
} from "../../scenes-plugin/src/online/liveProtocol";

import { accessFromRefresh, devGate, sceneTokenExpiry, unsealSceneToken, watchSecret } from "./auth";
import type { AuthEnv } from "./auth";
import { downloadFile, driveCall, driveUrls, getFile, isTransient, listRevisions, patchFile, problemOf, uploadVersion } from "./driveApi";
import type { DriveAnswer, Revision } from "./driveApi";
import {
  buildSceneFile,
  encryptContent,
  importSceneKey,
  indexBetween,
  keyOf,
  md5Hex,
  plainOf,
  randomNonce,
  sameContent,
  subjectsOfFile,
  validElement,
  wireOf,
} from "./serverMerge";
import type { Entry, SceneKey } from "./serverMerge";

export type SceneEnv = AuthEnv & { ACCOUNT: DurableObjectNamespace };

/** what the Worker checked and sealed into a ticket or access proof (never what a tab claims) */
export type Claims = {
  kind: "ticket" | "proof";
  fileId: string;
  sub: string;
  /** the person's display name (presence; memory only here) */
  person: string | null;
  role: Role;
  pseudonym: string;
  /** Drive's head when checked; `at`: its modifiedTime (ms) */
  head: { revision: string | null; md5: string | null; at?: number | null };
  keyId: string | null;
  /** editors: their refresh token, sealed for this scene (TOKEN_KEY) */
  token?: string;
  /** tickets: single use */
  nonce?: string;
  exp: number;
  /** the last time Google confirmed the access (extensions while Google is down stop 2 h after) */
  checkedAt: number;
  /** when the session signed in (sign out everywhere) */
  iat: number;
  protocol: number;
  /** Drive says this person owns the file (their "not found" is the evidence of a deletion) */
  owner?: boolean;
};

/** a connection's state (survives hibernation; ≤ 2 KB) */
type Attachment = {
  sub: string;
  pseudonym: string;
  person: string | null;
  role: Role;
  proofExp: number;
  token?: string;
  keyId: string | null;
  tab: string | null;
  openToken?: string;
  connectedAt: number;
  activeAt: number;
  /** hello answered */
  ready: boolean;
  /** waits for a seed (welcome wait / seed) */
  waiting: boolean;
  /** Drive's head when the ticket was issued: the only revision this tab may seed with */
  head: { revision: string | null; md5: string | null; at?: number | null };
};

type Batch = {
  seq: number;
  tab: string;
  counter: number;
  /** account (sub) it is saved as */
  author: string;
  pseudonym: string;
  via: "user" | "agent";
  live: boolean;
  at: number;
  /** pseudonym of the original author when someone accepted these changes as theirs */
  behalf?: string;
  command?: string;
  entries: Entry[];
  /** everything the batch touches, before and after (the grouping walk) */
  touches: string[];
  origin?: "user" | "repair";
  /** ciphertext characters (limits) */
  bytes: number;
  /** its row's data is in `chunks` */
  chunked?: boolean;
};

type Blocked = Record<string, { since: number; reason: BlockedAuthor["reason"] }>;
type SavedReceipt = Receipt & { at: number };
type Pin = { rev: string; kind: "day" | "agent" | "audit"; at: number };
type Plain = Map<string, { k: EventKind; id?: string; value: any }>;
type Change = { k: EventKind; id: string; value: any; deleted?: boolean };

/** the tab id of changes the object makes itself (discards): never in receipts */
const OWN_TAB = "~do";
/** rows stay far below Cloudflare's 2 MB per row (characters; ids may be multi-byte) */
const CHUNK = 512 * 1024;
const KEY_LEASE_MS = 60_000;
const CLEANUP_AFTER_MS = 10 * 60_000;
const TRASH_KEEP_MS = 7 * 24 * 3600_000;
const CLOSING_MS = 5 * 60_000;
/** a connection that hasn't said hello after this long is closed */
const HELLO_WITHIN_MS = 60_000;
/** an access confirmed this recently makes a "not found" mean "gone" */
const CONFIRMED_FRESH_MS = 15 * 60_000;
/** `made` may be this far ahead of our clock */
const CLOCK_SKEW_MS = 5 * 60_000;
const KURVIQ_PINS = 30;
const GOOGLE_PINS = 200;
const ON_BEHALF_KEPT = 50;
const OWN_REVS_KEPT = 30;
const RECEIPT_EXTRA_MAX = 20_000;
/**
 * How long "sign out everywhere" is remembered: as long as a session signed in
 * before it could still be presented (cookies live up to 400 days)
 */
const REVOCATION_KEPT_MS = 400 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** changes of an author who can't be saved as: discarded this long after they became blocked, if nobody accepted them */
const BLOCKED_KEPT_MS = 90 * DAY_MS;
/** connections of one account to one scene; slots kept free for editors (viewers can't take the last ones) */
const CONNECTIONS_PER_ACCOUNT = 5;
const EDITOR_RESERVED = 10;
/** tab ids one account may use in a scene (active within a day) */
const TABS_PER_ACCOUNT = 20;
/** presence, decide, keep-local, trash: per connection and minute */
const CONTROL_PER_MINUTE = 60;
/** full-state answers (big) per connection and minute */
const STATES_PER_MINUTE = 3;
/** after a sharing change: proofs this short until the next renewal (the DO checks access meanwhile) */
const RECHECK_PROOF_MS = 60_000;
/** an author who lost access: their changes can only be discarded, automatically after this */
const ACCESS_LOST_KEPT_MS = 7 * 24 * 3600_000;
/** frames.ts: parts of at most this size */
const PART_SIZE = 256 * 1024;
/** messages being assembled: per connection, and their reserved size across the object */
const ASSEMBLIES_PER_SOCKET = 2;
const ASSEMBLY_BYTES = 48 * 1024 * 1024;

const ID_RE = /^[\w.:~-]{1,128}$/;
const TAB_RE = /^[\w-]{1,64}$/;
const isInt = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const isStrOrNull = (value: unknown, max = 256) => value === null || (typeof value === "string" && value.length <= max);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** an element's readable part, rebuilt from what the tab sent (only known fields, right types), or null */
const cleanReadable = (r: any, id: string): Readable | null => {
  if (!r || typeof r !== "object" || r.id !== id) {
    return null;
  }
  const ids = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length <= 128);
  if (
    typeof r.type !== "string" ||
    r.type.length > 40 ||
    !isInt(r.version) ||
    !Number.isSafeInteger(r.versionNonce) ||
    typeof r.isDeleted !== "boolean" ||
    !isStrOrNull(r.index, 200) ||
    !ids(r.boundIds, 2000) ||
    !ids(r.groupIds, 200) ||
    ![r.containerId, r.startId, r.endId, r.frameId, r.fileId].every((value) => isStrOrNull(value, 128)) ||
    !(r.fontFamily === null || Number.isSafeInteger(r.fontFamily))
  ) {
    return null;
  }
  return {
    id,
    type: r.type,
    version: r.version,
    versionNonce: r.versionNonce,
    isDeleted: r.isDeleted,
    index: r.index,
    boundIds: [...r.boundIds],
    containerId: r.containerId,
    startId: r.startId,
    endId: r.endId,
    frameId: r.frameId,
    groupIds: [...r.groupIds],
    fileId: r.fileId,
    fontFamily: r.fontFamily,
  };
};

const validBase = (base: unknown): base is Base | null =>
  base === null || (!!base && typeof base === "object" && isInt((base as Base).v) && Number.isSafeInteger((base as Base).n));

/** a cipher's length limit per kind (images are big, the rest small) */
const maxCipher = (k: EventKind) => (k === "file" ? Math.ceil(LIMITS.fileBytes * 1.4) + 4096 : k === "font" ? 8 * 1024 * 1024 : 2 * 1024 * 1024);

/** custom font ids (scenes-plugin/src/fonts.ts) */
const FONT_ID_MIN = 2000;
const FONT_ID_MAX = 9000;

const REF_FIELDS = ["containerId", "frameId", "startId", "endId"] as const;

/** what an entry takes in storage and memory: ciphertext, readable part, row overhead */
const sizeOf = (entry: Entry) => entry.c.length + (entry.r ? JSON.stringify(entry.r).length : 0) + 96;
/** unsaved batches per scene (rows, memory) */
const MAX_PENDING_BATCHES = 20_000;

/**
 * What an entry touches, before and after the change: itself, what it
 * refers to and the groups of what it refers to (a group id names all its
 * members), its own groups, its image and its font
 */
const touchesOf = (entry: Entry, before: Entry | undefined, lookup: (id: string) => Entry | undefined, lookupBefore: (id: string) => Entry | undefined) => {
  const out = new Set<string>([keyOf(entry)]);
  for (const [state, find] of [
    [entry, lookup],
    [before, lookupBefore],
  ] as const) {
    const r = state?.r;
    if (r) {
      for (const id of referencesOf(r)) {
        out.add(id);
        find(id)?.r?.groupIds.forEach((group) => out.add(`g:${group}`));
      }
      r.groupIds.forEach((group) => out.add(`g:${group}`));
      if (r.fileId) {
        out.add(eventKey("file", r.fileId));
      }
      if (r.fontFamily !== null && r.fontFamily >= FONT_ID_MIN) {
        out.add(`f#${r.fontFamily}`);
      }
    }
    if (state?.k === "font" && state.fontId !== undefined) {
      out.add(`f#${state.fontId}`);
    }
  }
  return [...out];
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** counters as a contiguous mark plus the exceptions above it */
const receiptOf = (counters: Iterable<number>, from: Receipt = { mark: 0, extra: [] }): Receipt => {
  const set = new Set<number>(from.extra);
  for (const counter of counters) {
    if (counter > from.mark) {
      set.add(counter);
    }
  }
  let mark = from.mark;
  while (set.delete(mark + 1)) {
    mark++;
  }
  return { mark, extra: [...set].filter((counter) => counter > mark).sort((a, b) => a - b) };
};

const receiptHas = (receipt: Receipt, counter: number) => counter <= receipt.mark || receipt.extra.includes(counter);

const receiptTop = (receipt: Receipt) => Math.max(receipt.mark, ...receipt.extra);

/** `known` without the counters in `minus` (still unsaved), as mark + exceptions (bounded) */
const receiptMinus = (known: Receipt, minus: Set<number>): Receipt => {
  if (!minus.size) {
    return known;
  }
  const lowest = Math.min(...minus);
  const mark = Math.min(known.mark, lowest - 1);
  const extra: number[] = [];
  for (let c = mark + 1; c <= known.mark && extra.length < RECEIPT_EXTRA_MAX; c++) {
    if (!minus.has(c)) {
      extra.push(c);
    }
  }
  for (const c of known.extra) {
    if (!minus.has(c) && extra.length < RECEIPT_EXTRA_MAX) {
      extra.push(c);
    }
  }
  return { mark, extra: extra.sort((a, b) => a - b) };
};

export class SceneRoom extends DurableObject<SceneEnv> {
  private sql: SqlStorage;

  // the scene, in memory (rebuilt from SQLite when the object wakes)
  private loaded = false;
  private seqNow = 0;
  private snap = new Map<string, Entry>();
  private state = new Map<string, Entry>();
  private pending: Batch[] = [];
  /** tab → counters of discarded batches (their rows stay, so a resend is refused) */
  private discarded = new Map<string, Set<number>>();
  private indices = new Map<string, Set<string>>();
  private alive = 0;
  private sceneBytes = 0;

  // memory only: names, access tokens (≤ 1 h), the round's key, rate counters, locks
  private names = new Map<string, string | null>();
  private driveName: string | null = null;
  private access = new Map<string, { token: string; expiresAt: number }>();
  /** the last access token that worked here (a save or a one-time token): outside checks without asking a tab */
  private lastAccess: { sub: string; token: string; expiresAt: number } | null = null;
  private roundKey: SceneKey | null = null;
  /** per-minute counters: batches per connection and per account, control messages and full states per connection */
  private rateBySocket = new WeakMap<WebSocket, Record<string, { minute: number; count: number }>>();
  private rateBySub = new Map<string, { minute: number; count: number }>();
  private driveChain: Promise<unknown> = Promise.resolve();
  private outboxChain: Promise<unknown> = Promise.resolve();
  private alarmAt: number | null = null;
  private alarmRunning = false;
  /** the job the alarm is running now: a retry it plans replaces its (overdue) deadline */
  private runningKind: string | null = null;
  private assemblies = new Map<WebSocket, { sub: string; entries: Map<string, { parts: string[]; count: number; total: number; at: number }> }>();
  private assemblyBytes = 0;
  /** rows written since the object woke (cost measurement, dev-stats) */
  private rowsWritten = 0;
  /**
   * cost counters for QA (dev-stats), memory only; only with the fake Google's
   * dev gate (FAKE_GOOGLE=1, local DEV_ORIGIN), else nothing is counted
   */
  private devOn: boolean;
  private metrics = SceneRoom.emptyMetrics();
  private devEnv: SceneEnv | null = null;

  private static emptyMetrics() {
    return {
      since: Date.now(),
      rowsWritten: 0,
      rowsRead: 0,
      wsIn: 0,
      wsOut: 0,
      fetches: {} as Record<string, number>,
      alarms: 0,
      drive: {} as Record<string, { calls: number; ms: number }>,
      driveMs: 0,
      handlerMs: 0,
      handlers: {} as Record<string, { calls: number; ms: number }>,
    };
  }

  private countHandler(name: string, started: number) {
    if (!this.devOn) {
      return;
    }
    const ms = Date.now() - started;
    this.metrics.handlerMs += ms;
    const entry = (this.metrics.handlers[name] ??= { calls: 0, ms: 0 });
    entry.calls++;
    entry.ms += ms;
  }

  private countDrive(kind: string, ms: number) {
    const entry = (this.metrics.drive[kind] ??= { calls: 0, ms: 0 });
    entry.calls++;
    entry.ms += ms;
    this.metrics.driveMs += ms;
  }

  /** the env Drive calls get: with the cost observer when counting */
  private get genv(): SceneEnv {
    return this.devEnv ?? this.env;
  }

  private dcall(url: string, token: string, init: Parameters<typeof driveCall>[2] = {}) {
    return driveCall(url, token, this.devOn ? { ...init, observe: (kind, ms) => this.countDrive(kind, ms) } : init);
  }

  constructor(ctx: DurableObjectState, env: SceneEnv) {
    super(ctx, env);
    const started = Date.now();
    this.devOn = devGate(env);
    if (this.devOn) {
      this.devEnv = Object.assign(Object.create(env), { observeDrive: (kind: string, ms: number) => this.countDrive(kind, ms) });
    }
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY, tab TEXT, counter INTEGER, author TEXT, via TEXT,
        live INTEGER, at INTEGER, state TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS chunks (seq INTEGER, part INTEGER, data TEXT, PRIMARY KEY (seq, part)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS snapshot (part INTEGER PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS tabs (tab TEXT PRIMARY KEY, author TEXT, mark INTEGER, extra TEXT, seen INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS tokens (author TEXT PRIMARY KEY, sealed TEXT, expires INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS saves (op TEXT PRIMARY KEY, state TEXT, batches TEXT, md5 TEXT, base TEXT, author TEXT, at INTEGER,
        rev TEXT, keys TEXT, meta TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS schedule (kind TEXT PRIMARY KEY, at INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS losers (id TEXT PRIMARY KEY, author TEXT, data TEXT, until INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS nonces (n TEXT PRIMARY KEY, until INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, sub TEXT, op TEXT);
    `);
    this.countHandler("constructor", started);
    // jobs survive everything: an object that woke without an alarm gets it back
    ctx.blockConcurrencyWhile(async () => {
      const next = this.q("SELECT MIN(at) AS at FROM schedule")[0]?.at;
      if (next !== null && next !== undefined && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Math.max(Number(next), Date.now() + 10));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // small storage helpers (every statement counts its written rows)
  // ---------------------------------------------------------------------------

  private q(query: string, ...args: unknown[]): any[] {
    const cursor = this.sql.exec(query, ...args);
    const rows = cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    if (this.devOn) {
      this.metrics.rowsWritten += cursor.rowsWritten;
      this.metrics.rowsRead += cursor.rowsRead;
    }
    return rows;
  }

  private meta(k: string): string | null {
    const row = this.q("SELECT v FROM meta WHERE k = ?", k)[0];
    return row ? String(row.v) : null;
  }

  private metaJson<T>(k: string, fallback: T): T {
    const value = this.meta(k);
    if (value === null) {
      return fallback;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private setMeta(k: string, v: unknown) {
    if (v === null || v === undefined) {
      this.q("DELETE FROM meta WHERE k = ?", k);
    } else {
      this.q("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }

  private num(k: string) {
    return Number(this.meta(k) || 0);
  }

  private get fileId() {
    return this.meta("fileId") || "";
  }

  /** the last seq handed out: memory, derived from the batch rows and the checkpoint */
  private get seq() {
    return this.seqNow;
  }

  /** a seq without a batch row of its own must be checkpointed (in the same transaction) */
  private checkpointSeq() {
    this.setMeta("seq", String(this.seqNow));
  }

  private lifecycle(): { state: Lifecycle; epoch: number } {
    return this.metaJson("lifecycle", { state: "active" as Lifecycle, epoch: 1 });
  }

  private lastSaved(): { revision: string | null; md5: string | null; at: number } {
    return this.metaJson("lastSaved", { revision: null, md5: null, at: 0 });
  }

  private seeded() {
    return this.meta("seeded") === "1";
  }

  /**
   * account ↔ pseudonym, from what is stored anyway (pending batches, open
   * connections): no map of its own (pseudonyms are derived from the account
   * by the Worker, a stored map would be one more thing to delete)
   */
  private pseudonymOfSub(sub: string) {
    return (
      this.pending.find((batch) => batch.author === sub && batch.tab !== OWN_TAB)?.pseudonym ??
      this.sockets().find(({ att }) => att.sub === sub)?.att.pseudonym ??
      null
    );
  }

  private subOfPseudonym(pseudonym: string) {
    return (
      this.pending.find((batch) => batch.pseudonym === pseudonym)?.author ?? this.sockets().find(({ att }) => att.pseudonym === pseudonym)?.att.sub ?? null
    );
  }

  private writeText(seq: number, text: string) {
    if (text.length <= CHUNK) {
      return text;
    }
    this.q("DELETE FROM chunks WHERE seq = ?", seq);
    for (let i = 0; i * CHUNK < text.length; i++) {
      this.q("INSERT INTO chunks (seq, part, data) VALUES (?, ?, ?)", seq, i, text.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    return "@chunks";
  }

  private readText(seq: number, data: string) {
    if (data !== "@chunks") {
      return data;
    }
    return this.q("SELECT data FROM chunks WHERE seq = ? ORDER BY part", seq)
      .map((row) => String(row.data))
      .join("");
  }

  private writeSnapshot() {
    const text = JSON.stringify([...this.snap.values()]);
    const parts = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < parts; i++) {
      this.q("INSERT OR REPLACE INTO snapshot (part, data) VALUES (?, ?)", i, text.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    this.q("DELETE FROM snapshot WHERE part >= ?", parts);
  }

  private storeBatch(batch: Batch, state = "pending") {
    const data = JSON.stringify({
      entries: batch.entries,
      touches: batch.touches,
      pseudonym: batch.pseudonym,
      behalf: batch.behalf,
      command: batch.command,
      origin: batch.origin,
    });
    const stored = this.writeText(batch.seq, data);
    batch.chunked = stored === "@chunks";
    this.q(
      "INSERT OR REPLACE INTO batches (seq, tab, counter, author, via, live, at, state, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      batch.seq,
      batch.tab,
      batch.counter,
      batch.author,
      batch.via,
      batch.live ? 1 : 0,
      batch.at,
      state,
      stored,
    );
  }

  private deleteBatchRow(seq: number, chunked: boolean) {
    this.q("DELETE FROM batches WHERE seq = ?", seq);
    if (chunked) {
      this.q("DELETE FROM chunks WHERE seq = ?", seq);
    }
  }

  // ---------------------------------------------------------------------------
  // the scene in memory
  // ---------------------------------------------------------------------------

  private load() {
    if (this.loaded) {
      return;
    }
    this.snap = new Map();
    const text = this.q("SELECT data FROM snapshot ORDER BY part")
      .map((row) => String(row.data))
      .join("");
    if (text) {
      for (const entry of JSON.parse(text) as Entry[]) {
        this.snap.set(keyOf(entry), entry);
      }
    }
    this.pending = [];
    this.discarded = new Map();
    let maxSeq = this.num("seq");
    for (const row of this.q("SELECT * FROM batches ORDER BY seq")) {
      maxSeq = Math.max(maxSeq, Number(row.seq));
      if (row.state === "discarded") {
        this.addDiscarded(String(row.tab), Number(row.counter));
        continue;
      }
      const data = JSON.parse(this.readText(Number(row.seq), String(row.data)));
      this.pending.push({
        seq: Number(row.seq),
        tab: String(row.tab),
        counter: Number(row.counter),
        author: String(row.author),
        via: row.via === "agent" ? "agent" : "user",
        live: !!row.live,
        at: Number(row.at),
        pseudonym: data.pseudonym,
        behalf: data.behalf,
        command: data.command,
        origin: data.origin,
        entries: data.entries,
        touches: data.touches,
        bytes: (data.entries as Entry[]).reduce((sum, entry) => sum + sizeOf(entry), 0) + JSON.stringify(data.touches).length,
        chunked: row.data === "@chunks",
      });
    }
    this.seqNow = maxSeq;
    this.rebuildState();
    this.loaded = true;
  }

  private addDiscarded(tab: string, counter: number) {
    if (!this.discarded.has(tab)) {
      this.discarded.set(tab, new Set());
    }
    this.discarded.get(tab)!.add(counter);
  }

  /** current state = snapshot + pending batches in seq order */
  private rebuildState() {
    this.state = new Map();
    this.indices = new Map();
    this.alive = 0;
    this.sceneBytes = 0;
    for (const [key, entry] of this.snap) {
      this.setState(key, entry);
    }
    for (const batch of this.pending) {
      for (const entry of batch.entries) {
        this.setState(keyOf(entry), entry);
      }
    }
  }

  private setState(key: string, entry: Entry) {
    const old = this.state.get(key);
    if (old) {
      this.sceneBytes -= sizeOf(old);
    }
    if (old?.r) {
      if (!old.r.isDeleted) {
        this.alive--;
      }
      const holders = this.indices.get(old.r.index ?? "");
      holders?.delete(key);
      if (holders && !holders.size) {
        this.indices.delete(old.r.index ?? "");
      }
    }
    this.state.set(key, entry);
    this.sceneBytes += sizeOf(entry);
    // deleted elements keep their place in the order (Excalidraw orders all elements, deleted ones too):
    // their indices count as taken, so a repair never hands one to a live element
    if (entry.r) {
      if (!entry.r.isDeleted) {
        this.alive++;
      }
      const index = entry.r.index ?? "";
      if (!this.indices.has(index)) {
        this.indices.set(index, new Set());
      }
      this.indices.get(index)!.add(key);
    }
  }

  private isAlive(id: string, batch?: Map<string, Entry>) {
    const entry = batch?.get(id) ?? this.state.get(id);
    return !!entry?.r && !entry.r.isDeleted;
  }

  private fullState(): WireScene {
    const saved = this.lastSaved();
    return { revision: saved.revision, md5: saved.md5, events: [...this.state.values()].map((entry) => wireOf(entry)) };
  }

  private stamped(batch: Batch, events: WireEvent[]): StampedBatch {
    return {
      seq: batch.seq,
      counter: batch.counter,
      author: batch.pseudonym,
      pseudonym: batch.pseudonym,
      name: this.names.get(batch.author) ?? null,
      tab: batch.tab,
      via: batch.via,
      origin: batch.origin ?? "user",
      events,
    };
  }

  private pendingBytes(author?: string) {
    return this.pending.reduce((sum, batch) => sum + (!author || batch.author === author ? batch.bytes : 0), 0);
  }

  /** the counters of a tab the object has: the checkpoint plus pending and discarded rows */
  private knownCounters(tab: string): Receipt {
    const row = this.q("SELECT mark, extra FROM tabs WHERE tab = ?", tab)[0];
    const checkpoint: Receipt = { mark: Number(row?.mark ?? 0), extra: JSON.parse(String(row?.extra ?? "[]")) };
    const rows = [...this.pending.filter((batch) => batch.tab === tab).map((batch) => batch.counter), ...(this.discarded.get(tab) ?? [])];
    return receiptOf(rows, checkpoint);
  }

  /** counters of saved (or given up) batches move into the tab's checkpoint row */
  private foldCounters(tab: string, counters: number[], atLeastMark = 0) {
    if (tab === OWN_TAB || !counters.length) {
      return;
    }
    const row = this.q("SELECT author, mark, extra, seen FROM tabs WHERE tab = ?", tab)[0];
    const next = receiptOf(counters, { mark: Math.max(Number(row?.mark ?? 0), atLeastMark), extra: JSON.parse(String(row?.extra ?? "[]")) });
    this.q(
      "INSERT OR REPLACE INTO tabs (tab, author, mark, extra, seen) VALUES (?, ?, ?, ?, ?)",
      tab,
      String(row?.author ?? ""),
      next.mark,
      JSON.stringify(next.extra),
      Number(row?.seen ?? Date.now()),
    );
  }

  // ---------------------------------------------------------------------------
  // connections
  // ---------------------------------------------------------------------------

  /** every open connection, also those that haven't said hello */
  private sockets() {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return att && ws.readyState === WebSocket.OPEN ? [{ ws, att }] : [];
    });
  }

  /** connections with a valid proof that said hello; the expired ones are closed on the way */
  private readySockets() {
    return this.sweep().filter(({ att }) => att.ready);
  }

  /** closes connections whose proof ran out (or that never said hello); returns the others */
  private sweep() {
    const now = Date.now();
    return this.sockets().filter(({ ws, att }) => {
      if (att.proofExp <= now || (!att.ready && now - att.connectedAt > HELLO_WITHIN_MS)) {
        this.close(ws, "access");
        return false;
      }
      return true;
    });
  }

  /** the next sweep: at the earliest proof expiry (or hello deadline) */
  private scheduleSweep() {
    const times = this.sockets().map(({ att }) => (att.ready ? att.proofExp : Math.min(att.proofExp, att.connectedAt + HELLO_WITHIN_MS)));
    this.schedule("proofs", times.length ? Math.min(...times) + 50 : null);
  }

  private close(ws: WebSocket, reason: Lifecycle | "access" | "replaced") {
    try {
      sendMessage(ws, { type: "closed", reason });
      ws.close(4000, reason);
      if (this.devOn) {
        this.metrics.wsOut++;
      }
    } catch {}
  }

  /** every message out goes through here: nothing reaches a connection whose proof ran out */
  private send(ws: WebSocket, message: unknown) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.proofExp <= Date.now()) {
      this.close(ws, "access");
      return false;
    }
    try {
      sendMessage(ws, message);
      if (this.devOn) {
        this.metrics.wsOut++;
      }
      return true;
    } catch {
      return false;
    }
  }

  private broadcast(message: unknown, except?: WebSocket) {
    for (const { ws } of this.readySockets()) {
      if (ws !== except) {
        this.send(ws, message);
      }
    }
  }

  private presence(except?: WebSocket): Presence[] {
    return this.readySockets()
      .filter(({ ws }) => ws !== except)
      .map(({ att }) => ({
        tab: att.tab!,
        pseudonym: att.pseudonym,
        name: att.person,
        role: att.role,
        activeAt: att.activeAt,
      }));
  }

  private blockedList(): BlockedAuthor[] {
    const blocked = this.metaJson<Blocked>("blocked", {});
    const now = Date.now();
    return Object.entries(blocked)
      .filter(([sub]) => this.pending.some((batch) => batch.author === sub))
      .map(([sub, info]) => ({
        pseudonym: this.pseudonymOfSub(sub) ?? "?",
        name: this.names.get(sub) ?? null,
        since: info.since,
        reason: info.reason,
        decidable: now - info.since >= DECIDE_AFTER_MS,
        acceptable: info.reason !== "access",
      }));
  }

  private statusMessage(except?: WebSocket) {
    return {
      type: "status",
      blocked: this.blockedList(),
      error: this.meta("error"),
      lifecycle: this.lifecycle().state,
      presence: this.presence(except),
      pendingSaves: this.pending.length,
      driveName: this.driveName,
    };
  }

  private broadcastStatus(except?: WebSocket) {
    this.broadcast(this.statusMessage(except), except);
  }

  private setError(error: string | null) {
    if (this.meta("error") !== error) {
      this.setMeta("error", error);
      this.broadcastStatus();
    }
  }

  private setDriveName(name: unknown) {
    if (typeof name === "string" && name !== this.driveName) {
      this.driveName = name;
      this.broadcastStatus();
    }
  }

  /** an outside change or an access check needs a credential and none is stored: one connected tab fetches one */
  private requestToken(prefer?: string | null) {
    if (Date.now() - this.num("needTokenAt") < 60_000) {
      return;
    }
    const rank = (att: Attachment) => (att.sub === prefer ? 0 : att.role === "edit" ? 1 : 2);
    const sockets = this.readySockets().sort((a, b) => rank(a.att) - rank(b.att));
    if (sockets[0]) {
      this.setMeta("needTokenAt", String(Date.now()));
      this.send(sockets[0].ws, { type: "need-token" });
    }
  }

  /** Drive confirmed this person's access just now (a "not found" for them soon after means the file is gone) */
  private confirmed(sub: string) {
    const all = this.metaJson<Record<string, number>>("confirmed", {});
    const now = Date.now();
    for (const [key, at] of Object.entries(all)) {
      if (now - at > CONFIRMED_FRESH_MS) {
        delete all[key];
      }
    }
    all[sub] = now;
    this.setMeta("confirmed", all);
    this.schedule("retention", now + DAY_MS, true);
  }

  // ---------------------------------------------------------------------------
  // HTTP from the Worker (sceneRoutes.ts): connect, keys, renewals, webhooks
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    if (this.devOn) {
      const route = new URL(request.url).pathname;
      this.metrics.fetches[route] = (this.metrics.fetches[route] ?? 0) + 1;
    }
    try {
      return await this.handleFetch(request);
    } finally {
      this.countHandler("fetch", started);
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/live") {
        return await this.connect(request);
      }
      const body: any = await request.json().catch(() => ({}));
      // a scene comes into being with a ticket (prepare); anything else for an unknown object writes nothing
      if (!this.meta("fileId")) {
        if (url.pathname !== "/prepare" || typeof body.fileId !== "string") {
          return json(200, { ok: false, unknown: true });
        }
        this.setMeta("fileId", body.fileId);
        this.ensureGeneration();
      }
      this.load();
      switch (url.pathname) {
        case "/prepare":
          return json(200, await this.prepare(body));
        case "/key-done":
          return json(200, this.keyDone(body));
        case "/renew":
          return json(200, await this.renew(body));
        case "/watch-set":
          return json(200, this.watchSet(body));
        case "/reconcile-token":
          return json(200, await this.reconcileToken(body));
        case "/notify":
          return json(200, await this.notify(body));
        case "/forget":
          return json(200, this.forget(String(body.sub || ""), Number(body.epoch) || 0));
        case "/revoke-tab":
          return json(200, this.revokeTab(body));
        case "/keep-local-ok":
          return json(200, this.keepLocalOk(body));
        // tests with the fake Google only (sceneRoutes.ts gates them exactly like this)
        case "/dev-age":
          return json(200, await this.devAge(Number(body.ms) || 0, !!body.all));
        case "/dev-stats":
          return json(200, this.devStats(body));
        case "/dev-crash":
          return json(200, this.devCrash(body));
        case "/dev-expire":
          return json(200, this.devExpire(body));
        case "/dev-drop-tabs":
          // lost metadata: the tabs' counters and the saved receipts
          this.q("DELETE FROM tabs");
          this.setMeta("receipts", null);
          return json(200, { ok: true });
      }
      return json(404, { error: "Not found" });
    } catch (error: any) {
      console.warn(`[scene] ${url.pathname} failed: ${error?.message ?? error}`);
      this.loaded = false;
      return json(500, { error: "Scene error" });
    }
  }

  private async connect(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    let claims: Claims;
    try {
      claims = JSON.parse(request.headers.get("X-Kurviq-Claims") || "");
    } catch {
      return new Response("Bad claims", { status: 400 });
    }
    if (!this.meta("fileId")) {
      this.setMeta("fileId", claims.fileId);
    }
    this.ensureGeneration();
    this.load();
    if (claims.kind !== "ticket" || claims.fileId !== this.fileId || !claims.nonce || claims.exp <= Date.now()) {
      return new Response("Invalid ticket", { status: 403 });
    }
    const lifecycle = this.lifecycle().state;
    if (lifecycle === "deleted" || lifecycle === "local" || lifecycle === "closing") {
      return new Response(`Scene is ${lifecycle}`, { status: 410 });
    }
    // single use: the nonce is spent here
    this.q("DELETE FROM nonces WHERE until < ?", Date.now());
    if (this.q("SELECT 1 FROM nonces WHERE n = ?", claims.nonce).length) {
      return new Response("Ticket already used", { status: 403 });
    }
    // expired connections never hold a slot; unready ones count. One account can't take them all,
    // and viewers leave the last ones to editors (checked again right before accepting: other
    // connections may have come in while the account guard was asked)
    const full = () => {
      const open = this.sweep();
      return (
        open.length >= LIMITS.connections ||
        open.filter(({ att }) => att.sub === claims.sub).length >= CONNECTIONS_PER_ACCOUNT ||
        (claims.role !== "edit" && open.length >= LIMITS.connections - EDITOR_RESERVED)
      );
    };
    if (full()) {
      return new Response("Too many connections to this scene", { status: 429 });
    }
    this.q("INSERT INTO nonces (n, until) VALUES (?, ?)", claims.nonce, claims.exp + 60_000);
    // the account knows this scene is open before the socket is (sign out everywhere finds it), and refuses
    // a sign-in older than its revocation epoch
    let registered = false;
    try {
      const res = await this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(claims.sub)).fetch("https://account/scene-connect", {
        method: "POST",
        body: JSON.stringify({ fileId: this.fileId, iat: claims.iat }),
      });
      registered = res.ok && ((await res.json()) as any).ok === true;
    } catch {
      return new Response("Try again", { status: 503 });
    }
    // a sign out everywhere that arrived meanwhile
    const forgotten = this.metaJson<Record<string, number>>("forgotten", {})[claims.sub];
    if (!registered || (forgotten && claims.iat < forgotten)) {
      return new Response("Signed out everywhere", { status: 403 });
    }
    // no await from here to the accept: the caps hold
    if (full() || this.isRevoked(claims.sub)) {
      return new Response("Too many connections to this scene", { status: 429 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`sub:${claims.sub}`]);
    const now = Date.now();
    pair[1].serializeAttachment({
      sub: claims.sub,
      pseudonym: claims.pseudonym,
      person: claims.person,
      role: claims.role,
      proofExp: now + PROOF_VALID_MS,
      token: claims.role === "edit" ? claims.token : undefined,
      keyId: claims.keyId,
      tab: null,
      connectedAt: now,
      activeAt: now,
      ready: false,
      waiting: false,
      head: { revision: claims.head?.revision ?? null, md5: claims.head?.md5 ?? null, at: claims.head?.at ?? null },
    } satisfies Attachment);
    this.names.set(claims.sub, claims.person);
    this.confirmed(claims.sub);
    if (claims.owner) {
      this.setMeta("owner", claims.sub);
    }
    // an author whose lease ran out gets a fresh one with every connection
    if (claims.role === "edit" && claims.token) {
      this.refreshAuthorToken(claims.sub, claims.token);
    }
    // Drive has a revision we did not write: an outside change to merge
    if (this.seeded() && claims.head.revision && !this.isOwnRevision(claims.head.revision)) {
      this.wantOutsideCheck();
    }
    this.setMeta("watchStop", null);
    this.schedule("watch-stop", null);
    this.schedule("cleanup", null);
    this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private ensureGeneration() {
    if (!this.meta("generation")) {
      this.setMeta("generation", crypto.randomUUID());
    }
  }

  private isOwnRevision(revision: string) {
    return revision === this.lastSaved().revision || this.metaJson<string[]>("ownRevs", []).includes(revision);
  }

  /** an editor with unsaved changes hands in a fresh sealed token (connect, renewal): stored, saving resumes */
  private refreshAuthorToken(sub: string, sealed: string) {
    const stored = this.q("SELECT expires FROM tokens WHERE author = ?", sub)[0];
    if (!stored && !this.pending.some((batch) => batch.author === sub)) {
      return;
    }
    if (stored && Number(stored.expires) >= sceneTokenExpiry(sealed)) {
      return;
    }
    this.storeToken(sub, sealed);
    // only called with a sealed token from a fresh Drive check (a ticket, a confirmed renewal)
    this.unblock(sub, true);
    if (this.pending.some((batch) => batch.author === sub)) {
      this.schedule("save", Date.now() + 1000, true);
    }
  }

  /**
   * Key creation for an existing scene (the Worker, under this object's
   * lease): `found` = the key id of a valid key property on the file (copies
   * count as none). Once the scene has a key, a missing or changed property
   * is an error to resolve, never a reason to make a new key.
   */
  private async prepare(body: any) {
    // a file Drive shows again (restored from the trash, or found after a "not found"): a new epoch
    const lifecycle = this.lifecycle().state;
    if (body.trashed === false && (lifecycle === "trashed" || lifecycle === "deleted")) {
      this.restored();
    } else if (body.trashed === true && lifecycle === "active") {
      await this.toTrash();
    }
    const found = typeof body.found === "string" ? body.found : null;
    const known = this.meta("keyId");
    const watch = await this.watchNeeded(typeof body.sub === "string" ? body.sub : "");
    if (known) {
      return { key: !found ? "missing" : found !== known ? "changed" : "ok", keyId: known, watch };
    }
    if (found) {
      this.setMeta("keyId", found);
      return { key: "ok", keyId: found, watch };
    }
    if (body.viewer) {
      return { key: "none", watch };
    }
    const lease = this.metaJson<{ id: string; until: number } | null>("keyLease", null);
    if (lease && lease.until > Date.now()) {
      return { key: "held", watch };
    }
    const id = crypto.randomUUID();
    this.setMeta("keyLease", { id, until: Date.now() + KEY_LEASE_MS });
    return { key: "lease", lease: id, watch };
  }

  private keyDone(body: any) {
    const lease = this.metaJson<{ id: string; until: number } | null>("keyLease", null);
    if (!lease || lease.id !== body.lease || typeof body.keyId !== "string") {
      return { ok: false };
    }
    if (!this.meta("keyId")) {
      this.setMeta("keyId", body.keyId);
    }
    this.setMeta("keyLease", null);
    return { ok: this.meta("keyId") === body.keyId };
  }

  /** a Drive watch is wanted (none, or it runs out within 2 hours): reserved for the asking Worker */
  private async watchNeeded(creator: string) {
    if (this.lifecycle().state !== "active") {
      return null;
    }
    const channel = this.metaJson<{ id: string; expiration: number } | null>("channel", null);
    if (channel && channel.expiration > Date.now() + 2 * 3600_000) {
      return null;
    }
    const reserved = this.metaJson<{ id: string; secret: string; until: number } | null>("channelPending", null);
    if (reserved && reserved.until > Date.now()) {
      return null;
    }
    const id = crypto.randomUUID();
    const next = { id, secret: await watchSecret(this.env, this.fileId, id), until: Date.now() + 60_000, creator };
    this.setMeta("channelPending", next);
    return { id: next.id, token: `${this.fileId}.${next.secret}` };
  }

  /** the Worker made the watch: it becomes the channel; the old one is handed back to be stopped */
  private watchSet(body: any) {
    const reserved = this.metaJson<{ id: string; secret: string; creator: string } | null>("channelPending", null);
    if (!reserved || reserved.id !== body.id || typeof body.resourceId !== "string") {
      return { ok: false };
    }
    const old = this.metaJson<{ id: string; resourceId: string; creator?: string } | null>("channel", null);
    this.setMeta("channel", {
      id: reserved.id,
      secret: reserved.secret,
      resourceId: body.resourceId,
      expiration: Number(body.expiration) || 0,
      creator: reserved.creator,
    });
    this.setMeta("channelPending", null);
    // only its creator may stop a channel: handed back when that is the same person
    return { ok: true, stop: old && old.creator === reserved.creator ? { id: old.id, resourceId: old.resourceId } : null };
  }

  /** a tab renewed its access proof (every 10 minutes, or after renew-now) */
  private async renew(body: any) {
    const claims = body.claims as Claims;
    // an extension while Google is down (not confirmed by Drive) never undoes what is known since the
    // proof's last real check: a refusal, a downgrade, a sharing change's re-check
    const unconfirmed = body.confirmed === false;
    if (unconfirmed && this.isRevoked(claims.sub)) {
      for (const ws of this.ctx.getWebSockets(`sub:${claims.sub}`)) {
        this.close(ws, "access");
      }
      return { ok: false };
    }
    const recheckAt = this.num("recheckAt");
    let found = false;
    for (const { ws, att } of this.sockets()) {
      if (att.tab !== body.tab || att.sub !== claims.sub) {
        continue;
      }
      found = true;
      const role: Role = unconfirmed && att.role === "read" ? "read" : claims.role;
      const proofExp = unconfirmed && recheckAt > claims.checkedAt ? att.proofExp : claims.exp;
      ws.serializeAttachment({
        ...att,
        role,
        proofExp,
        token: role === "edit" ? claims.token ?? att.token : undefined,
        keyId: claims.keyId,
      } satisfies Attachment);
    }
    if (body.confirmed !== false) {
      this.confirmed(claims.sub);
      this.setRevoked(claims.sub, false);
      if (claims.owner) {
        this.setMeta("owner", claims.sub);
      }
    }
    if (claims.role === "edit" && claims.token) {
      this.refreshAuthorToken(claims.sub, claims.token);
    }
    if (claims.role === "edit" && body.confirmed !== false) {
      this.unblock(claims.sub, true);
    }
    this.setDriveName(body.name);
    const lifecycle = this.lifecycle().state;
    if (body.trashed === true && lifecycle === "active") {
      await this.toTrash();
    } else if (body.trashed === false && (lifecycle === "trashed" || lifecycle === "deleted")) {
      this.restored();
    } else if (this.seeded() && body.head?.revision && !this.isOwnRevision(body.head.revision)) {
      this.wantOutsideCheck();
    }
    this.scheduleSweep();
    return { ok: found, watch: await this.watchNeeded(claims.sub) };
  }

  /** a renewal was refused (access removed in Drive): that tab's connection ends */
  /** a renewal was refused: every connection of that account ends (not only the renewing tab's) */
  private revokeTab(body: any) {
    if (typeof body.sub !== "string") {
      return { ok: false };
    }
    this.setRevoked(body.sub, true);
    for (const ws of this.ctx.getWebSockets(`sub:${body.sub}`)) {
      this.close(ws, "access");
    }
    return { ok: true };
  }

  /** accounts whose last renewal (or the DO's own check) was refused: their batches are refused until a renewal succeeds */
  private setRevoked(sub: string, revoked: boolean) {
    const all = this.metaJson<Record<string, number>>("revoked", {});
    if (revoked === !!all[sub]) {
      return;
    }
    if (revoked) {
      all[sub] = Date.now();
      this.schedule("retention", Date.now() + DAY_MS, true);
    } else {
      delete all[sub];
    }
    this.setMeta("revoked", Object.keys(all).length ? all : null);
  }

  private isRevoked(sub: string) {
    return !!this.metaJson<Record<string, number>>("revoked", {})[sub];
  }

  /**
   * A sharing change (permissions notification, remove): every connected
   * account is checked at once with what is at hand (a stored token, the last
   * access that worked); those without access are closed, those who may only
   * read are downgraded. Meanwhile every proof is cut to a minute, so whoever
   * couldn't be checked must renew (renew-now) or is closed by the sweep.
   */
  private startRecheck() {
    const until = Date.now() + RECHECK_PROOF_MS;
    this.setMeta("recheckAt", String(Date.now()));
    for (const { ws, att } of this.sockets()) {
      if (att.proofExp > until) {
        ws.serializeAttachment({ ...att, proofExp: until });
      }
    }
    this.scheduleSweep();
    this.broadcast({ type: "renew-now" });
    this.schedule("recheck", Date.now(), true);
  }

  private async recheckAccess() {
    for (const sub of new Set(this.sockets().map(({ att }) => att.sub))) {
      let token: string | null = null;
      if (this.q("SELECT 1 FROM tokens WHERE author = ?", sub).length) {
        const access = await this.accessFor(sub);
        token = "token" in access ? access.token : null;
      }
      if (!token && this.lastAccessToken()?.sub === sub) {
        token = this.lastAccessToken()!.token;
      }
      if (!token) {
        continue; // their short proof decides
      }
      const file = await getFile(this.genv, token, this.fileId, "id,capabilities(canEdit)");
      if (file.status === 200) {
        if (file.data.capabilities?.canEdit === false) {
          for (const { ws, att } of this.sockets()) {
            if (att.sub === sub && att.role === "edit") {
              ws.serializeAttachment({ ...att, role: "read", token: undefined });
            }
          }
        }
        continue;
      }
      if (!isTransient(problemOf(file))) {
        this.setRevoked(sub, true);
        for (const ws of this.ctx.getWebSockets(`sub:${sub}`)) {
          this.close(ws, "access");
        }
      }
    }
  }

  /** a "trash" from a tab is a hint: the scene is trashed only when Drive says so */
  private async trashCheck(oneTime?: { sub: string; token: string }) {
    if (this.meta("trashCheck") !== "1") {
      return;
    }
    const access = oneTime ?? (await this.anyAccess());
    if (access === "unreachable") {
      this.schedule("trash-check", Date.now() + 60_000);
      return;
    }
    if (!access) {
      this.requestToken();
      this.schedule("trash-check", Date.now() + 15 * 60_000);
      return;
    }
    const file = await getFile(this.genv, access.token, this.fileId, "id,trashed");
    if (file.status !== 200 && isTransient(problemOf(file))) {
      this.schedule("trash-check", Date.now() + 60_000);
      return;
    }
    this.setMeta("trashCheck", null);
    if (file.status === 200 && file.data.trashed) {
      this.toTrashNow();
    }
  }

  /** the Worker checked with Drive that this person owns the file and it is not shared: "Keep only here" may start */
  private keepLocalOk(body: any) {
    if (typeof body.sub !== "string") {
      return { ok: false };
    }
    this.setMeta("keepLocalOk", { sub: body.sub, until: Date.now() + 2 * 60_000 });
    return { ok: true };
  }

  private async devAge(ms: number, all: boolean) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    Object.values(blocked).forEach((info) => (info.since -= ms));
    this.setMeta("blocked", blocked);
    if (all) {
      // everything with a time gets older: the retention job then runs at once
      this.q("UPDATE tabs SET seen = seen - ?", ms);
      this.q("UPDATE batches SET at = at - ?", ms);
      this.q("UPDATE saves SET at = at - ?", ms);
      this.pending.forEach((batch) => (batch.at -= ms));
      for (const key of ["forgotten", "confirmed"]) {
        const map = this.metaJson<Record<string, number>>(key, {});
        Object.keys(map).forEach((k) => (map[k] -= ms));
        this.setMeta(key, map);
      }
      await this.retention();
    }
    this.broadcastStatus();
    return { ok: true, blocked: Object.keys(blocked).length };
  }

  private devStats(body: any) {
    if (body.reset) {
      this.rowsWritten = 0;
      this.metrics = SceneRoom.emptyMetrics();
    }
    return {
      rowsWritten: this.rowsWritten,
      // since the last reset (or since the object woke): rows, messages, requests, alarms, Google calls, handler time
      costs: this.metrics,
      pending: this.pending.length,
      seq: this.seq,
      schedule: this.q("SELECT kind, at FROM schedule"),
      saves: this.q("SELECT op, state, base, rev FROM saves"),
      lifecycle: this.lifecycle(),
      channel: !!this.meta("channel"),
      watchStop: this.meta("watchStop"),
      tokens: this.q("SELECT author FROM tokens").length,
      blocked: this.metaJson("blocked", {}),
      pins: this.metaJson("pins", []),
      error: this.meta("error"),
      needCredential: this.meta("needCredential"),
      auditPins: this.metaJson("auditPins", []),
      metaKeys: this.q("SELECT k FROM meta").map((row) => String(row.k)),
      // what is kept per account (retention checks)
      kept: {
        tabs: this.q("SELECT COUNT(*) AS n FROM tabs")[0]?.n ?? 0,
        discarded: this.q("SELECT COUNT(*) AS n FROM batches WHERE state = 'discarded'")[0]?.n ?? 0,
        forgotten: Object.keys(this.metaJson("forgotten", {})).length,
        confirmed: Object.keys(this.metaJson("confirmed", {})).length,
        owner: !!this.meta("owner"),
        doneSaves: this.q("SELECT COUNT(*) AS n FROM saves WHERE state = 'done'")[0]?.n ?? 0,
        nonces: this.q("SELECT COUNT(*) AS n FROM nonces")[0]?.n ?? 0,
        outbox: this.q("SELECT COUNT(*) AS n FROM outbox")[0]?.n ?? 0,
      },
    };
  }

  /**
   * tests: the next upload stops at `at` ("after-upload": Drive answered,
   * nothing recorded; "after-commit": committed, audit not run), as if the
   * object died there; `race`: an outside write lands just before the upload
   */
  private devCrash(body: any) {
    this.setMeta("devCrash", typeof body.at === "string" ? body.at : null);
    this.setMeta("devRace", body.race && typeof body.race === "object" ? body.race : null);
    this.setMeta("devRestart", body.restart ? "1" : null);
    return { ok: true };
  }

  /** tests: Drive's current file plus `add` (an element), written "from outside" right before our upload */
  private async devRace(token: string) {
    const race = this.metaJson<{ email: string; add: unknown } | null>("devRace", null);
    if (!race || this.env.FAKE_GOOGLE !== "1" || !this.env.DEV_ORIGIN) {
      return;
    }
    this.setMeta("devRace", null);
    const current = await downloadFile(this.genv, token, this.fileId);
    const data = JSON.parse(current.text);
    data.elements.push(race.add);
    delete data.kurviq;
    await fetch(`${this.env.DEV_ORIGIN}/fake-google/admin/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: race.email, fileId: this.fileId, content: JSON.stringify(data) }),
    });
  }

  private crashPoint(at: string) {
    if (this.meta("devCrash") === at) {
      this.setMeta("devCrash", null);
      if (this.meta("devRestart") === "1") {
        // like a real restart: memory (access tokens, caches) is gone
        this.setMeta("devRestart", null);
        this.access.clear();
        this.lastAccess = null;
        this.names.clear();
        this.driveName = null;
      }
      throw new Error(`dev crash: ${at}`);
    }
  }

  /** tests: a connection's proof runs out in `inMs` (the sweep must close it without any message) */
  private devExpire(body: any) {
    for (const { ws, att } of this.sockets()) {
      if (att.tab === body.tab) {
        ws.serializeAttachment({ ...att, proofExp: Date.now() + (Number(body.inMs) || 1000) });
      }
    }
    this.scheduleSweep();
    return { ok: true };
  }

  /** a tab answered need-token: a one-time access token, used for these checks only (memory) */
  private async reconcileToken(body: any) {
    if (typeof body.token !== "string") {
      return { ok: false };
    }
    const sub = typeof body.sub === "string" ? body.sub : "";
    const oneTime = { sub, token: body.token as string };
    await this.withDrive(async () => {
      try {
        if (this.meta("verifyWanted") === "1") {
          await this.verifyAccess(oneTime);
        }
        if (this.meta("trashCheck") === "1") {
          await this.trashCheck(oneTime);
        }
        if (this.q("SELECT 1 FROM saves WHERE state IN ('prepared', 'audit', 'repair') LIMIT 1").length) {
          if (await this.recoverSaves(oneTime)) {
            this.schedule("save", Date.now(), true);
          }
        }
        await this.outsideCheck(oneTime);
      } finally {
        this.roundKey = null;
      }
    });
    return { ok: true };
  }

  /**
   * Drive's push notification (the Worker checked the channel token's shape).
   * Our own saves are recognised by their revision when checked, not by time;
   * a notification without details is checked like a content change.
   */
  private async notify(body: any) {
    const channel = this.metaJson<{ id: string; secret: string; resourceId: string } | null>("channel", null);
    if (!channel || channel.id !== body.channelId || channel.secret !== body.secret || channel.resourceId !== body.resourceId) {
      return { ok: false };
    }
    const changed = String(body.changed || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    switch (body.state) {
      case "trash":
        await this.toTrash();
        break;
      case "untrash":
        this.restored();
        break;
      case "remove":
        // deleted, OR unshared from whoever made the watch: never wiped on this alone
        this.setMeta("verifyWanted", "1");
        this.schedule("verify", Date.now(), true);
        this.startRecheck();
        break;
      default:
        if (!changed.length || changed.includes("content") || changed.includes("properties") || changed.includes("parents")) {
          this.wantOutsideCheck();
        }
        if (!changed.length || changed.includes("permissions")) {
          this.startRecheck();
        }
    }
    return { ok: true };
  }

  /** sign out everywhere: this account's stored token goes, its connections close */
  private forget(sub: string, epoch: number) {
    const forgotten = this.metaJson<Record<string, number>>("forgotten", {});
    forgotten[sub] = Math.max(forgotten[sub] ?? 0, epoch || Date.now());
    this.setMeta("forgotten", forgotten);
    this.schedule("retention", Date.now() + DAY_MS, true);
    this.dropToken(sub);
    for (const ws of this.ctx.getWebSockets(`sub:${sub}`)) {
      this.close(ws, "access");
    }
    if (this.pending.some((batch) => batch.author === sub)) {
      this.markBlocked(sub, "token");
    }
    this.schedule("outbox", Date.now(), true);
    this.broadcastStatus();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // WebSocket messages
  // ---------------------------------------------------------------------------

  /**
   * frames.ts parts, assembled here with bounds: only for editors who said
   * hello (nobody else ever sends a big message); one message at most
   * LIMITS.batchBytes; two at a time per connection, one batch's worth per
   * account, 48 MB across the object; an unfinished one is dropped two
   * minutes after it began (swept across all connections, not only the sender's)
   */
  private assemble(ws: WebSocket, att: Attachment, raw: string): any | null {
    if (raw.length > PART_SIZE * 6 + 1024) {
      throw new Error("message too big");
    }
    const message = JSON.parse(raw);
    if (message?.type !== "part") {
      return message;
    }
    if (!att.ready || att.role !== "edit") {
      throw new Error("parts only from editors");
    }
    const { id, i, total, data } = message;
    if (
      typeof id !== "string" ||
      id.length > 40 ||
      !isInt(total, 1) ||
      total * PART_SIZE > LIMITS.batchBytes + PART_SIZE ||
      !isInt(i) ||
      i >= total ||
      typeof data !== "string" ||
      data.length > PART_SIZE
    ) {
      throw new Error("malformed part");
    }
    this.sweepAssemblies();
    let mine = this.assemblies.get(ws);
    if (!mine) {
      mine = { sub: att.sub, entries: new Map() };
      this.assemblies.set(ws, mine);
    }
    let entry = mine.entries.get(id);
    if (!entry) {
      const reserve = total * PART_SIZE;
      const accountReserved = [...this.assemblies.values()]
        .filter((other) => other.sub === att.sub)
        .reduce((sum, other) => sum + [...other.entries.values()].reduce((n, e) => n + e.total * PART_SIZE, 0), 0);
      if (
        mine.entries.size >= ASSEMBLIES_PER_SOCKET ||
        accountReserved + reserve > LIMITS.batchBytes + PART_SIZE ||
        this.assemblyBytes + reserve > ASSEMBLY_BYTES
      ) {
        throw new Error("too many unfinished messages");
      }
      entry = { parts: new Array(total), count: 0, total, at: Date.now() };
      mine.entries.set(id, entry);
      this.assemblyBytes += reserve;
    }
    if (entry.total !== total) {
      throw new Error("malformed part");
    }
    if (entry.parts[i] === undefined) {
      entry.parts[i] = data;
      entry.count++;
    }
    if (entry.count < total) {
      return null;
    }
    mine.entries.delete(id);
    this.assemblyBytes -= total * PART_SIZE;
    return JSON.parse(entry.parts.join(""));
  }

  /** unfinished messages older than two minutes, of every connection */
  private sweepAssemblies() {
    const now = Date.now();
    for (const [ws, mine] of this.assemblies) {
      for (const [key, entry] of mine.entries) {
        if (now - entry.at > 120_000) {
          mine.entries.delete(key);
          this.assemblyBytes -= entry.total * PART_SIZE;
        }
      }
      if (!mine.entries.size || ws.readyState !== WebSocket.OPEN) {
        this.dropAssemblies(ws);
      }
    }
  }

  private dropAssemblies(ws: WebSocket) {
    for (const entry of this.assemblies.get(ws)?.entries.values() ?? []) {
      this.assemblyBytes -= entry.total * PART_SIZE;
    }
    this.assemblies.delete(ws);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const started = Date.now();
    if (this.devOn) {
      this.metrics.wsIn++;
    }
    try {
      await this.handleMessage(ws, raw);
    } finally {
      this.countHandler("webSocketMessage", started);
    }
  }

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    // every message checks the proof first, before anything is assembled
    if (!att || att.proofExp <= Date.now()) {
      this.dropAssemblies(ws);
      this.close(ws, "access");
      return;
    }
    // refused (a renewal, or the scene's own access check): nothing of this account is dispatched
    if (this.isRevoked(att.sub)) {
      for (const other of this.ctx.getWebSockets(`sub:${att.sub}`)) {
        this.close(other, "access");
      }
      return;
    }
    let message: any;
    try {
      message = this.assemble(ws, att, raw);
    } catch {
      this.dropAssemblies(ws);
      try {
        ws.close(1008, "invalid message");
      } catch {}
      return;
    }
    if (!message || typeof message !== "object") {
      return;
    }
    this.load();
    if (message.type === "hello") {
      return this.onHello(ws, att, message);
    }
    if (!att.ready) {
      return;
    }
    if (["presence", "decide", "keep-local", "keep-local-done", "trash"].includes(message.type) && !this.rateOk(ws, "control", CONTROL_PER_MINUTE)) {
      return;
    }
    switch (message.type) {
      case "batch":
        return this.onBatch(ws, att, message);
      case "seed":
        return await this.onSeed(ws, att, message);
      case "decide":
        return this.onDecide(ws, att, message);
      case "presence":
        if (isInt(message.activeAt)) {
          ws.serializeAttachment({ ...att, activeAt: Math.min(message.activeAt, Date.now()) });
          this.broadcastStatus();
        }
        return;
      case "keep-local":
        return this.onKeepLocal(ws, att);
      case "keep-local-done":
        return this.onKeepLocalDone(ws, att);
      case "trash":
        // only a hint: the scene is trashed when Drive says so
        if (att.role === "edit" && this.lifecycle().state === "active") {
          this.setMeta("trashCheck", "1");
          this.schedule("trash-check", Date.now(), true);
        }
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const started = Date.now();
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {}
    this.afterLeave(ws);
    this.countHandler("webSocketClose", started);
  }

  async webSocketError(ws: WebSocket) {
    this.afterLeave(ws);
  }

  private afterLeave(gone: WebSocket) {
    this.load();
    this.dropAssemblies(gone);
    const att = gone.deserializeAttachment() as Attachment | null;
    const others = this.sockets().filter(({ ws }) => ws !== gone);
    if (att && !others.some((other) => other.att.sub === att.sub)) {
      this.q("INSERT INTO outbox (sub, op) VALUES (?, 'disconnect')", att.sub);
      this.schedule("outbox", Date.now(), true);
    }
    if (!others.length) {
      // the last tab left: save at once, stop the watch, forget the content 10 minutes later
      if (this.pending.length) {
        this.schedule("save", Date.now());
      }
      if (this.meta("channel")) {
        this.setMeta("watchStop", "1");
        this.schedule("watch-stop", Date.now());
      }
      this.schedule("cleanup", Date.now() + CLEANUP_AFTER_MS);
    } else {
      this.broadcastStatus(gone);
    }
    this.scheduleSweep();
  }

  private onHello(ws: WebSocket, att: Attachment, hello: any) {
    // one hello per connection (a second one would be a full state on demand)
    if (att.ready) {
      try {
        ws.close(1008, "one hello per connection");
      } catch {}
      return;
    }
    if (
      hello.protocol !== LIVE_PROTOCOL ||
      typeof hello.tab !== "string" ||
      !TAB_RE.test(hello.tab) ||
      typeof hello.openToken !== "string" ||
      hello.openToken.length > 200 ||
      !isInt(hello.seq) ||
      !isStrOrNull(hello.generation, 100) ||
      !isStrOrNull(hello.revision, 200)
    ) {
      try {
        ws.close(1008, "invalid hello");
      } catch {}
      return;
    }
    const lifecycle = this.lifecycle();
    if (lifecycle.state === "deleted" || lifecycle.state === "local") {
      this.close(ws, lifecycle.state);
      return;
    }
    const tab = hello.tab as string;
    const now = Date.now();
    const row = this.q("SELECT author, mark, extra FROM tabs WHERE tab = ?", tab)[0];
    // a tab id belongs to one account (tabs never send as someone else)
    if (row && row.author && row.author !== att.sub) {
      try {
        ws.close(1008, "tab of another account");
      } catch {}
      return;
    }
    // and one account uses a bounded number of tab ids
    if (!row && this.q("SELECT COUNT(*) AS n FROM tabs WHERE author = ? AND seen > ?", att.sub, now - DAY_MS)[0].n >= TABS_PER_ACCOUNT) {
      try {
        ws.close(1008, "too many tabs");
      } catch {}
      return;
    }
    this.q(
      "INSERT OR REPLACE INTO tabs (tab, author, mark, extra, seen) VALUES (?, ?, ?, ?, ?)",
      tab,
      att.sub,
      Number(row?.mark ?? 0),
      String(row?.extra ?? "[]"),
      now,
    );
    const known = this.knownCounters(tab);
    const generation = this.meta("generation")!;
    const saved = this.lastSaved();
    let mode: "events" | "state" | "seed" | "wait";
    let events: StampedBatch[] | undefined;
    let state: WireScene | undefined;
    if (!this.seeded()) {
      mode = att.role === "edit" && lifecycle.state === "active" && this.meta("keyId") ? "seed" : "wait";
    } else if (hello.generation === generation && hello.seq >= this.num("maxDeleted") && hello.seq <= this.seq) {
      mode = "events";
      events = this.pending.filter((batch) => batch.seq > hello.seq).map((batch) => this.stamped(batch, batch.entries.map((e) => wireOf(e))));
    } else if (hello.generation === null && hello.revision && hello.revision === saved.revision) {
      // loaded exactly the last save: what is not in it yet
      mode = "events";
      events = this.pending.map((batch) => this.stamped(batch, batch.entries.map((e) => wireOf(e))));
    } else {
      mode = "state";
      state = this.fullState();
    }
    ws.serializeAttachment({ ...att, tab, openToken: hello.openToken, ready: true, waiting: mode === "seed" || mode === "wait" });
    this.send(ws, {
      type: "welcome",
      mode,
      fileId: this.fileId,
      openToken: hello.openToken,
      epoch: lifecycle.epoch,
      seq: this.seq,
      generation,
      events,
      state,
      keyId: this.meta("keyId"),
      role: att.role,
      lifecycle: lifecycle.state,
      presence: this.presence(),
      known: known.extra,
      knownMark: known.mark,
      saved: { revision: saved.revision, md5: saved.md5 },
      receipts: this.savedReceipts(),
    });
    if (att.role === "edit") {
      this.autoAcceptIndependent(ws.deserializeAttachment() as Attachment);
    }
    if ((this.meta("outsideWanted") === "1" || this.meta("verifyWanted") === "1") && !this.anyToken() && !this.lastAccessToken()) {
      this.requestToken();
    }
    this.broadcastStatus();
    this.scheduleSweep();
  }

  private savedReceipts(): Record<string, Receipt> {
    const all = this.metaJson<Record<string, SavedReceipt>>("receipts", {});
    return Object.fromEntries(Object.entries(all).map(([tab, { mark, extra }]) => [tab, { mark, extra }]));
  }

  // ---------------------------------------------------------------------------
  // batches
  // ---------------------------------------------------------------------------

  private refuse(ws: WebSocket, counter: number, reason: RefuseReason, current: Entry[] = [], detail?: string) {
    this.send(ws, { type: "refused", counter, reason, ...(detail ? { detail } : {}), current: current.map((entry) => wireOf(entry)) });
  }

  private validEvent(event: any): event is WireEvent {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || !ID_RE.test(event.id) || !validBase(event.base)) {
      return false;
    }
    if (!["el", "set", "file", "font", "name"].includes(event.k) || typeof event.c !== "string" || event.c.length < 20) {
      return false;
    }
    if (event.c.length > maxCipher(event.k)) {
      return false;
    }
    switch (event.k as EventKind) {
      case "el":
        return !!cleanReadable(event.r, event.id);
      case "set":
        return event.id === SETTINGS_ID;
      case "name":
        return event.id === NAME_ID;
      case "font":
        return isInt(event.fontId) && event.fontId >= FONT_ID_MIN && event.fontId < FONT_ID_MAX;
      case "file":
        return true;
    }
    return false;
  }

  /** within `limit` per minute for this connection (by kind), and for batches also per account (twice the per-tab limit) */
  private rateOk(ws: WebSocket, kind: "batch" | "control" | "state", limit: number, sub?: string) {
    const minute = Math.floor(Date.now() / 60_000);
    const counters = this.rateBySocket.get(ws) ?? {};
    this.rateBySocket.set(ws, counters);
    const mine = counters[kind]?.minute === minute ? counters[kind] : (counters[kind] = { minute, count: 0 });
    mine.count++;
    if (mine.count > limit) {
      return false;
    }
    if (sub) {
      const account = this.rateBySub.get(sub)?.minute === minute ? this.rateBySub.get(sub)! : { minute, count: 0 };
      this.rateBySub.set(sub, account);
      account.count++;
      return account.count <= limit * 2;
    }
    return true;
  }

  private onBatch(ws: WebSocket, att: Attachment, msg: any) {
    const counter = msg.counter;
    if (!isInt(counter, 1)) {
      return;
    }
    const tab = att.tab!;
    if (att.role !== "edit" || this.isRevoked(att.sub)) {
      return this.refuse(ws, counter, "role");
    }
    const lifecycle = this.lifecycle().state;
    if (lifecycle !== "active") {
      return this.refuse(ws, counter, "lifecycle", [], lifecycle);
    }
    if (!this.seeded()) {
      return this.refuse(ws, counter, "old", [], "not seeded");
    }
    if (!this.meta("keyId") || att.keyId !== this.meta("keyId")) {
      return this.refuse(ws, counter, "key");
    }
    // resent: stored once, answered again
    const known = this.knownCounters(tab);
    if (this.discarded.get(tab)?.has(counter)) {
      return this.refuse(ws, counter, "discarded");
    }
    if (receiptHas(known, counter)) {
      const batch = this.pending.find((b) => b.tab === tab && b.counter === counter);
      const stamps = Object.fromEntries((batch?.entries ?? []).map((e) => [keyOf(e), { v: e.v, n: e.n }]));
      return this.send(ws, { type: "ack", counter, seq: batch?.seq ?? 0, stamps, duplicate: true });
    }
    // counters stay near the tab's own (receipts stay small)
    if (counter > receiptTop(known) + LIMITS.counterWindow) {
      return this.refuse(ws, counter, "limit", [], "counterWindow");
    }
    const now = Date.now();
    // never replayed after 30 days (deleted elements could come back); `made` must be sane
    if (!isInt(msg.made) || msg.made > now + CLOCK_SKEW_MS) {
      return this.refuse(ws, counter, "invalid", [], "made");
    }
    if (now - msg.made > REPLAY_HORIZON_MS) {
      return this.refuse(ws, counter, "old", [], "older than 30 days");
    }
    if (!att.token || sceneTokenExpiry(att.token) <= now) {
      return this.refuse(ws, counter, "token");
    }
    if (!this.rateOk(ws, "batch", LIMITS.batchesPerMinute, att.sub)) {
      return this.refuse(ws, counter, "limit", [], "batchesPerMinute");
    }
    const events = msg.events;
    if (!Array.isArray(events) || !events.length) {
      return this.refuse(ws, counter, "invalid", [], "no events");
    }
    if (events.length > LIMITS.eventsPerBatch) {
      return this.refuse(ws, counter, "limit", [], "eventsPerBatch");
    }
    const seen = new Set<string>();
    for (const event of events) {
      if (!this.validEvent(event) || seen.has(eventKey(event.k, event.id))) {
        return this.refuse(ws, counter, "invalid", [], typeof event?.id === "string" ? event.id.slice(0, 64) : undefined);
      }
      seen.add(eventKey(event.k, event.id));
    }
    const ownBase = isInt(msg.base, 1) ? msg.base : null;

    // 1. bases: the element as the tab last saw it, or what its own pending batch produced
    const collisions: Entry[] = [];
    const missing: string[] = [];
    for (const event of events as WireEvent[]) {
      const cur = this.state.get(eventKey(event.k, event.id));
      if (!cur) {
        if (event.base !== null) {
          missing.push(event.id);
        }
        continue;
      }
      // the same image or font twice (identified by a hash of its bytes) is not a collision
      if ((event.k === "file" || event.k === "font") && event.base === null) {
        continue;
      }
      const own = ownBase !== null && cur.t === tab && cur.u === ownBase;
      if (!sameBase(event.base, { v: cur.v, n: cur.n }) && !own) {
        collisions.push(cur);
      }
    }
    if (collisions.length || missing.length) {
      return this.refuse(ws, counter, "collision", collisions, missing.length ? `unknown: ${missing.slice(0, 20).join(",")}` : undefined);
    }

    // 2. fonts: one numeric id per font, without clashes
    const fontIds: Record<string, number> = {};
    const used = new Map<number, string>();
    for (const entry of this.state.values()) {
      if (entry.k === "font" && entry.fontId !== undefined) {
        used.set(entry.fontId, entry.id);
      }
    }
    const remap = new Map<number, number>();
    for (const event of events as WireEvent[]) {
      if (event.k !== "font") {
        continue;
      }
      const existing = this.state.get(eventKey("font", event.id));
      let id = existing?.fontId ?? event.fontId!;
      if (!existing && used.has(id) && used.get(id) !== event.id) {
        let free: number | null = null;
        for (let step = 1; step < FONT_ID_MAX - FONT_ID_MIN && free === null; step++) {
          const candidate = FONT_ID_MIN + ((id - FONT_ID_MIN + step) % (FONT_ID_MAX - FONT_ID_MIN));
          if (!used.has(candidate)) {
            free = candidate;
          }
        }
        if (free === null) {
          return this.refuse(ws, counter, "font-id", [], "no free font id");
        }
        id = free;
      }
      if (id !== event.fontId) {
        fontIds[event.id] = id;
        remap.set(event.fontId!, id);
      }
      used.set(id, event.id);
    }

    // 3. build the stamped entries
    const batchMap = new Map<string, Entry>();
    const entries: Entry[] = [];
    const stamps: Record<string, Base> = {};
    for (const event of events as WireEvent[]) {
      const key = eventKey(event.k, event.id);
      const cur = this.state.get(key);
      if ((event.k === "file" || event.k === "font") && cur && event.base === null) {
        stamps[key] = { v: cur.v, n: cur.n };
        continue;
      }
      const v = cur ? cur.v + 1 : event.k === "el" ? Math.max(1, cleanReadable(event.r, event.id)!.version) : 1;
      const n = randomNonce();
      const entry: Entry = { k: event.k, id: event.id, c: event.c, v, n, a: att.pseudonym, seq: 0, t: tab, u: counter };
      if (event.k === "el") {
        const r = cleanReadable(event.r, event.id)!;
        r.version = v;
        r.versionNonce = n;
        if (r.fontFamily !== null && remap.has(r.fontFamily)) {
          r.fontFamily = remap.get(r.fontFamily)!;
        }
        entry.r = r;
      }
      if (event.k === "font") {
        entry.fontId = fontIds[event.id] ?? event.fontId;
      }
      batchMap.set(key, entry);
      entries.push(entry);
      stamps[key] = { v, n };
    }

    // 4. the resulting graph: nothing alive points at something deleted or unknown
    const problem = this.referenceProblem(entries, batchMap);
    if (problem) {
      const current = this.state.get(problem.target);
      return this.refuse(ws, counter, "reference", current ? [current] : [], problem.detail);
    }

    // 5. limits on the result
    let aliveAfter = this.alive;
    let bytes = 0;
    let sceneAfter = this.sceneBytes;
    for (const entry of entries) {
      const before = this.state.get(keyOf(entry));
      bytes += sizeOf(entry);
      sceneAfter += sizeOf(entry) - (before ? sizeOf(before) : 0);
      if (entry.k === "el") {
        aliveAfter += (entry.r!.isDeleted ? 0 : 1) - (before?.r && !before.r.isDeleted ? 1 : 0);
      }
    }
    if (aliveAfter > LIMITS.elements) {
      return this.refuse(ws, counter, "limit", [], "elements");
    }
    if (sceneAfter > LIMITS.sceneBytes) {
      return this.refuse(ws, counter, "limit", [], "sceneBytes");
    }
    if (this.pending.length >= MAX_PENDING_BATCHES) {
      return this.refuse(ws, counter, "limit", [], "pendingBatches");
    }
    if (this.pendingBytes() + bytes > LIMITS.pendingBytes) {
      return this.refuse(ws, counter, "limit", [], "pendingBytes");
    }
    if (this.pendingBytes(att.sub) + bytes > LIMITS.accountPendingBytes) {
      return this.refuse(ws, counter, "limit", [], "accountPendingBytes");
    }

    // 6. clashing fractional indices are repaired here (tabs never repair)
    const repairs: Record<string, string> = {};
    const taken = new Set<string>();
    for (const entry of entries) {
      const r = entry.r;
      if (!r || r.isDeleted) {
        continue;
      }
      const holders = [...(this.indices.get(r.index ?? "") ?? [])].filter((key) => !batchMap.has(key));
      if (r.index !== null && !holders.length && !taken.has(r.index)) {
        taken.add(r.index);
        continue;
      }
      const index = this.freeIndex(r.index, taken);
      if (index) {
        r.index = index;
        repairs[entry.id] = index;
        taken.add(index);
      }
    }

    // 7. durable before anyone hears of it (the output gate holds the answers); two rows per batch
    const seq = this.seq + 1;
    entries.forEach((entry) => (entry.seq = seq));
    const before = (id: string) => this.state.get(id);
    const after = (id: string) => batchMap.get(id) ?? this.state.get(id);
    const batch: Batch = {
      seq,
      tab,
      counter,
      author: att.sub,
      pseudonym: att.pseudonym,
      via: msg.via === "agent" ? "agent" : "user",
      live: !!msg.live,
      at: msg.made,
      command: typeof msg.command === "string" ? msg.command.slice(0, 100) : undefined,
      entries,
      touches: [...new Set(entries.flatMap((entry) => touchesOf(entry, this.state.get(keyOf(entry)), after, before)))],
      bytes,
    };
    batch.bytes += JSON.stringify(batch.touches).length;
    if (this.pendingBytes(att.sub) + batch.bytes > LIMITS.accountPendingBytes || this.pendingBytes() + batch.bytes > LIMITS.pendingBytes) {
      return this.refuse(ws, counter, "limit", [], "accountPendingBytes");
    }
    const skip: number[] = Array.isArray(msg.skip) ? msg.skip.filter((c: unknown) => isInt(c, 1) && (c as number) <= counter).slice(0, 1000) : [];
    try {
      this.ctx.storage.transactionSync(() => {
        if (entries.length) {
          this.storeBatch(batch);
        } else {
          // nothing new (assets it already had): only the counter is recorded
          this.foldCounters(tab, [counter]);
          this.seqNow = seq;
          this.checkpointSeq();
        }
        if (skip.length) {
          this.foldCounters(tab, skip);
        }
        // the author's token is stored in the same transaction as their first unsaved change
        if (entries.length && !this.q("SELECT 1 FROM tokens WHERE author = ?", att.sub).length) {
          this.storeToken(att.sub, att.token!);
        }
      });
    } catch (error) {
      this.loaded = false;
      throw error;
    }
    this.seqNow = seq;
    if (entries.length) {
      this.pending.push(batch);
      entries.forEach((entry) => this.setState(keyOf(entry), entry));
    }
    this.unblock(att.sub);
    this.send(ws, {
      type: "ack",
      counter,
      seq,
      stamps,
      ...(Object.keys(fontIds).length ? { fontIds } : {}),
      ...(Object.keys(repairs).length ? { repairs } : {}),
    });
    if (entries.length) {
      const wire = (events as WireEvent[])
        .filter((event) => batchMap.has(eventKey(event.k, event.id)))
        .map((event) => wireOf(batchMap.get(eventKey(event.k, event.id))!, event.base));
      this.broadcast({ type: "events", ...this.stamped(batch, wire) }, ws);
      this.schedule("save", Date.now() + SAVE_EVERY_MS, true);
      this.recordLosers(batch, msg.losers);
      this.autoAcceptDependency(att);
    }
  }

  /**
   * The graph after the batch: every alive element of the batch points only at
   * alive elements (container, frame, bindings, newly bound elements), its
   * image and font exist, and nothing alive still points at what the batch deletes
   */
  private referenceProblem(entries: Entry[], batchMap: Map<string, Entry>): { target: string; detail: string } | null {
    const fontIds = new Set<number>();
    for (const entry of [...this.state.values(), ...entries]) {
      if (entry.k === "font" && entry.fontId !== undefined) {
        fontIds.add(entry.fontId);
      }
    }
    const deleted = new Set<string>();
    for (const entry of entries) {
      const r = entry.r;
      if (!r) {
        continue;
      }
      const before = this.state.get(entry.id)?.r;
      if (r.isDeleted) {
        if (before && !before.isDeleted) {
          deleted.add(entry.id);
        }
        continue;
      }
      for (const field of REF_FIELDS) {
        const target = r[field];
        if (target && !this.isAlive(target, batchMap)) {
          return { target, detail: `${entry.id}:${field}:${target}` };
        }
      }
      for (const target of r.boundIds) {
        if (!before?.boundIds.includes(target) && !this.isAlive(target, batchMap)) {
          return { target, detail: `${entry.id}:boundElements:${target}` };
        }
      }
      if (r.fileId && r.fileId !== before?.fileId && !batchMap.has(eventKey("file", r.fileId)) && !this.state.has(eventKey("file", r.fileId))) {
        return { target: eventKey("file", r.fileId), detail: `${entry.id}:fileId:${r.fileId}` };
      }
      if (r.fontFamily !== null && r.fontFamily >= FONT_ID_MIN && r.fontFamily !== before?.fontFamily && !fontIds.has(r.fontFamily)) {
        return { target: `font#${r.fontFamily}`, detail: `${entry.id}:fontFamily:${r.fontFamily}` };
      }
    }
    if (deleted.size) {
      // reverse references: what still points at a deleted element
      for (const [key, entry] of this.state) {
        const r = (batchMap.get(key) ?? entry).r;
        if (!r || r.isDeleted) {
          continue;
        }
        for (const field of REF_FIELDS) {
          if (r[field] && deleted.has(r[field]!)) {
            return { target: key, detail: `${key}:${field}:${r[field]}` };
          }
        }
      }
    }
    return null;
  }

  /** an index above `index` and below the next used one (or after all, for a missing index) */
  private freeIndex(index: string | null, taken: Set<string>) {
    const all = [...this.indices.keys(), ...taken].filter((value) => value !== "").sort();
    if (index === null) {
      return indexBetween(all[all.length - 1] ?? null, null);
    }
    const above = all.find((value) => value > index) ?? null;
    return indexBetween(index, above);
  }

  /** live collisions the tab settled "later wins": the other author may restore theirs until the next save */
  private recordLosers(batch: Batch, losers: unknown) {
    if (!Array.isArray(losers)) {
      return;
    }
    const until = Date.now() + SAVE_EVERY_MS * 2;
    for (const loser of losers.slice(0, 200)) {
      if (!this.validEvent(loser) || loser.k !== "el") {
        continue;
      }
      // the loser is whoever wrote the state this batch replaced
      const replaced = this.pending
        .filter((b) => b.seq < batch.seq)
        .reverse()
        .flatMap((b) => b.entries.filter((e) => e.id === loser.id))[0];
      const author = replaced?.a ? this.subOfPseudonym(replaced.a) : null;
      if (!author || author === batch.author) {
        continue;
      }
      this.q("INSERT OR REPLACE INTO losers (id, author, data, until) VALUES (?, ?, ?, ?)", loser.id, author, JSON.stringify(loser), until);
      for (const ws of this.ctx.getWebSockets(`sub:${author}`)) {
        this.send(ws, { type: "lost", id: loser.id, by: batch.pseudonym, until, event: loser });
      }
    }
  }

  private async onSeed(ws: WebSocket, att: Attachment, msg: any) {
    const ticketHead = att.head;
    const head = this.seeded() ? this.lastSaved() : ticketHead;
    const refuse = (reason: string) => this.send(ws, { type: "seed-refused", reason, head: { revision: head.revision, md5: head.md5 } });
    if (att.role !== "edit") {
      return refuse("role");
    }
    if (this.lifecycle().state !== "active") {
      return refuse("lifecycle");
    }
    if (this.seeded()) {
      refuse("seeded");
      return this.rateOk(ws, "state", STATES_PER_MINUTE) ? this.send(ws, this.welcomeState(att)) : undefined;
    }
    if (!this.meta("keyId") || att.keyId !== this.meta("keyId")) {
      return refuse("key");
    }
    const scene = msg.scene;
    if (!scene || !Array.isArray(scene.events) || scene.events.length > LIMITS.elements + 10_000) {
      return refuse("invalid");
    }
    // only exactly the revision the Worker saw in Drive when issuing this editor's ticket
    if (!ticketHead.revision || scene.revision !== ticketHead.revision || scene.md5 !== ticketHead.md5) {
      return refuse("old");
    }
    const entries: Entry[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const event of scene.events) {
      if (!this.validEvent({ ...event, base: null }) || seen.has(eventKey(event.k, event.id))) {
        return refuse("invalid");
      }
      seen.add(eventKey(event.k, event.id));
      const entry: Entry = { k: event.k, id: event.id, c: event.c, v: 1, n: randomNonce(), a: null, seq: 0 };
      if (event.k === "el") {
        entry.r = cleanReadable(event.r, event.id)!;
        entry.v = entry.r.version;
        entry.n = entry.r.versionNonce;
      } else if (event.v && isInt(event.v.v) && Number.isSafeInteger(event.v.n)) {
        entry.v = event.v.v;
        entry.n = event.v.n;
      }
      if (event.k === "font") {
        entry.fontId = event.fontId;
      }
      bytes += sizeOf(entry);
      entries.push(entry);
    }
    if (bytes > LIMITS.sceneBytes) {
      return refuse("invalid");
    }
    // the file's own record (who wrote what, what is saved, on whose behalf) comes from Drive,
    // read with this editor's access — never from the tab: forged receipts would make other tabs drop their work
    const record = await this.driveRecord(att);
    if (this.seeded() || this.lifecycle().state !== "active" || ws.readyState !== WebSocket.OPEN) {
      refuse(this.seeded() ? "seeded" : "lifecycle");
      return this.seeded() && this.rateOk(ws, "state", STATES_PER_MINUTE) ? this.send(ws, this.welcomeState(att)) : undefined;
    }
    const kurviq = record ?? {};
    const authors: Record<string, unknown> = kurviq.authors && typeof kurviq.authors === "object" ? kurviq.authors : {};
    for (const entry of entries) {
      const author = authors[entry.id];
      entry.a = entry.k === "el" && typeof author === "string" && author.length <= 40 ? author : null;
    }
    const receipts = record ? this.seedReceipts(kurviq.receipts) : null;
    const onBehalf = Array.isArray(kurviq.onBehalf)
      ? kurviq.onBehalf
          .filter((item: any) => item && typeof item.by === "string" && typeof item.for === "string" && isInt(item.at))
          .slice(-ON_BEHALF_KEPT)
          .map((item: any) => ({ by: item.by.slice(0, 40), for: item.for.slice(0, 40), at: item.at }))
      : null;
    const previous = this.lastSaved();
    // the saved revision's own time (a reseed doesn't make yesterday's save today's: milestone pins)
    const savedAt = previous.revision === scene.revision && previous.at ? previous.at : isInt(ticketHead.at) ? ticketHead.at! : Date.now();
    this.seqNow = this.seq + 1;
    const seq = this.seqNow;
    entries.forEach((entry) => (entry.seq = seq));
    this.snap = new Map(entries.map((entry) => [keyOf(entry), entry]));
    this.ctx.storage.transactionSync(() => {
      this.writeSnapshot();
      this.checkpointSeq();
      this.setMeta("maxDeleted", String(seq));
      this.setMeta("seeded", "1");
      this.setMeta("lastSaved", { revision: scene.revision, md5: scene.md5, at: savedAt });
      this.setMeta("outsideWanted", null);
      // Drive's record could not be read now: the first save round takes it (until then: none)
      this.setMeta("seedCheck", record ? null : "1");
      if (receipts) {
        this.setMeta("receipts", receipts);
        // …and the counters the object knows (a resend is recognised; the tab's next save keeps them)
        for (const [tab, receipt] of Object.entries(receipts)) {
          this.foldCounters(tab, [...receipt.extra, ...(receipt.mark ? [receipt.mark] : [])], receipt.mark);
        }
      }
      if (onBehalf) {
        this.setMeta("onBehalf", onBehalf);
      }
    });
    this.rebuildState();
    // the seeder has it all; everyone who waited gets it now
    for (const { ws: other, att: info } of this.readySockets()) {
      if (other === ws) {
        other.serializeAttachment({ ...info, waiting: false });
        this.send(other, { ...this.welcomeState(info), mode: "events", events: [], state: undefined });
      } else if (info.waiting) {
        other.serializeAttachment({ ...info, waiting: false });
        this.send(other, this.welcomeState(info));
      }
    }
  }

  /**
   * The seeded file's `kurviq` record, read from Drive with the seeding
   * editor's own access (their sealed token), only if the bytes are exactly
   * the ticket's revision (its md5); null: not readable now (the first save
   * round takes it then), {}: the file has none
   */
  private async driveRecord(att: Attachment): Promise<any | null> {
    if (!att.token || !att.head.md5) {
      return null;
    }
    const sealed = await unsealSceneToken(this.env, att.token, this.fileId, att.sub);
    const access = sealed ? await accessFromRefresh(this.env, sealed.r) : null;
    if (!access || typeof access === "string") {
      return null;
    }
    const download = await downloadFile(this.genv, access.token, this.fileId);
    if (download.status !== 200 || (await md5Hex(new TextEncoder().encode(download.text))) !== att.head.md5) {
      return null;
    }
    try {
      const record = JSON.parse(download.text)?.kurviq;
      return record && typeof record === "object" && !Array.isArray(record) ? record : {};
    } catch {
      return {};
    }
  }

  /**
   * A seed whose record could not be read from Drive then: the first save
   * round reads what the Drive file itself says (no record in the file:
   * none). false: Drive didn't answer, try again.
   */
  private async verifySeedRecord(token: string) {
    const download = await downloadFile(this.genv, token, this.fileId);
    if (download.status !== 200) {
      if (isTransient(problemOf(download))) {
        return false;
      }
      this.setMeta("seedCheck", null);
      return true;
    }
    let record: any = null;
    try {
      record = JSON.parse(download.text)?.kurviq ?? null;
    } catch {}
    const authors: Record<string, unknown> = record?.authors && typeof record.authors === "object" ? record.authors : {};
    this.ctx.storage.transactionSync(() => {
      // the file's own record (authentic: read from Drive), its receipts become the tabs' counters too
      this.setMeta("receipts", null);
      const verified = this.seedReceipts(record?.receipts);
      this.setMeta("receipts", verified);
      for (const [tab, receipt] of Object.entries(verified ?? {})) {
        this.foldCounters(tab, [...receipt.extra, ...(receipt.mark ? [receipt.mark] : [])], receipt.mark);
      }
      this.setMeta(
        "onBehalf",
        Array.isArray(record?.onBehalf)
          ? record.onBehalf
              .filter((item: any) => item && typeof item.by === "string" && typeof item.for === "string" && isInt(item.at))
              .slice(-ON_BEHALF_KEPT)
          : null,
      );
      let changed = false;
      for (const entry of this.snap.values()) {
        if (entry.k === "el" && entry.seq <= this.num("maxDeleted")) {
          const author = typeof authors[entry.id] === "string" && (authors[entry.id] as string).length <= 40 ? (authors[entry.id] as string) : null;
          if (entry.a !== author && entry.a !== "outside") {
            entry.a = author;
            changed = true;
          }
        }
      }
      if (changed) {
        this.writeSnapshot();
      }
      this.setMeta("seedCheck", null);
    });
    return true;
  }

  /** receipts from a seeded file: kept as they were (with their time), merged with what we still had */
  private seedReceipts(value: unknown): Record<string, SavedReceipt> | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const out = this.metaJson<Record<string, SavedReceipt>>("receipts", {});
    const now = Date.now();
    for (const [tab, receipt] of Object.entries<any>(value).slice(0, 1000)) {
      if (
        !TAB_RE.test(tab) ||
        !receipt ||
        !isInt(receipt.mark) ||
        !Array.isArray(receipt.extra) ||
        receipt.extra.length > RECEIPT_EXTRA_MAX ||
        !receipt.extra.every((c: unknown) => isInt(c, 1))
      ) {
        continue;
      }
      const at = isInt(receipt.at) && receipt.at <= now ? receipt.at : now;
      if (now - at > REPLAY_HORIZON_MS) {
        continue;
      }
      const merged = receiptOf([...(out[tab]?.extra ?? []), ...receipt.extra], { mark: Math.max(out[tab]?.mark ?? 0, receipt.mark), extra: [] });
      out[tab] = { ...merged, at: Math.max(out[tab]?.at ?? 0, at) };
    }
    return out;
  }

  private welcomeState(att: Attachment) {
    const known = this.knownCounters(att.tab!);
    const saved = this.lastSaved();
    const lifecycle = this.lifecycle();
    return {
      type: "welcome",
      mode: "state",
      fileId: this.fileId,
      openToken: att.openToken ?? "",
      epoch: lifecycle.epoch,
      seq: this.seq,
      generation: this.meta("generation"),
      state: this.fullState(),
      keyId: this.meta("keyId"),
      role: att.role,
      lifecycle: lifecycle.state,
      presence: this.presence(),
      known: known.extra,
      knownMark: known.mark,
      saved: { revision: saved.revision, md5: saved.md5 },
      receipts: this.savedReceipts(),
    };
  }

  // ---------------------------------------------------------------------------
  // authors who can't be saved as: decide, accept, discard
  // ---------------------------------------------------------------------------

  private markBlocked(sub: string, reason: BlockedAuthor["reason"]) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    // lost access is sticky: an expired token or another problem never makes it acceptable again
    if (blocked[sub]?.reason === reason || blocked[sub]?.reason === "access") {
      return;
    }
    blocked[sub] = { since: blocked[sub]?.since ?? Date.now(), reason };
    this.setMeta("blocked", blocked);
  }

  /** `fresh`: Drive confirmed just now that this person may edit (a ticket, a confirmed renewal): only that lifts a lost-access block */
  private unblock(sub: string, fresh = false) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    if (blocked[sub]?.reason === "access" && !fresh) {
      return;
    }
    if (blocked[sub] && this.q("SELECT 1 FROM tokens WHERE author = ? AND expires > ?", sub, Date.now()).length) {
      delete blocked[sub];
      this.setMeta("blocked", blocked);
      this.schedule("save", Date.now() + 1000, true);
      this.broadcastStatus();
    }
  }

  private onDecide(ws: WebSocket, att: Attachment, msg: any) {
    if (att.role !== "edit" || typeof msg.author !== "string") {
      return;
    }
    const sub = this.subOfPseudonym(msg.author);
    const blocked = this.metaJson<Blocked>("blocked", {});
    if (!sub || !blocked[sub] || Date.now() - blocked[sub].since < DECIDE_AFTER_MS || sub === att.sub) {
      return this.send(ws, this.statusMessage());
    }
    if (msg.action === "accept" && blocked[sub].reason !== "access") {
      this.acceptAs(sub, att);
    } else if (msg.action === "discard") {
      this.discardAuthor(sub, att);
    }
    this.broadcastStatus();
  }

  /**
   * The batches that stand or fall with `seed`: those, and every later
   * batch that touches what one of them (or of the batches it pulled in)
   * touched — transitively, groups included (touches carry group ids)
   */
  private closureFrom(seed: Set<Batch>) {
    const touched = new Set<string>();
    const members: Batch[] = [];
    for (const batch of this.pending) {
      if (seed.has(batch) || batch.touches.some((key) => touched.has(key))) {
        members.push(batch);
        batch.touches.forEach((key) => touched.add(key));
      }
    }
    return members;
  }

  private closureOf(sub: string) {
    return this.closureFrom(new Set(this.pending.filter((batch) => batch.author === sub)));
  }

  /**
   * Someone takes over a blocked author's changes: saved under their name,
   * recorded "on behalf of". The work built on them (the closure) is saved
   * after them, in order, as its own authors'.
   */
  private acceptAs(from: string, by: { sub: string; pseudonym: string; token?: string }) {
    if (!by.token && !this.q("SELECT 1 FROM tokens WHERE author = ?", by.sub).length) {
      return;
    }
    this.ctx.storage.transactionSync(() => {
      for (const batch of this.pending.filter((b) => b.author === from)) {
        batch.behalf = batch.behalf ?? batch.pseudonym;
        batch.author = by.sub;
        batch.pseudonym = by.pseudonym;
        this.storeBatch(batch);
      }
      if (by.token && !this.q("SELECT 1 FROM tokens WHERE author = ?", by.sub).length) {
        this.storeToken(by.sub, by.token);
      }
      const blocked = this.metaJson<Blocked>("blocked", {});
      delete blocked[from];
      this.setMeta("blocked", blocked);
      if (!this.pending.some((b) => b.author === from)) {
        this.dropToken(from);
      }
    });
    this.schedule("save", Date.now(), true);
  }

  /** a blocked author's changes are thrown away, with everything built on them */
  private discardAuthor(sub: string, by: Attachment) {
    if (!by.token) {
      return;
    }
    this.discardBatches(this.closureOf(sub), { sub: by.sub, pseudonym: by.pseudonym, token: by.token }, "discarded");
    const blocked = this.metaJson<Blocked>("blocked", {});
    delete blocked[sub];
    this.setMeta("blocked", blocked);
  }

  /**
   * Batches go (a discard, or invalid changes and what was built on them):
   * every counter is recorded (a resend is refused), the authors' tabs are
   * told (they keep their work as an offline copy), and the scene goes back
   * to what it would be without them, sent to every tab as a repair (deleted
   * subjects included) and saved by `by` like any change.
   */
  private discardBatches(gone: Batch[], by: { sub: string; pseudonym: string; token?: string }, reason: "discarded" | "invalid") {
    if (!gone.length) {
      return;
    }
    const goneSet = new Set(gone);
    const before = this.state;
    this.pending = this.pending.filter((b) => !goneSet.has(b));
    this.rebuildState();
    const seq = this.seq + 1;
    const entries: Entry[] = [];
    for (const key of new Set(gone.flatMap((b) => b.entries.map(keyOf)))) {
      const old = before.get(key)!;
      const back = this.state.get(key);
      if (back === old) {
        continue;
      }
      const v = old.v + 1;
      const n = randomNonce();
      if (back) {
        entries.push({ ...back, v, n, seq, t: OWN_TAB, u: seq, ...(back.r ? { r: { ...back.r, version: v, versionNonce: n } } : {}) });
      } else if (old.r) {
        // a new element of the discarded changes: deleted (nothing of it is kept)
        entries.push({ k: "el", id: old.id, c: "", v, n, a: by.pseudonym, seq, t: OWN_TAB, u: seq, r: { ...old.r, isDeleted: true, version: v, versionNonce: n } });
      }
    }
    const lookup = (id: string) => this.state.get(id);
    const repair: Batch = {
      seq,
      tab: OWN_TAB,
      counter: seq,
      author: by.sub,
      pseudonym: by.pseudonym,
      via: "user",
      live: true,
      at: Date.now(),
      entries,
      touches: [...new Set(entries.flatMap((entry) => touchesOf(entry, before.get(keyOf(entry)), lookup, (id) => before.get(id))))],
      origin: "repair",
      bytes: entries.reduce((sum, entry) => sum + sizeOf(entry), 0),
    };
    const authors = new Set(gone.map((batch) => batch.author));
    this.ctx.storage.transactionSync(() => {
      for (const batch of gone) {
        this.q("UPDATE batches SET state = 'discarded', data = '' WHERE seq = ?", batch.seq);
        this.q("DELETE FROM chunks WHERE seq = ?", batch.seq);
        this.addDiscarded(batch.tab, batch.counter);
      }
      this.seqNow = seq;
      if (entries.length) {
        this.storeBatch(repair);
        this.pending.push(repair);
        if (by.token && !this.q("SELECT 1 FROM tokens WHERE author = ?", by.sub).length) {
          this.storeToken(by.sub, by.token);
        }
      } else {
        this.checkpointSeq();
      }
      // tokens of authors with nothing left (the repair counts: its author keeps theirs)
      for (const author of authors) {
        if (!this.pending.some((b) => b.author === author)) {
          this.dropToken(author);
        }
      }
    });
    if (entries.length) {
      entries.forEach((entry) => this.setState(keyOf(entry), entry));
      this.broadcast({ type: "events", ...this.stamped(repair, entries.map((entry) => wireOf(entry))) });
      this.schedule("save", Date.now() + SAVE_EVERY_MS, true);
    }
    for (const batch of gone) {
      for (const { ws, att } of this.readySockets()) {
        if (att.tab === batch.tab) {
          this.refuse(ws, batch.counter, reason, [], reason === "invalid" ? "invalid or built on an invalid change" : "discarded, or built on discarded changes");
        }
      }
    }
  }

  /** after 7 days: changes nobody's work depends on go to the next editor who connects */
  private autoAcceptIndependent(att: Attachment) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    for (const [sub, info] of Object.entries(blocked)) {
      if (sub === att.sub || info.reason === "access" || Date.now() - info.since < AUTO_ACCEPT_AFTER_MS || this.dependents(sub).size) {
        continue;
      }
      this.acceptAs(sub, att);
    }
  }

  /** after 7 days: the next editor whose work depends on them accepts them */
  private autoAcceptDependency(att: Attachment) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    for (const [sub, info] of Object.entries(blocked)) {
      if (sub !== att.sub && info.reason !== "access" && Date.now() - info.since >= AUTO_ACCEPT_AFTER_MS && this.dependents(sub).has(att.sub)) {
        this.acceptAs(sub, att);
      }
    }
  }

  /** authors whose pending work builds on `sub`'s (the closure) */
  private dependents(sub: string) {
    return new Set(
      this.closureOf(sub)
        .map((batch) => batch.author)
        .filter((author) => author !== sub),
    );
  }

  // ---------------------------------------------------------------------------
  // tokens (sealed by the Worker; the lease is in their expiry)
  // ---------------------------------------------------------------------------

  private storeToken(sub: string, sealed: string) {
    const expires = sceneTokenExpiry(sealed);
    const had = this.q("SELECT 1 FROM tokens WHERE author = ?", sub).length > 0;
    this.q("INSERT OR REPLACE INTO tokens (author, sealed, expires) VALUES (?, ?, ?)", sub, sealed, expires);
    this.access.delete(sub);
    if (!had) {
      this.q("INSERT INTO outbox (sub, op) VALUES (?, 'add')", sub);
      this.schedule("outbox", Date.now(), true);
    }
    this.schedule("lease", expires, true);
  }

  private dropToken(sub: string) {
    if (this.q("SELECT 1 FROM tokens WHERE author = ?", sub).length) {
      this.q("DELETE FROM tokens WHERE author = ?", sub);
      this.q("INSERT INTO outbox (sub, op) VALUES (?, 'remove')", sub);
      this.schedule("outbox", Date.now(), true);
    }
    this.access.delete(sub);
  }

  private anyToken() {
    return this.q("SELECT author FROM tokens WHERE expires > ? LIMIT 1", Date.now())[0]?.author as string | undefined;
  }

  private lastAccessToken() {
    return this.lastAccess && this.lastAccess.expiresAt > Date.now() + 60_000 ? this.lastAccess : null;
  }

  /** leases that ran out: their tokens go, their authors' changes wait */
  private expireLeases() {
    const now = Date.now();
    for (const row of this.q("SELECT author FROM tokens WHERE expires <= ?", now)) {
      const sub = String(row.author);
      this.dropToken(sub);
      if (this.pending.some((batch) => batch.author === sub)) {
        this.markBlocked(sub, "token");
      }
    }
    const next = this.q("SELECT MIN(expires) AS at FROM tokens")[0]?.at;
    this.schedule("lease", next ? Number(next) : null);
  }

  /**
   * The account index (AccountGuard) learns which scenes hold this account's
   * token and which are open for it. Drained in order by one drain at a time
   * (alarm), stopping at the first failure (retried a minute later).
   */
  private flushOutbox() {
    const run = this.outboxChain.catch(() => {}).then(async () => {
      for (;;) {
        const row = this.q("SELECT id, sub, op FROM outbox ORDER BY id LIMIT 1")[0];
        if (!row) {
          return;
        }
        // what is true now is sent (an old "disconnect" must not undo a newer connection's registration)
        const sub = String(row.sub);
        const stale =
          (row.op === "disconnect" && this.ctx.getWebSockets(`sub:${sub}`).length > 0) ||
          (row.op === "remove" && this.q("SELECT 1 FROM tokens WHERE author = ?", sub).length > 0) ||
          (row.op === "add" && !this.q("SELECT 1 FROM tokens WHERE author = ?", sub).length);
        if (stale) {
          this.q("DELETE FROM outbox WHERE id = ?", row.id);
          continue;
        }
        try {
          const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(String(row.sub)));
          const res = await stub.fetch(`https://account/scene-${row.op}`, { method: "POST", body: JSON.stringify({ fileId: this.fileId }) });
          if (!res.ok) {
            throw new Error(String(res.status));
          }
          this.q("DELETE FROM outbox WHERE id = ?", row.id);
        } catch {
          this.schedule("outbox", Date.now() + 60_000, true);
          return;
        }
      }
    });
    this.outboxChain = run.catch(() => {});
    return run;
  }

  /** an author's access token: from the stored refresh token (checked against sign out everywhere) */
  private async accessFor(sub: string): Promise<{ token: string } | { problem: "token" | "unreachable" }> {
    const cached = this.access.get(sub);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
      return { token: cached.token };
    }
    const row = this.q("SELECT sealed, expires FROM tokens WHERE author = ?", sub)[0];
    if (!row || Number(row.expires) <= Date.now()) {
      return { problem: "token" };
    }
    const sealed = await unsealSceneToken(this.env, String(row.sealed), this.fileId, sub);
    if (!sealed) {
      this.dropToken(sub);
      return { problem: "token" };
    }
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(sub));
      const { epoch } = (await (await stub.fetch("https://account/epoch")).json()) as { epoch: number };
      if (epoch && sealed.iat < epoch) {
        this.dropToken(sub);
        return { problem: "token" };
      }
    } catch {
      return { problem: "unreachable" };
    }
    const exchangeStarted = Date.now();
    const answer = await accessFromRefresh(this.env, sealed.r);
    if (this.devOn) {
      this.countDrive("POST oauth/token", Date.now() - exchangeStarted);
    }
    if (answer === "unreachable") {
      return { problem: "unreachable" };
    }
    if (answer === "expired") {
      this.dropToken(sub);
      return { problem: "token" };
    }
    this.access.set(sub, answer);
    this.lastAccess = { sub, ...answer };
    return { token: answer.token };
  }

  /** any credential that reads the file: a stored author's, or the last one that worked here */
  private async anyAccess(): Promise<{ sub: string; token: string } | "unreachable" | null> {
    for (const row of this.q("SELECT author FROM tokens WHERE expires > ?", Date.now())) {
      const access = await this.accessFor(String(row.author));
      if ("token" in access) {
        return { sub: String(row.author), token: access.token };
      }
      if (access.problem === "unreachable") {
        return "unreachable";
      }
    }
    return this.lastAccessToken();
  }

  // ---------------------------------------------------------------------------
  // timers: one alarm, many kinds (the schedule table); a job stays until done
  // ---------------------------------------------------------------------------

  /** `at` null: cancel; `earlier`: only if sooner than what is planned */
  private schedule(kind: string, at: number | null, earlier = false) {
    if (at === null) {
      this.q("DELETE FROM schedule WHERE kind = ?", kind);
    } else {
      const row = this.q("SELECT at FROM schedule WHERE kind = ?", kind)[0];
      const running = this.runningKind === kind && row && Number(row.at) <= Date.now();
      if (row && !running && (Number(row.at) === at || (earlier && Number(row.at) <= at))) {
        return;
      }
      this.q("INSERT OR REPLACE INTO schedule (kind, at) VALUES (?, ?)", kind, at);
    }
    this.armAlarm();
  }

  private armAlarm() {
    if (this.alarmRunning) {
      return; // set when the running alarm finishes
    }
    const next = this.q("SELECT MIN(at) AS at FROM schedule")[0]?.at;
    const at = next === null || next === undefined ? null : Math.max(Number(next), Date.now() + 10);
    if (at !== this.alarmAt) {
      this.alarmAt = at;
      if (at === null) {
        void this.ctx.storage.deleteAlarm();
      } else {
        void this.ctx.storage.setAlarm(at);
      }
    }
  }

  async alarm() {
    const started = Date.now();
    if (this.devOn) {
      this.metrics.alarms++;
    }
    try {
      await this.runAlarm();
    } finally {
      this.countHandler("alarm", started);
    }
  }

  private async runAlarm() {
    this.alarmAt = null;
    this.alarmRunning = true;
    try {
      this.load();
      // an unfinished save (recorded upload, audit) always gets its round, also after a crash
      if (this.q("SELECT 1 FROM saves WHERE state IN ('prepared', 'audit') LIMIT 1").length) {
        const row = this.q("SELECT at FROM schedule WHERE kind = 'save'")[0];
        if (!row || Number(row.at) > Date.now()) {
          this.q("INSERT OR REPLACE INTO schedule (kind, at) VALUES ('save', ?)", Date.now());
        }
      }
      const due = this.q("SELECT kind, at FROM schedule WHERE at <= ? ORDER BY at", Date.now());
      for (const { kind, at } of due) {
        this.runningKind = String(kind);
        try {
          await this.runTimer(String(kind));
        } catch (error: any) {
          // never content: the kind and the error's message
          console.warn(`[scene] ${kind} failed: ${error?.message ?? error}`);
          this.loaded = false;
          this.load();
          // the job stays (a little later), it is not lost
          this.q("UPDATE schedule SET at = ? WHERE kind = ? AND at = ?", Date.now() + 10_000, kind, at);
          continue;
        }
        // done: taken off, unless it was planned again meanwhile
        this.q("DELETE FROM schedule WHERE kind = ? AND at = ?", kind, at);
      }
    } finally {
      this.runningKind = null;
      this.alarmRunning = false;
      this.armAlarm();
    }
  }

  private async runTimer(kind: string) {
    switch (kind) {
      case "save":
        return this.saveRound();
      case "cleanup":
        return this.cleanup();
      case "retention":
        return this.retention();
      case "lease":
        return this.expireLeases();
      case "outbox":
        return this.flushOutbox();
      case "proofs":
        this.sweep();
        this.sweepAssemblies();
        return this.scheduleSweep();
      case "outside":
        return this.withDrive(() => this.outsideCheck());
      case "verify":
        return this.withDrive(() => this.verifyAccess());
      case "recheck":
        return this.withDrive(() => this.recheckAccess());
      case "trash-check":
        return this.withDrive(() => this.trashCheck());
      case "watch-stop":
        return this.withDrive(() => this.stopWatch());
      case "trash-expire":
        if (this.lifecycle().state === "trashed" || this.lifecycle().state === "deleted") {
          this.wipeContent();
        }
        return;
      case "closing":
        if (this.lifecycle().state === "closing") {
          this.setLifecycle("active");
        }
        this.setMeta("closingBy", null);
        return;
    }
  }

  /**
   * Retention (daily, and from cleanup): what is kept per account has a
   * bound, enforced here and not only when it is touched.
   *   tabs (tab id, account, counters, last seen)   30 days after the tab's last connection
   *   saved receipts (tab ids, counters)             30 days after the tab's last saved change
   *   discarded batch rows (account, no content)     30 days after the change was made
   *   changes of an author who can't be saved as      90 days after they became blocked (lost access: 7 days), with what was built on them
   *   refused-renewal marks (account id)              1 day
   *   finished save records (account)                 30 days
   *   "sign out everywhere" marks                     400 days (the longest a session from before could be presented)
   *   confirmed-access times                          15 minutes
   *   one-time tickets, collision losers, keep-local permissions, expired watch records: when they run out
   */
  private async retention() {
    const now = Date.now();
    const horizon = now - REPLAY_HORIZON_MS;
    this.q("DELETE FROM nonces WHERE until < ?", now);
    this.q("DELETE FROM losers WHERE until < ?", now);
    this.q("DELETE FROM saves WHERE state = 'done' AND at < ?", horizon);
    // first blocked changes past their deadline become discarded rows (kept 30 days like any discard)
    this.expireBlocked(now - BLOCKED_KEPT_MS);
    const old = this.q("SELECT seq, tab, counter FROM batches WHERE state = 'discarded' AND at < ?", horizon);
    this.ctx.storage.transactionSync(() => {
      for (const row of old) {
        this.deleteBatchRow(Number(row.seq), false);
        this.discarded.get(String(row.tab))?.delete(Number(row.counter));
      }
      this.checkpointSeq();
      this.q("DELETE FROM tabs WHERE seen < ?", horizon);
      const receipts = this.metaJson<Record<string, SavedReceipt>>("receipts", {});
      for (const [tab, receipt] of Object.entries(receipts)) {
        if (receipt.at < horizon) {
          delete receipts[tab];
        }
      }
      this.setMeta("receipts", Object.keys(receipts).length ? receipts : null);
      const forgotten = this.metaJson<Record<string, number>>("forgotten", {});
      for (const [sub, at] of Object.entries(forgotten)) {
        if (now - at > REVOCATION_KEPT_MS) {
          delete forgotten[sub];
        }
      }
      this.setMeta("forgotten", Object.keys(forgotten).length ? forgotten : null);
      const revokedMarks = this.metaJson<Record<string, number>>("revoked", {});
      for (const [sub, at] of Object.entries(revokedMarks)) {
        if (now - at > DAY_MS) {
          delete revokedMarks[sub];
        }
      }
      this.setMeta("revoked", Object.keys(revokedMarks).length ? revokedMarks : null);
      const confirmed = this.metaJson<Record<string, number>>("confirmed", {});
      for (const [sub, at] of Object.entries(confirmed)) {
        if (now - at > CONFIRMED_FRESH_MS) {
          delete confirmed[sub];
        }
      }
      this.setMeta("confirmed", Object.keys(confirmed).length ? confirmed : null);
      if ((this.metaJson<{ until: number } | null>("keepLocalOk", null)?.until ?? Infinity) < now) {
        this.setMeta("keepLocalOk", null);
      }
      if ((this.metaJson<{ until: number } | null>("channelPending", null)?.until ?? Infinity) < now) {
        this.setMeta("channelPending", null);
      }
      if ((this.metaJson<{ expiration: number } | null>("channel", null)?.expiration ?? Infinity) < now) {
        this.setMeta("channel", null);
        this.setMeta("watchStop", null);
      }
      const blocked = this.metaJson<Blocked>("blocked", {});
      for (const sub of Object.keys(blocked)) {
        if (!this.pending.some((batch) => batch.author === sub)) {
          delete blocked[sub];
        }
      }
      this.setMeta("blocked", Object.keys(blocked).length ? blocked : null);
    });
    const left =
      this.q("SELECT 1 FROM tabs LIMIT 1").length ||
      this.q("SELECT 1 FROM batches LIMIT 1").length ||
      this.q("SELECT 1 FROM saves LIMIT 1").length ||
      this.meta("forgotten") ||
      this.meta("confirmed");
    this.schedule("retention", left ? now + DAY_MS : null);
  }

  /**
   * Changes of authors blocked longer than 90 days (nobody accepted them):
   * they go, with what was built on them; Drive never had them, so the scene
   * just goes back (connected tabs get the repair, their batches are refused)
   */
  private expireBlocked(deadline: number) {
    const blocked = this.metaJson<Blocked>("blocked", {});
    // lost access: discarded 7 days after (never accepted); other reasons: 90 days
    const accessDeadline = Date.now() - ACCESS_LOST_KEPT_MS;
    const expired = new Set(
      Object.entries(blocked)
        .filter(([, info]) => info.since < (info.reason === "access" ? accessDeadline : deadline))
        .map(([sub]) => sub),
    );
    const old = this.pending.filter((batch) => expired.has(batch.author));
    if (!old.length) {
      return;
    }
    const gone = this.closureFrom(new Set(old));
    const goneSet = new Set(gone);
    const before = this.state;
    this.ctx.storage.transactionSync(() => {
      for (const batch of gone) {
        this.q("UPDATE batches SET state = 'discarded', data = '' WHERE seq = ?", batch.seq);
        this.q("DELETE FROM chunks WHERE seq = ?", batch.seq);
        this.addDiscarded(batch.tab, batch.counter);
      }
      this.pending = this.pending.filter((batch) => !goneSet.has(batch));
      for (const author of new Set(gone.map((batch) => batch.author))) {
        if (!this.pending.some((batch) => batch.author === author)) {
          this.dropToken(author);
        }
      }
      this.seqNow = this.seq + 1;
      this.checkpointSeq();
      this.setMeta("maxDeleted", String(this.seq));
      for (const sub of expired) {
        delete blocked[sub];
      }
      this.setMeta("blocked", Object.keys(blocked).length ? blocked : null);
    });
    this.rebuildState();
    const changed = [...new Set(gone.flatMap((batch) => batch.entries.map(keyOf)))]
      .map((key) => this.state.get(key))
      .filter((entry): entry is Entry => !!entry && entry !== before.get(keyOf(entry)));
    if (changed.length) {
      this.broadcast({ type: "events", seq: this.seq, author: "kurviq", pseudonym: "kurviq", name: null, tab: OWN_TAB, via: "user", origin: "repair", events: changed.map((entry) => wireOf(entry)) });
    }
    for (const batch of gone) {
      for (const { ws, att } of this.readySockets()) {
        if (att.tab === batch.tab) {
          this.refuse(ws, batch.counter, "discarded", [], "not saved within 90 days");
        }
      }
    }
  }

  /**
   * Nobody connected for 10 minutes and everything in Drive: content leaves
   * active storage, and with it what was kept about the people who worked on
   * it (owner, on-behalf records, errors naming pseudonyms, finished save records)
   */
  private async cleanup() {
    await this.retention();
    if (this.sockets().length || this.pending.length || !this.seeded()) {
      return;
    }
    this.snap = new Map();
    this.ctx.storage.transactionSync(() => {
      this.q("DELETE FROM snapshot");
      this.q("DELETE FROM saves WHERE state = 'done'");
      for (const key of ["seeded", "owner", "onBehalf", "error", "blocked", "keepLocalOk", "closingBy", "confirmed", "needTokenAt"]) {
        this.setMeta(key, null);
      }
      this.setMeta("maxDeleted", String(this.seq));
      this.checkpointSeq();
    });
    this.rebuildState();
  }

  /**
   * The last connection left: the watch is stopped. Google lets only the
   * channel's creator stop it, so this needs their credential (their stored
   * token, or the last access that worked here, if it was theirs); until then
   * the obligation stays (retried, dropped when the channel runs out or
   * someone connects again and it is wanted).
   */
  private async stopWatch() {
    if (this.sockets().length || this.meta("watchStop") !== "1") {
      this.setMeta("watchStop", null);
      return;
    }
    const channel = this.metaJson<{ id: string; resourceId: string; expiration: number; creator?: string } | null>("channel", null);
    if (!channel || channel.expiration < Date.now()) {
      this.setMeta("channel", null);
      this.setMeta("watchStop", null);
      return;
    }
    const creator = channel.creator ?? "";
    let token: string | null = null;
    if (this.q("SELECT 1 FROM tokens WHERE author = ?", creator).length) {
      const access = await this.accessFor(creator);
      token = "token" in access ? access.token : null;
    }
    if (!token && this.lastAccessToken()?.sub === creator) {
      token = this.lastAccessToken()!.token;
    }
    if (!token) {
      this.schedule("watch-stop", Math.min(channel.expiration + 1000, Date.now() + 15 * 60_000));
      return;
    }
    const answer = await this.dcall(`${driveUrls(this.env).api}/channels/stop`, token, {
      method: "POST",
      json: { id: channel.id, resourceId: channel.resourceId },
    });
    if (answer.status === 200 || answer.status === 204 || answer.status === 404) {
      this.setMeta("channel", null);
      this.setMeta("watchStop", null);
      return;
    }
    // refused or Google down: the obligation stays
    this.schedule("watch-stop", Date.now() + (answer.status === 0 || answer.status >= 500 ? 60_000 : 15 * 60_000));
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  private setLifecycle(state: Lifecycle, epoch = this.lifecycle().epoch) {
    this.setMeta("lifecycle", { state, epoch });
  }

  /** content, tokens and save records go (metadata, generation and lifecycle stay) */
  private wipeContent() {
    const subs = this.q("SELECT author FROM tokens").map((row) => String(row.author));
    this.ctx.storage.transactionSync(() => {
      // the counters of what goes stay known (a resend is not taken as new)
      for (const batch of this.pending) {
        this.foldCounters(batch.tab, [batch.counter]);
      }
      for (const [tab, counters] of this.discarded) {
        this.foldCounters(tab, [...counters]);
      }
      for (const table of ["snapshot", "batches", "chunks", "losers", "saves"]) {
        this.q(`DELETE FROM ${table}`);
      }
      subs.forEach((sub) => this.dropToken(sub));
      this.checkpointSeq();
      this.setMeta("seeded", null);
      this.setMeta("maxDeleted", String(this.seq));
      this.setMeta("blocked", null);
      this.setMeta("outsideWanted", null);
      this.setMeta("verifyWanted", null);
      for (const key of ["owner", "onBehalf", "error", "keepLocalOk", "confirmed", "needTokenAt"]) {
        this.setMeta(key, null);
      }
    });
    this.snap = new Map();
    this.pending = [];
    this.discarded = new Map();
    this.rebuildState();
    this.schedule("save", null);
  }

  /** in the trash (Kurviq's Delete, Drive's interface, or seen before a save): saving stops, changes kept 7 days */
  private async toTrash() {
    await this.driveChain.catch(() => {});
    this.toTrashNow();
  }

  private toTrashNow() {
    if (this.lifecycle().state !== "active") {
      return;
    }
    this.setLifecycle("trashed");
    this.schedule("save", null);
    this.schedule("trash-expire", Date.now() + TRASH_KEEP_MS);
    this.broadcastStatus();
  }

  /** back from the trash (or found again): a new epoch, the tabs reload; older changes stay recoverable as copies in the browsers */
  private restored() {
    const lifecycle = this.lifecycle();
    if (lifecycle.state === "deleted") {
      // Drive shows the file after all: the tombstone was wrong, nothing is lost
      this.setLifecycle("active");
      this.schedule("trash-expire", null);
      this.setMeta("error", null);
      this.broadcastStatus();
      return;
    }
    if (lifecycle.state !== "trashed") {
      return;
    }
    this.wipeContent();
    this.setLifecycle("active", lifecycle.epoch + 1);
    this.schedule("trash-expire", null);
    for (const { ws } of this.sockets()) {
      this.close(ws, "replaced");
    }
  }

  /** Drive says the file is gone (to an editor who had access minutes ago): a tombstone; content kept 7 days, then wiped */
  private deleted() {
    this.setLifecycle("deleted");
    this.schedule("save", null);
    this.schedule("trash-expire", Date.now() + TRASH_KEEP_MS);
    this.setMeta("channel", null);
    this.setMeta("verifyWanted", null);
    for (const { ws } of this.sockets()) {
      this.close(ws, "deleted");
    }
  }

  /**
   * A `remove` notification: deleted, or unshared from the watch's maker.
   * Checked with every account that may still have access (the owner
   * first). Google answers "not found" for a file someone may not read, so
   * one editor's "not found" means only that they lost access. Only the
   * owner's "not found" is evidence of a deletion (a tombstone, content kept
   * 7 days). Without an answer either way, everything is kept ("access-unknown")
   * and the check is repeated.
   */
  private async verifyAccess(oneTime?: { sub: string; token: string }) {
    if (this.meta("verifyWanted") !== "1") {
      return;
    }
    const owner = this.meta("owner");
    const candidates: Array<{ sub: string; token: string }> = oneTime ? [oneTime] : [];
    for (const row of this.q("SELECT author FROM tokens WHERE expires > ?", Date.now())) {
      if (candidates.some((c) => c.sub === row.author)) {
        continue;
      }
      const access = await this.accessFor(String(row.author));
      if ("token" in access) {
        candidates.push({ sub: String(row.author), token: access.token });
      } else if (access.problem === "unreachable") {
        this.schedule("verify", Date.now() + 60_000);
        return;
      }
    }
    const last = this.lastAccessToken();
    if (last && !candidates.some((c) => c.sub === last.sub)) {
      candidates.push(last);
    }
    candidates.sort((a, b) => (a.sub === owner ? 0 : 1) - (b.sub === owner ? 0 : 1));
    for (const { sub, token } of candidates) {
      const file = await getFile(this.genv, token, this.fileId);
      if (file.status === 200) {
        if (file.data.trashed) {
          this.toTrashNow();
        } else {
          this.confirmed(sub);
          await this.moveWatch(token, sub);
        }
        this.setMeta("verifyWanted", null);
        if (this.meta("error") === "access-unknown") {
          this.setError(null);
        }
        return;
      }
      if (isTransient(problemOf(file))) {
        this.schedule("verify", Date.now() + 60_000);
        return;
      }
      if (file.status === 404 && sub === owner) {
        this.deleted();
        return;
      }
      // this person lost access themselves
      if (this.pending.some((batch) => batch.author === sub)) {
        this.markBlocked(sub, "access");
      }
      if (this.lastAccess?.sub === sub) {
        this.lastAccess = null;
      }
    }
    // no one could tell: keep everything, ask a tab (the owner's first), look again later
    this.setError("access-unknown");
    this.requestToken(owner);
    this.schedule("verify", Date.now() + 15 * 60_000);
  }

  /** the watch's maker lost access: their channel ends (stopped if `sub` made it); the next renewal by an editor makes a new one */
  private async moveWatch(token: string, sub: string) {
    const channel = this.metaJson<{ id: string; resourceId: string; creator?: string } | null>("channel", null);
    if (channel && channel.creator === sub) {
      await this.dcall(`${driveUrls(this.env).api}/channels/stop`, token, { method: "POST", json: { id: channel.id, resourceId: channel.resourceId } });
    }
    this.setMeta("channel", null);
    this.setMeta("channelPending", null);
    this.broadcast({ type: "renew-now" });
  }

  /**
   * "Keep only here": only after the Worker checked with Drive that this
   * person owns the file and it is shared with nobody (keep-local route), no
   * other connection (ready or not), nobody else's unsaved changes; checked
   * again after a running save finished. Then the final state.
   */
  private async onKeepLocal(ws: WebSocket, att: Attachment) {
    const answer = (reason: string) => this.send(ws, { type: "keep-local", ok: false, reason });
    const allowed = () => {
      const ok = this.metaJson<{ sub: string; until: number } | null>("keepLocalOk", null);
      if (!ok || ok.sub !== att.sub || ok.until < Date.now()) {
        return "shared";
      }
      if (this.sweep().some((other) => other.ws !== ws)) {
        return "connected";
      }
      if (this.pending.some((batch) => batch.author !== att.sub)) {
        return "others-pending";
      }
      return null;
    };
    if (att.role !== "edit" || this.lifecycle().state !== "active") {
      return answer("lifecycle");
    }
    const first = allowed();
    if (first) {
      return answer(first);
    }
    // closed first: no new connections or writes; a running save finishes
    this.setLifecycle("closing");
    this.setMeta("closingBy", att.sub);
    this.schedule("closing", Date.now() + CLOSING_MS);
    await this.driveChain.catch(() => {});
    const again = this.lifecycle().state === "closing" ? allowed() : "lifecycle";
    if (again) {
      if (this.lifecycle().state === "closing") {
        this.setLifecycle("active");
      }
      this.schedule("closing", null);
      return answer(again);
    }
    this.setMeta("keepLocalOk", null);
    this.send(ws, { type: "keep-local", ok: true, state: this.fullState() });
  }

  private onKeepLocalDone(ws: WebSocket, att: Attachment) {
    if (this.lifecycle().state !== "closing" || this.meta("closingBy") !== att.sub) {
      return;
    }
    this.wipeContent();
    this.setLifecycle("local");
    this.setMeta("closingBy", null);
    this.schedule("closing", null);
    for (const { ws: other } of this.sockets()) {
      this.close(other, "local");
    }
  }

  // ---------------------------------------------------------------------------
  // saving
  // ---------------------------------------------------------------------------

  /** one Drive procedure at a time (saves, merges, checks); new batches keep coming meanwhile */
  private withDrive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.driveChain.catch(() => {}).then(fn);
    this.driveChain = run.catch(() => {});
    return run;
  }

  private retryLater(problem: string) {
    const failures = this.num("failures") + 1;
    this.setMeta("failures", String(failures));
    this.setError(problem);
    this.schedule("save", Date.now() + Math.min(SAVE_EVERY_MS * 2 ** (failures - 1), 30 * 60_000));
  }

  /**
   * The next group of the per-author walk, or null when nothing can be saved
   * now. A batch of the author with the other `via` ends the group: what
   * came after it waits for the next one (user → agent → user stays in order).
   */
  private planGroup(skip: Set<string>): Batch[] | null {
    const now = Date.now();
    const tokens = new Set(this.q("SELECT author FROM tokens WHERE expires > ?", now).map((row) => String(row.author)));
    const blocked = this.metaJson<Blocked>("blocked", {});
    const savable = (sub: string) => tokens.has(sub) && !blocked[sub] && !skip.has(sub);
    const candidates: Array<{ author: string; via: string }> = [];
    for (const batch of this.pending) {
      if (savable(batch.author) && !candidates.some((c) => c.author === batch.author && c.via === batch.via)) {
        candidates.push({ author: batch.author, via: batch.via });
      }
    }
    for (const candidate of candidates) {
      const blockedKeys = new Set<string>();
      const group: Batch[] = [];
      let ended = false;
      for (const batch of this.pending) {
        const mine = batch.author === candidate.author;
        if (mine && batch.via !== candidate.via) {
          ended = true;
        }
        if (mine && !ended && batch.via === candidate.via && !batch.touches.some((key) => blockedKeys.has(key))) {
          group.push(batch);
        } else {
          batch.touches.forEach((key) => blockedKeys.add(key));
        }
      }
      if (group.length) {
        return group;
      }
    }
    return null;
  }

  private async saveRound() {
    await this.withDrive(async () => {
      try {
        await this.saveRoundLocked();
      } finally {
        this.roundKey = null;
      }
    });
  }

  private async saveRoundLocked() {
    this.load();
    if (this.lifecycle().state !== "active" || !this.seeded()) {
      return;
    }
    this.expireLeases();
    this.q("DELETE FROM losers");
    if (!(await this.recoverSaves())) {
      return;
    }
    const skip = new Set<string>();
    let versions = 0;
    let merges = 0;
    while (versions < MAX_VERSIONS_PER_ROUND) {
      const group = this.planGroup(skip);
      if (!group) {
        break;
      }
      const author = group[0].author;
      const access = await this.accessFor(author);
      if ("problem" in access) {
        if (access.problem === "unreachable") {
          return this.retryLater("google-unreachable");
        }
        this.markBlocked(author, "token");
        skip.add(author);
        continue;
      }
      const file = await getFile(this.genv, access.token, this.fileId);
      if (file.status !== 200) {
        const problem = problemOf(file);
        if (isTransient(problem) || problem === "other") {
          return this.retryLater(problem);
        }
        // Google answers "not found" also when access was removed: for an author who made edits, that is lost access
        this.markBlocked(author, problem === "token" ? "token" : "access");
        skip.add(author);
        continue;
      }
      this.confirmed(author);
      if (file.data.trashed) {
        this.toTrashNow();
        return;
      }
      if (file.data.capabilities?.canEdit === false) {
        this.markBlocked(author, "access");
        skip.add(author);
        continue;
      }
      const key = await this.keyFrom(file);
      if (!key) {
        return this.retryLater(this.meta("error") || "key-missing");
      }
      this.setDriveName(file.data.name);
      if (this.meta("seedCheck") === "1" && !(await this.verifySeedRecord(access.token))) {
        return this.retryLater("google-unreachable");
      }
      // a version Drive has that we did not write: merged first, then the walk starts again
      if (file.data.headRevisionId !== this.lastSaved().revision) {
        if (++merges > 2) {
          return this.retryLater("outside-busy");
        }
        if ((await this.mergeOutside(access.token, key, file.data)) === "retry") {
          return this.retryLater("google-unreachable");
        }
        continue;
      }
      const result = await this.upload(group, access.token, key);
      if (result === "retry") {
        return;
      }
      if (result === "replan") {
        continue;
      }
      if (typeof result === "object") {
        this.markBlocked(author, result.blocked);
        skip.add(author);
        continue;
      }
      versions++;
    }
    if (versions) {
      this.setMeta("failures", null);
      if (["google-unreachable", "rate-limited", "drive-full", "save-failed", "outside-busy"].includes(this.meta("error") || "")) {
        this.setError(null);
      }
    }
    // more groups than one round may write: the next round starts at once
    if (versions >= MAX_VERSIONS_PER_ROUND && this.planGroup(new Set())) {
      this.schedule("save", Date.now() + 100);
    }
    // a watch that should stop and waited for a credential
    if (this.meta("watchStop") === "1") {
      this.schedule("watch-stop", Date.now(), true);
    }
    this.broadcastStatus();
  }

  /** the scene key from the file (fetched with the author's access, kept for this round only) */
  private async keyFrom(file: DriveAnswer): Promise<SceneKey | null> {
    if (this.roundKey) {
      return this.roundKey;
    }
    const parsed = await parseKeyProperty(file.data?.appProperties?.[KEY_PROPERTY], this.fileId);
    const known = this.meta("keyId");
    if (!parsed || parsed.copy) {
      this.setError("key-missing");
      return null;
    }
    if (parsed.keyId !== known) {
      this.setError("key-changed");
      return null;
    }
    this.roundKey = await importSceneKey(parsed.key, parsed.keyId, this.fileId);
    if (["key-missing", "key-changed"].includes(this.meta("error") || "")) {
      this.setError(null);
    }
    return this.roundKey;
  }

  /** plain values of a set of entries; entries that don't decrypt or aren't valid are reported */
  private async decryptAll(key: SceneKey, entries: Iterable<[string, Entry]>) {
    const plain: Plain = new Map();
    const bad: Entry[] = [];
    for (const [k, entry] of entries) {
      try {
        const value = await plainOf(key, entry);
        if (entry.k === "el" && !validElement(value)) {
          throw new Error("invalid element");
        }
        plain.set(k, { k: entry.k, id: entry.id, value });
      } catch {
        bad.push(entry);
      }
    }
    return { plain, bad };
  }

  /** receipts for a file that contains everything saved so far plus `extra` batches */
  private receiptsWith(extra: Batch[]) {
    const all = this.metaJson<Record<string, SavedReceipt>>("receipts", {});
    const now = Date.now();
    const extraSet = new Set(extra);
    for (const tab of new Set(extra.map((batch) => batch.tab))) {
      if (tab === OWN_TAB) {
        continue;
      }
      // everything known of the tab that is not still pending (saved, given up or discarded)
      const stillPending = new Set(this.pending.filter((b) => b.tab === tab && !extraSet.has(b)).map((b) => b.counter));
      const receipt = receiptMinus(this.knownCounters(tab), stillPending);
      all[tab] = { ...receipt, at: now };
    }
    for (const [tab, receipt] of Object.entries(all)) {
      if (now - receipt.at > REPLAY_HORIZON_MS) {
        delete all[tab];
      }
    }
    return all;
  }

  /**
   * One Drive version: the last save plus, for each subject of the group,
   * its state from the group's last event. Drive's head is checked right
   * before uploading (a write that landed meanwhile is merged first); the
   * operation is recorded (id, checksum, base, the file's receipts and
   * on-behalf list), committed in one transaction when Drive confirms, then
   * audited (a foreign revision just before ours). `repairOf`: this version
   * repairs that operation's audit (it is finished in the same transaction).
   */
  private async upload(
    group: Batch[],
    token: string,
    key: SceneKey,
    behalfOutside = false,
    repairOf?: string,
  ): Promise<"ok" | "retry" | "replan" | { blocked: BlockedAuthor["reason"] }> {
    const last = new Map<string, Entry>();
    for (const batch of group) {
      batch.entries.forEach((entry) => last.set(keyOf(entry), entry));
    }
    const next = new Map(this.snap);
    last.forEach((entry, k) => next.set(k, entry));
    const { plain, bad } = await this.decryptAll(key, next);
    // an invalid change is set aside, with everything built on it (its authors are told) and never reaches Drive
    const badBatches = group.filter((batch) => batch.entries.some((entry) => bad.includes(entry)));
    if (badBatches.length) {
      this.setAside(badBatches, group[0]);
      return "replan";
    }
    const author = group[0]?.author ?? this.lastAccess?.sub ?? this.anyToken() ?? "";
    const pseudonym = group[0]?.pseudonym ?? this.pseudonymOfSub(author) ?? "kurviq";
    const op = crypto.randomUUID();
    const receipts = this.receiptsWith(group);
    const authors: Record<string, string> = {};
    for (const entry of next.values()) {
      if (entry.k === "el" && entry.a && !entry.r?.isDeleted) {
        authors[entry.id] = entry.a;
      }
    }
    const onBehalf = this.metaJson<Array<{ by: string; for: string; at: number }>>("onBehalf", []);
    for (const behalf of new Set(group.map((batch) => batch.behalf).filter((value): value is string => !!value))) {
      onBehalf.push({ by: pseudonym, for: behalf, at: Date.now() });
    }
    if (behalfOutside) {
      onBehalf.push({ by: pseudonym, for: "outside", at: Date.now() });
    }
    const keptOnBehalf = onBehalf.slice(-ON_BEHALF_KEPT);
    const { json: text, name } = buildSceneFile(plain, { op, receipts, authors, onBehalf: keptOnBehalf });
    const bytes = new TextEncoder().encode(text);
    const md5 = await md5Hex(bytes);
    const base = this.lastSaved();
    const metadata: Record<string, unknown> = { appProperties: { kurviqSync: LIVE_MARKER } };
    if (name && group.some((batch) => batch.entries.some((entry) => entry.k === "name"))) {
      metadata.name = `${name}.excalidraw`;
    }
    // the head right before uploading: a write that landed since the round's check is merged first
    const head = await getFile(this.genv, token, this.fileId, "headRevisionId");
    if (head.status !== 200) {
      const problem = problemOf(head);
      if (problem === "token" || problem === "access" || problem === "not-picked") {
        return { blocked: problem === "token" ? "token" : "access" };
      }
      this.retryLater(isTransient(problem) ? problem : "save-failed");
      return "retry";
    }
    if (head.data?.headRevisionId !== base.revision) {
      return "replan";
    }
    this.q(
      "INSERT INTO saves (op, state, batches, md5, base, author, at, rev, keys, meta) VALUES (?, 'prepared', ?, ?, ?, ?, ?, NULL, ?, ?)",
      op,
      JSON.stringify(group.map((batch) => batch.seq)),
      md5,
      base.revision,
      author,
      Date.now(),
      JSON.stringify([...last.keys()]),
      // exactly what the file says: a recovered commit records the same receipts and on-behalf list
      JSON.stringify({ receipts, onBehalf: keptOnBehalf, repairOf: repairOf ?? null }),
    );
    await this.devRace(token);
    const answer = await uploadVersion(this.genv, token, this.fileId, metadata, bytes);
    this.crashPoint("after-upload");
    if (answer.status !== 200 || !answer.data?.headRevisionId) {
      if (answer.status === 0) {
        // no answer: it may have landed; the next round looks for its checksum
        this.retryLater("google-unreachable");
        return "retry";
      }
      this.q("DELETE FROM saves WHERE op = ?", op);
      const problem = problemOf(answer);
      if (problem === "token" || problem === "access" || problem === "not-picked") {
        return { blocked: problem === "token" ? "token" : "access" };
      }
      this.retryLater(isTransient(problem) ? problem : "save-failed");
      return "retry";
    }
    const revision = String(answer.data.headRevisionId);
    this.lastAccess = { sub: author, token, expiresAt: this.access.get(author)?.expiresAt ?? Date.now() + 30 * 60_000 };
    this.commitSave(op, group, last, revision, String(answer.data.md5Checksum || md5), receipts, keptOnBehalf, repairOf);
    this.setDriveName(answer.data.name);
    this.crashPoint("after-commit");
    await this.audit(op, token, key);
    await this.pinAfter(token, base, revision, group[0]?.via === "agent");
    return "ok";
  }

  private commitSave(
    op: string,
    group: Batch[],
    last: Map<string, Entry>,
    revision: string,
    md5: string,
    receipts: Record<string, SavedReceipt>,
    onBehalf: unknown[],
    repairOf?: string | null,
  ) {
    const seqs = new Set(group.map((batch) => batch.seq));
    this.ctx.storage.transactionSync(() => {
      last.forEach((entry, k) => this.snap.set(k, entry));
      this.writeSnapshot();
      const byTab = new Map<string, number[]>();
      for (const batch of group) {
        this.deleteBatchRow(batch.seq, !!batch.chunked);
        byTab.set(batch.tab, [...(byTab.get(batch.tab) ?? []), batch.counter]);
      }
      // the saved counters move into the tabs' checkpoints, the seq into meta
      byTab.forEach((counters, tab) => this.foldCounters(tab, counters));
      this.checkpointSeq();
      this.setMeta("maxDeleted", String(Math.max(this.num("maxDeleted"), ...seqs, 0)));
      this.setMeta("receipts", receipts);
      this.setMeta("lastSaved", { revision, md5, at: Date.now() });
      this.setMeta("ownRevs", [...this.metaJson<string[]>("ownRevs", []), revision].slice(-OWN_REVS_KEPT));
      this.setMeta("onBehalf", onBehalf);
      this.pending = this.pending.filter((batch) => !seqs.has(batch.seq));
      // done only after its audit (a crash before it reruns the audit); the author's token stays until then
      this.q("UPDATE saves SET state = 'audit', rev = ? WHERE op = ?", revision, op);
      if (repairOf) {
        this.finishSave(repairOf);
      }
      this.q("DELETE FROM saves WHERE state = 'done' AND op NOT IN (SELECT op FROM saves WHERE state = 'done' ORDER BY at DESC LIMIT 20)");
    });
    this.broadcast({ type: "saved", revision, md5, receipts: this.savedReceipts(), at: Date.now() });
  }

  /** a save is complete (audit included): tokens only until the author's changes are in Drive */
  private finishSave(op: string) {
    const row = this.q("SELECT author FROM saves WHERE op = ?", op)[0];
    this.q("UPDATE saves SET state = 'done' WHERE op = ?", op);
    const author = row ? String(row.author) : "";
    const audits = this.q("SELECT 1 FROM saves WHERE author = ? AND state IN ('prepared', 'audit', 'repair')", author).length;
    if (author && !audits && !this.pending.some((batch) => batch.author === author)) {
      this.dropToken(author);
    }
  }

  /** an invalid change (doesn't decrypt, not an element): set aside with everything built on it, like a discard */
  private setAside(batches: Batch[], by: Batch | undefined) {
    const authors = new Set(batches.map((batch) => batch.pseudonym));
    const repairer = by ?? batches[0];
    const token = this.q("SELECT sealed FROM tokens WHERE author = ?", repairer.author)[0]?.sealed as string | undefined;
    this.discardBatches(this.closureFrom(new Set(batches)), { sub: repairer.author, pseudonym: repairer.pseudonym, token }, "invalid");
    this.setError(`invalid:${[...authors].join(",")}`);
  }

  /**
   * Unfinished saves, at the start of every round (and when a one-time
   * token arrives): a recorded upload is done if a revision since its base
   * has its checksum (even with newer ones after it), then audited;
   * otherwise it is dropped and the walk runs again (newer revisions are
   * merged first, as outside changes). Never a blind re-upload. An audit and
   * its repair run until done. Without any credential the job waits durably
   * and a connected tab is asked for one (need-token).
   */
  private async recoverSaves(oneTime?: { sub: string; token: string }): Promise<boolean> {
    for (const row of this.q("SELECT * FROM saves WHERE state IN ('prepared', 'audit', 'repair') ORDER BY at")) {
      const access = (await this.accessFor(String(row.author))) as { token?: string; problem?: string };
      let token = access.token ?? oneTime?.token ?? null;
      if (!token) {
        const other = await this.anyAccess();
        if (other === "unreachable" || access.problem === "unreachable") {
          this.retryLater("google-unreachable");
          return false;
        }
        token = other?.token ?? null;
      }
      if (!token) {
        this.setMeta("needCredential", "1");
        this.requestToken();
        this.schedule("save", Date.now() + 15 * 60_000);
        return false;
      }
      const file = await getFile(this.genv, token, this.fileId);
      if (file.status !== 200) {
        this.retryLater(problemOf(file));
        return false;
      }
      const key = await this.keyFrom(file);
      if (!key) {
        return false;
      }
      if (row.state === "prepared") {
        const revisions = await listRevisions(this.genv, token, this.fileId);
        if (!Array.isArray(revisions)) {
          this.retryLater(problemOf(revisions));
          return false;
        }
        const baseAt = revisions.findIndex((rev) => rev.id === row.base);
        const found = revisions.slice(baseAt + 1).find((rev) => rev.md5Checksum === row.md5);
        if (!found) {
          this.q("DELETE FROM saves WHERE op = ?", row.op);
          continue;
        }
        const seqs = new Set<number>(JSON.parse(String(row.batches)));
        const group = this.pending.filter((batch) => seqs.has(batch.seq));
        const last = new Map<string, Entry>();
        group.forEach((batch) => batch.entries.forEach((entry) => last.set(keyOf(entry), entry)));
        const meta = JSON.parse(String(row.meta || "{}"));
        this.commitSave(
          String(row.op),
          group,
          last,
          found.id,
          String(row.md5),
          meta.receipts ?? this.receiptsWith(group),
          meta.onBehalf ?? this.metaJson("onBehalf", []),
          meta.repairOf,
        );
      }
      const done = row.state === "repair" ? await this.repairUpload(String(row.op), token, key) : await this.audit(String(row.op), token, key);
      if (!done) {
        return false;
      }
    }
    this.setMeta("needCredential", null);
    return true;
  }

  /**
   * After an upload: a write that landed between our check and our upload
   * (a foreign revision between the base and ours) was overwritten by ours.
   * Google lets only kept revisions be downloaded, so the base and the
   * foreign one are pinned for the audit (Kurviq pins, within the budget) and
   * let go afterwards. Their changes, where ours didn't write, become a
   * repair recorded together with the new snapshot; the audit is done only
   * when the repair version is in Drive. Problems that last keep the audit
   * open (with an error) without stopping other saves.
   */
  private async audit(op: string, token: string, key: SceneKey): Promise<boolean> {
    const row = this.q("SELECT * FROM saves WHERE op = ? AND state = 'audit'", op)[0];
    if (!row) {
      return true;
    }
    const later = () => {
      this.schedule("save", Date.now() + 60_000, true);
      return false;
    };
    await this.releaseAuditPins(token);
    const revisions = await listRevisions(this.genv, token, this.fileId);
    if (!Array.isArray(revisions)) {
      return later();
    }
    const ours = revisions.findIndex((rev) => rev.id === row.rev);
    const baseAt = revisions.findIndex((rev) => rev.id === row.base);
    if (ours <= 0 || baseAt < 0 || baseAt >= ours - 1) {
      this.finishSave(op);
      return true;
    }
    const needed = [revisions[baseAt], revisions[ours - 1]];
    for (const rev of needed.filter((r) => !r.keepForever)) {
      if (!(await this.pinRoom(token, revisions))) {
        this.setError("audit-pins-full");
        return true;
      }
      const pinned = await this.dcall(`${driveUrls(this.env).api}/files/${this.fileId}/revisions/${rev.id}?fields=id,keepForever`, token, {
        method: "PATCH",
        json: { keepForever: true },
      });
      if (pinned.status !== 200) {
        return isTransient(problemOf(pinned)) ? later() : (this.setError("audit-failed"), true);
      }
      // recorded at once: a crash later still lets it go
      this.setMeta("auditPins", [...this.metaJson<string[]>("auditPins", []), rev.id]);
      this.setMeta("pins", [...this.metaJson<Pin[]>("pins", []), { rev: rev.id, kind: "audit", at: Date.now() }]);
    }
    const [baseFile, foreignFile] = await Promise.all(needed.map((rev) => downloadFile(this.genv, token, this.fileId, rev.id)));
    await this.releaseAuditPins(token);
    if (baseFile.status !== 200 || foreignFile.status !== 200) {
      const failed = baseFile.status !== 200 ? baseFile : foreignFile;
      if (isTransient(problemOf(failed))) {
        return later();
      }
      this.setError("audit-failed");
      return true;
    }
    let base: Plain;
    try {
      base = await subjectsOfFile(baseFile.text, null, fontHash);
    } catch {
      this.finishSave(op);
      return true;
    }
    const written = new Set<string>(JSON.parse(String(row.keys || "[]")));
    const changes = ((await this.diffAgainst(base, foreignFile.text, null)) ?? []).filter((change) => !written.has(eventKey(change.k, change.id)));
    if (!changes.length) {
      this.finishSave(op);
      return true;
    }
    const entries = await this.outsideEntries(key, changes);
    // the merged changes and the obligation to save them, in one transaction
    this.commitOutside(entries, null, () => this.q("UPDATE saves SET state = 'repair' WHERE op = ?", op));
    return this.repairUpload(op, token, key);
  }

  /** the audit's repair: a version with the merged outside changes (finishes the audit when Drive has it) */
  private async repairUpload(op: string, token: string, key: SceneKey): Promise<boolean> {
    let result = await this.upload([], token, key, true, op);
    if (result === "replan") {
      const file = await getFile(this.genv, token, this.fileId);
      if (file.status === 200 && (await this.mergeOutside(token, key, file.data)) === "ok") {
        result = await this.upload([], token, key, true, op);
      }
    }
    if (result === "ok") {
      return true;
    }
    this.schedule("save", Date.now() + 60_000, true);
    return false;
  }

  /** pins made only so an audit could download a revision: let go again */
  private async releaseAuditPins(token: string) {
    for (const rev of this.metaJson<string[]>("auditPins", [])) {
      const answer = await this.dcall(`${driveUrls(this.env).api}/files/${this.fileId}/revisions/${rev}?fields=id,keepForever`, token, {
        method: "PATCH",
        json: { keepForever: false },
      });
      if (answer.status === 0 || answer.status >= 500) {
        return;
      }
      this.setMeta("auditPins", this.metaJson<string[]>("auditPins", []).filter((id) => id !== rev));
      this.setMeta("pins", this.metaJson<Pin[]>("pins", []).filter((pin) => !(pin.rev === rev && pin.kind === "audit")));
    }
  }

  /**
   * room for one more of Kurviq's pins: the oldest milestone goes when 30 are
   * used (never the latest agent mark, never the user's own), none when the
   * file is near Google's 200
   */
  private async pinRoom(token: string, revisions: Revision[]) {
    if (revisions.filter((rev) => rev.keepForever).length >= GOOGLE_PINS - 5) {
      this.setError("pins-full");
      return false;
    }
    let pins = this.metaJson<Pin[]>("pins", []);
    while (pins.length >= KURVIQ_PINS) {
      const oldest = pins.find((pin) => pin.kind === "day");
      if (!oldest) {
        return false;
      }
      await this.dcall(`${driveUrls(this.env).api}/files/${this.fileId}/revisions/${oldest.rev}`, token, { method: "DELETE" });
      pins = pins.filter((pin) => pin !== oldest);
      this.setMeta("pins", pins);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // changes made outside Kurviq
  // ---------------------------------------------------------------------------

  private wantOutsideCheck() {
    this.setMeta("outsideWanted", "1");
    this.schedule("outside", Date.now(), true);
  }

  /** with a stored author token, the last one that worked, or the one-time token a tab fetched (need-token) */
  private async outsideCheck(oneTime?: { sub: string; token: string }) {
    this.load();
    if (this.lifecycle().state !== "active" || !this.seeded()) {
      this.setMeta("outsideWanted", null);
      return;
    }
    let access: { sub: string; token: string } | "unreachable" | null = oneTime ?? null;
    if (!access) {
      access = await this.anyAccess();
    }
    if (access === "unreachable") {
      this.schedule("outside", Date.now() + 60_000);
      return;
    }
    if (!access) {
      this.requestToken();
      return;
    }
    try {
      const file = await getFile(this.genv, access.token, this.fileId);
      if (file.status !== 200) {
        if (isTransient(problemOf(file))) {
          this.schedule("outside", Date.now() + 60_000);
        }
        return;
      }
      if (oneTime) {
        this.lastAccess = { ...oneTime, expiresAt: Date.now() + 30 * 60_000 };
      }
      if (file.data.trashed) {
        this.toTrashNow();
        return;
      }
      this.setDriveName(file.data.name);
      // our own saves are known by their revision (and checksum), never by time
      if (file.data.headRevisionId === this.lastSaved().revision || (file.data.md5Checksum && file.data.md5Checksum === this.lastSaved().md5)) {
        this.setMeta("outsideWanted", null);
        return;
      }
      const key = await this.keyFrom(file);
      if (!key) {
        return;
      }
      if ((await this.mergeOutside(access.token, key, file.data)) === "retry") {
        this.schedule("outside", Date.now() + 60_000);
      }
    } finally {
      this.roundKey = null;
    }
  }

  /**
   * Drive's newest revision is not our last save: download it, compare it
   * with the snapshot (full content), and make what changed the new saved
   * base. Kurviq's pending changes win where both changed something (they
   * stay pending on top); the rest goes to every tab as "outside".
   */
  private async mergeOutside(token: string, key: SceneKey, file: any): Promise<"ok" | "retry"> {
    const head = { revision: String(file.headRevisionId), md5: String(file.md5Checksum || "") };
    if (head.md5 && head.md5 === this.lastSaved().md5) {
      this.setMeta("lastSaved", { ...this.lastSaved(), revision: head.revision });
      this.setMeta("outsideWanted", null);
      return "ok";
    }
    const download = await downloadFile(this.genv, token, this.fileId);
    if (download.status !== 200 && download.status !== 413) {
      return isTransient(problemOf(download)) ? "retry" : "ok";
    }
    // an outside file too big to hold is not imported (it stays in Drive's history); the budgets hold for it too
    if (download.status === 413 || download.text.length > LIMITS.sceneBytes) {
      this.setError("outside-too-big");
      this.setMeta("lastSaved", { ...this.lastSaved(), revision: head.revision, md5: head.md5 });
      this.setMeta("outsideWanted", null);
      return "ok";
    }
    const { plain } = await this.decryptAll(key, this.snap);
    const changes = await this.diffAgainst(plain, download.text, typeof file.name === "string" ? file.name : null);
    const entries = changes ? await this.outsideEntries(key, changes) : [];
    this.commitOutside(entries, head);
    return "ok";
  }

  /** what an outside file changed against `base` (plain values; null: not a scene file, nothing taken from it) */
  private async diffAgainst(base: Plain, text: string, driveName: string | null): Promise<Change[] | null> {
    let theirs: Map<string, { k: EventKind; id: string; value: any }>;
    try {
      theirs = await subjectsOfFile(text, driveName, fontHash);
    } catch {
      this.setError("outside-invalid");
      return null;
    }
    const changes: Change[] = [];
    for (const k of new Set([...base.keys(), ...theirs.keys()])) {
      const mine = base.get(k);
      const other = theirs.get(k);
      if (other) {
        if (!sameContent(other.k, mine?.value, other.value)) {
          changes.push(other);
        }
      } else if (mine?.k === "el" && !mine.value?.isDeleted) {
        // removed outside (images, fonts, settings and the name missing from a file stay)
        changes.push({ k: "el", id: mine.id ?? mine.value.id, value: null, deleted: true });
      }
    }
    return changes;
  }

  private async outsideEntries(key: SceneKey, changes: Change[]) {
    const entries: Entry[] = [];
    for (const change of changes) {
      const k = eventKey(change.k, change.id);
      const v = Math.max(this.snap.get(k)?.v ?? 0, this.state.get(k)?.v ?? 0) + 1;
      const n = randomNonce();
      const entry: Entry = { k: change.k, id: change.id, c: "", v, n, a: "outside", seq: 0 };
      if (change.k === "el") {
        if (change.deleted) {
          const old = (this.snap.get(k) ?? this.state.get(k))?.r;
          if (!old) {
            continue;
          }
          entry.r = { ...old, isDeleted: true, version: v, versionNonce: n };
        } else {
          const element = { ...change.value, version: v, versionNonce: n };
          entry.r = readableOf(element);
          entry.c = await encryptContent(key, "el", change.id, contentOf(element));
        }
      } else {
        entry.c = await encryptContent(key, change.k, change.id, change.value);
        if (change.k === "font") {
          entry.fontId = change.value.id;
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * The outside revision becomes the saved base; tabs get what has no
   * pending Kurviq change on top. An outside deletion of an element something
   * alive still refers to (a pending arrow bound to it, say) is not taken:
   * Kurviq's work that depends on it wins, and the element is saved again.
   * `alsoInTransaction`: written atomically with it (the audit's obligation).
   */
  private commitOutside(entries: Entry[], head: { revision: string; md5: string } | null, alsoInTransaction?: () => void) {
    const deletedIds = new Set(entries.filter((entry) => entry.r?.isDeleted).map((entry) => entry.id));
    if (deletedIds.size) {
      const incoming = new Map(entries.map((entry) => [keyOf(entry), entry]));
      const stillUsed = new Set<string>();
      for (const [key, current] of this.state) {
        const r = (incoming.get(key) ?? current).r;
        if (!r || r.isDeleted || deletedIds.has(key)) {
          continue;
        }
        for (const id of [r.containerId, r.frameId, r.startId, r.endId, ...r.boundIds]) {
          if (id && deletedIds.has(id)) {
            stillUsed.add(id);
          }
        }
      }
      entries = entries.filter((entry) => !(entry.r?.isDeleted && stillUsed.has(entry.id)));
    }
    const pendingKeys = new Set(this.pending.flatMap((batch) => batch.entries.map(keyOf)));
    this.seqNow = this.seq + 1;
    const seq = this.seqNow;
    const toTabs: Entry[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        entry.seq = seq;
        this.snap.set(keyOf(entry), entry);
      }
      if (entries.length) {
        this.writeSnapshot();
      }
      this.checkpointSeq();
      this.setMeta("maxDeleted", String(seq));
      if (head) {
        this.setMeta("lastSaved", { revision: head.revision, md5: head.md5, at: Date.now() });
      }
      this.setMeta("outsideWanted", null);
      alsoInTransaction?.();
    });
    for (const entry of entries) {
      if (!pendingKeys.has(keyOf(entry))) {
        this.setState(keyOf(entry), entry);
        toTabs.push(entry);
      }
    }
    if (toTabs.length) {
      this.broadcast({
        type: "events",
        seq,
        author: "outside",
        pseudonym: "outside",
        name: null,
        tab: "",
        via: "user",
        origin: "outside",
        events: toTabs.map((entry) => wireOf(entry)),
      });
    }
    if (head) {
      this.broadcast({ type: "saved", revision: head.revision, md5: head.md5, receipts: this.savedReceipts(), at: Date.now() });
    }
  }

  // ---------------------------------------------------------------------------
  // pins: one milestone per edit day, the latest agent mark, at most 30 of Kurviq's
  // ---------------------------------------------------------------------------

  private async pinAfter(token: string, base: { revision: string | null; at: number }, revision: string, agent: boolean) {
    const dayMilestone = !!base.revision && !!base.at && dayOf(base.at) !== dayOf(Date.now()) && this.meta("pinDay") !== dayOf(base.at);
    if (!agent && !dayMilestone) {
      return;
    }
    const revisions = await listRevisions(this.genv, token, this.fileId);
    if (Array.isArray(revisions)) {
      await this.pin(token, revisions, base, revision, agent);
    }
  }

  private async pin(token: string, revisions: Revision[], base: { revision: string | null; at: number }, revision: string, agent: boolean) {
    const api = driveUrls(this.env).api;
    const keep = (rev: string, value: boolean) =>
      this.dcall(`${api}/files/${this.fileId}/revisions/${rev}?fields=id,keepForever`, token, { method: "PATCH", json: { keepForever: value } });
    let pins: Pin[] = [];
    const makeRoom = async () => {
      const room = await this.pinRoom(token, revisions);
      pins = this.metaJson<Pin[]>("pins", []);
      return room;
    };
    pins = this.metaJson<Pin[]>("pins", []);
    // the previous edit day's last version: kept for good
    if (base.revision && base.at && dayOf(base.at) !== dayOf(Date.now()) && this.meta("pinDay") !== dayOf(base.at)) {
      if (!pins.some((pin) => pin.rev === base.revision) && (await makeRoom())) {
        const answer = await keep(base.revision, true);
        if (answer.status === 200) {
          pins.push({ rev: base.revision, kind: "day", at: Date.now() });
        }
      }
      this.setMeta("pinDay", dayOf(base.at));
    }
    if (agent) {
      const previous = pins.find((pin) => pin.kind === "agent");
      if (this.meta("agentPins") !== "off" && (await makeRoom())) {
        if ((await keep(revision, true)).status === 200) {
          pins.push({ rev: revision, kind: "agent", at: Date.now() });
        }
        if (previous) {
          // un-pinning the previous mark; if Drive doesn't allow it, agent marks are no longer pinned at all
          if ((await keep(previous.rev, false)).status === 200) {
            pins = pins.filter((pin) => pin !== previous);
          } else {
            this.setMeta("agentPins", "off");
            previous.kind = "day";
          }
        }
      }
      await patchFile(this.genv, token, this.fileId, { appProperties: { agentRev: revision, agentAt: new Date().toISOString() } });
    }
    this.setMeta("pins", pins);
  }
}
