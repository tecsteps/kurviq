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

export type AuthEnv = {
  /** default: online/google.json */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET: string;
  /** base64 of 32 random bytes: encrypts the cookies */
  COOKIE_KEY: string;
  /** wrangler dev only (.dev.vars): this server's real address; wrangler dev gives the Worker the first route's (kurviq.com) */
  DEV_ORIGIN?: string;
};

const clientId = (env: AuthEnv) => env.GOOGLE_CLIENT_ID || google.clientId;

const SESSION_COOKIE = "kq_google";
const STATE_COOKIE = "kq_oauth_state";
/** purpose of a session handed to the local install (never valid as a cookie) */
const LOCAL_SESSION = "kq_google_local";
/** browsers cap cookies at 400 days; every refresh renews it */
const SESSION_DAYS = 400;

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
];
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleUser = { email: string; name: string | null; avatarUrl: string | null };

type Session = {
  /** access token and when it expires (ms) */
  a: string;
  ae: number;
  /** refresh token */
  r: string;
  user: GoogleUser;
  /** the user allowed Kurviq's Drive access (Google lets them untick it) */
  drive: boolean;
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
    res = await fetch("https://oauth2.googleapis.com/token", {
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

/** who signed in: from the ID token, which came straight from Google's token endpoint (TLS) */
const userOf = (idToken: string | undefined): GoogleUser | null => {
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(idToken!.split(".")[1])));
    if (!claims.email) {
      return null;
    }
    return {
      email: String(claims.email),
      name: claims.name ? String(claims.name) : null,
      avatarUrl: claims.picture ? String(claims.picture) : null,
    };
  } catch {
    return null;
  }
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
  return {
    ...session,
    a: answer.access_token,
    ae: Date.now() + (answer.expires_in ?? 3600) * 1000,
    drive: answer.scope ? grantsDrive(answer.scope) : session.drive,
  };
};

const tokenAnswer = (session: Session) => ({
  token: session.a,
  expiresAt: new Date(session.ae).toISOString(),
  user: session.user,
  drive: session.drive,
});

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

/** the local install: localhost, 127.0.0.1, *.localhost and *.test (Herd), any port */
const isLocalOrigin = (origin: string | null) => {
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
type Flow = { state: string; back: string; local: boolean; consent: boolean; redirect: string };

const startFlow = async (request: Request, env: AuthEnv, back: string, local: boolean, consent: boolean, hint?: string, redirectUri?: string) => {
  const url = new URL(request.url);
  const callback = redirectUri ?? `${env.DEV_ORIGIN || url.origin}/auth/callback`;
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const sealed = await seal(env, { state, back, local, consent, redirect: callback } satisfies Flow, STATE_COOKIE);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
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
    if (session) {
      fragment.set("session", await seal(env, session, LOCAL_SESSION));
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
    return unseal<Session>(env, readCookie(request, SESSION_COOKIE), SESSION_COOKIE);
  }
  const body: any = await request.json().catch(() => ({}));
  return unseal<Session>(env, typeof body.session === "string" ? body.session : undefined, LOCAL_SESSION);
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
    return startFlow(request, env, back, toLocal, url.searchParams.has("consent"), url.searchParams.get("hint") ?? undefined);
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
        return startFlow(request, env, flow.back, flow.local, true, user.email, flow.redirect);
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
      return json(200, { ...tokenAnswer(next), session: await seal(env, next, LOCAL_SESSION) }, [], cors);
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
