// A store that keeps at most `max` entries (an IndexedDB store of
// idb-keyval): an index of key → time is kept beside them, so dropping the
// oldest never loads the entries themselves (each can be many MB). Writes
// run one at a time in this tab (the index is read and written whole).
// Used by the agents' checkpoints (./storage.ts) and uploads (./uploads.ts).

import { delMany, get, keys, set } from "idb-keyval";

type Store = Parameters<typeof get>[1];

export type BoundedOptions = {
  /** the key of the index (key → time) in the same store */
  indexKey: string;
  max: number;
  /** which keys of the store are entries (before the index existed: the stored ones, as the oldest) */
  isEntry: (key: string) => boolean;
  /** more keys to drop after a write of `key` (oldest first in `byAge`) */
  alsoDrop?: (key: string, byAge: string[]) => string[];
};

export const boundedStore = (store: Store, { indexKey, max, isEntry, alsoDrop }: BoundedOptions) => {
  let writes: Promise<unknown> = Promise.resolve();
  return {
    /** keep `value` under `key` (written at `at`); the oldest entries above `max` go */
    put(key: string, value: unknown, at: number) {
      const write = writes.then(async () => {
        await set(key, value, store);
        const index =
          (await get<Record<string, number>>(indexKey, store)) ??
          Object.fromEntries((await keys(store)).map(String).filter((k) => k !== indexKey && isEntry(k)).map((k) => [k, 0]));
        index[key] = at;
        const byAge = Object.entries(index)
          .sort((a, b) => a[1] - b[1])
          .map(([k]) => k);
        const drop = new Set(byAge.slice(0, Math.max(0, byAge.length - max)));
        alsoDrop?.(key, byAge).forEach((k) => drop.add(k));
        drop.forEach((k) => delete index[k]);
        if (drop.size) {
          await delMany([...drop], store);
        }
        await set(indexKey, index, store);
      });
      writes = write.catch(() => {});
      return write;
    },
  };
};
