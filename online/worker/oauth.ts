// Sign-in for agents (OAuth 2.1, as the MCP spec has it): the agent adds
// https://kurviq.com/mcp, its client opens the user's browser, the user allows
// it there, and the client keeps the tokens it gets. No secret in the URL any
// more: a copied address is worthless.
//
//   /.well-known/oauth-protected-resource[/mcp]  where to sign in (RFC 9728)
//   /.well-known/oauth-authorization-server       the endpoints (RFC 8414)
//   POST /oauth/register   a client registers itself (RFC 7591)
//   GET  /mcp/oauth/authorize  the page that asks the user (it reads this
//                          browser's agent key, which only Kurviq's own pages
//                          can read); under /mcp, which the app's service
//                          worker (also older ones) leaves to the network
//   POST /oauth/approve    the page's "Allow": a one-time code for the client
//   POST /oauth/token      code (+ PKCE) or refresh token -> tokens
//
// Stateless like the rest: client ids, codes and tokens are sealed (AES-GCM
// with the Worker's key, see auth.ts), so they can't be read or forged, and
// expire by the time inside them. They carry the pairing (the hash of the
// browser's agent key), never the key: "Sign out all agents" in Kurviq gives the
// browser a new key and with it a new pairing, so every token made before
// reaches nobody.

import { b64url, seal, unseal } from "./auth";

import type { AuthEnv } from "./auth";

const CODE_SECONDS = 60;
const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 90 * 24 * 60 * 60;
const UPLOAD_SECONDS = 7 * 24 * 60 * 60;

const KEY_RE = /^[A-Za-z0-9_-]{32}$/;

type Client = { r: string[]; n: string };
type Code = { p: string; c: string; r: string; cc: string; e: number };
type Grant = { p: string; c: string; e: number };
type Upload = { p: string; e: number };

const now = () => Math.floor(Date.now() / 1000);

const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** the pairing (Durable Object name) of an agent key: its hash, so the key itself is never stored or sent */
export const pairingName = async (key: string) => hex(await sha256(`kurviq-pairing:${key}`));

/** a client id, short: what codes and tokens are bound to */
const clientTag = async (clientId: string) => hex(await sha256(`kurviq-client:${clientId}`)).slice(0, 32);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers },
  });

const oauthError = (status: number, error: string, description: string) =>
  json(status, { error, error_description: description });

/** loopback (any port, as native apps use) or https; nothing else may receive codes */
const allowedRedirect = (uri: string) => {
  try {
    const url = new URL(uri);
    if (url.hash) {
      return false;
    }
    if (url.protocol === "https:") {
      return true;
    }
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

/** a registered redirect URI matches, the port of a loopback one may differ (RFC 8252) */
const redirectMatches = (registered: string[], uri: string) =>
  registered.some((known) => {
    if (known === uri) {
      return true;
    }
    try {
      const a = new URL(known);
      const b = new URL(uri);
      const loopback = ["localhost", "127.0.0.1", "[::1]"];
      return a.protocol === "http:" && loopback.includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
    } catch {
      return false;
    }
  });

export const protectedResourceMetadata = (origin: string) => ({
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  bearer_methods_supported: ["header"],
  resource_name: "Kurviq",
  resource_documentation: `${origin}/llms.txt`,
});

const authorizationServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/mcp/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kurviq"],
  service_documentation: `${origin}/llms.txt`,
});

