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
  /** a scene's stored content (ciphertext of everything; the object holds it in memory while saving) */
  sceneBytes: 30 * 1024 * 1024,
  /** unsaved changes of a scene, and of one account in it */
  pendingBytes: 24 * 1024 * 1024,
  accountPendingBytes: 16 * 1024 * 1024,
  /** a batch counter at most this far above the tab's highest known one */
  counterWindow: 10_000,
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
  /**
   * settings and name: the stamp the Durable Object gave this state (elements
   * carry theirs in `r`), so the next change names it as its base
   */
  v?: Base;
  /** fonts: the numeric font id the elements use (readable, the DO keeps them free of clashes) */
  fontId?: number;
};

/**
 * What `c` decrypts to (UTF-8 JSON), per kind:
 *   el    contentOf(element)
 *   set   { viewBackgroundColor, gridSize, gridStep, gridModeEnabled }      (id SETTINGS_ID)
 *   file  Excalidraw's BinaryFileData { id, mimeType, dataURL, created, … }  (id = its file id)
 *   font  { family, id, faces, source } as in kurviqFonts                    (id = fontHash(font))
 *   name  { name }                                                            (id NAME_ID)
 * c is "" only in deletions the Durable Object makes itself (r.isDeleted:
 * an outside app removed the element, or a discarded new element): nothing to decrypt.
 */
export const SETTINGS_ID = "settings";
export const NAME_ID = "name";

/** a whole scene as the Durable Object holds it */
export type WireScene = {
  revision: string | null;
  md5: string | null;
  events: WireEvent[];
  /** seeds only: the seeded Drive file's top-level `kurviq` object, verbatim (same as the seed message's `kurviq`) */
  meta?: unknown;
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
  /** "accept" is offered (not for an author who lost access: their changes can only be discarded) */
  acceptable?: boolean;
};

export type Presence = { tab: string; pseudonym: string; name: string | null; role: Role; activeAt: number };

export type RefuseReason =
  /** the connection's sealed refresh token has run out: renew the proof, then resend */
  | "token"
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
      /** this tab's own pending batch the events build on (tabs that wait for each answer leave it out) */
      base?: number;
      /**
       * live collisions the tab settled by "later wins" on the same property:
       * the other author's state of the element (encrypted like an event), so
       * the DO can offer them "restore yours?" until the next save
       */
      losers?: WireEvent[];
      /** counters of this tab's refused batches it gave up (moved into an offline copy): receipts skip them */
      skip?: number[];
      events: WireEvent[];
    }
  | {
      type: "seed";
      scene: WireScene;
      /**
       * the seeded Drive file's top-level `kurviq` object, as it is in the
       * file (receipts, per-element authors, on-behalf records): saved
       * receipts and attribution survive a reseed
       */
      kurviq?: { receipts?: Record<string, Receipt & { at?: number }>; authors?: Record<string, string>; onBehalf?: Array<{ by: string; for: string; at: number }> };
    }
  | { type: "decide"; author: string; action: "accept" | "discard" }
  | { type: "presence"; activeAt: number }
  /** "Keep only here": close the scene (refused while others are connected or have unsaved changes) */
  | { type: "keep-local" }
  /** the tab stored the final state of `keep-local` in the browser: the DO may delete the scene's content */
  | { type: "keep-local-done" }
  /** the tab moves the scene to Drive's trash (Kurviq's Delete): saving stops first */
  | { type: "trash" };

