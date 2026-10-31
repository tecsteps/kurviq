// "Sign in with Google" without a Kurviq account: Google's OAuth tokens,
// kept in an encrypted httpOnly cookie of this browser. The Worker stores
// nothing — the cookie is the only place the refresh token exists (besides
// Google).
//
//   GET  /auth/login?return=…    sign in with Google (Drive: drive.file only)
//   GET  /auth/callback          Google's redirect: code -> tokens -> cookie
//   POST /auth/token             a valid access token (1 h) for the page,
//                                refreshed with the refresh token when needed
//                                ({ connected: false } if there is none)
//   POST /auth/logout            forget the connection in this browser
//
// The local install (localhost, *.test) signs in through these routes too:
// its return address is allowed, and instead of a cookie (which it couldn't
// read) it gets the session sealed in the URL fragment. It keeps that blob
// and sends it to /auth/token and /auth/logout (CORS, local origins only).
//
// Google's refresh tokens don't expire while they are used (the consent
// screen must be "In production"; in "Testing" they last 7 days) and don't
// rotate, so tabs refreshing at the same moment don't hurt each other.

import google from "../google.json";
import { googleUrls } from "./google";
import type { GoogleEnv } from "./google";

export type AuthEnv = GoogleEnv & {
  /** default: online/google.json */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET: string;
  /** base64 of 32 random bytes: encrypts the cookies */
  COOKIE_KEY: string;
  /** wrangler dev only (.dev.vars): this server's real address; wrangler dev gives the Worker the first route's (kurviq.com) */
  DEV_ORIGIN?: string;
  /**
   * live sync: base64 of 32 random bytes, seals refresh tokens handed to a
   * scene's Durable Object (outside the database); TOKEN_KEY_PREVIOUS: the
   * one before a rotation, still accepted
   */
  TOKEN_KEY?: string;
  TOKEN_KEY_PREVIOUS?: string;
  /** base64 of 32 random bytes: derives the per-scene pseudonyms (required for live sync) */
  PSEUDONYM_KEY?: string;
  /** "sign out everywhere" epochs (./account.ts), checked when a session's account is known */
  ACCOUNT?: DurableObjectNamespace;
};

/**
 * The dev gate: the fake Google, test hooks and DEV_ORIGIN are trusted only
 * with FAKE_GOOGLE=1, a local DEV_ORIGIN, and (when there is a request) a
 * request from this machine — never on kurviq.com, whatever the env says
 */
export const devGate = (env: { FAKE_GOOGLE?: string; DEV_ORIGIN?: string }, request?: Request) => {
  if (env.FAKE_GOOGLE !== "1" || !isLocalOrigin(env.DEV_ORIGIN ?? null)) {
    return false;
  }
  if (!request) {
    return true;
  }
  // wrangler dev hands the Worker the first route's host (kurviq.com): the client's address tells instead
  // (in production it is always the visitor's public address, never a loopback one)
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const host = new URL(request.url).hostname;
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "::ffff:127.0.0.1" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".localhost")
  );
};

const clientId = (env: AuthEnv) => env.GOOGLE_CLIENT_ID || google.clientId;

const SESSION_COOKIE = "kq_google";
const STATE_COOKIE = "kq_oauth_state";
/** purpose of a session handed to the local install (never valid as a cookie) */
const LOCAL_SESSION = "kq_google_local";
/** browsers cap cookies at 400 days; every refresh renews it */
const SESSION_DAYS = 400;
/** the local install's sealed session: valid this long after its last renewal (each refresh renews it) */
const LOCAL_SESSION_DAYS = 90;

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
];
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleUser = { email: string; name: string | null; avatarUrl: string | null };

export type Session = {
  /** access token and when it expires (ms) */
  a: string;
  ae: number;
  /** refresh token */
  r: string;
  user: GoogleUser;
  /** the user allowed Kurviq's Drive access (Google lets them untick it) */
  drive: boolean;
  /** Google's stable account id (missing in sessions made before live sync) */
  sub?: string;
  /** when this sign-in happened (ms): "sign out everywhere" ends every session issued before */
  iat?: number;
  /** the local install's sealed session: valid until (ms), renewed with every refresh */
  exp?: number;
  /** the local install's origin it was handed to: refused from any other page */
  lo?: string;
};