/** 401 for /mcp without (valid) sign-in: tells the client where to sign in */
export const unauthorized = (origin: string, invalid = false) =>
  new Response(
    JSON.stringify({
      error: invalid ? "invalid_token" : "unauthorized",
      error_description: invalid
        ? "The Kurviq token expired or is not valid any more: sign in again."
        : `Kurviq's MCP needs a sign-in: add ${origin}/mcp as a remote MCP server (Streamable HTTP, OAuth); your client opens the user's browser, where the user allows it. See ${origin}/llms.txt`,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...CORS,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${
          invalid ? ', error="invalid_token"' : ""
        }`,
      },
    },
  );

/** the pairing a request's bearer token belongs to: a string, "invalid", or null (no token) */
export const bearerPairing = async (request: Request, env: AuthEnv): Promise<string | "invalid" | null> => {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return null;
  }
  const grant = await unseal<Grant>(env, match[1], "oauth-access");
  return grant && grant.e > now() ? grant.p : "invalid";
};

/** the address agents upload images and big edits to (curl can't sign in): this pairing, for a week */
export const uploadToken = async (env: AuthEnv, pairing: string) =>
  seal(env, { p: pairing, e: now() + UPLOAD_SECONDS } satisfies Upload, "mcp-upload");

export const uploadPairing = async (env: AuthEnv, token: string) => {
  const upload = await unseal<Upload>(env, token, "mcp-upload");
  return upload && upload.e > now() ? upload.p : null;
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** who asks, in words: an app on this computer (loopback) or a website */
const describeRedirect = (uri: string) => {
  const url = new URL(uri);
  return url.protocol === "http:" ? "an app on this computer" : url.hostname;
};

const page = (title: string, body: string, nonce: string, status = 200) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – Kurviq</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f9; --card: #fff; --text: #1b1b1f; --muted: #6b6b76; --border: #e4e4ea; --primary: #6965db; --primary-text: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --card: #1e1e22; --text: #ececf1; --muted: #a0a0ab; --border: #33333a; --primary: #a8a5ff; --primary-text: #121214; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.08); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; margin-bottom: 18px; }
  .brand img { width: 28px; height: 28px; border-radius: 7px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: var(--muted); }
  ul { margin: 0 0 16px; padding-left: 20px; color: var(--muted); }
  strong { color: var(--text); }
  .row { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 18px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text); }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-text); }
  button:disabled { opacity: .6; cursor: default; }
  .note { font-size: 14px; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--primary) 10%, transparent); color: var(--text); margin-top: 12px; }
  .error { color: #e03131; }
  [hidden] { display: none !important; }
</style>
</head>
<body><main class="card"><div class="brand"><img src="/apple-touch-icon.png" alt="">Kurviq</div>${body}</main>
</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    },
  );

const errorPage = (message: string) =>
  page("Can't connect", `<h1>This agent can't connect</h1><p class="error">${escapeHtml(message)}</p>`, "none", 400);

/** the browser side of "Allow": reads this browser's agent key (only Kurviq's own pages can) */
const approveScript = `
const params = JSON.parse(document.getElementById("params").textContent);
const KEY = "kurviq-agent-key";
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const makeKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
};
const $ = (id) => document.getElementById(id);
const hasKey = !!read();
$("ready").hidden = !hasKey;
$("nokey").hidden = hasKey;
const fail = (message) => { $("error").textContent = message; $("error").hidden = false; document.querySelectorAll("button").forEach((b) => (b.disabled = false)); };
const allow = async () => {
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  let key = read();
  if (!key) {
    key = makeKey();
    try { localStorage.setItem(KEY, key); } catch { return fail("This browser doesn't let Kurviq store its agent access."); }
  }
  try {
    const res = await fetch("/oauth/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...params, key }) });
    const body = await res.json();
    if (!res.ok || !body.redirect) return fail(body.error_description || body.error || "Something went wrong.");
    $("done").hidden = false;
    location.href = body.redirect;
  } catch { fail("Kurviq could not be reached. Try again."); }
};
$("allow").addEventListener("click", allow);
$("allow-new").addEventListener("click", allow);
$("deny").addEventListener("click", () => { location.href = params.denyUrl; });
$("deny-new").addEventListener("click", () => { location.href = params.denyUrl; });
$("copy").addEventListener("click", () => navigator.clipboard.writeText(location.href).then(() => ($("copy").textContent = "Copied ✓")));
`;

const authorizePage = async (url: URL, env: AuthEnv) => {
  const q = url.searchParams;
  const clientId = q.get("client_id") || "";
  const redirectUri = q.get("redirect_uri") || "";
  const client = await unseal<Client>(env, clientId, "oauth-client");
  if (!client) {
    return errorPage("Unknown agent (its registration isn't from Kurviq). Remove Kurviq from the agent and add it again.");
  }
  if (!redirectUri || !redirectMatches(client.r, redirectUri)) {
    return errorPage("The agent's return address doesn't match its registration.");
  }
  const back = (params: Record<string, string>) => {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) {
      target.searchParams.set(name, value);
    }
    if (q.get("state")) {
      target.searchParams.set("state", q.get("state")!);
    }
    return target.toString();
  };
  if (q.get("response_type") !== "code") {
    return Response.redirect(back({ error: "unsupported_response_type" }), 302);
  }
  if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") {
    return Response.redirect(back({ error: "invalid_request", error_description: "PKCE with S256 is required" }), 302);
  }
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    state: q.get("state") || "",
    code_challenge: q.get("code_challenge"),
    denyUrl: back({ error: "access_denied", error_description: "The user did not allow access" }),
  };
  const name = escapeHtml(client.n || "An AI agent");
  const from = escapeHtml(describeRedirect(redirectUri));
  return page(
    "Allow an agent",
    `<h1>Allow <strong>${name}</strong> to use Kurviq?</h1>
<p>It asks from ${from}. Once allowed, it can do what you can do in Kurviq in this browser, while a Kurviq tab is open here:</p>
<ul><li>read, draw and edit your scenes</li><li>create, rename and delete scenes</li></ul>
<div id="ready" hidden>
  <div class="row"><button id="allow" class="primary" type="button">Allow</button><button id="deny" type="button">Cancel</button></div>
  <p class="note">By allowing it you accept Kurviq's <a href="/terms" target="_blank" rel="noopener">terms of use</a>; see also <a href="/privacy" target="_blank" rel="noopener">privacy</a>.</p>
</div>
<div id="nokey" hidden>
  <p class="note">Agent access isn't turned on in this browser. <strong>Do you use Kurviq in another browser?</strong> Open this page there instead: copy its address into that browser.</p>
  <div class="row"><button id="copy" type="button">Copy this page's address</button></div>
  <div class="row"><button id="allow-new" class="primary" type="button">Use this browser and allow</button><button id="deny-new" type="button">Cancel</button></div>
</div>
<p id="error" class="error" hidden></p>
<p id="done" hidden>Allowed. You can close this page and go back to your agent.</p>
<p style="font-size:14px;margin-top:16px">You can sign out every agent at any time in Kurviq: MCP → Sign out all agents.</p>
<script type="application/json" id="params">${JSON.stringify(params).replace(/</g, "\\u003c")}</script>
<script nonce="${nonce}">${approveScript}</script>`,
    nonce,
  );
};

