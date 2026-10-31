// The contact form (kurviq.com/contact, linked from the imprint): a second,
// fast way to reach Kurviq besides email. Plain HTML, no script:
//
//   GET  /contact          the page (online/pages/contact.html); ?sent=1 shows the confirmation
//   POST /contact          name (optional), email (required, for the reply), message (required);
//                          stored in D1 (contact_messages) and, if the CONTACT_EMAIL
//                          send_email binding is configured, emailed to the operator;
//                          then 303 to /contact?sent=1. Errors: the page again, filled in.
//
// Rate-limited per sender like feedback: the sender is kept only as a keyed
// hash of the IP address, blanked after a day. Messages are deleted a year after receipt
// (./retention.ts).

import { keyedHash } from "./feedback";
import type { StatsEnv } from "./stats";
import { countStat, pageStats } from "./stats";

type D1 = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => { first: <T>() => Promise<T | null>; run: () => Promise<unknown> };
  };
};

/** Cloudflare's send_email binding (Email Routing) */
type SendEmail = { send: (message: unknown) => Promise<void> };

export type ContactEnv = StatsEnv & {
  FEEDBACK?: D1;
  COOKIE_KEY: string;
  ASSETS: Fetcher;
  /** optional: wrangler.jsonc send_email binding; without it messages are only stored */
  CONTACT_EMAIL?: SendEmail;
  /** the sender address on kurviq.com (Email Routing) and the recipient (verified destination) */
  CONTACT_FROM?: string;
  CONTACT_TO?: string;
};

const PER_HOUR = 5;
const PER_DAY = 20;
/** all senders together per day: bounds storage and email even from many addresses */
const ALL_PER_DAY = 200;

/** the rate-limit key of an address: IPv6 by its /64 (one connection usually has a whole /64) */
/** the largest form body read (the fields are capped far below) */
const MAX_BODY = 30_000;

/** the request body, read up to max bytes (null if it is longer), whatever Content-Length says */
const readBounded = async (request: Request, max: number): Promise<Uint8Array | null> => {
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
};

const senderKey = (ip: string) => (ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip);
const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const CONTACT_SCHEMA = `CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  sender TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new'
)`;

let schemaReady = false;

/** the sender, as a keyed hash of the IP address: messages can be counted per sender, nobody can be identified */
const senderHash = (env: ContactEnv, ip: string) => keyedHash(env.COOKIE_KEY, `contact:${ip}`);

/** plain text: no control characters except line breaks and tabs, trimmed */
const clean = (value: unknown, max: number, multiline = false) =>
  String(value ?? "")
    .replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max + 1);

const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/** the message as a MIME email to the operator (reply goes to the sender's address) */
const mime = (env: ContactEnv, id: number, input: { name: string; email: string; message: string }, at: string) => {
  const from = env.CONTACT_FROM || "contact@kurviq.com";
  const to = env.CONTACT_TO || "fabian.wesner@tecsteps.com";
  const subject = `Kurviq contact #${id}${input.name ? ` from ${input.name.slice(0, 50)}` : ""}`;
  const body = `${input.message}\n\n--\nName: ${input.name || "(none)"}\nEmail: ${input.email}\nReceived: ${at} (UTC)\nMessage #${id} in D1 contact_messages (deleted automatically after one year)\n`;
  return {
    from,
    to,
    raw: [
      `From: Kurviq contact form <${from}>`,
      `To: <${to}>`,
      `Reply-To: <${input.email}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date(at).toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <contact-${id}-${crypto.randomUUID()}@${from.split("@")[1]}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(body).replace(/.{76}/g, "$&\r\n"),
      "",
    ].join("\r\n"),
  };
};

const sendEmail = async (env: ContactEnv, id: number, input: { name: string; email: string; message: string }, at: string) => {
  if (!env.CONTACT_EMAIL) {
    return false;
  }
  try {
    // @ts-ignore provided by the Workers runtime (external in build-worker.mjs)
    const { EmailMessage } = await import("cloudflare:email");
    const { from, to, raw } = mime(env, id, input, at);
    await env.CONTACT_EMAIL.send(new EmailMessage(from, to, raw));
    return true;
  } catch (error) {
    console.warn(`[contact] email for message #${id} failed: ${(error as Error).message}`);
    return false;
  }
};

/** the contact page from the static assets, with a status shown (and the form filled in again after an error) */
const page = async (
  request: Request,
  env: ContactEnv,
  status?: { kind: "ok" | "error"; text: string; values?: { name: string; email: string; message: string } },
  code = 200,
) => {
  const asset = await env.ASSETS.fetch(new Request(new URL("/contact", request.url), { headers: { Accept: "text/html" } }));
  if (!status) {
    return asset;
  }
  const values = status.values;
  let rewriter = new HTMLRewriter().on("#contact-status", {
    element: (el) => {
      el.removeAttribute("hidden");
      el.setAttribute("class", `status ${status.kind}`);
      el.setAttribute("role", status.kind === "ok" ? "status" : "alert");
      el.setInnerContent(status.text);
    },
  });
  if (status.kind === "ok") {
    rewriter = rewriter.on("#contact-form", { element: (el) => el.remove() });
  } else if (values) {
    rewriter = rewriter
      .on('input[name="name"]', { element: (el) => el.setAttribute("value", values.name) })
      .on('input[name="email"]', { element: (el) => el.setAttribute("value", values.email) })
      .on('textarea[name="message"]', { element: (el) => el.setInnerContent(values.message) });
  }
  const response = rewriter.transform(asset);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: code, headers });
};

