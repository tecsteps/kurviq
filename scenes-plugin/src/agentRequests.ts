// What makes agent edits safe to retry, and big edits cheap to send.
//
// - Every edit carries a requestId. A tab that already applied (or is still
//   applying) that request answers with its result instead of applying it
//   again: an agent whose call timed out simply sends it once more. Results
//   are kept in IndexedDB, so this also holds after a reload of the tab.
// - Edit payloads an agent uploads (kurviq.com/mcp/<key>/upload with a JSON
//   body) are kept here until edit_scene names them (payloadId), so a big
//   edit doesn't have to pass through the model's tool call.

import { createStore, del, entries, get, set } from "idb-keyval";

const results = createStore("kurviq-agent-edits", "results");
const payloads = createStore("kurviq-agent-payloads", "payloads");

const MAX_RESULTS = 60;
const MAX_PAYLOADS = 30;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** edits of this tab still running, by requestId */
const running = new Map<string, Promise<any>>();

const prune = async (store: ReturnType<typeof createStore>, max: number) => {
  const all = await entries<string, { at: number }>(store);
  if (all.length > max) {
    all.sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0));
    await Promise.all(all.slice(0, all.length - max).map(([key]) => del(key, store)));
  }
};

/** the result without the scene's elements (kept small) */
const summary = (result: any) => {
  const { elements: _elements, files: _files, appState: _appState, ...rest } = result || {};
  return rest;
};

/**
 * Run an edit once per requestId. A repeated request joins the running one
 * or gets the stored result, marked alreadyApplied (`reload` fills in the
 * scene's elements, which aren't stored).
 */
export const onceForRequest = async <T,>(
  requestId: string | undefined,
  run: () => Promise<T>,
  reload: () => Promise<any[]>,
): Promise<T> => {
  if (!requestId || !ID_RE.test(requestId)) {
    return run();
  }
  const inFlight = running.get(requestId);
  if (inFlight) {
    return inFlight.then((result) => ({ ...result, alreadyApplied: "This request was already being applied; this is its result." }));
  }
  // claimed before the first await: a retry arriving meanwhile joins this one
  const task = (async () => {
    const done = await get<{ at: number; result: any }>(requestId, results).catch(() => undefined);
    if (done) {
      return {
        ...done.result,
        elements: await reload().catch(() => []),
        alreadyApplied: `This request (${requestId}) was applied at ${new Date(done.at).toISOString()}; nothing was applied again.`,
      } as T;
    }
    const result = await run();
    await set(requestId, { at: Date.now(), result: summary(result) }, results).catch(() => {});
    prune(results, MAX_RESULTS).catch(() => {});
    return result;
  })();
  running.set(requestId, task);
  try {
    return await task;
  } finally {
    running.delete(requestId);
  }
};

/** how the agent's edits stand right now (for the health check) */
export const editsRunning = () => running.size;

// -----------------------------------------------------------------------------
// uploaded edit payloads
// -----------------------------------------------------------------------------

export const MAX_PAYLOAD_CHARS = 1_000_000;

export const keepPayload = async ({ id, json }: { id: string; json: string }) => {
  if (!/^[0-9a-f]{40}$/.test(id) || typeof json !== "string" || json.length > MAX_PAYLOAD_CHARS) {
    throw new Error("Not an edit payload");
  }
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed) && (typeof parsed !== "object" || parsed === null)) {
    throw new Error('An edit payload is { "add": [...], "update": [...], "delete": [...] } or an array of elements to add');
  }
  await set(id, { at: Date.now(), json }, payloads);
  prune(payloads, MAX_PAYLOADS).catch(() => {});
  const add = Array.isArray(parsed) ? parsed : parsed.add;
  return {
    payloadId: id,
    add: Array.isArray(add) ? add.length : typeof add === "string" ? "(JSON string)" : 0,
    update: Array.isArray(parsed.update) ? parsed.update.length : 0,
    delete: Array.isArray(parsed.delete) ? parsed.delete.length : 0,
  };
};

export const getPayload = async (id: string) => {
  const entry = await get<{ at: number; json: string }>(id, payloads).catch(() => undefined);
  if (!entry) {
    throw new Error(`No uploaded edit payload "${id}" in the user's Kurviq tab (uploads are kept in that browser only, the last ${MAX_PAYLOADS}). Upload it again.`);
  }
  return entry.json;
};