// -----------------------------------------------------------------------------
// encrypted cookies (AES-GCM)
// -----------------------------------------------------------------------------

export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (text: string) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

let cachedKey: { raw: string; key: CryptoKey } | null = null;

const cookieKey = async (env: AuthEnv) => {
  if (cachedKey?.raw !== env.COOKIE_KEY) {
    const raw = Uint8Array.from(atob(env.COOKIE_KEY), (char) => char.charCodeAt(0));
    if (raw.length !== 32) {
      throw new Error("COOKIE_KEY must be base64 of 32 bytes");
    }
    cachedKey = { raw: env.COOKIE_KEY, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
  }
  return cachedKey.key;
};

export const seal = async (env: AuthEnv, value: unknown, purpose: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, await cookieKey(env), data),
  );
  return `${b64url(iv)}.${b64url(sealed)}`;
};

export const unseal = async <T>(env: AuthEnv, text: string | undefined, purpose: string): Promise<T | null> => {
  if (!text) {
    return null;
  }
  try {
    const [iv, sealed] = text.split(".").map(fromB64url);
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
      await cookieKey(env),
      sealed,
    );
    return JSON.parse(new TextDecoder().decode(data)) as T;
  } catch {
    return null;
  }
};

const readCookie = (request: Request, name: string) => {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === name) {
      return part.slice(index + 1);
    }
  }
  return undefined;
};

const cookie = (request: Request, name: string, value: string, maxAgeSeconds: number) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`;
};

// -----------------------------------------------------------------------------
// Google
// -----------------------------------------------------------------------------

type TokenAnswer = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

const exchange = async (env: AuthEnv, params: Record<string, string>): Promise<TokenAnswer> => {
  let res: Response;
  try {
    res = await fetch(googleUrls(env).token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(env), client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
    });
  } catch {
    return { error: "http_0" };
  }
  if (res.ok) {
    return res.json();
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.status < 500) {
    console.warn(`[auth] Google's token endpoint: ${body.error} (${body.error_description ?? ""}) redirect_uri=${params.redirect_uri ?? "-"}`);
  }
  return { error: res.status >= 500 ? `http_${res.status}` : String(body.error || `http_${res.status}`) };
};

const idClaims = (idToken: string | undefined): any => {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(idToken!.split(".")[1])));
  } catch {
    return null;
  }
};

/** who signed in: from the ID token, which came straight from Google's token endpoint (TLS) */
const userOf = (idToken: string | undefined): GoogleUser | null => {
  const claims = idClaims(idToken);
  if (!claims?.email) {
    return null;
  }
  return {
    email: String(claims.email),
    name: claims.name ? String(claims.name) : null,
    avatarUrl: claims.picture ? String(claims.picture) : null,
  };
};

/** Google's stable account id (the email can change) */
const subOf = (idToken: string | undefined): string | undefined => {
  const sub = idClaims(idToken)?.sub;
  return typeof sub === "string" && /^[\w.-]{1,128}$/.test(sub) ? sub : undefined;
};

const grantsDrive = (scope: string | undefined) => (scope ?? "").split(" ").includes(DRIVE_SCOPE);

const sessionCookie = async (request: Request, env: AuthEnv, session: Session) =>
  cookie(request, SESSION_COOKIE, await seal(env, session, SESSION_COOKIE), SESSION_DAYS * 24 * 3600);

/** a session with a fresh access token, or why there is none */
const refresh = async (env: AuthEnv, session: Session): Promise<Session | "expired" | "unreachable"> => {
  const answer = await exchange(env, { grant_type: "refresh_token", refresh_token: session.r });
  if (!answer.access_token) {
    return answer.error?.startsWith("http_") ? "unreachable" : "expired";
  }
  // a refresh brings an ID token when the grant has openid: the sub of
  // sessions made before live sync comes from there (else a new sign-in)
  const sub = subOf(answer.id_token);
  return {
    ...session,
    a: answer.access_token,
    ae: Date.now() + (answer.expires_in ?? 3600) * 1000,
    drive: answer.scope ? grantsDrive(answer.scope) : session.drive,
    sub: session.sub ?? sub,
  };
};

const tokenAnswer = (session: Session) => ({
  token: session.a,
  expiresAt: new Date(session.ae).toISOString(),
  user: session.user,
  drive: session.drive,
});

