// Live sync: the browser keeps every change of a Drive scene until Drive has
// it, not just until the scene's Durable Object answered (CONCEPT "Offline
// queue"). One IndexedDB entry per batch, keyed by
//
//   [account sub, Drive file id, tab, counter]
//
// - the account: a queue of another Google account in this browser is held
//   back, never sent as the one signed in now;
// - the tab: a random id per tab and scene (scenes can't be linked by it);
//   tabs never write each other's entries. A tab id is held with a Web Lock
//   while a tab uses it; a queue whose tab is gone (closed, reloaded) is
//   taken over by the next tab of the same account, whichever scene it has
//   open, under the same tab id: the DO recognises batches it already has by
//   tab and counter and stores them once.
//
// "In this browser" is shown only once the write committed: putBatch
// resolves after IndexedDB's transaction completed, and rejects otherwise
// (the scene then says "not saved" and offers an export).

import { createStore, del, get, promisifyRequest, set, update } from "idb-keyval";

import type { Base, EventKind } from "./liveProtocol";

/** one change of a batch, as the user made it (encrypted only when sent: the key may not be there yet) */
export type QueuedChange = {
  k: EventKind;
  id: string;
  /** the element / settings / file / font / name */
  value: any;
  /** the DO's stamp the change was made on (null: new) */
  base: Base | null;
  /** properties the user changed against that base (null: all, e.g. a new element) */
  keys: string[] | null;
  /** fonts: the numeric id the elements use */
  fontId?: number;
  /** made on top of this tab's own unanswered batch (its counter): that batch's stamp is the base */
  after?: number;
};

export type QueuedBatch = {
  sub: string;
  fileId: string;
  tab: string;
  counter: number;
  /** when the change was made (ms) */
  made: number;
  /** made while connected and up to date (decides live vs offline collision handling) */
  live: boolean;
  via: "user" | "agent";
  command?: string;
  changes: QueuedChange[];
  /** queued: not answered yet; acked: on the server (seq), not in Drive yet */
  state: "queued" | "acked";
  seq?: number;
  /** the DO's stamps for it (eventKey -> stamp): later batches of the same elements build on them */
  stamps?: Record<string, Base>;
  /** the scene's lifecycle epoch it was made in (a batch of an older one is never replayed) */
  epoch?: number;
  /** settled after a live collision: its changes carry their own (the DO's current) base */
  rebased?: boolean;
};

export type BatchKey = [string, string, string, number];

export const batchKey = (batch: Pick<QueuedBatch, "sub" | "fileId" | "tab" | "counter">): BatchKey => [
  batch.sub,
  batch.fileId,
  batch.tab,
  batch.counter,
];

// opened on first use (not at import: the module is also loaded where there is no IndexedDB)
let batchStore: ReturnType<typeof createStore> | null = null;
let counterStore: ReturnType<typeof createStore> | null = null;
const batches = () => (batchStore ??= createStore("kurviq-live-queue", "batches"));
const counters = () => (counterStore ??= createStore("kurviq-live-counters", "counters"));

/** array keys sort after strings and numbers: [x, []] is above every [x, …] */
const prefixRange = (...prefix: string[]) => IDBKeyRange.bound(prefix, [...prefix, []]);

/** store a batch (resolves only once it is in IndexedDB) */
export const putBatch = (batch: QueuedBatch) => set(batchKey(batch), batch, batches());

export const deleteBatch = (batch: Pick<QueuedBatch, "sub" | "fileId" | "tab" | "counter">) => del(batchKey(batch), batches());

/** the queued batches of an account (one scene, one tab of it), oldest counter first per tab */
export const batchesOf = (sub: string, fileId?: string, tab?: string): Promise<QueuedBatch[]> =>
  batches()("readonly", (store) =>
    promisifyRequest(
      store.getAll(prefixRange(...([sub, fileId, tab].filter((part) => part !== undefined) as string[]))),
    ),
  );

/** a scene left Drive: every queued batch of it (all tabs of the account) goes */
export const forgetFile = async (sub: string, fileId: string) => {
  for (const batch of await batchesOf(sub, fileId)) {
    await deleteBatch(batch);
  }
};

/** the next counter of a tab id (counters only grow, also after the queue emptied) */
export const nextCounter = async (sub: string, fileId: string, tab: string) => {
  let value = 0;
  await update<number>(
    [sub, fileId, tab],
    (current) => {
      value = (current ?? 0) + 1;
      return value;
    },
    counters(),
  );
  return value;
};

