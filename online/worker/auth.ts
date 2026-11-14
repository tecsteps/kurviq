// "Sign in with Google" without a Kurviq account: Google's OAuth tokens,
// kept in an encrypted httpOnly cookie of this browser. The Worker stores
// nothing: the cookie is the only place the refresh token exists (besides
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
// A *.test address is not loopback (whoever answers DNS on the network can
// serve it), so before a session goes there kurviq.com asks the user once
// per sign-in, on a page of its own (POST /auth/login).
//
// Google's refresh tokens don't expire while they are used (the consent
// screen must be "In production"; in "Testing" they last 7 days) and don't
// rotate, so tabs refreshing at the same moment don't hurt each other.

import google from "../google.json";
import { bytesFromBase64, readText } from "./bytes";
import { googleUrls } from "./google";
import type { GoogleEnv } from "./google";
import { isDevOrigin, isLocalInstall } from "./origins";

export type AuthEnv = GoogleEnv & {
  /** "on": sign-in also asks for drive.appdata (see scopesOf) */
  GOOGLE_APPDATA?: string;
  /** default: online/google.json */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * base64 of 32 random bytes: encrypts the session cookies, the local
   * install's sessions, agents' OAuth registrations and tokens, upload
   * addresses, and keys the rate-limit hashes (see online/secrets.mjs)
   */
  COOKIE_KEY: string;
  /** the COOKIE_KEY before a rotation: what it sealed is still accepted (sessions, agents' tokens) until it expires */
  COOKIE_KEY_PREVIOUS?: string;
  /** wrangler dev only (.dev.vars): this server's real address; wrangler dev gives the Worker the first route's (kurviq.com) */
  DEV_ORIGIN?: string;
  /**
   * the retired live sync: base64 of 32 random bytes, unseals the refresh
   * tokens its scene objects still hold while they are drained (./scene.ts),
   * and seals a sign-out-everywhere revocation to retry; TOKEN_KEY_PREVIOUS:
   * the one before a rotation. Unread once the follow-up release removed the
   * scene objects (docs/relay/CONCEPT.md)
   */
  TOKEN_KEY?: string;
  TOKEN_KEY_PREVIOUS?: string;
  /** "sign out everywhere" epochs (./account.ts), checked when a session's account is known */
  ACCOUNT?: DurableObjectNamespace;
};

/**
 * The dev gate: the fake Google, test hooks and DEV_ORIGIN are trusted only
 * with FAKE_GOOGLE=1, a local DEV_ORIGIN, and (when there is a request) a
 * request from this machine, never on kurviq.com, whatever the env says
 */
export const devGate = (env: { FAKE_GOOGLE?: string; DEV_ORIGIN?: string }, request?: Request) => {
  if (env.FAKE_GOOGLE !== "1" || !isDevOrigin(env.DEV_ORIGIN)) {
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
    ip === "::ffff:127.0.0.1" || // NOSONAR S1313: loopback is allowed only for the local development sign-in origin
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

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
];
/**
 * The hidden app data folder: Kurviq's own settings that follow the user
 * (connected databases). Asked for only with GOOGLE_APPDATA = "on", once the
 * scope is on the OAuth consent screen (else every sign-in would ask again
 * for a permission the console doesn't list); without it the connections
 * stay in the browser.
 */
const APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const scopesOf = (env: { GOOGLE_APPDATA?: string }) => (env.GOOGLE_APPDATA === "on" ? [...SCOPES, APPDATA_SCOPE] : SCOPES);
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
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").split("=")[0]; // NOSONAR S7758: base64 encoding uses binary bytes, not Unicode code points

const fromB64url = (text: string) => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)); // NOSONAR S7758: base64 decoding reads binary bytes, not Unicode code points
};

/** AES keys by their base64 text (COOKIE_KEY and COOKIE_KEY_PREVIOUS) */
const aesKeys = new Map<string, Promise<CryptoKey>>();

const aesKey = (raw64: string) => {
  let key = aesKeys.get(raw64);
  if (!key) {
    const raw = bytesFromBase64(raw64);
    if (raw.length !== 32) {
      throw new Error("COOKIE_KEY must be base64 of 32 bytes");
    }
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeys.set(raw64, key);
  }
  return key;
};