// -----------------------------------------------------------------------------
// live sync: refresh tokens sealed for one scene's Durable Object
// -----------------------------------------------------------------------------

const tokenKeys = new Map<string, { id: string; key: CryptoKey }>();

/** TOKEN_KEY (or TOKEN_KEY_PREVIOUS) as an AES key, with its id: the first 8 characters of its SHA-256 */
const tokenKey = async (raw64: string | undefined) => {
  if (!raw64) {
    return null;
  }
  let entry = tokenKeys.get(raw64);
  if (!entry) {
    const raw = Uint8Array.from(atob(raw64), (char) => char.charCodeAt(0));
    if (raw.length !== 32) {
      throw new Error("TOKEN_KEY must be base64 of 32 bytes");
    }
    const id = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))).slice(0, 8);
    entry = { id, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
    tokenKeys.set(raw64, entry);
  }
  return entry;
};

const tokenAad = (fileId: string, sub: string, exp: number, keyId: string) =>
  new TextEncoder().encode(`kurviq-scene-token:${fileId}:${sub}:${exp}:${keyId}`);

export type SceneToken = { r: string; iat: number; exp: number };

/**
 * An author's refresh token for one scene's Durable Object:
 * "<keyId>.<exp>.<iv>.<ciphertext>", bound to the file, the account and the
 * expiry (the lease): the DO can't use it for another scene or person, or
 * after it ran out. `iat`: when the session was signed in (sign out everywhere).
 */
export const sealSceneToken = async (env: AuthEnv, fileId: string, sub: string, refreshToken: string, iat: number, exp: number) => {
  const current = await tokenKey(env.TOKEN_KEY);
  if (!current) {
    throw new Error("TOKEN_KEY is not set");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ r: refreshToken, iat }));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: tokenAad(fileId, sub, exp, current.id) }, current.key, data),
  );
  return `${current.id}.${exp}.${b64url(iv)}.${b64url(sealed)}`;
};

/** the expiry of a sealed scene token, readable without the key (0: not one) */
export const sceneTokenExpiry = (sealed: string | null | undefined) => Number(String(sealed || "").split(".")[1]) || 0;

export const unsealSceneToken = async (env: AuthEnv, sealed: string, fileId: string, sub: string): Promise<SceneToken | null> => {
  try {
    const [keyId, expText, iv, data] = sealed.split(".");
    const exp = Number(expText);
    if (!(exp > Date.now())) {
      return null;
    }
    for (const raw of [env.TOKEN_KEY, env.TOKEN_KEY_PREVIOUS]) {
      const entry = await tokenKey(raw);
      if (entry?.id === keyId) {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromB64url(iv), additionalData: tokenAad(fileId, sub, exp, keyId) },
          entry.key,
          fromB64url(data),
        );
        const value = JSON.parse(new TextDecoder().decode(plain));
        return { r: String(value.r), iat: Number(value.iat) || 0, exp };
      }
    }
  } catch {}
  return null;
};

/** a 1-hour access token from a refresh token (the scene DO saving as its author) */
export const accessFromRefresh = async (env: AuthEnv, refreshToken: string) => {
  const answer = await exchange(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (!answer.access_token) {
    return answer.error?.startsWith("http_") ? ("unreachable" as const) : ("expired" as const);
  }
  return { token: answer.access_token, expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000 };
};

/** Kurviq's grant at Google ends (sign out everywhere) */
export const revokeAtGoogle = async (env: AuthEnv, refreshToken: string) => {
  try {
    const res = await fetch(googleUrls(env).revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok || res.status === 400; // 400: already revoked
  } catch {
    return false;
  }
};

/**
 * A Drive watch channel's secret: derived from the file and channel id with a
 * server key, so the Worker checks a notification before any scene object is woken
 */
export const watchSecret = async (env: AuthEnv, fileId: string, channelId: string) => {
  const raw = Uint8Array.from(atob(env.COOKIE_KEY), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`kurviq-watch:${fileId}|${channelId}`)));
  return b64url(mac).slice(0, 32);
};

/**
 * A person's name in one scene's file: derived from the account id, the
 * file id and a server secret, so it can't be linked across scenes (not even
 * by someone who holds both scenes' keys)
 */
