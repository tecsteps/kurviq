// "Connect with Supabase" (specs/2026-11-13-own-database.md): the Worker's
// only part in a user's own database. It keeps nothing: no row, no cookie, no
// log of a token.
//
//   GET  /auth/supabase/callback   Supabase's OAuth redirect: the app's page; the
//                                  browser holds the PKCE verifier and goes on
//   POST /api/supabase/token       {code, codeVerifier}: the code exchanged for a
//                                  management token with Kurviq's client secret
//                                  (Supabase's token endpoint needs it), answered
//                                  to the browser; the refresh token is dropped
//   *    /api/supabase/v1/…        a few Management API calls passed through as they
//                                  are: Supabase's API answers browsers only on
//                                  supabase.com (CORS), so the browser can't call
//                                  it itself. The token comes with each request
//                                  and is used for that request only; secret API
//                                  keys are taken out of the answer.
//
// Only Kurviq's own pages may call it (same origin).

import supabase from "../supabase.json";

export type SupabaseEnv = {
  /** default: online/supabase.json */
  SUPABASE_CLIENT_ID?: string;
  /** the OAuth app's secret (online/secrets.mjs) */
  SUPABASE_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
};

const API = "https://api.supabase.com";
export const CALLBACK_PATH = supabase.callbackPath;
const MAX_BODY = 512 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** the Management API calls the setup needs (method + path pattern) */
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/v1\/organizations$/],
  ["GET", /^\/v1\/projects$/],
  ["POST", /^\/v1\/projects$/],
  ["GET", /^\/v1\/projects\/[a-z0-9]{20}$/],
  ["GET", /^\/v1\/projects\/[a-z0-9]{20}\/api-keys$/],
  ["POST", /^\/v1\/projects\/[a-z0-9]{20}\/database\/query$/],
  ["GET", /^\/v1\/projects\/[a-z0-9]{20}\/config\/auth$/],
  ["PATCH", /^\/v1\/projects\/[a-z0-9]{20}\/config\/auth$/],
];

export const allowedCall = (method: string, path: string) => ALLOWED.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path));

/** an API keys answer without its secret keys (only the public ones go to the browser) */
export const publicKeysOnly = (keys: unknown) =>
  Array.isArray(keys)
    ? keys.filter((key) => key && typeof key === "object" && (key.type === "publishable" || (key.name === "anon" && key.type !== "secret")))
    : [];

const sameOrigin = (request: Request, url: URL) => request.headers.get("Origin") === url.origin;

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

const exchange = async (request: Request, env: SupabaseEnv, url: URL) => {
  const clientId = env.SUPABASE_CLIENT_ID || supabase.clientId;
  if (!env.SUPABASE_CLIENT_SECRET) {
    return json(503, { error: "Connect with Supabase is not set up on this server" });
  }
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code : "";
  const verifier = typeof body?.codeVerifier === "string" ? body.codeVerifier : "";
  if (!code || code.length > 2000 || !/^[\w.~-]{43,128}$/.test(verifier)) {
    return json(400, { error: "code and codeVerifier needed" });
  }
  const answer = await fetch(`${API}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${btoa(clientId + ":" + env.SUPABASE_CLIENT_SECRET)}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${url.origin}${CALLBACK_PATH}` }),
  });
  const tokens = (await answer.json().catch(() => null)) as Record<string, unknown> | null;
  if (!answer.ok || typeof tokens?.access_token !== "string") {
    const why = tokens?.error_description ?? tokens?.message ?? tokens?.error;
    const detail = why ? ": " + String(why).slice(0, 200) : "";
    return json(answer.status >= 500 ? 502 : 400, { error: `Supabase did not accept the sign-in${detail}` });
  }
  // the refresh token is not passed on: the setup uses the access token once, then drops it
  return json(200, { accessToken: tokens.access_token, expiresIn: Number(tokens.expires_in) || 3600 });
};

const forward = async (request: Request, url: URL, path: string) => {
  if (!allowedCall(request.method, path)) {
    return json(404, { error: "Not a call Kurviq makes" });
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [\w.~+/=-]{10,4000}$/.test(auth)) {
    return json(401, { error: "Management token needed" });
  }
  let body: string | undefined;
  if (request.method !== "GET") {
    body = await request.text();
    if (body.length > MAX_BODY) {
      return json(413, { error: "Too large" });
    }
  }
  const answer = await fetch(`${API}${path}${url.search}`, {
    method: request.method,
    headers: { Authorization: auth, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body,
  });
  const text = await answer.text();
  if (answer.ok && /\/api-keys$/.test(path)) {
    let keys: unknown = null;
    try {
      keys = JSON.parse(text);
    } catch {}
    return json(answer.status, publicKeysOnly(keys));
  }
  return new Response(text, { status: answer.status, headers: { "Content-Type": answer.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" } });
};

/** the Supabase routes; null: not one of them */
export const handleSupabase = async (request: Request, env: SupabaseEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === CALLBACK_PATH) {
    // the app's page: it finishes in the browser (the PKCE verifier is there)
    return request.method === "GET" ? env.ASSETS.fetch(new Request(new URL("/", url), request)) : json(405, { error: "Method not allowed" });
  }
  if (!url.pathname.startsWith("/api/supabase/")) {
    return null;
  }
  if (!sameOrigin(request, url)) {
    return json(403, { error: "Forbidden" });
  }
  if (url.pathname === "/api/supabase/token") {
    return request.method === "POST" ? exchange(request, env, url) : json(405, { error: "Method not allowed" });
  }
  return forward(request, url, url.pathname.slice("/api/supabase".length));
};