const readBody = async (request: Request): Promise<Record<string, string>> => {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value ?? "")]));
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
};

const issueTokens = async (env: AuthEnv, pairing: string, client: string) => ({
  access_token: await seal(env, { p: pairing, c: client, e: now() + ACCESS_SECONDS } satisfies Grant, "oauth-access"),
  token_type: "Bearer",
  expires_in: ACCESS_SECONDS,
  refresh_token: await seal(env, { p: pairing, c: client, e: now() + REFRESH_SECONDS } satisfies Grant, "oauth-refresh"),
  scope: "kurviq",
});

const pkceMatches = async (verifier: string, challenge: string) =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && b64url(await sha256(verifier)) === challenge;

/** the OAuth routes; null for any other request */
export const handleOAuth = async (request: Request, env: AuthEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const isOAuth =
    path.startsWith("/.well-known/oauth-protected-resource") ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/openid-configuration" ||
    path.startsWith("/oauth/") ||
    path === "/mcp/oauth/authorize";
  if (!isOAuth) {
    return null;
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(200, protectedResourceMetadata(url.origin));
  }
  if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
    return json(200, authorizationServerMetadata(url.origin));
  }

  if (path === "/oauth/register" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(body?.redirect_uris) ? body!.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(allowedRedirect)) {
      return oauthError(400, "invalid_redirect_uri", "redirect_uris: one or more https or loopback (http://localhost) addresses");
    }
    const name = String(body?.client_name ?? "").slice(0, 80);
    const clientId = await seal(env, { r: uris, n: name } satisfies Client, "oauth-client");
    return json(201, {
      client_id: clientId,
      client_id_issued_at: now(),
      redirect_uris: uris,
      client_name: name || undefined,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  if ((path === "/mcp/oauth/authorize" || path === "/oauth/authorize") && request.method === "GET") {
    return authorizePage(url, env);
  }

  if (path === "/oauth/approve" && request.method === "POST") {
    // only Kurviq's own approval page (and it needs the browser's agent key anyway)
    // (browsers say where a request comes from: Sec-Fetch-Site can't be set by a page)
    const sameOrigin = request.headers.get("Sec-Fetch-Site") === "same-origin" || request.headers.get("Origin") === url.origin;
    if (!sameOrigin) {
      return oauthError(403, "forbidden", "Not from Kurviq's approval page");
    }
    const body = await readBody(request);
    const client = await unseal<Client>(env, body.client_id, "oauth-client");
    if (!client || !redirectMatches(client.r, body.redirect_uri || "")) {
      return oauthError(400, "invalid_client", "Unknown agent or return address");
    }
    if (!KEY_RE.test(body.key || "") || !body.code_challenge) {
      return oauthError(400, "invalid_request", "Missing agent access or PKCE challenge");
    }
    const code = await seal(
      env,
      {
        p: await pairingName(body.key),
        c: await clientTag(body.client_id),
        r: body.redirect_uri,
        cc: body.code_challenge,
        e: now() + CODE_SECONDS,
      } satisfies Code,
      "oauth-code",
    );
    const target = new URL(body.redirect_uri);
    target.searchParams.set("code", code);
    if (body.state) {
      target.searchParams.set("state", body.state);
    }
    return json(200, { redirect: target.toString() });
  }

  if (path === "/oauth/token" && request.method === "POST") {
    const body = await readBody(request);
    if (body.grant_type === "authorization_code") {
      const code = await unseal<Code>(env, body.code, "oauth-code");
      if (!code || code.e <= now()) {
        return oauthError(400, "invalid_grant", "The code expired or is not valid: sign in again");
      }
      if (code.c !== (await clientTag(body.client_id || "")) || code.r !== body.redirect_uri) {
        return oauthError(400, "invalid_grant", "The code was issued to another client or return address");
      }
      if (!(await pkceMatches(body.code_verifier || "", code.cc))) {
        return oauthError(400, "invalid_grant", "PKCE verification failed");
      }
      return json(200, await issueTokens(env, code.p, code.c));
    }
    if (body.grant_type === "refresh_token") {
      const grant = await unseal<Grant>(env, body.refresh_token, "oauth-refresh");
      if (!grant || grant.e <= now()) {
        return oauthError(400, "invalid_grant", "The refresh token expired or is not valid: sign in again");
      }
      if (body.client_id && grant.c !== (await clientTag(body.client_id))) {
        return oauthError(400, "invalid_grant", "The refresh token belongs to another client");
      }
      return json(200, await issueTokens(env, grant.p, grant.c));
    }
    return oauthError(400, "unsupported_grant_type", "authorization_code or refresh_token");
  }

  return oauthError(404, "not_found", "Unknown OAuth endpoint");
};