export const pseudonymOf = async (env: AuthEnv, sub: string, fileId: string) => {
  if (!env.PSEUDONYM_KEY) {
    throw new Error("PSEUDONYM_KEY is not set");
  }
  const secret = Uint8Array.from(atob(env.PSEUDONYM_KEY), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`kurviq-pseudonym:${sub}:${fileId}`)));
  return `p${b64url(mac).slice(0, 11)}`;
};

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

/** the local install: localhost, 127.0.0.1, *.localhost and *.test (Herd), any port */
export const isLocalOrigin = (origin: string | null) => {
  if (!origin) {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".test"))
    );
  } catch {
    return false;
  }
};

/**
 * Where to go back to: a path on this site, or a page of the local install
 * (no open redirects otherwise). Parsed like a browser would (which drops
 * tabs and newlines and reads "\\" as "/").
 */
const safeReturn = (value: string | null, origin: string): { back: string; local: boolean } => {
  if (!value || /[\u0000-\u001f\\]/.test(value)) {
    return { back: "/", local: false };
  }
  try {
    const target = new URL(value, origin);
    if (value.startsWith("/") && target.origin === origin) {
      return { back: `${target.pathname}${target.search}`, local: false };
    }
    if (isLocalOrigin(target.origin) && target.origin !== origin) {
      return { back: `${target.origin}${target.pathname}${target.search}`, local: true };
    }
  } catch {}
  return { back: "/", local: false };
};

const withParam = (path: string, key: string, value: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach((value) => headers.append("Set-Cookie", value));
  return new Response(null, { status: 302, headers });
};

