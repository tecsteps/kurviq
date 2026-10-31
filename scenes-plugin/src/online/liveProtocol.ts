// Live sync: the contract between a Kurviq tab and its scene's Durable
// Object (online/worker/scene.ts). Shared by the app and the Worker, like
// frames.ts. docs/live-sync/PROTOCOL.md explains the whole picture.

export const LIVE_PROTOCOL = 1;

/** the file's marker once its scene saves through the scene's Durable Object */
export const LIVE_MARKER = "do-1";

/** a tab collects changes this long before sending them */
export const BATCH_MS = 300;
/** an unanswered batch after this long: the connection counts as dead */
export const ACK_TIMEOUT_MS = 10_000;
/** access proofs: renewed this often, valid this long */
export const PROOF_RENEW_MS = 10 * 60_000;
export const PROOF_VALID_MS = 15 * 60_000;
/** connect tickets */
export const TICKET_VALID_MS = 60_000;
/** stored refresh tokens: at most this long after the author's last renewal */
export const TOKEN_LEASE_MS = 4 * 3600_000;
/** save rounds: this often while changes are pending */
export const SAVE_EVERY_MS = 60_000;
/** at most this many Drive versions per save round */
export const MAX_VERSIONS_PER_ROUND = 5;
/** batches older than this are never replayed */
export const REPLAY_HORIZON_MS = 30 * 24 * 3600_000;
/** unresolved changes of an author who cannot be saved as */
export const DECIDE_AFTER_MS = 24 * 3600_000;
export const AUTO_ACCEPT_AFTER_MS = 7 * 24 * 3600_000;

/** limits (refused before acceptance, never cut off) */
export const LIMITS = {
  /** one batch, framed (frames.ts splits it into parts) */
  batchBytes: 24 * 1024 * 1024,
  eventsPerBatch: 5_000,
  /** a scene's elements */
  elements: 50_000,
  /** one image */
  fileBytes: 12 * 1024 * 1024,
  /** connections per scene */
  connections: 50,
  /** batches per minute per tab */
  batchesPerMinute: 600,
};

export type Role = "edit" | "read";

/** the element version a change was made on (null: a new element) */
export type Base = { v: number; n: number };

/** what the Durable Object may read of an element (all else is encrypted) */
export type Readable = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  boundIds: string[];
  containerId: string | null;
  startId: string | null;
  endId: string | null;
  frameId: string | null;
  groupIds: string[];
  fileId: string | null;
  fontFamily: number | null;
};

export type EventKind = "el" | "set" | "file" | "font" | "name";

/** one change: an element, the scene settings, an image, a font or the name */
export type WireEvent = {
  k: EventKind;
  /** element id; "settings"; the image's file id; the font's hash; "name" */
  id: string;
  base: Base | null;
  /** elements only */
  r?: Readable;
  /** base64 of IV (12 bytes) + AES-GCM ciphertext of the encrypted part */
  c: string;
};

/** a whole scene as the Durable Object holds it */
export type WireScene = {
  revision: string | null;
  md5: string | null;
  events: WireEvent[];
};

export type Receipt = { mark: number; extra: number[] };

export type Lifecycle = "active" | "closing" | "trashed" | "local" | "deleted";

export type BlockedAuthor = {
  pseudonym: string;
  name: string | null;
  since: number;
  reason: "token" | "access" | "not-picked";
  /** an editor may decide now (after DECIDE_AFTER_MS) */
  decidable: boolean;
};

export type Presence = { tab: string; pseudonym: string; name: string | null; role: Role; activeAt: number };

export type RefuseReason =
  | "collision"
  | "reference"
  | "limit"
  | "key"
  | "role"
  | "lifecycle"
  | "discarded"
  | "font-id"
  | "invalid"
  | "old";

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "hello"; protocol: number; tab: string; openToken: string; revision: string | null; seq: number; generation: string | null }
  | {
      type: "batch";
      counter: number;
      /** made while connected and up to date (decides live vs offline collision handling) */
      live: boolean;
      made: number;
      via: "user" | "agent";
      /** agent command id, so a retry never applies twice */
      command?: string;
      events: WireEvent[];
    }
  | { type: "seed"; scene: WireScene }
  | { type: "decide"; author: string; action: "accept" | "discard" }
  | { type: "presence"; activeAt: number };