export const seal = async (env: AuthEnv, value: unknown, purpose: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, await aesKey(env.COOKIE_KEY), data),
  );
  return `${b64url(iv)}.${b64url(sealed)}`;
};

const unsealWith = async <T>(raw64: string, text: string, purpose: string): Promise<T | null> => {
  try {
    const [iv, sealed] = text.split(".").map(fromB64url);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, await aesKey(raw64), sealed);
    return JSON.parse(new TextDecoder().decode(data)) as T;
  } catch {
    return null;
  }
};

/** the value sealed with COOKIE_KEY (or, after a rotation, COOKIE_KEY_PREVIOUS); null: not ours, or tampered with */
export const unseal = async <T>(env: AuthEnv, text: string | undefined, purpose: string): Promise<T | null> => {
  if (!text) {
    return null;
  }
  const current = await unsealWith<T>(env.COOKIE_KEY, text, purpose);
  if (current !== null || !env.COOKIE_KEY_PREVIOUS) {
    return current;
  }
  return unsealWith<T>(env.COOKIE_KEY_PREVIOUS, text, purpose);
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
      // like the revocation: a hanging Google is "unreachable", not a request that never ends
      signal: AbortSignal.timeout(15_000),
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

/** Set-Cookie of a (renewed) session, for Kurviq's own pages */
export const sessionCookie = async (request: Request, env: AuthEnv, session: Session) =>
  cookie(request, SESSION_COOKIE, await seal(env, session, SESSION_COOKIE), SESSION_DAYS * 24 * 3600);

/**
 * A 1-hour access token from a refresh token, with the scope and ID token
 * Google sent along. "unreachable": Google's 5xx or a timeout; "expired": the
 * grant is gone (revoked, or the password changed).
 */
export const accessFromRefresh = async (env: AuthEnv, refreshToken: string) => {
  const answer = await exchange(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (!answer.access_token) {
    return answer.error?.startsWith("http_") ? ("unreachable" as const) : ("expired" as const);
  }
  return { token: answer.access_token, expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000, scope: answer.scope, idToken: answer.id_token };
};

/** a session with a fresh access token, or why there is none */
const refresh = async (env: AuthEnv, session: Session): Promise<Session | "expired" | "unreachable"> => {
  const access = await accessFromRefresh(env, session.r);
  if (typeof access === "string") {
    return access;
  }
  // a refresh brings an ID token when the grant has openid: the sub of
  // sessions made before live sync comes from there (else a new sign-in)
  return {
    ...session,
    a: access.token,
    ae: access.expiresAt,
    drive: access.scope ? grantsDrive(access.scope) : session.drive,
    sub: session.sub ?? subOf(access.idToken),
  };
};

const tokenAnswer = (session: Session) => ({
  token: session.a,
  expiresAt: new Date(session.ae).toISOString(),
  // with the account id: Drive's "New → Kurviq" names the account it is for (../../scenes-plugin/src/online/driveNew.ts)
  user: session.sub ? { ...session.user, sub: session.sub } : session.user,
  drive: session.drive,
});

// -----------------------------------------------------------------------------
// the retired live sync: refresh tokens sealed for one scene's Durable Object
// -----------------------------------------------------------------------------

const tokenKeys = new Map<string, { id: string; key: CryptoKey }>();

/** TOKEN_KEY (or TOKEN_KEY_PREVIOUS) as an AES key, with its id: the first 8 characters of its SHA-256 */
const tokenKey = async (raw64: string | undefined) => {
  if (!raw64) {
    return null;
  }
  let entry = tokenKeys.get(raw64);
  if (!entry) {
    const raw = bytesFromBase64(raw64);
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

/**
 * An author's refresh token, sealed by the retired live sync for one scene's
 * Durable Object: "<keyId>.<exp>.<iv>.<ciphertext>", bound to the file, the
 * account and the expiry (the lease). Only read now (the drain); nothing seals
 * new ones. `iat`: when the session was signed in (sign out everywhere).
 */
export type SceneToken = { r: string; iat: number; exp: number };

/** a sealed scene token's content, or null (another file or account, run out, or not sealed with our keys) */
export const unsealSceneToken = async (env: AuthEnv, sealed: string, fileId: string, sub: string): Promise<SceneToken | null> => {
  try {
    const [keyId, expText, iv, data] = sealed.split(".");
    const exp = Number(expText);
    if (exp <= Date.now() || Number.isNaN(exp)) {
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

/** Kurviq's grant at Google ends (sign out everywhere) */
export const revokeAtGoogle = async (env: AuthEnv, refreshToken: string, timeoutMs = 15_000) => {
  try {
    const res = await fetch(googleUrls(env).revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status === 400; // 400: already revoked
  } catch {
    return false;
  }
};

/** waits between the tries of a revocation within one request (sign out everywhere) */
export const REVOKE_RETRY_WAITS_MS = [500, 1_500];

/**
 * The revocation at Google, tried again a few times within the request
 * (5 s each, about 17 s at most). The token is never kept for a later try:
 * if Google can't be reached, the person removes Kurviq's access themselves.
 */
export const revokeAtGoogleNow = async (env: AuthEnv, refreshToken: string, waits = REVOKE_RETRY_WAITS_MS) => {
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, waits[attempt - 1])); // NOSONAR S9382: tries in order on purpose
    }
    if (await revokeAtGoogle(env, refreshToken, 5_000)) { // NOSONAR S9382: tries in order on purpose (each after the one before)
      return true;
    }
  }
  return false;
};

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

export { isDevOrigin, isLocalInstall } from "./origins";

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
    if (isLocalInstall(target.origin) && target.origin !== origin) {
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

/**
 * A sign-in under way (sealed in the state cookie). `redirect`: Google's
 * redirect URI of this flow, sent again with the code. `pageState`: the local
 * install's own value (?state= on /auth/login), handed back in the fragment so
 * that page knows the sign-in is the one it started.
 */
type Flow = { state: string; back: string; local: boolean; consent: boolean; redirect: string; pageState?: string };

const PAGE_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

const startFlow = async (
  request: Request,
  env: AuthEnv,
  back: string,
  local: boolean,
  consent: boolean,
  { hint, redirectUri, pageState }: { hint?: string; redirectUri?: string; pageState?: string },
) => {
  const url = new URL(request.url);
  // wrangler dev: its real (local) address; never a configured non-local one
  const callback = redirectUri ?? `${isDevOrigin(env.DEV_ORIGIN) ? env.DEV_ORIGIN : url.origin}/auth/callback`;
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const sealed = await seal(env, { state, back, local, consent, redirect: callback, pageState } satisfies Flow, STATE_COOKIE);
  const target = new URL(googleUrls(env, url.origin).authorize);
  target.searchParams.set("client_id", clientId(env));
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", scopesOf(env).join(" "));
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
export const requestSession = async (request: Request, env: AuthEnv, local: boolean) => {
  if (!local) {
    return cookieSession(request, env);
  }
  // a sealed session is a few KB: anything bigger is not read
  const text = (await readText(request.body, 32 * 1024)) ?? "";
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  return localSession(env, body?.session, request.headers.get("Origin"));
};

/** the CORS preflight of a POST route the local install calls (its origin is approved, Content-Type allowed) */
export const localPreflight = (origin: string) =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });

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
  seal(env, { ...session, iat: session.iat ?? 0, exp: Date.now() + LOCAL_SESSION_DAYS * 24 * 3_600_000 }, LOCAL_SESSION);

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

const authCallback = async (request: Request, env: AuthEnv, url: URL) => {
  const flow = await unseal<Flow>(env, readCookie(request, STATE_COOKIE), STATE_COOKIE);
  if (flow?.state !== url.searchParams.get("state")) {
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
      return startFlow(request, env, flow.back, flow.local, true, { hint: user.email, redirectUri: flow.redirect, pageState: flow.pageState });
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
};

const authToken = async (request: Request, env: AuthEnv, url: URL, origin: string | null, local: boolean) => {
  if (origin !== url.origin && !local) {
    return json(403, { error: "Forbidden" });
  }
  const cors = local ? origin! : undefined;
  const session = await requestSession(request, env, local);
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
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** the parameters /auth/login takes (in the query, or in the confirmation's form) */
const LOGIN_PARAMS = ["return", "state", "consent", "hint"];

/**
 * "Sign in the Kurviq at http://x.test?": asked before a session goes to a
 * local address that is not loopback. The button posts the same parameters
 * back to /auth/login (a form of this page: a link alone can't skip it).
 */
const confirmLocalPage = (target: string, params: URLSearchParams) => {
  const fields = LOGIN_PARAMS.filter((name) => params.has(name))
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`)
    .join("");
  const address = escapeHtml(target);
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in your local Kurviq</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; }
  code { word-break: break-all; }
  button { font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 18px; cursor: pointer; border: 0; background: #6965db; color: #fff; }
  a { color: inherit; }
</style></head>
<body><main>
<h1>Sign in your local Kurviq?</h1>
<p>The Kurviq at <code>${address}</code> asks to use your Google sign-in. It gets access to your Kurviq files in Google Drive.</p>
<p>Only continue if you started this sign-in from your own Kurviq at this address.</p>
<form method="post" action="/auth/login">${fields}<button type="submit">Sign in ${address}</button></form>
<p><a href="/">Cancel</a></p>
</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
};

/** the parameters of a POST /auth/login (the confirmation's form), from Kurviq's own page only; null: refused */
const confirmedParams = async (request: Request, url: URL) => {
  const origin = request.headers.get("Origin");
  const sameOrigin = origin ? origin === url.origin : request.headers.get("Sec-Fetch-Site") === "same-origin";
  if (!sameOrigin) {
    return null;
  }
  return new URLSearchParams((await readText(request.body, 8 * 1024)) ?? "");
};

/**
 * GET /auth/login (from a link) or POST /auth/login (the confirmation page's
 * button, `confirmed`). The local install's session is handed to a loopback
 * address at once, to any other local address (*.test) only after the click.
 */
const authLogin = async (request: Request, env: AuthEnv, url: URL, params: URLSearchParams, confirmed: boolean) => {
  const { back, local: toLocal } = safeReturn(params.get("return"), url.origin);
  const pageState = params.get("state");
  if (toLocal && pageState !== null && !PAGE_STATE_RE.test(pageState)) {
    return json(400, { error: "state: 16 to 128 characters of A-Z a-z 0-9 _ -" });
  }
  if (toLocal && !confirmed && !isDevOrigin(new URL(back).origin)) {
    return confirmLocalPage(new URL(back).origin, params);
  }
  return startFlow(
    request,
    env,
    back,
    toLocal,
    params.has("consent"),
    { hint: params.get("hint") ?? undefined, pageState: toLocal ? pageState ?? undefined : undefined },
  );
};

const authUnavailable = (url: URL, local: boolean, origin: string | null) => {
  if (url.pathname === "/auth/token") {
    // a Kurviq without Google: nobody is signed in, scenes stay in the browser
    return json(200, { connected: false }, [], local ? origin! : undefined);
  }
  return json(503, { error: "Google sign-in is not configured on this Kurviq server" }, [], local ? origin! : undefined);
};

const authLogout = (request: Request, url: URL, origin: string | null, local: boolean) => {
  if (origin !== url.origin && !local) {
    return json(403, { error: "Forbidden" });
  }
  // not revoked at Google: that would end Kurviq's access in every other
  // browser of this user too (they remove it at myaccount.google.com/permissions)
  return json(200, { ok: true }, local ? [] : [cookie(request, SESSION_COOKIE, "", 0)], local ? origin! : undefined);
};

export const handleAuth = async (request: Request, env: AuthEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) {
    return null;
  }
  const origin = request.headers.get("Origin");
  const local = isLocalInstall(origin) && origin !== url.origin;

  if (request.method === "OPTIONS" && local && (url.pathname === "/auth/token" || url.pathname === "/auth/logout")) {
    return localPreflight(origin!);
  }
  if (!clientId(env) || !env.GOOGLE_CLIENT_SECRET || !env.COOKIE_KEY) {
    return authUnavailable(url, local, origin);
  }

  const routes: Record<string, () => Promise<Response> | Response> = {
    "GET /auth/login": () => authLogin(request, env, url, url.searchParams, false),
    "POST /auth/login": async () => {
      const params = await confirmedParams(request, url);
      return params ? authLogin(request, env, url, params, true) : json(403, { error: "Forbidden" });
    },
    "GET /auth/callback": () => authCallback(request, env, url),
    "POST /auth/token": () => authToken(request, env, url, origin, local),
    "POST /auth/logout": () => authLogout(request, url, origin, local),
  };
  const route = routes[`${request.method} ${url.pathname}`];
  return route ? route() : json(404, { error: "Not found" });
};
