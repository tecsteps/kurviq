// Messages between a Kurviq tab and its pairing (Durable Object) over one
// WebSocket. Big messages (scene JSON, PNG renders) are sent in parts, so
// no single WebSocket message gets near the platform's size limit.
// Shared by the app (scenes-plugin) and the Worker (online/worker).

const PART_SIZE = 256 * 1024;

type Sender = { send: (data: string) => void };

export const sendMessage = (ws: Sender, message: unknown) => {
  const text = JSON.stringify(message);
  if (text.length <= PART_SIZE) {
    ws.send(text);
    return;
  }
  const id = Math.random().toString(36).slice(2, 12);
  const total = Math.ceil(text.length / PART_SIZE);
  for (let i = 0; i < total; i++) {
    ws.send(JSON.stringify({ type: "part", id, i, total, data: text.slice(i * PART_SIZE, (i + 1) * PART_SIZE) }));
  }
};

/** a message in parts is at most this big (a scene with images, a PNG render) */
const MAX_PARTS = 160; // 40 MB
/** messages being assembled at the same time, per connection */
const MAX_PENDING = 8;

/**
 * Collects parts; returns the whole message once complete (else null).
 * Throws on anything malformed or too big: the caller drops the connection.
 */
export const createReceiver = () => {
  const partial = new Map<string, { parts: string[]; count: number; at: number }>();
  return (raw: string): any => {
    // a part is a slice of JSON text packed into JSON again: escaping (\" \\
    // \uXXXX) can make it several times its length, so the bound is generous;
    // the part's own content is checked below
    if (raw.length > PART_SIZE * 6 + 1024) {
      throw new Error("message too big");
    }
    const message = JSON.parse(raw);
    if (message?.type !== "part") {
      return message;
    }
    const { id, i, total, data } = message;
    if (
      typeof id !== "string" ||
      id.length > 40 ||
      !Number.isInteger(total) ||
      total < 1 ||
      total > MAX_PARTS ||
      !Number.isInteger(i) ||
      i < 0 ||
      i >= total ||
      typeof data !== "string" ||
      data.length > PART_SIZE
    ) {
      throw new Error("malformed part");
    }
    // drop leftovers of messages that never completed
    for (const [key, entry] of partial) {
      if (Date.now() - entry.at > 120_000) {
        partial.delete(key);
      }
    }
    if (!partial.has(id) && partial.size >= MAX_PENDING) {
      throw new Error("too many unfinished messages");
    }
    const entry = partial.get(id) ?? { parts: new Array(total), count: 0, at: Date.now() };
    if (entry.parts.length !== total) {
      throw new Error("malformed part");
    }
    if (entry.parts[i] === undefined) {
      entry.parts[i] = data;
      entry.count++;
    }
    partial.set(id, entry);
    if (entry.count < total) {
      return null;
    }
    partial.delete(id);
    return JSON.parse(entry.parts.join(""));
  };
};