export type ServerMessage =
  | {
      type: "welcome";
      /** events: catch-up follows; state: the full scene; seed: send yours; wait: an editor must seed first */
      mode: "events" | "state" | "seed" | "wait";
      seq: number;
      generation: string;
      events?: StampedBatch[];
      state?: WireScene;
      keyId: string | null;
      role: Role;
      lifecycle: Lifecycle;
      presence: Presence[];
      /** this tab's batches the DO already has (so the tab resends only the rest) */
      known: number[];
      /** Drive's newest saved revision as the DO knows it */
      saved: { revision: string | null; md5: string | null };
      receipts: Record<string, Receipt>;
    }
  | { type: "ack"; counter: number; seq: number; stamps: Record<string, Base> }
  | { type: "refused"; counter: number; reason: RefuseReason; detail?: string; current: WireEvent[] }
  | ({ type: "events" } & StampedBatch)
  | { type: "saved"; revision: string; md5: string; receipts: Record<string, Receipt>; at: number }
  | { type: "status"; blocked: BlockedAuthor[]; error: string | null; lifecycle: Lifecycle; presence: Presence[]; pendingSaves: number }
  | { type: "renew-now" }
  | { type: "need-token" }
  | { type: "closed"; reason: Lifecycle | "access" | "replaced" };

export type StampedBatch = {
  seq: number;
  author: string;
  pseudonym: string;
  name: string | null;
  tab: string;
  via: "user" | "agent";
  origin: "user" | "outside" | "repair";
  events: WireEvent[];
};

// ---------------------------------------------------------------------------
// Worker answers
// ---------------------------------------------------------------------------

export type TicketAnswer =
  | { enabled: false; code?: string; error?: string }
  | {
      enabled: true;
      protocol: number;
      ticket: string;
      proof: string;
      proofExpiresAt: number;
      role: Role;
      key: string | null;
      keyId: string | null;
      pseudonym: string;
      name: string;
      head: { revision: string | null; md5: string | null };
    };

// ---------------------------------------------------------------------------
// elements: readable part and encrypted part
// ---------------------------------------------------------------------------

/** properties the Durable Object reads; they are taken out before encrypting */
export const READABLE_KEYS = [
  "id",
  "type",
  "version",
  "versionNonce",
  "isDeleted",
  "index",
  "boundElements",
  "containerId",
  "startBinding",
  "endBinding",
  "frameId",
  "groupIds",
  "fileId",
  "fontFamily",
] as const;

/** element (as Excalidraw keeps it) → its readable part */
export const readableOf = (el: any): Readable => ({
  id: String(el.id),
  type: String(el.type),
  version: Number(el.version) || 0,
  versionNonce: Number(el.versionNonce) || 0,
  isDeleted: !!el.isDeleted,
  index: el.index ?? null,
  boundIds: Array.isArray(el.boundElements) ? el.boundElements.map((b: any) => String(b?.id)).filter(Boolean) : [],
  containerId: el.containerId ?? null,
  startId: el.startBinding?.elementId ?? null,
  endId: el.endBinding?.elementId ?? null,
  frameId: el.frameId ?? null,
  groupIds: Array.isArray(el.groupIds) ? el.groupIds.map(String) : [],
  fileId: el.fileId ?? null,
  fontFamily: typeof el.fontFamily === "number" ? el.fontFamily : null,
});

/**
 * the encrypted part: everything except id, version, versionNonce, isDeleted,
 * index and frameId (the references stay inside too: the readable copy is
 * for checks, the encrypted one is what the scene uses)
 */
export const contentOf = (el: any) => {
  const { id, version, versionNonce, isDeleted, index, ...rest } = el;
  return rest;
};

/** readable part + decrypted content → the element */
export const elementOf = (r: Readable, content: any) => ({
  ...content,
  id: r.id,
  version: r.version,
  versionNonce: r.versionNonce,
  isDeleted: r.isDeleted,
  index: r.index,
});

/** the ids an element refers to (for reference checks and the grouping walk) */
export const referencesOf = (r: Readable): string[] => {
  const ids = new Set<string>(r.boundIds);
  for (const id of [r.containerId, r.startId, r.endId, r.frameId]) {
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
};

export const sameBase = (a: Base | null | undefined, b: Base | null | undefined) =>
  !!a && !!b && a.v === b.v && a.n === b.n;
