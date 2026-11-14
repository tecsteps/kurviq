// Working together on a Drive scene (docs/relay/CONCEPT.md): the Worker's
// routes in front of the scenes' memory-only relays (./relay.ts), the drain
// of the retired live sync (./scene.ts) and the account guards (./account.ts).
//
//   POST /relay/<fileId>/ticket  a short-lived signed ticket for the scene's relay, after
//                                asking Drive what the person may do (edit / comment / read)
//   GET  /relay/<fileId>/live    the tab's WebSocket to the relay (?ticket=…)
//   POST /live/drain             the retired live sync: the signed-in account's old scene
//                                objects save what they still hold to Drive, then delete everything
//   POST /drive/notify           Drive's push notifications for the retired live sync: answered, ignored
//   POST /auth/logout-all        sign out everywhere
//
// Nothing is written here: Google's token comes from the encrypted session
// cookie (or the local install's sealed session) for the request and is
// forgotten after it. All POSTs take the cookie, or { session } from the
// local install (CORS for local origins, like /auth/token).

import {
  accountEpochOf,
  clearSessionCookie,
  cookieSession,
  devGate,
  freshSession,
  isLocalInstall,
  localSession,
  revokeAtGoogleNow,
  seal,
  sealLocalSession,
  sessionCookie,
  unseal,
} from "./auth";
import type { AuthEnv, Session } from "./auth";
import { getFile, patchFile, problemOf, readLimited } from "./driveApi";
import type { DriveAnswer } from "./driveApi";
import { CLAIMS_HEADER } from "./relay";
import type { RelayClaims, RelayRole } from "./relayRoom";
import { authorKey } from "../../scenes-mcp/sceneComments.mjs";
import { KEY_PROPERTY, LIVE_MARKER, keyIdOf, keyProperty, newKey, parseKeyProperty } from "../../scenes-plugin/src/online/sceneKey";

export type SceneRoutesEnv = AuthEnv & {
  /** the retired live sync's scene objects (drain only, ./scene.ts) */
  SCENE: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  /** one memory-only relay per Drive file (./relay.ts) */
  RELAY: DurableObjectNamespace;
};

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
/** route bodies: a few flags, the local install's sealed session */
const ROUTE_BODY_BYTES = 32 * 1024;
const TICKET = "kq_relay_ticket";
export const TICKET_VALID_MS = 60_000;
const FILE_FIELDS = "id,name,trashed,capabilities(canEdit,canComment),appProperties";
/** the people's colors (pointers, the pen bar): the same person always gets the same */
export const PEOPLE_COLORS = ["#7048e8", "#1971c2", "#0c8599", "#2f9e44", "#e8590c", "#c2255c", "#5f3dc4", "#364fc7"];

export type Ctx = {
  request: Request;
  env: SceneRoutesEnv;
  url: URL;
  origin: string | null;
  /** the local install (session in the body, CORS) */
  local: boolean;
  body: any;
  cookies: string[];
};

/** a relay ticket's content (sealed: only the Worker reads it) */
export type RelayTicket = RelayClaims & { kind: "relay"; fileId: string; exp: number };