const json = (status: number, body: unknown, cookies: string[] = [], corsOrigin?: string) => {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  cookies.forEach((value) => headers.append("Set-Cookie", value));
  if (corsOrigin) {
    headers.set("Access-Control-Allow-Origin", corsOrigin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
};

/** `redirect`: Google's redirect URI of this flow, sent again with the code */
/**
 * `pageState`: the local install's own value (?state= on /auth/login), handed
 * back in the fragment so that page knows the sign-in is the one it started
 */
type Flow = { state: string; back: string; local: boolean; consent: boolean; redirect: string; pageState?: string };

const PAGE_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

const startFlow = async (
  request: Request,
  env: AuthEnv,
  back: string,
  local: boolean,
  consent: boolean,
  hint?: string,
  redirectUri?: string,
  pageState?: string,
) => {
  const url = new URL(request.url);
  // wrangler dev: its real (local) address; never a configured non-local one
  const callback = redirectUri ?? `${isLocalOrigin(env.DEV_ORIGIN ?? null) ? env.DEV_ORIGIN : url.origin}/auth/callback`;
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const sealed = await seal(env, { state, back, local, consent, redirect: callback, pageState } satisfies Flow, STATE_COOKIE);
  const target = new URL(googleUrls(env, url.origin).authorize);
  target.searchParams.set("client_id", clientId(env));
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", SCOPES.join(" "));
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("include_granted_scopes", "true");
  target.searchParams.set("state", state);
  // Google hands out a refresh token only on consent: asked for once more
  // when a sign-in came back without one (see the callback)
  target.searchParams.set("prompt", consent ? "consent" : "select_account");
  if (hint) {
    target.searchParams.set("login_hint", hint);
  }
  // an hour: Google's pages (account, consent, two-step login) can take a while
  return redirect(target.toString(), [cookie(request, STATE_COOKIE, sealed, 3600)]);
};

/** back to the page that asked: this site (cookie) or the local install (sealed session in the fragment) */
const finish = async (request: Request, env: AuthEnv, flow: Flow, status: string, session?: Session) => {
  const clearState = cookie(request, STATE_COOKIE, "", 0);
  if (flow.local) {
    const fragment = new URLSearchParams({ "kurviq-google": status });
    if (flow.pageState) {
      fragment.set("kurviq-state", flow.pageState);
    }
    if (session) {
      // bound to the page it goes to: presented from any other origin it is refused
      fragment.set("session", await sealLocalSession(env, { ...session, lo: new URL(flow.back).origin }));
    }
    return redirect(`${flow.back}#${fragment}`, [clearState]);
  }
  return redirect(withParam(flow.back, "google", status), session ? [clearState, await sessionCookie(request, env, session)] : [clearState]);
};

/**
 * The session a request carries: Kurviq's own pages send the cookie, the
 * local install sends its sealed session in the body ({ session }).
 */
const sessionOf = async (request: Request, env: AuthEnv, local: boolean) => {
  if (!local) {
    return cookieSession(request, env);
  }
  // a sealed session is a few KB: anything bigger is not read
  const text = await readBody(request, 32 * 1024);
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  return localSession(env, body?.session, request.headers.get("Origin"));
};

/** a request body up to `max` bytes, read as a stream (stops beyond it); "" when bigger */
const readBody = async (request: Request, max: number) => {
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "";
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
};

export const cookieSession = (request: Request, env: AuthEnv) => unseal<Session>(env, readCookie(request, SESSION_COOKIE), SESSION_COOKIE);

/**
 * Local-install sessions sealed before expiries existed have none: they work
 * until this date (about 90 days after live sync shipped, 2026-10-31), and get
 * an expiry with their next refresh; after it they need a new sign-in.
 */
const LEGACY_LOCAL_DEADLINE = Date.UTC(2027, 0, 31);

/** the local install's sealed session, unless it ran out or comes from another origin than the one it was handed to */
export const localSession = async (env: AuthEnv, sealed: unknown, origin: string | null) => {
  const session = await unseal<Session>(env, typeof sealed === "string" ? sealed : undefined, LOCAL_SESSION);
  const until = session?.exp ?? LEGACY_LOCAL_DEADLINE;
  if (!session || until <= Date.now() || (session.lo && session.lo !== origin)) {
    return null;
  }
  return session;
};

/** renewed: a new expiry; the sign-in time stays what it was (0 if unknown: live sync then asks for a new sign-in) */
export const sealLocalSession = (env: AuthEnv, session: Session) =>
  seal(env, { ...session, iat: session.iat ?? 0, exp: Date.now() + LOCAL_SESSION_DAYS * 24 * 3600_000 }, LOCAL_SESSION);

/** an account's "sign out everywhere" epoch (0: never); null: the guard could not be asked or answered nonsense */
export const accountEpochOf = async (env: AuthEnv, sub: string, init?: RequestInit): Promise<number | null> => {
  if (!env.ACCOUNT) {
    return null;
  }
  try {
    const res = await env.ACCOUNT.get(env.ACCOUNT.idFromName(sub)).fetch("https://account/epoch", init);
    const epoch = res.ok ? ((await res.json()) as any)?.epoch : undefined;
    return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
  } catch {
    return null;
  }
};

/** "sign out everywhere" ended this session (its account's epoch is newer than its sign-in); "unknown": couldn't check */
export const revokedEverywhere = async (env: AuthEnv, session: Session): Promise<boolean | "unknown"> => {
  if (!session.sub) {
    return false;
  }
  const epoch = await accountEpochOf(env, session.sub);
  if (epoch === null) {
    return env.ACCOUNT ? "unknown" : false;
  }
  return !!epoch && (session.iat ?? 0) < epoch;
};

/** Set-Cookie of a renewed session (Kurviq's own pages) */
export const sessionCookieHeader = (request: Request, env: AuthEnv, session: Session) => sessionCookie(request, env, session);

export const clearSessionCookie = (request: Request) => cookie(request, SESSION_COOKIE, "", 0);

/**
 * A session whose access token is good for 10 more minutes: as it is, or
 * refreshed (`renewed`). "unreachable": Google's 5xx or a timeout; "expired":
 * the grant is gone (revoked, or the password changed).
 */
export const freshSession = async (env: AuthEnv, session: Session, needSub = false) => {
  if (session.ae - Date.now() > 10 * 60_000 && (!needSub || session.sub)) {
    return { session, renewed: false };
  }
  const next = await refresh(env, session);
  return typeof next === "string" ? next : { session: next, renewed: true };
};

export const handleAuth = async (request: Request, env: AuthEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) {
    return null;
  }
  const origin = request.headers.get("Origin");
  const local = isLocalOrigin(origin) && origin !== url.origin;

  if (request.method === "OPTIONS" && local && (url.pathname === "/auth/token" || url.pathname === "/auth/logout")) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }
  if (!clientId(env) || !env.GOOGLE_CLIENT_SECRET || !env.COOKIE_KEY) {
    if (url.pathname === "/auth/token") {
      // a Kurviq without Google: nobody is signed in, scenes stay in the browser
      return json(200, { connected: false }, [], local ? origin! : undefined);
    }
    return json(503, { error: "Google sign-in is not configured on this Kurviq server" }, [], local ? origin! : undefined);
  }

  if (url.pathname === "/auth/login" && request.method === "GET") {
    const { back, local: toLocal } = safeReturn(url.searchParams.get("return"), url.origin);
    const pageState = url.searchParams.get("state");
    if (toLocal && pageState !== null && !PAGE_STATE_RE.test(pageState)) {
      return json(400, { error: "state: 16 to 128 characters of A-Z a-z 0-9 _ -" });
    }
    return startFlow(
      request,
      env,
      back,
      toLocal,
      url.searchParams.has("consent"),
      url.searchParams.get("hint") ?? undefined,
      undefined,
      toLocal ? pageState ?? undefined : undefined,
    );
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const flow = await unseal<Flow>(env, readCookie(request, STATE_COOKIE), STATE_COOKIE);
    if (!flow || flow.state !== url.searchParams.get("state")) {
      console.warn(`[auth] sign-in failed: ${flow ? "state does not match" : "no sign-in started in this browser (state cookie missing)"}`);
      return redirect("/?google=failed", [cookie(request, STATE_COOKIE, "", 0)]);
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      console.warn(`[auth] sign-in cancelled: ${url.searchParams.get("error") ?? "no code"}`);
      return finish(request, env, flow, "cancelled");
    }
    const answer = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: flow.redirect });
    const user = userOf(answer.id_token);
    if (!answer.access_token || !user) {
      // (only `wrangler tail` sees this: no request logs are kept)
      console.warn(`[auth] sign-in failed: ${answer.error ?? (answer.access_token ? "no email in the ID token" : "no token")}`);
      return finish(request, env, flow, "failed");
    }
    if (!answer.refresh_token) {
      // allowed before (another browser has the refresh token): ask for consent once more
      if (!flow.consent) {
        return startFlow(request, env, flow.back, flow.local, true, user.email, flow.redirect, flow.pageState);
      }
      console.warn("[auth] sign-in failed: no refresh token, even after consent");
      return finish(request, env, flow, "failed");
    }
    const session: Session = {
      a: answer.access_token,
      ae: Date.now() + (answer.expires_in ?? 3600) * 1000,
      r: answer.refresh_token,
      user,
      drive: grantsDrive(answer.scope),
      sub: subOf(answer.id_token),
      iat: Date.now(),
    };
    return finish(request, env, flow, session.drive ? "connected" : "nodrive", session);
  }

  if (url.pathname === "/auth/token" && request.method === "POST") {
    if (origin !== url.origin && !local) {
      return json(403, { error: "Forbidden" });
    }
    const cors = local ? origin! : undefined;
    const session = await sessionOf(request, env, local);
    if (!session) {
      return json(200, { connected: false }, [], cors);
    }
    // signed out everywhere since: this session is over too (and if that can't be checked now, no token is handed out)
    const revoked = await revokedEverywhere(env, session);
    if (revoked === "unknown") {
      return json(503, { error: "Sign-in check not available, try again" }, [], cors);
    }
    if (revoked) {
      return json(200, { connected: false, expired: true }, local ? [] : [cookie(request, SESSION_COOKIE, "", 0)], cors);
    }
    if (session.ae - Date.now() > 10 * 60_000) {
      return json(200, tokenAnswer(session), [], cors);
    }
    const next = await refresh(env, session);
    if (next === "unreachable") {
      return json(503, { error: "Google not reachable" }, [], cors);
    }
    if (next === "expired") {
      // revoked at Google (or the password changed): signed out
      return json(200, { connected: false, expired: true }, local ? [] : [cookie(request, SESSION_COOKIE, "", 0)], cors);
    }
    if (local) {
      return json(200, { ...tokenAnswer(next), session: await sealLocalSession(env, next) }, [], cors);
    }
    return json(200, tokenAnswer(next), [await sessionCookie(request, env, next)]);
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    if (origin !== url.origin && !local) {
      return json(403, { error: "Forbidden" });
    }
    // not revoked at Google: that would end Kurviq's access in every other
    // browser of this user too (they remove it at myaccount.google.com/permissions)
    return json(200, { ok: true }, local ? [] : [cookie(request, SESSION_COOKIE, "", 0)], local ? origin! : undefined);
  }

  return json(404, { error: "Not found" });
};
