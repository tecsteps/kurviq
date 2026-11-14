// The pen's pure parts (./pen.ts): what the holder's tab has not sent yet,
// how a viewer's canvas takes the holder's elements, big payloads in parts,
// and the mark on the Drive file (appProperties.kurviqPen) for tabs that
// can't reach the relay. No browser or editor APIs, so they are tested on
// their own (scenes-plugin/test/pen.test.ts).

type El = { id: string; version: number; versionNonce: number; index?: string | null; [key: string]: any };

/** a fresh mark is renewed this often by the holder... */
export const MARK_RENEW_MS = 60_000;
/** ...and is stale (the next person may edit) after this */
export const MARK_STALE_MS = 2 * 60_000;

/** the pen's mark on the Drive file: who (a display name), when, which tab */
export type PenMark = { n: string; t: number; i: string };

/** appProperties allow 124 bytes for key and value together: the name is cut short */
export const markText = (mark: PenMark) => JSON.stringify({ n: mark.n.slice(0, 40), t: Math.round(mark.t), i: mark.i.slice(0, 24) });

export const parseMark = (text: string | null | undefined): PenMark | null => {
  if (!text) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (typeof value?.n === "string" && Number.isFinite(value.t) && typeof value.i === "string") {
      return { n: value.n, t: Number(value.t), i: value.i };
    }
  } catch {}
  return null;
};

/** someone else's fresh mark: their name (this tab may not edit); null: no mark, a stale one, or this tab's own */
export const markHolder = (mark: PenMark | null, tab: string, now: number) =>
  mark && mark.i !== tab && now - mark.t < MARK_STALE_MS ? mark.n : null;

const stamp = (el: El) => `${el.version}:${el.versionNonce}`;

/** the elements whose state the viewers don't have yet (`sent`: element id → the stamp last sent) */
export const unsentElements = (elements: readonly El[], sent: ReadonlyMap<string, string>) => elements.filter((el) => sent.get(el.id) !== stamp(el));

export const rememberSent = (sent: Map<string, string>, elements: readonly El[]) => {
  for (const el of elements) {
    sent.set(el.id, stamp(el));
  }
};

/** z-order: fractional indices compare as strings; elements without one keep their place at the end */
const byIndex = (a: El, b: El) => {
  const [x, y] = [a.index ?? "", b.index ?? ""];
  if (x === y) {
    return 0;
  }
  if (!x || !y) {
    return x ? -1 : 1;
  }
  return x < y ? -1 : 1;
};

/**
 * A viewer's canvas with the holder's elements: the holder's state of an
 * element always wins (only the holder edits), new ones are added, and the
 * whole list is in z-order again. Null: nothing changed.
 */
export const withIncoming = <T extends El>(current: readonly T[], incoming: readonly T[]): T[] | null => {
  const byId = new Map(current.map((el) => [el.id, el]));
  let changed = false;
  for (const el of incoming) {
    const now = byId.get(el.id);
    if (!now || stamp(now) !== stamp(el)) {
      byId.set(el.id, el);
      changed = true;
    }
  }
  return changed ? [...byId.values()].sort(byIndex) : null;
};

/** one relay message at most (the relay takes 900,000 characters) */
export const PART_CHARS = 400_000;

/** an encrypted payload in parts the relay takes */
export const splitBody = (body: string, size = PART_CHARS) => {
  const parts: string[] = [];
  for (let i = 0; i < body.length || parts.length === 0; i += size) {
    parts.push(body.slice(i, i + size));
  }
  return parts;
};

/** an unfinished payload is dropped after this */
const ASSEMBLY_MS = 2 * 60_000;
/** the most a viewer puts together at once (a scene with big images) */
const ASSEMBLY_CHARS = 64 * 1024 * 1024;

/** a payload that came in parts, put together again (per sender and request) */
export class Assembler {
  private readonly open = new Map<string, { parts: string[]; count: number; size: number; at: number }>();

  /** the whole body once its last part is in, else null */
  add(key: string, part: number, parts: number, body: string, now: number): string | null {
    if (parts <= 1) {
      return body;
    }
    this.sweep(now);
    if (!Number.isSafeInteger(part) || part < 0 || part >= parts || parts > ASSEMBLY_CHARS / 1000) {
      return null;
    }
    let entry = this.open.get(key);
    if (entry?.parts.length !== parts) {
      entry = { parts: new Array<string>(parts), count: 0, size: 0, at: now };
      this.open.set(key, entry);
    }
    if (entry.parts[part] === undefined) {
      entry.count++;
      entry.size += body.length;
    }
    entry.parts[part] = body;
    if (entry.size > ASSEMBLY_CHARS) {
      this.open.delete(key);
      return null;
    }
    if (entry.count < parts) {
      return null;
    }
    this.open.delete(key);
    return entry.parts.join("");
  }

  sweep(now: number) {
    for (const [key, entry] of this.open) {
      if (now - entry.at > ASSEMBLY_MS) {
        this.open.delete(key);
      }
    }
  }
}

/** what an agent's tool hears when someone else holds the pen */
export const editingRefusal = (holder: string) =>
  `${holder} is editing this scene right now: only their Kurviq tab accepts edits (one editor at a time). Reading works; ask the user to click "Ask to edit" in Kurviq, or try again later.`;

/**
 * A dead connection, decided by progress, not a fixed time: nothing came in
 * for `silentMs` and what this tab sends doesn't drain either (a big upload
 * that is still moving keeps the connection).
 */
export const connectionDead = (now: number, lastMessageAt: number, buffered: number, bufferedBefore: number, silentMs = 60_000) =>
  now - lastMessageAt > silentMs && (buffered === 0 || buffered >= bufferedBefore);

/**
 * A socket that is closing or closed counts as gone at once: its close
 * handshake can hang for minutes when the network is down (the close event
 * comes only when the other side answers), and the tab must not stay
 * "connected" and read only meanwhile.
 */
export const socketGone = (readyState: number) => readyState === 2 || readyState === 3; // WebSocket.CLOSING, WebSocket.CLOSED

/**
 * A socket this tab gives up on: no more events from it, closed without
 * waiting for the handshake, and `gone` runs right away.
 */
export const dropSocket = (
  ws: { onmessage: unknown; onclose: unknown; onerror: unknown; close: () => void },
  gone: () => void,
) => {
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close();
  } catch {
    // closed already
  }
  gone();
};