export type ServerMessage =
  | {
      type: "welcome";
      /** events: catch-up follows; state: the full scene; seed: send yours; wait: an editor must seed first */
      mode: "events" | "state" | "seed" | "wait";
      fileId: string;
      /** the hello's openToken: a tab that has switched scenes ignores the answer */
      openToken: string;
      /** lifecycle epoch (a new one after a restore from the trash): batches made in an older one are never replayed */
      epoch: number;
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
      /** …and every counter up to this one (known lists only those above) */
      knownMark: number;
      /** Drive's newest saved revision as the DO knows it */
      saved: { revision: string | null; md5: string | null };
      receipts: Record<string, Receipt>;
    }
  | {
      type: "ack";
      counter: number;
      seq: number;
      stamps: Record<string, Base>;
      /** fonts whose numeric id the DO changed (hash -> id): the tab remaps its elements */
      fontIds?: Record<string, number>;
      /** eventKey → the fractional index the DO gave the element instead (it clashed) */
      repairs?: Record<string, string>;
      /** a resend of a batch the DO already had: stored once, stamps may be empty (already saved) */
      duplicate?: boolean;
    }
  | { type: "refused"; counter: number; reason: RefuseReason; detail?: string; current: WireEvent[] }
  | ({ type: "events" } & StampedBatch)
  | { type: "saved"; revision: string; md5: string; receipts: Record<string, Receipt>; at: number }
  | {
      type: "status";
      blocked: BlockedAuthor[];
      /** "drive-full" | "rate-limited" | "google-unreachable" | "key-changed" | "key-missing" | "pins-full" | "invalid:<pseudonym>" */
      error: string | null;
      lifecycle: Lifecycle;
      presence: Presence[];
      pendingSaves: number;
      /** the file's name in Drive (a rename outside Kurviq shows here first) */
      driveName?: string | null;
    }
  /** a seed not taken: "old" = reload from Drive (not the ticket's revision), "seeded" = another came first (a welcome follows) */
  | { type: "seed-refused"; reason: "old" | "seeded" | "role" | "lifecycle" | "invalid" | "key"; head: { revision: string | null; md5: string | null } }
  | { type: "renew-now" }
  | { type: "need-token" }
  /** answer to `keep-local`: the final state (ok), or why not */
  | { type: "keep-local"; ok: boolean; reason?: "connected" | "others-pending" | "shared" | "lifecycle"; state?: WireScene }
  /** someone's change won a live collision over this author's on the same property: restore theirs? */
  | { type: "lost"; id: string; by: string | null; until: number; event: WireEvent }
  | { type: "closed"; reason: Lifecycle | "access" | "replaced" };

export type StampedBatch = {
  seq: number;
  /** the sending tab's counter (a tab that missed the answer to its own batch recognises it) */
  counter?: number;
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
      /** the account's stable id: the browser keys its queues by it */
      sub?: string;
      /** the local install: its sealed session, renewed (keep it instead of the old one) */
      session?: string;
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

/** AES-GCM additional data of an event: binds it to its scene, its kind, its id and the key */
export const aadOf = (fileId: string, k: EventKind, eventId: string, keyId: string) => `${fileId}:${k}:${eventId}:${keyId}`;

export const sameBase = (a: Base | null | undefined, b: Base | null | undefined) =>
  !!a && !!b && a.v === b.v && a.n === b.n;

/** the key of an event's subject in ack stamps / repairs: element ids as they are, the rest "<kind>:<id>" */
export const eventKey = (k: EventKind, id: string) => (k === "el" ? id : `${k}:${id}`);

// ---------------------------------------------------------------------------
// the scene key on the Drive file: appProperties.kurviqKey = "<keyId>.<fileId>.<base64 key>"
// ---------------------------------------------------------------------------

export const KEY_PROPERTY = "kurviqKey";

/** a key's id: the first 12 characters of the base64url SHA-256 of its 32 bytes */
export const keyIdOf = async (keyBase64: string) => {
  const raw = Uint8Array.from(atob(keyBase64), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 12);
};

export const keyProperty = (keyId: string, fileId: string, keyBase64: string) => `${keyId}.${fileId}.${keyBase64}`;

/**
 * The property's parts, or null (also when its key id is not the key's own);
 * `copy`: made for another file (a copy in Drive needs its own key)
 */
export const parseKeyProperty = async (value: string | null | undefined, fileId: string) => {
  const match = /^([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9+/]{43}=)$/.exec(value || "");
  if (!match || (await keyIdOf(match[3])) !== match[1]) {
    return null;
  }
  return { keyId: match[1], fileId: match[2], key: match[3], copy: match[2] !== fileId };
};

/** an embedded font's event id: hex SHA-256 of JSON.stringify(font.faces), so the same font twice is one */
export const fontHash = async (font: { faces?: unknown }) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(font.faces ?? []))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
