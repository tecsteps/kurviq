// Live sync: the Worker's routes in front of the scene Durable Objects
// (./scene.ts) and the account guards (./account.ts). docs/live-sync/PROTOCOL.md §3.
//
//   POST /scene/<fileId>/ticket     connect ticket (60 s, single use) + access proof (15 min)
//   GET  /scene/<fileId>/live       the tab's WebSocket (?ticket=…)
//   POST /scene/<fileId>/renew      a new access proof (every 10 minutes, and on renew-now)
//   POST /scene/<fileId>/reconcile  a one-time access token for an outside-change merge (need-token)
//   POST /drive/notify              Drive's push notifications (files.watch)
//   POST /auth/logout-all           sign out everywhere
//
// Who someone is and what they may do is decided here, with Google, and
// sealed into the ticket and proof: the scene object never trusts a tab's
// own claims. All POSTs take the sign-in cookie, or { session } from the
// local install (CORS for local origins, like /auth/token).

import {
  KEY_PROPERTY,
  LIVE_MARKER,
  LIVE_PROTOCOL,
  PROOF_VALID_MS,
  TICKET_VALID_MS,
  TOKEN_LEASE_MS,
  keyIdOf,
  keyProperty,
  parseKeyProperty,
} from "../../scenes-plugin/src/online/liveProtocol";

import {
  accountEpochOf,
  b64url,
  clearSessionCookie,
  cookieSession,
  devGate,
  watchSecret,
  freshSession,
  isLocalOrigin,
  localSession,
  pseudonymOf,
  revokeAtGoogle,
  seal,
  sealLocalSession,
  sealSceneToken,
  sessionCookieHeader,
  unseal,
} from "./auth";
import type { AuthEnv, Session } from "./auth";
import { driveCall, driveUrls, getFile, patchFile, problemOf, readLimited } from "./driveApi";
import type { Claims } from "./scene";

export type SceneRoutesEnv = AuthEnv & {
  SCENE: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  /** "off" | "all" | comma-separated emails (PROTOCOL §2) */
  LIVE_SYNC?: string;
};

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
/** route bodies: a tab id, a proof, the local install's sealed session */
const ROUTE_BODY_BYTES = 32 * 1024;
const TICKET = "kq_scene_ticket";
const PROOF = "kq_scene_proof";
/** while Google is unreachable, proofs are extended at most this long after the last real check */
const OUTAGE_GRACE_MS = 2 * 3600_000;
const WATCH_MS = 24 * 3600_000;
const FILE_FIELDS = "id,name,trashed,ownedByMe,headRevisionId,md5Checksum,modifiedTime,capabilities(canEdit),appProperties";

type Ctx = {
  request: Request;
  env: SceneRoutesEnv;
  url: URL;
  origin: string | null;
  /** the local install (session in the body, CORS) */
  local: boolean;
  body: any;
  cookies: string[];
  /** a renewal: the account's index entries of this scene are kept fresh */
  touch?: string;
};