export const answer = (ctx: Ctx, status: number, body: unknown) => {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  ctx.cookies.forEach((value) => headers.append("Set-Cookie", value));
  if (ctx.local && ctx.origin) {
    headers.set("Access-Control-Allow-Origin", ctx.origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
};

export const fail = (ctx: Ctx, status: number, code: string, error: string) => answer(ctx, status, { error, code });

const sceneStub = (env: SceneRoutesEnv, fileId: string) => env.SCENE.get(env.SCENE.idFromName(fileId));
const accountStub = (env: SceneRoutesEnv, sub: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(sub));

/** the account's revocation epoch; throws when the guard can't be asked (callers answer 503: fail closed) */
const accountEpoch = async (env: SceneRoutesEnv, sub: string) => {
  const epoch = await accountEpochOf(env, sub);
  if (epoch === null) {
    throw Object.assign(new Error("account guard unavailable"), { status: 503 });
  }
  return epoch;
};

/** this site's pages, or the local install */
export const sameSite = (ctx: Ctx) =>
  ctx.origin === ctx.url.origin || (devGate(ctx.env, ctx.request) && !!ctx.env.DEV_ORIGIN && ctx.origin === ctx.env.DEV_ORIGIN);

/**
 * The signed-in session with an access token good for 10 more minutes and a
 * `sub`, or the answer to give. A refreshed session goes back with the answer
 * (cookie, or `session` for the local install).
 */
export const signedIn = async (ctx: Ctx): Promise<{ session: Session; sealedLocal?: string } | Response> => {
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
  // the account's id and the sign-in's time (sign out everywhere): older sessions sign in again
  if (!fresh.session.sub || !fresh.session.iat) {
    return fail(ctx, 401, "sign-in-again", "Sign in again to work together on scenes");
  }
  let sealedLocal: string | undefined;
  if (fresh.renewed) {
    if (ctx.local) {
      sealedLocal = await sealLocalSession(ctx.env, fresh.session);
    } else {
      ctx.cookies.push(await sessionCookie(ctx.request, ctx.env, fresh.session));
    }
  }
  const epoch = await accountEpoch(ctx.env, fresh.session.sub);
  if (epoch && (fresh.session.iat ?? 0) < epoch) {
    if (!ctx.local) {
      ctx.cookies.push(clearSessionCookie(ctx.request));
    }
    return fail(ctx, 401, "signed-out-everywhere", "Signed out everywhere: sign in again");
  }
  return { session: fresh.session, sealedLocal };
};

/** Drive's word on a file: edit, comment (Drive's commenters: comments only) or read */
export const roleOf = (file: any): RelayRole => {
  if (file?.capabilities?.canEdit) {
    return "edit";
  }
  return file?.capabilities?.canComment ? "comment" : "read";
};

/** the same person always gets the same color */
export const colorOf = (who: string) => PEOPLE_COLORS[(Number.parseInt(who.slice(0, 8), 16) || 0) % PEOPLE_COLORS.length];

/**
 * Why Drive didn't give the file: a rate limit or an outage is "try again"
 * (503), never "no access"; an expired token is a sign-in problem (401);
 * only a real refusal (or drive.file not granted: "not found") is 403.
 */
export const fileProblem = (ctx: Ctx, file: DriveAnswer) => {
  const problem = problemOf(file);
  if (problem === "unreachable" || problem === "rate-limited") {
    return fail(ctx, 503, "google-unreachable", "Google Drive is not reachable: try again in a moment");
  }
  if (problem === "token") {
    return fail(ctx, 401, "signed-out", "The sign-in has expired");
  }
  return fail(ctx, 403, "no-access", "No access to this file through Kurviq");
};

/**
 * The scene's key from the file; an editor asks for a new one (`create`)
 * only while holding the pen, so two editors never make two keys at once.
 * Read again after writing: what Drive has is the key.
 */
const sceneKeyOf = async (ctx: Ctx, fileId: string, token: string, file: any, create: boolean): Promise<{ key: string; keyId: string } | null> => {
  const found = await parseKeyProperty(file.appProperties?.[KEY_PROPERTY], fileId);
  if (found && !found.copy) {
    return { key: found.key, keyId: found.keyId };
  }
  if (!create) {
    return null;
  }
  const key = newKey();
  const keyId = await keyIdOf(key);
  const written = await patchFile(ctx.env, token, fileId, { appProperties: { [KEY_PROPERTY]: keyProperty(keyId, fileId, key) } });
  if (written.status !== 200) {
    return null;
  }
  const again = await getFile(ctx.env, token, fileId, "appProperties");
  const stored = await parseKeyProperty(again.data?.appProperties?.[KEY_PROPERTY], fileId);
  return stored && !stored.copy ? { key: stored.key, keyId: stored.keyId } : null;
};

/**
 * A file the retired live sync saved (marked kurviqSync): its old scene
 * object saves what it still holds and deletes everything, with the token
 * of this request (an editor's), before anyone works on the file.
 */
const drainMarked = async (ctx: Ctx, fileId: string, session: Session, file: any, role: RelayRole) => {
  if (file.appProperties?.kurviqSync !== LIVE_MARKER || role !== "edit") {
    return;
  }
  const result = await drainScene(ctx.env, fileId, session.sub!, session.a).catch(() => null);
  if (result?.state === "empty" || result?.state === "drained") {
    await accountStub(ctx.env, session.sub!)
      .fetch("https://account/scene-drained", { method: "POST", body: JSON.stringify({ fileId }) })
      .catch(() => null);
  }
};

export type DrainResult = { fileId: string; state: "empty" | "drained" | "kept"; saved?: "version" | "copy"; reason?: string };

/** one old scene object: save what it holds to Drive (with this token, or one it still holds), then delete everything */
const drainScene = async (env: SceneRoutesEnv, fileId: string, sub: string, token: string): Promise<DrainResult> => {
  const res = await sceneStub(env, fileId).fetch("https://scene/drain", { method: "POST", body: JSON.stringify({ fileId, sub, token }) });
  const body = (await res.json().catch(() => ({}))) as Partial<DrainResult>;
  return { fileId, state: body.state ?? "kept", ...(body.saved ? { saved: body.saved } : {}), ...(body.reason ? { reason: body.reason } : {}) };
};

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

const ticket = async (ctx: Ctx, fileId: string) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const { session } = who;
  const file = await getFile(ctx.env, session.a, fileId, FILE_FIELDS);
  if (file.status !== 200) {
    return fileProblem(ctx, file);
  }
  const role = roleOf(file.data);
  await drainMarked(ctx, fileId, session, file.data, role);
  const key = await sceneKeyOf(ctx, fileId, session.a, file.data, ctx.body.createKey === true && role === "edit");
  const whoKey = await authorKey(session.user.email);
  const claims: RelayTicket = {
    kind: "relay",
    fileId,
    name: (session.user.name ?? session.user.email.split("@")[0]).slice(0, 80),
    color: colorOf(whoKey),
    role,
    who: whoKey,
    // a commenter's comments are recorded on their behalf by the holder's tab
    ...(role === "comment" ? { email: session.user.email } : {}),
    exp: Date.now() + TICKET_VALID_MS,
  };
  return answer(ctx, 200, {
    ticket: await seal(ctx.env, claims, TICKET),
    expiresAt: claims.exp,
    role,
    name: claims.name,
    color: claims.color,
    who: claims.who,
    key: key?.key ?? null,
    keyId: key?.keyId ?? null,
    ...(who.sealedLocal ? { session: who.sealedLocal } : {}),
  });
};

/** the tab's WebSocket: the ticket is checked here, the relay gets the checked claims */
const connect = async (ctx: Ctx, fileId: string) => {
  if (ctx.request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket", { status: 426 });
  }
  // browsers always send Origin with a WebSocket: this site or the local install
  if (!sameSite(ctx) && !isLocalInstall(ctx.origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const claims = await unseal<RelayTicket>(ctx.env, ctx.url.searchParams.get("ticket") ?? undefined, TICKET);
  if (claims?.kind !== "relay" || claims.fileId !== fileId || claims.exp <= Date.now()) {
    return new Response("Invalid or expired ticket", { status: 403 });
  }
  const relayClaims: RelayClaims = { name: claims.name, color: claims.color, role: claims.role, who: claims.who, ...(claims.email ? { email: claims.email } : {}) };
  const headers = new Headers(ctx.request.headers);
  headers.set(CLAIMS_HEADER, JSON.stringify(relayClaims));
  return ctx.env.RELAY.get(ctx.env.RELAY.idFromName(fileId)).fetch("https://relay/live", { headers });
};

/** the retired live sync: every old scene object the account guard knows drains (saves, then deletes everything) */
const drain = async (ctx: Ctx) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const sub = who.session.sub!;
  const account = accountStub(ctx.env, sub);
  const listed = await account.fetch("https://account/scenes-list", { method: "POST", body: "{}" });
  const { scenes = [] } = (await listed.json().catch(() => ({}))) as { scenes?: string[] };
  const results: DrainResult[] = [];
  for (const fileId of scenes.filter((id) => FILE_ID_RE.test(id))) {
    const result = await drainScene(ctx.env, fileId, sub, who.session.a).catch(() => ({ fileId, state: "kept" as const, reason: "unavailable" })); // NOSONAR S9382: one at a time on purpose (each may upload to Drive)
    results.push(result);
    if (result.state !== "kept") {
      await account.fetch("https://account/scene-drained", { method: "POST", body: JSON.stringify({ fileId }) }); // NOSONAR S9382: one at a time on purpose (follows its drain)
    }
  }
  return answer(ctx, 200, { results, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

/** where a person removes Kurviq's access at Google themselves */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

/** what sign out everywhere answers: whether Google confirmed, and if not, what the person can do */
export const logoutAllAnswer = (revoked: boolean, scenes: number) => ({
  ok: revoked,
  revokedAtGoogle: revoked,
  scenes,
  ...(revoked
    ? {}
    : {
        message:
          "You are signed out of Kurviq everywhere, but Google couldn't be reached to end Kurviq's access to your Google account. " +
          `Remove Kurviq there yourself: ${GOOGLE_PERMISSIONS_URL} (choose Kurviq, then delete its connection).`,
        removeAccess: GOOGLE_PERMISSIONS_URL,
      }),
});

/**
 * Sign out everywhere: epoch raised, Kurviq revoked at Google (tried a few times within this request; the token
 * is never kept for a later try), the old scene objects told to drop this account's tokens
 */
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
  const revoked = await revokeAtGoogleNow(ctx.env, session.r);
  if (!sub) {
    return answer(ctx, 200, logoutAllAnswer(revoked, 0));
  }
  // the account guard tells every old scene object it knows (tokens they still hold go) and retries until each confirmed
  const res = await accountStub(ctx.env, sub).fetch("https://account/logout-all", { method: "POST", body: JSON.stringify({ sub }) });
  const { scenes = [], epoch } = (await res.json().catch(() => ({}))) as { scenes?: string[]; epoch?: number };
  await Promise.all(
    scenes.map((fileId) => sceneStub(ctx.env, fileId).fetch("https://scene/forget", { method: "POST", body: JSON.stringify({ fileId, sub, epoch }) }).catch(() => null)),
  );
  return answer(ctx, 200, logoutAllAnswer(revoked, scenes.length));
};

const dispatch = async (ctx: Ctx, action: string, fileId: string | null) => {
  try {
    if (action === "logout-all") {
      return await logoutAll(ctx);
    }
    if (action === "drain") {
      return await drain(ctx);
    }
    return await ticket(ctx, fileId!);
  } catch (error: any) {
    // the account guard (or another of our objects) couldn't be asked: nothing is handed out
    if (error?.status === 503) {
      return fail(ctx, 503, "unavailable", "Try again in a moment");
    }
    throw error;
  }
};

const readBody = async (ctx: Ctx) => {
  // Kurviq's own pages: the sign-in cookie is checked before any body is read; bodies are small
  const signedOut = !ctx.local && !(await cookieSession(ctx.request, ctx.env));
  // read at most the limit either way (nothing beyond it is buffered); without a cookie it is never parsed
  const text = await readLimited(ctx.request.body, ROUTE_BODY_BYTES);
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
  return null;
};

const handleAction = async (ctx: Ctx, action: string, fileId: string | null) => {
  if (ctx.request.method !== "POST") {
    return fail(ctx, 405, "method", "POST only");
  }
  if (!sameSite(ctx) && !ctx.local) {
    return fail(ctx, 403, "forbidden", "Forbidden");
  }
  return (await readBody(ctx)) ?? dispatch(ctx, action, fileId);
};

const routeOf = (pathname: string): { action: string; fileId: string | null } | null => {
  const relay = /^\/relay\/([^/]+)\/(ticket|live)$/.exec(pathname);
  if (relay) {
    return { action: relay[2], fileId: relay[1] };
  }
  if (pathname === "/auth/logout-all") {
    return { action: "logout-all", fileId: null };
  }
  return pathname === "/live/drain" ? { action: "drain", fileId: null } : null;
};

export const handleSceneRoutes = async (request: Request, env: SceneRoutesEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/drive/notify") {
    // channels the retired live sync opened run out within a day: answered (Google retries otherwise), never acted on
    return new Response(null, { status: request.method === "POST" ? 200 : 405 });
  }
  const route = routeOf(url.pathname);
  if (!route) {
    return null;
  }
  const origin = request.headers.get("Origin");
  const ctx: Ctx = { request, env, url, origin, local: false, body: {}, cookies: [] };
  ctx.local = isLocalInstall(origin) && !sameSite(ctx);
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
  if (route.fileId !== null && !FILE_ID_RE.test(route.fileId)) {
    return fail(ctx, 404, "not-found", "Not a Drive file id");
  }
  if (route.action === "live") {
    return connect(ctx, route.fileId!);
  }
  return handleAction(ctx, route.action, route.fileId);
};
