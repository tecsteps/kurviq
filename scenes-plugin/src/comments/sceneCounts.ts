// The number of open comment threads per scene in the scene list (index.tsx's
// switcher), for the scenes this browser has: the open scene's from its
// comments on screen, the others' from their stored copies (../storage.ts),
// never from Drive (reading other files just for that costs too much). A
// stored copy is read again only when it changed (its length and version):
// the counts are kept in localStorage.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { getSnapshot } from "../storage";
import { cachedCount, openThreadCount, readCountCache } from "./listRules";
import { readLocal, writeLocal } from "./local";
import { commentStore } from "./store";

const KEY = "kurviq-comment-counts";

let lastKey: string | null = null;
let lastCount = 0;
/** the open scene's open threads (counted again only when its comments changed) */
const editorCount = () => {
  const key = commentStore.editorKey();
  if (key !== lastKey) {
    lastKey = key;
    lastCount = openThreadCount(commentStore.editorList());
  }
  return lastCount;
};

/**
 * Open threads per scene name, while the list is shown: the open scene's at
 * once, the others' once their stored copies are read (only those of names).
 */
export const useOpenThreadCounts = (names: string[], current: string | null) => {
  const [stored, setStored] = useState<Map<string, number>>(new Map());
  const live = useSyncExternalStore(commentStore.subscribe, editorCount);
  const wanted = names.join("\u0000");
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const cache = readCountCache(readLocal(KEY));
      const next = new Map<string, number>();
      for (const name of wanted ? wanted.split("\u0000") : []) {
        const snapshot = await getSnapshot(name).catch(() => undefined); // NOSONAR S9382: one after the other on purpose (large stored copies)
        if (!alive) {
          return;
        }
        if (snapshot?.json) {
          next.set(name, cachedCount(cache, name, snapshot));
        }
      }
      // only the scenes listed are kept
      writeLocal(KEY, Object.fromEntries(Object.entries(cache).filter(([name]) => next.has(name))));
      setStored(next);
    };
    read().catch((error) => console.warn("[comments] the scenes' comment counts could not be read", error));
    return () => {
      alive = false;
    };
  }, [wanted]);
  return useMemo(() => {
    const counts = new Map(stored);
    if (current !== null) {
      counts.set(current, live);
    }
    return counts;
  }, [stored, live, current]);
};