/** /contact and /contact.html, or null for other paths */
export const handleContact = async (request: Request, env: ContactEnv, ctx: ExecutionContext): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/contact" && url.pathname !== "/contact.html") {
    return null;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (url.searchParams.has("sent")) {
      return page(request, env, {
        kind: "ok",
        text: "Thank you, your message was sent. We will answer by email. / Danke, deine Nachricht wurde gesendet. Wir antworten per E-Mail.",
      });
    }
    const response = await page(request, env);
    pageStats(request, response, env, ctx);
    return response;
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  // only from this page (browsers send Origin with a form POST)
  const origin = request.headers.get("Origin");
  if (origin ? origin !== url.origin : request.headers.get("Sec-Fetch-Site") !== "same-origin") {
    return new Response("Forbidden", { status: 403 });
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) {
    return new Response("Too long", { status: 413 });
  }
  const body = await readBounded(request, MAX_BODY);
  if (!body) {
    return new Response("Too long", { status: 413 });
  }
  let form: FormData;
  try {
    form = await new Request(url, { method: "POST", headers: request.headers, body }).formData();
  } catch {
    return page(request, env, { kind: "error", text: "The form could not be read, please try again. / Das Formular konnte nicht gelesen werden." }, 400);
  }
  const values = {
    name: clean(form.get("name"), MAX_NAME),
    email: clean(form.get("email"), MAX_EMAIL),
    message: clean(form.get("message"), MAX_MESSAGE, true),
  };
  // the honeypot (hidden from people): a bot filled it in; it gets the confirmation, nothing is stored
  if (clean(form.get("website"), 200)) {
    return Response.redirect(new URL("/contact?sent=1", url).toString(), 303);
  }
  const problem =
    values.name.length > MAX_NAME
      ? `The name may be at most ${MAX_NAME} characters. / Der Name darf höchstens ${MAX_NAME} Zeichen lang sein.`
      : !EMAIL_RE.test(values.email) || values.email.length > MAX_EMAIL
        ? "Please enter a valid email address for our reply. / Bitte gib eine gültige E-Mail-Adresse für die Antwort an."
        : !values.message
          ? "Please write a message. / Bitte schreib eine Nachricht."
          : values.message.length > MAX_MESSAGE
            ? `The message may be at most ${MAX_MESSAGE} characters. / Die Nachricht darf höchstens ${MAX_MESSAGE} Zeichen lang sein.`
            : null;
  if (problem) {
    return page(request, env, { kind: "error", text: problem, values: { ...values, name: values.name.slice(0, MAX_NAME), message: values.message.slice(0, MAX_MESSAGE) } }, 400);
  }
  if (!env.FEEDBACK) {
    return page(request, env, { kind: "error", text: "The contact form is not available right now, please write an email. / Bitte schreib eine E-Mail.", values }, 503);
  }
  const db = env.FEEDBACK;
  if (!schemaReady) {
    await db.prepare(CONTACT_SCHEMA).bind().run();
    schemaReady = true;
  }
  const sender = await senderHash(env, senderKey(request.headers.get("CF-Connecting-IP") ?? "unknown"));
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  // one statement: the quotas are checked and the message stored atomically (parallel requests can't all pass)
  const row = await db
    .prepare(
      `INSERT INTO contact_messages (created_at, name, email, message, sender)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM contact_messages WHERE sender = ?5 AND created_at > ?6) < ${PER_HOUR}
         AND (SELECT COUNT(*) FROM contact_messages WHERE sender = ?5 AND created_at > ?7) < ${PER_DAY}
         AND (SELECT COUNT(*) FROM contact_messages WHERE created_at > ?7) < ${ALL_PER_DAY}
       RETURNING id`,
    )
    .bind(new Date(now).toISOString(), values.name || null, values.email, values.message, sender, new Date(now - 3600_000).toISOString(), dayAgo)
    .first<{ id: number }>();
  if (!row) {
    return page(
      request,
      env,
      { kind: "error", text: "Too many messages from here, please try again later or write an email. / Zu viele Nachrichten, bitte versuch es später oder schreib eine E-Mail.", values },
      429,
    );
  }
  const at = new Date(now).toISOString();
  const id = row.id;
  if (await sendEmail(env, id, values, at)) {
    await db.prepare("UPDATE contact_messages SET emailed = 1 WHERE id = ?").bind(id).run();
  }
  countStat(env, ctx, "contact");
  return Response.redirect(new URL("/contact?sent=1", url).toString(), 303);
};