const answer = (ctx: Ctx, status: number, body: unknown) => {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  ctx.cookies.forEach((value) => headers.append("Set-Cookie", value));
  if (ctx.local && ctx.origin) {
    headers.set("Access-Control-Allow-Origin", ctx.origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
};

const fail = (ctx: Ctx, status: number, code: string, error: string) => answer(ctx, status, { error, code });

const sceneStub = (env: SceneRoutesEnv, fileId: string) => env.SCENE.get(env.SCENE.idFromName(fileId));
const accountStub = (env: SceneRoutesEnv, sub: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(sub));

const toScene = async (env: SceneRoutesEnv, fileId: string, path: string, body: Record<string, unknown>) => {
  const res = await sceneStub(env, fileId).fetch(`https://scene${path}`, { method: "POST", body: JSON.stringify({ fileId, ...body }) });
  return (await res.json().catch(() => ({}))) as any;
};

/** the account's revocation epoch; throws when the guard can't be asked (callers answer 503: fail closed) */
const accountEpoch = async (env: SceneRoutesEnv, sub: string, touch?: string) => {
  const epoch = await accountEpochOf(env, sub, touch ? { method: "POST", body: JSON.stringify({ fileId: touch, touch: true }) } : undefined);
  if (epoch === null) {
    throw Object.assign(new Error("account guard unavailable"), { status: 503 });
  }
  return epoch;
};

/** this site's pages, or the local install */
const sameSite = (ctx: Ctx) =>
  ctx.origin === ctx.url.origin || (devGate(ctx.env, ctx.request) && !!ctx.env.DEV_ORIGIN && ctx.origin === ctx.env.DEV_ORIGIN);

/**
 * The signed-in session with an access token good for 10 more minutes and a
 * `sub`, or the answer to give. A refreshed session goes back with the answer
 * (cookie, or `session` for the local install).
 */
const signedIn = async (ctx: Ctx): Promise<{ session: Session; sealedLocal?: string } | Response> => {
  const session = ctx.local ? await localSession(ctx.env, ctx.body.session, ctx.origin) : await cookieSession(ctx.request, ctx.env);
  if (!session) {
    return fail(ctx, 401, "signed-out", "Not signed in");
  }
  const fresh = await freshSession(ctx.env, session, true);
  if (fresh === "unreachable") {
    return fail(ctx, 503, "google-unreachable", "Google is not reachable");
  }
  if (fresh === "expired") {
    if (!ctx.local) {
      ctx.cookies.push(clearSessionCookie(ctx.request));
    }
    return fail(ctx, 401, "signed-out", "The sign-in has expired");
  }
  // live sync needs the account's id and the sign-in's time (sign out everywhere): older sessions sign in again
  if (!fresh.session.sub || !fresh.session.iat) {
    return fail(ctx, 401, "sign-in-again", "Sign in again to use live sync");
  }
  let sealedLocal: string | undefined;
  if (fresh.renewed) {
    if (ctx.local) {
      sealedLocal = await sealLocalSession(ctx.env, fresh.session);
    } else {
      ctx.cookies.push(await sessionCookieHeader(ctx.request, ctx.env, fresh.session));
    }
  }
  const epoch = await accountEpoch(ctx.env, fresh.session.sub, ctx.touch);
  if (epoch && (fresh.session.iat ?? 0) < epoch) {
    if (!ctx.local) {
      ctx.cookies.push(clearSessionCookie(ctx.request));
    }
    return fail(ctx, 401, "signed-out-everywhere", "Signed out everywhere: sign in again");
  }
  return { session: fresh.session, sealedLocal };
};

/** live sync for this person and file (PROTOCOL §2): the pilot switch, or a file already marked */
const liveEnabled = (env: SceneRoutesEnv, email: string, appProperties: Record<string, string> | undefined) => {
  if (appProperties?.kurviqSync === LIVE_MARKER) {
    return true;
  }
  const value = (env.LIVE_SYNC || "off").trim().toLowerCase();
  return value === "all" || value.split(",").map((item) => item.trim()).includes(email.toLowerCase());
};

const sceneName = (file: any) => String(file?.name ?? "").replace(/\.excalidraw$/, "");

/**
 * A Drive watch while someone is connected: made with this person's access,
 * reserved by the scene object (one at a time), the old channel stopped.
 */
const keepWatch = async (ctx: Ctx, fileId: string, token: string, watch: { id: string; token: string } | null | undefined) => {
  if (!watch) {
    return;
  }
  const api = driveUrls(ctx.env).api;
  const made = await driveCall(`${api}/files/${fileId}/watch?supportsAllDrives=true`, token, {
    method: "POST",
    json: {
      id: watch.id,
      type: "web_hook",
      address: `${ctx.env.DEV_ORIGIN || ctx.url.origin}/drive/notify`,
      token: watch.token,
      expiration: Date.now() + WATCH_MS,
    },
  });
  if (made.status !== 200 || !made.data?.resourceId) {
    return;
  }
  const set = await toScene(ctx.env, fileId, "/watch-set", {
    id: watch.id,
    resourceId: made.data.resourceId,
    expiration: Number(made.data.expiration) || Date.now() + WATCH_MS,
  });
  if (set.stop) {
    await driveCall(`${api}/channels/stop`, token, { method: "POST", json: set.stop });
  }
};

/**
 * The scene's key: the property on the file, or (an editor, none yet) a new
 * one written under the scene object's lease, read again just before
 * writing. A copy's key (another file id) counts as none.
 */
const sceneKey = async (ctx: Ctx, fileId: string, token: string, file: any, role: "edit" | "read", sub: string) => {
  const parsed = await parseKeyProperty(file.appProperties?.[KEY_PROPERTY], fileId);
  const found = parsed && !parsed.copy ? parsed : null;
  const prep = await toScene(ctx.env, fileId, "/prepare", { found: found?.keyId ?? null, viewer: role !== "edit", trashed: !!file.trashed, sub });
  const watch = prep.watch;
  switch (prep.key) {
    case "ok":
      return found ? { key: found.key, keyId: found.keyId, watch } : { code: "key-missing", watch };
    case "none":
      return { code: "no-key-yet", watch };
    case "missing":
    case "changed":
      return { code: `key-${prep.key}`, watch };
    case "held":
      return { code: "key-busy", watch };
    case "lease":
      break;
    default:
      return { code: "scene-error", watch };
  }
  // under the lease: maybe an earlier attempt wrote one meanwhile
  const again = await getFile(ctx.env, token, fileId, "appProperties");
  if (again.status !== 200) {
    return { code: problemOf(again) === "unreachable" ? "google-unreachable" : "no-access", watch };
  }
  const existing = await parseKeyProperty(again.data?.appProperties?.[KEY_PROPERTY], fileId);
  let key: string;
  let keyId: string;
  if (existing && !existing.copy) {
    ({ key, keyId } = existing);
  } else {
    key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    keyId = await keyIdOf(key);
    const written = await patchFile(ctx.env, token, fileId, {
      appProperties: { [KEY_PROPERTY]: keyProperty(keyId, fileId, key), kurviqSync: LIVE_MARKER },
    });
    if (written.status !== 200) {
      return { code: problemOf(written) === "unreachable" ? "google-unreachable" : "no-access", watch };
    }
  }
  const done = await toScene(ctx.env, fileId, "/key-done", { lease: prep.lease, keyId });
  return done.ok ? { key, keyId, watch } : { code: "key-busy", watch };
};

/** what the scene object gets about this person (sealed into ticket / proof) */
const claimsOf = async (ctx: Ctx, kind: Claims["kind"], fileId: string, session: Session, file: any, role: "edit" | "read", keyId: string | null) => {
  const now = Date.now();
  const claims: Claims = {
    kind,
    fileId,
    sub: session.sub!,
    person: session.user.name ?? session.user.email.split("@")[0],
    role,
    pseudonym: await pseudonymOf(ctx.env, session.sub!, fileId),
    head: { revision: file.headRevisionId ?? null, md5: file.md5Checksum ?? null, at: Date.parse(file.modifiedTime ?? "") || null },
    keyId,
    exp: now + (kind === "ticket" ? TICKET_VALID_MS : PROOF_VALID_MS),
    checkedAt: now,
    iat: session.iat ?? 0,
    protocol: LIVE_PROTOCOL,
    owner: file.ownedByMe === true,
  };
  if (kind === "ticket") {
    claims.nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  }
  return claims;
};

const sealedToken = (ctx: Ctx, fileId: string, session: Session) =>
  sealSceneToken(ctx.env, fileId, session.sub!, session.r, session.iat ?? 0, Date.now() + TOKEN_LEASE_MS);

const fileProblem = (ctx: Ctx, file: { status: number; data: any; text: string }) => {
  const problem = problemOf(file);
  if (problem === "unreachable" || problem === "rate-limited") {
    return fail(ctx, 503, "google-unreachable", "Google Drive is not reachable");
  }
  if (problem === "token") {
    return fail(ctx, 401, "signed-out", "The sign-in has expired");
  }
  // drive.file: a file Kurviq never opened for this person reads as "not found" (the Picker grants it)
  return answer(ctx, 403, { enabled: false, code: "no-access", error: "No access to this file through Kurviq" });
};

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

const ticket = async (ctx: Ctx, fileId: string) => {
  if (!ctx.env.TOKEN_KEY || !ctx.env.PSEUDONYM_KEY) {
    return fail(ctx, 503, "not-configured", "Live sync is not configured on this server");
  }
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const { session } = who;
  const file = await getFile(ctx.env, session.a, fileId, FILE_FIELDS);
  if (file.status !== 200) {
    return fileProblem(ctx, file);
  }
  if (!liveEnabled(ctx.env, session.user.email, file.data.appProperties)) {
    return answer(ctx, 200, { enabled: false });
  }
  const role = file.data.capabilities?.canEdit ? "edit" : "read";
  const key = await sceneKey(ctx, fileId, session.a, file.data, role, session.sub!);
  await keepWatch(ctx, fileId, session.a, key.watch);
  if (!("key" in key) || !key.key) {
    const status = key.code === "no-key-yet" ? 200 : key.code === "google-unreachable" ? 503 : key.code === "no-access" ? 403 : 409;
    return answer(ctx, status, { enabled: false, code: key.code, error: `Live sync can't start yet: ${key.code}` });
  }
  const claims = await claimsOf(ctx, "ticket", fileId, session, file.data, role, key.keyId);
  if (role === "edit") {
    claims.token = await sealedToken(ctx, fileId, session);
  }
  const { token: _token, nonce: _nonce, ...proofClaims } = claims;
  const proof: Claims = { ...proofClaims, kind: "proof", exp: Date.now() + PROOF_VALID_MS };
  return answer(ctx, 200, {
    enabled: true,
    protocol: LIVE_PROTOCOL,
    ticket: await seal(ctx.env, claims, TICKET),
    proof: await seal(ctx.env, proof, PROOF),
    proofExpiresAt: proof.exp,
    role,
    key: key.key,
    keyId: key.keyId,
    pseudonym: claims.pseudonym,
    name: sceneName(file.data),
    head: claims.head,
    sub: session.sub,
    ...(who.sealedLocal ? { session: who.sealedLocal } : {}),
  });
};

const connect = async (ctx: Ctx, fileId: string) => {
  if (ctx.request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket", { status: 426 });
  }
  // browsers always send Origin with a WebSocket: this site or the local install
  if (!sameSite(ctx) && !isLocalOrigin(ctx.origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const claims = await unseal<Claims>(ctx.env, ctx.url.searchParams.get("ticket") ?? undefined, TICKET);
  if (!claims || claims.kind !== "ticket" || claims.fileId !== fileId || claims.exp <= Date.now() || claims.protocol !== LIVE_PROTOCOL) {
    return new Response("Invalid or expired ticket", { status: 403 });
  }
  // a ticket issued before "sign out everywhere" opens nothing any more
  const epoch = await accountEpoch(ctx.env, claims.sub);
  if (epoch && claims.iat < epoch) {
    return new Response("Signed out everywhere", { status: 403 });
  }
  const headers = new Headers(ctx.request.headers);
  headers.set("X-Kurviq-Claims", JSON.stringify(claims));
  return sceneStub(ctx.env, fileId).fetch("https://scene/live", { headers });
};

const renew = async (ctx: Ctx, fileId: string) => {
  const old = await unseal<Claims>(ctx.env, typeof ctx.body.proof === "string" ? ctx.body.proof : undefined, PROOF);
  const tab = typeof ctx.body.tab === "string" ? ctx.body.tab.slice(0, 64) : "";
  if (!old || old.kind !== "proof" || old.fileId !== fileId || !tab) {
    return fail(ctx, 400, "bad-proof", "Not an access proof of this scene");
  }
  ctx.touch = fileId;
  const session = ctx.local ? await localSession(ctx.env, ctx.body.session, ctx.origin) : await cookieSession(ctx.request, ctx.env);
  if (!session || (session.sub && session.sub !== old.sub)) {
    return fail(ctx, 401, "signed-out", "Not signed in");
  }
  /** Google down (5xx, timeouts only): the old proof is extended, at most 2 h after the last real check */
  const extend = async () => {
    const epoch = await accountEpoch(ctx.env, old.sub, fileId);
    const until = Math.min(Date.now() + PROOF_VALID_MS, old.checkedAt + OUTAGE_GRACE_MS);
    if (old.exp <= Date.now() || until <= Date.now() || (epoch && old.iat < epoch)) {
      return fail(ctx, 503, "google-unreachable", "Google is not reachable");
    }
    const proof: Claims = { ...old, exp: until };
    await toScene(ctx.env, fileId, "/renew", { tab, claims: proof, confirmed: false });
    return answer(ctx, 200, { proof: await seal(ctx.env, proof, PROOF), expiresAt: until, role: proof.role, extended: true });
  };
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    if (who.status === 401) {
      await toScene(ctx.env, fileId, "/revoke-tab", { sub: old.sub, tab });
    }
    return who.status === 503 ? extend() : who;
  }
  const file = await getFile(ctx.env, who.session.a, fileId, FILE_FIELDS);
  if (file.status !== 200) {
    if (problemOf(file) === "unreachable") {
      return extend();
    }
    // a refusal ends the access (no extension)
    await toScene(ctx.env, fileId, "/revoke-tab", { sub: old.sub, tab });
    return fileProblem(ctx, file);
  }
  const role = file.data.capabilities?.canEdit ? "edit" : "read";
  const proof = await claimsOf(ctx, "proof", fileId, who.session, file.data, role, old.keyId);
  const forDo: Claims = { ...proof, ...(role === "edit" ? { token: await sealedToken(ctx, fileId, who.session) } : {}) };
  const done = await toScene(ctx.env, fileId, "/renew", {
    tab,
    claims: forDo,
    name: typeof file.data.name === "string" ? file.data.name : null,
    trashed: !!file.data.trashed,
    head: proof.head,
  });
  await keepWatch(ctx, fileId, who.session.a, done.watch);
  return answer(ctx, 200, {
    proof: await seal(ctx.env, proof, PROOF),
    expiresAt: proof.exp,
    role,
    ...(who.sealedLocal ? { session: who.sealedLocal } : {}),
  });
};

const reconcile = async (ctx: Ctx, fileId: string) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const file = await getFile(ctx.env, who.session.a, fileId, "id");
  if (file.status !== 200) {
    return fileProblem(ctx, file);
  }
  const done = await toScene(ctx.env, fileId, "/reconcile-token", { token: who.session.a, sub: who.session.sub });
  return answer(ctx, 200, { ok: !!done.ok, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

/**
 * "Keep only here" needs Drive's word that the person owns the file and it is
 * shared with nobody (the scene object can't see sharing): checked here with
 * their access and handed to the object for two minutes. The tab calls this
 * before sending keep-local.
 */
const keepLocal = async (ctx: Ctx, fileId: string) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const file = await getFile(ctx.env, who.session.a, fileId, "id,ownedByMe,capabilities(canEdit)");
  if (file.status !== 200) {
    return fileProblem(ctx, file);
  }
  const permissions = await driveCall(
    `${driveUrls(ctx.env).api}/files/${fileId}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`,
    who.session.a,
  );
  if (permissions.status !== 200) {
    return problemOf(permissions) === "unreachable" ? fail(ctx, 503, "google-unreachable", "Google Drive is not reachable") : fileProblem(ctx, permissions);
  }
  const list: any[] = permissions.data?.permissions ?? [];
  const alone = file.data.ownedByMe === true && list.every((permission) => permission.role === "owner");
  if (!alone) {
    return answer(ctx, 409, { ok: false, code: "shared", error: "Shared with others: keep a local copy instead" });
  }
  await toScene(ctx.env, fileId, "/keep-local-ok", { sub: who.session.sub });
  return answer(ctx, 200, { ok: true, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

/**
 * Drive's webhook: the channel token is "<fileId>.<secret>", the secret an
 * HMAC of file and channel id: checked here, so a forged notification never
 * wakes a scene object (which then checks its channel and resource id)
 */
const notify = async (request: Request, env: SceneRoutesEnv) => {
  const header = (name: string) => request.headers.get(name) || "";
  const state = header("X-Goog-Resource-State");
  const [fileId, secret] = header("X-Goog-Channel-Token").split(".");
  const channelId = header("X-Goog-Channel-ID");
  const genuine = !!fileId && FILE_ID_RE.test(fileId) && !!secret && !!channelId && secret === (await watchSecret(env, fileId, channelId));
  if (state !== "sync" && genuine) {
    await toScene(env, fileId, "/notify", {
      channelId: header("X-Goog-Channel-ID"),
      resourceId: header("X-Goog-Resource-ID"),
      secret,
      state,
      changed: header("X-Goog-Changed"),
    });
  }
  // always 200: Google retries otherwise, and a wrong token learns nothing
  return new Response(null, { status: 200 });
};

/** sign out everywhere: epoch raised, Kurviq revoked at Google, every stored token copy deleted */
const logoutAll = async (ctx: Ctx) => {
  const session = ctx.local ? await localSession(ctx.env, ctx.body.session, ctx.origin) : await cookieSession(ctx.request, ctx.env);
  if (!session) {
    return fail(ctx, 401, "signed-out", "Not signed in");
  }
  let sub = session.sub;
  if (!sub) {
    const fresh = await freshSession(ctx.env, session, true);
    sub = typeof fresh === "string" ? undefined : fresh.session.sub;
  }
  if (!ctx.local) {
    ctx.cookies.push(clearSessionCookie(ctx.request));
  }
  const revoked = await revokeAtGoogle(ctx.env, session.r);
  if (!sub) {
    return answer(ctx, 200, { ok: revoked, scenes: 0 });
  }
  // the account guard tells every scene (stored tokens, open connections) and retries until each confirmed;
  // a revocation Google didn't confirm is retried there too (the refresh token sealed, for 30 days at most)
  const retryRevoke = revoked ? null : await sealSceneToken(ctx.env, "revoke-at-google", sub, session.r, session.iat ?? 0, Date.now() + 30 * 24 * 3600_000);
  const res = await accountStub(ctx.env, sub).fetch("https://account/logout-all", { method: "POST", body: JSON.stringify({ sub, retryRevoke }) });
  const { scenes = [], epoch } = (await res.json().catch(() => ({}))) as { scenes?: string[]; epoch?: number };
  // at once as well (the guard's retries are the guarantee; telling a scene twice does no harm)
  await Promise.all(scenes.map((fileId) => toScene(ctx.env, fileId, "/forget", { sub, epoch }).catch(() => null)));
  return answer(ctx, 200, { ok: revoked, scenes: scenes.length });
};

export const handleSceneRoutes = async (request: Request, env: SceneRoutesEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  const scene = url.pathname.match(/^\/scene\/([^/]+)\/(ticket|live|renew|reconcile|keep-local)$/);
  const isLogoutAll = url.pathname === "/auth/logout-all";
  if (url.pathname === "/drive/notify") {
    return request.method === "POST" ? notify(request, env) : new Response("Method not allowed", { status: 405 });
  }
  const dev = url.pathname.match(/^\/scene\/([^/]+)\/(dev-age|dev-stats|dev-crash|dev-expire|dev-drop-tabs|dev-account-age)$/);
  if (!scene && !isLogoutAll && !dev) {
    return null;
  }
  const origin = request.headers.get("Origin");
  const ctx: Ctx = { request, env, url, origin, local: false, body: {}, cookies: [] };
  ctx.local = isLocalOrigin(origin) && !sameSite(ctx);
  if (request.method === "OPTIONS" && ctx.local) {
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
  if (scene && !FILE_ID_RE.test(scene[1])) {
    return fail(ctx, 404, "not-found", "Not a Drive file id");
  }
  // tests with the fake Google only (FAKE_GOOGLE=1 and a local DEV_ORIGIN, never in production):
  // dev-age ages blocked authors (24 h / 7 day rules), dev-stats counts rows written, dev-crash stops an upload midway
  if (dev && request.method === "POST" && devGate(env, request) && FILE_ID_RE.test(dev[1])) {
    const body: any = await request.json().catch(() => ({}));
    if (dev[2] === "dev-account-age") {
      // the signed-in account's guard (cookie session)
      const session = await cookieSession(request, env);
      if (!session?.sub) {
        return fail(ctx, 401, "signed-out", "Not signed in");
      }
      const res = await accountStub(env, session.sub).fetch("https://account/dev-age", { method: "POST", body: JSON.stringify({ ms: Number(body.ms) || 0 }) });
      return answer(ctx, 200, await res.json());
    }
    return answer(ctx, 200, await toScene(env, dev[1], `/${dev[2]}`, body && typeof body === "object" ? body : {}));
  }
  if (dev) {
    return fail(ctx, 404, "not-found", "Not found");
  }
  if (scene?.[2] === "live") {
    return connect(ctx, scene[1]).catch((error) => {
      if (error?.status === 503) {
        return new Response("Try again in a moment", { status: 503 });
      }
      throw error;
    });
  }
  if (request.method !== "POST") {
    return fail(ctx, 405, "method", "POST only");
  }
  if (!sameSite(ctx) && !ctx.local) {
    return fail(ctx, 403, "forbidden", "Forbidden");
  }
  // Kurviq's own pages: the sign-in cookie is checked before any body is read; bodies are small
  // (a tab id, a proof, the local install's session) and read with a limit
  const signedOut = !ctx.local && !(await cookieSession(request, env));
  // read at most the limit either way (nothing beyond it is buffered); without a cookie it is never parsed
  const text = await readLimited(request.body, ROUTE_BODY_BYTES);
  if (signedOut) {
    return fail(ctx, 401, "signed-out", "Not signed in");
  }
  if (text === null) {
    return fail(ctx, 413, "too-big", "Request too big");
  }
  try {
    ctx.body = text ? JSON.parse(text) : {};
  } catch {
    ctx.body = {};
  }
  if (!ctx.body || typeof ctx.body !== "object") {
    ctx.body = {};
  }
  try {
    if (isLogoutAll) {
      return await logoutAll(ctx);
    }
    const [, fileId, action] = scene!;
    if (action === "ticket") {
      return await ticket(ctx, fileId);
    }
    if (action === "renew") {
      return await renew(ctx, fileId);
    }
    if (action === "keep-local") {
      return await keepLocal(ctx, fileId);
    }
    return await reconcile(ctx, fileId);
  } catch (error: any) {
    // the account guard (or another of our objects) couldn't be asked: nothing is handed out
    if (error?.status === 503) {
      return fail(ctx, 503, "unavailable", "Try again in a moment");
    }
    throw error;
  }
};