/** a tab id taken over: its counters continue */
export const currentCounter = async (sub: string, fileId: string, tab: string) =>
  (await get<number>([sub, fileId, tab], counters())) ?? 0;

/**
 * The account's id became known (the queue was keyed by a stand-in, e.g. its
 * email, before): its entries move over. Same person, same Google account.
 */
export const moveAccount = async (from: string, to: string) => {
  if (from === to) {
    return;
  }
  for (const batch of await batchesOf(from)) {
    const moved = { ...batch, sub: to };
    await putBatch(moved);
    await deleteBatch(batch);
    await update<number>(
      [to, batch.fileId, batch.tab],
      (current) => Math.max(current ?? 0, batch.counter),
      counters(),
    );
  }
};

// -----------------------------------------------------------------------------
// tab ids: held with a Web Lock while in use
// -----------------------------------------------------------------------------

const lockName = (fileId: string, tab: string) => `kurviq-live-tab:${fileId}:${tab}`;

export const newTabId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 16);
};

export type HeldTab = { tab: string; release: () => void };

/** hold a tab id (null: another tab holds it) */
export const holdTab = async (fileId: string, tab: string): Promise<HeldTab | null> => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    // no Web Locks (old browsers): this tab's own ids only, never taken over
    return { tab, release: () => {} };
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = await new Promise<boolean>((resolve) => {
    locks
      .request(lockName(fileId, tab), { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        await released;
      })
      .catch(() => resolve(false));
  });
  return acquired ? { tab, release } : null;
};

/**
 * The tab id for a scene: this browser tab's previous one (it survives a
 * reload in sessionStorage), else a queue of the account no tab holds any
 * more, else a new one.
 */
export const claimTab = async (sub: string, fileId: string): Promise<HeldTab> => {
  const sessionKey = `kurviq-live-tab:${sub}:${fileId}`;
  let previous: string | null = null;
  try {
    previous = sessionStorage.getItem(sessionKey);
  } catch {}
  const candidates = [
    ...(previous ? [previous] : []),
    ...new Set((await batchesOf(sub, fileId).catch(() => [] as QueuedBatch[])).map((batch) => batch.tab)),
  ];
  for (const tab of candidates) {
    const held = await holdTab(fileId, tab);
    if (held) {
      remember(sessionKey, tab);
      return held;
    }
  }
  for (;;) {
    const held = await holdTab(fileId, newTabId());
    if (held) {
      remember(sessionKey, held.tab);
      return held;
    }
  }
};

const remember = (key: string, tab: string) => {
  try {
    sessionStorage.setItem(key, tab);
  } catch {}
};

/** queues of the account that no open tab holds (to be sent by this one) */
export const orphanQueues = async (sub: string): Promise<{ fileId: string; tab: string }[]> => {
  const seen = new Map<string, { fileId: string; tab: string }>();
  for (const batch of await batchesOf(sub)) {
    seen.set(`${batch.fileId}:${batch.tab}`, { fileId: batch.fileId, tab: batch.tab });
  }
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    return [];
  }
  const held = new Set(((await locks.query()).held ?? []).map((lock) => lock.name));
  return [...seen.values()].filter((entry) => !held.has(lockName(entry.fileId, entry.tab)));
};

// -----------------------------------------------------------------------------
// agent commands: recorded before their change is applied, so a retry (after
// a timeout, or a reload of the tab) never applies it twice
// -----------------------------------------------------------------------------

let commandStore: ReturnType<typeof createStore> | null = null;
const commands = () => (commandStore ??= createStore("kurviq-live-commands", "commands"));

/** commands are remembered this long (agents retry within minutes) */
const COMMAND_KEEP_MS = 7 * 24 * 3600_000;

export type CommandRecord = { at: number; revision?: string };

export const commandRecord = (sub: string, fileId: string, command: string) =>
  get<CommandRecord>([sub, fileId, command], commands()).then((record) =>
    record && Date.now() - record.at < COMMAND_KEEP_MS ? record : undefined,
  );

/** resolves once the record is in IndexedDB (the change is applied only then) */
export const recordCommand = (sub: string, fileId: string, command: string, record: CommandRecord) =>
  set([sub, fileId, command], record, commands());
