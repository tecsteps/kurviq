// Bug reports and change requests, from the app (POST /api/feedback) and from
// agents (the MCP's send_feedback): checked (scenes-mcp/feedback.mjs: plain
// text, limited length), rate-limited per sender, stored in D1. Who sent it
// is kept only as a keyed hash (of the IP address, or of the agent pairing).

import { cleanFeedback } from "../../scenes-mcp/feedback.mjs";

import { bytesFromBase64, readJson } from "./bytes";
import { database } from "./database";
import type { D1 } from "./database";

export type FeedbackEnv = { FEEDBACK?: D1; COOKIE_KEY: string };

/** reports per sender and hour */
const PER_HOUR = 10;
/** reports of all senders together per day: bounds the storage even from many addresses */
const ALL_PER_DAY = 500;
/** the largest request body read (the report's fields are capped far below) */
const MAX_BODY = 10_000;

/**
 * The rate-limit key of an address: IPv6 by its /64 (one connection usually
 * has a whole /64 and may change its address inside it at will). "::" is
 * expanded first, so every address of a /64 gets the same key.
 */
export const senderKey = (ip: string) => {
  // IPv4 (also written inside IPv6, ::ffff:1.2.3.4): the address itself
  if (!ip.includes(":") || ip.includes(".")) {
    return ip;
  }
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
};

/** a sender, as a keyed hash: reports can be counted per sender, nobody can be identified */
export const senderHash = async (env: FeedbackEnv, value: string) => keyedHash(env.COOKIE_KEY, `feedback:${value}`);

/**
 * HMAC-SHA256 with a key derived from the server secret for this purpose
 * (not the secret itself), shortened to 24 hex characters: counts per sender,
 * identifies nobody
 */
export const keyedHash = async (secret64: string, value: string) => {
  const raw = bytesFromBase64(secret64);
  const master = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", master, new TextEncoder().encode("kurviq-sender-hash"));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(mac.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const db = await database(env.FEEDBACK);
  if (!db) {
    return { error: "Feedback is not available here", status: 503 };
  }
  const now = Date.now();
  const { kind, title, text, scene } = checked.value;
  // one statement: the quotas are checked and the report stored atomically (parallel requests can't all pass)
  const row = await db
    .prepare(
      `INSERT INTO feedback (created_at, kind, title, text, scene, source, sender)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT COUNT(*) FROM feedback WHERE sender = ?7 AND created_at > ?8) < ${PER_HOUR}
         AND (SELECT COUNT(*) FROM feedback WHERE created_at > ?9) < ${ALL_PER_DAY}
       RETURNING id`,
    )
    .bind(
      new Date(now).toISOString(),
      kind,
      title,
      text,
      scene,
      source,
      sender,
      new Date(now - 3_600_000).toISOString(),
      new Date(now - 86_400_000).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) {
    return { error: `At most ${PER_HOUR} reports per hour, please try again later`, status: 429 };
  }
  return { id: row.id };
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
  const body = await readJson(request, MAX_BODY);
  if (body === "too-big") {
    return json({ error: "Too long" }, 413);
  }
  if (body === "invalid") {
    return json({ error: "Not JSON" }, 400);
  }
  const sender = await senderHash(env, senderKey(request.headers.get("CF-Connecting-IP") ?? "unknown"));
  const result = await saveFeedback(env, body.value, { source: "app", sender });
  return "error" in result ? json({ error: result.error }, result.status) : json({ ok: true, id: result.id });
};
