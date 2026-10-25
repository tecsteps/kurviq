// Bug reports and change requests, from the app (POST /api/feedback) and from
// agents (the MCP's send_feedback): checked (scenes-mcp/feedback.mjs: plain
// text, limited length), rate-limited per sender, stored in D1. Who sent it
// is kept only as a keyed hash (of the IP address, or of the agent pairing).

import { cleanFeedback } from "../../scenes-mcp/feedback.mjs";

/** the D1 calls used here */
type D1 = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => { first: <T>() => Promise<T | null>; run: () => Promise<unknown> };
  };
};

export type FeedbackEnv = { FEEDBACK?: D1; COOKIE_KEY: string };

/** reports per sender and hour */
const PER_HOUR = 10;

const SCHEMA = `CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  scene TEXT,
  source TEXT NOT NULL,
  sender TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT
)`;

let schemaReady = false;

/** a sender, as a keyed hash: reports can be counted per sender, nobody can be identified */
export const senderHash = async (env: FeedbackEnv, value: string) => {
  const data = new TextEncoder().encode(`feedback:${env.COOKIE_KEY}:${value}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** store a report, or say why not: { id } | { error, status } */
export const saveFeedback = async (
  env: FeedbackEnv,
  input: unknown,
  { source, sender }: { source: "app" | "agent"; sender: string },
): Promise<{ id: number } | { error: string; status: number }> => {
  if (!env.FEEDBACK) {
    return { error: "Feedback is not available here", status: 503 };
  }
  const checked = cleanFeedback((input && typeof input === "object" ? input : {}) as Record<string, unknown>);
  if (!checked.ok) {
    return { error: checked.error, status: 400 };
  }
  const db = env.FEEDBACK;
  if (!schemaReady) {
    await db.prepare(SCHEMA).bind().run();
    schemaReady = true;
  }
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE sender = ? AND created_at > ?")
    .bind(sender, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= PER_HOUR) {
    return { error: `At most ${PER_HOUR} reports per hour, please try again later`, status: 429 };
  }
  const { kind, title, text, scene } = checked.value;
  const row = await db
    .prepare("INSERT INTO feedback (created_at, kind, title, text, scene, source, sender) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(new Date().toISOString(), kind, title, text, scene, source, sender)
    .first<{ id: number }>();
  return { id: row?.id ?? 0 };
};

/** POST /api/feedback from Kurviq's own pages */
export const handleFeedback = async (request: Request, env: FeedbackEnv) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  // only from Kurviq's pages
  if (request.headers.get("Origin") !== url.origin) {
    return json({ error: "Forbidden" }, 403);
  }
  const body = await request.text();
  if (body.length > 10_000) {
    return json({ error: "Too long" }, 413);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json({ error: "Not JSON" }, 400);
  }
  const sender = await senderHash(env, request.headers.get("CF-Connecting-IP") ?? "unknown");
  const result = await saveFeedback(env, input, { source: "app", sender });
  return "error" in result ? json({ error: result.error }, result.status) : json({ ok: true, id: result.id });
};
