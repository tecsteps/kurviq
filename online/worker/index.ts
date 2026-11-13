// Kurviq (https://kurviq.com): the Cloudflare Worker.
//
//   /auth/*          Sign in with Google (./auth.ts): stateless, encrypted cookie
//   /scene/<fileId>/…  live sync of a Drive scene: tickets, WebSocket, proofs (./sceneRoutes.ts, ./scene.ts)
//   /drive/notify    Drive's push notifications for live scenes
//   /folders, /folders/…  shared folders through the owner's sign-in (./folders.ts)
//   /live/<key>      WebSocket of a Kurviq tab to its agent pairing (./pairing.ts)
//   /mcp             remote MCP for agents (scenes-mcp/tools.mjs), answered
//                    through the pairing's open Kurviq tab; agents sign in
//                    (OAuth, ./oauth.ts) and the user allows them in Kurviq
//   /mcp/<key>       the old link with the key in the URL: refused (410), the
//                    agent is told to sign in
//   /mcp/upload/<token>  images and big edits of a signed-in agent (curl)
//   /oauth/*, /.well-known/oauth-*  the sign-in (./oauth.ts)
//   /llms.txt        how agents use Kurviq
//   /api/public/…    scenes shared "anyone with the link" on Drive, cached (./shared.ts)
//   /contact         the contact form (./contact.ts); usage statistics are
//                    counted from page loads and server events (./stats.ts)
//   /api/fonts/…     fonts from Google Fonts for "Add font", cached (./fonts.ts)
//   /s/<fileId>/…    a shared scene: the app, titled for link previews (./shared.ts)
//   /pub/<name>      the same through a short link; /api/pub/… claims and looks them up (./pubLinks.ts)
//   /drive/open      Drive's "Open with Kurviq": to /s/<fileId>
//   everything else  the app (static assets, built by `npm run build:online`);
//                    /assets/* and /fonts/* don't reach the Worker at all
//                    (wrangler.jsonc run_worker_first)

import { DurableObject } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerTools } from "../../excalidraw-mcp/dist/server.js";
import { handleFeedback, saveFeedback, senderHash } from "./feedback";
import type { FeedbackEnv } from "./feedback";
import { createScenesMcp } from "../../scenes-mcp/tools.mjs";

import llmsTxt from "../llms.txt";
import { devGate, handleAuth } from "./auth";
import { FakeGoogle as FakeGoogleStore, handleFakeGoogle } from "./fakeGoogle";
import { handleFonts } from "./fonts";
import { base64FromBytes, readBytes } from "./bytes";
import { FILE_ID_RE } from "./driveApi";
import { AGENT_KEY_RE, bearerPairing, handleOAuth, pairingName, unauthorized, uploadPairing, uploadToken } from "./oauth";
import { handleSceneRoutes } from "./sceneRoutes";
import { handleFolderRoutes } from "./folders";
import type { FoldersEnv } from "./folders";
import type { SceneRoutesEnv } from "./sceneRoutes";
import { handlePublicApi, handleSharedPage } from "./shared";
import { handlePubApi } from "./pubLinks";
import type { PubEnv } from "./pubLinks";
import { kurviqReference, kurviqSkill } from "./skill";
import { feedbackStats, handleStatsDev, mcpStats, pageStats, publicReadStats, routeStats } from "./stats";
import type { StatsEnv } from "./stats";
import { handleContact } from "./contact";
import type { ContactEnv } from "./contact";
import { runRetention } from "./retention";

import type { AuthEnv } from "./auth";
import type { SharedEnv } from "./shared";

export { Pairing } from "./pairing";
export { SceneRoom } from "./scene";
export { AccountGuard } from "./account";
export { Stats } from "./stats";

/**
 * A development build (online/build-worker.mjs without --production): the
 * fake Google and its admin API are in the bundle. The production bundle
 * leaves them out as dead code, so they can't be switched on by configuration.
 */
declare const __KURVIQ_DEV__: boolean;

/**
 * The fake Google's Durable Object; in production a stub that is never used
 * (the binding FAKE_GOOGLE_STORE and its migration need the class to exist)
 */
export const FakeGoogle = __KURVIQ_DEV__ ? FakeGoogleStore : class extends DurableObject {};

type Env = AuthEnv & SharedEnv & FeedbackEnv & SceneRoutesEnv & FoldersEnv & StatsEnv & ContactEnv & PubEnv & {
  ASSETS: Fetcher;
  PAIRING: DurableObjectNamespace;
  /** canonical host (www and workers.dev redirect there), e.g. kurviq.com */
  CANONICAL_HOST?: string;
};

/**
 * Who an agent request is for: the pairing (the Durable Object, named by the
 * hash of the browser's agent key, so the key itself is never stored) of a
 * signed-in agent
 */
type Access = { pairing: string };

const pairingStub = (env: Env, access: Access) => env.PAIRING.get(env.PAIRING.idFromName(access.pairing));

/** a request to the pairing (with the app's address, which the pairing uses in its messages) */
const toPairing = (path: string, init: RequestInit = {}, app?: string) => {
  const headers = new Headers(init.headers);
  if (app) {
    headers.set("X-Kurviq-App", app);
  }
  return new Request(`https://pairing${path}`, { ...init, headers });
};

/** what an agent with the old link (the key in the URL, before agents signed in) is told */
const legacyRefused = (app: string) =>
  `This agent uses the old Kurviq link (the key in the URL), which doesn't work any more. Connect with ${app}/mcp instead: the agent signs in once and the user allows it in Kurviq (e.g. claude mcp add --transport http kurviq ${app}/mcp). Ask the user to do this.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

const withCors = (response: Response) => {
  const next = new Response(response.body, response);
  Object.entries(CORS).forEach(([key, value]) => next.headers.set(key, value));
  return next;
};

/** images an agent uploads: at most this big (the tab keeps them, the scene file carries them) */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** the image type, from the file's first bytes (agents often send no or a wrong Content-Type) */
const imageType = (bytes: Uint8Array): string | null => {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp"; // NOSONAR S7758: these are signature bytes, not Unicode code points
  // SVG: after an optional <?xml …?>, <!DOCTYPE …> and comments (icon sets start with a license comment)
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 4096))
    .toLowerCase()
    .replace(/^(\s|<\?xml[^>]*\?>|<!doctype[^>]*>|<!--[\s\S]*?-->)*/, "");
  if (head.startsWith("<svg")) return "image/svg+xml";
  return null;
};

/**
 * POST /mcp/upload/<token> with an image file as the body (curl --data-binary
 * @file.png): the image goes straight to the user's Kurviq tab (nothing is
 * stored here), which answers with its fileId. The agent then adds
 * { "type": "image", "fileId": "…" } to a scene. The image's bytes never
 * pass through the model.
 */
const handleUpload = async (request: Request, env: Env, access: Access | null) => {
  const answer = (status: number, body: unknown) =>
    withCors(new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } }));
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (!access) {
    return answer(404, { error: "Unknown or expired upload address: read_me has the current one" });
  }
  if (request.method !== "POST") {
    return answer(405, { error: "POST the image file as the request body: curl --data-binary @image.png <this URL>" });
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_UPLOAD_BYTES) {
    return answer(413, { error: `At most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per image (use JPEG or WebP for photos)` });
  }
  // read only up to the limit, whatever Content-Length said (a chunked body has none)
  const bytes = await readBytes(request.body, MAX_UPLOAD_BYTES);
  if (!bytes) {
    return answer(413, { error: `At most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per image` });
  }
  if (!bytes.length) {
    return answer(400, { error: "Empty body: send the image file as the request body (curl --data-binary @image.png)" });
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)); // NOSONAR S4790: Excalidraw content identifier only, not authentication or integrity verification
  const id = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const first = bytes.find((byte) => byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09);
  if (first === 0x7b || first === 0x5b) {
    return uploadPayload(request, env, access, id, bytes, answer);
  }
  const mimeType = imageType(bytes);
  if (!mimeType) {
    return answer(415, { error: "Not an image (PNG, JPEG, GIF, WebP or SVG) and not an edit (JSON)" });
  }
  const res = await pairingStub(env, access).fetch(
    toPairing(
      "/api/app/command",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "upload", file: { id, mimeType, dataURL: `data:${mimeType};base64,${base64FromBytes(bytes)}` } }),
      },
      new URL(request.url).origin,
    ),
  );
  const body = (await res.json().catch(() => ({}))) as { result?: { fileId: string; width: number; height: number }; error?: string };
  if (!res.ok || !body.result) {
    return answer(res.status >= 400 ? res.status : 502, {
      error: body.error || "The Kurviq tab did not take the image. Is Kurviq open in the browser where the user allowed this agent?",
    });
  }
  const { fileId, width, height } = body.result;
  return answer(200, {
    fileId,
    mimeType,
    width,
    height,
    use: `Add it with edit_scene (or save_scene): { "type": "image", "id": "<your id>", "x": 0, "y": 0, "width": ${Math.min(width, 1200)}, "fileId": "${fileId}" } (width or height alone keeps the aspect ratio).`,
  });
};

/** big edits an agent uploads instead of pasting them into a tool call */
const MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * POST /mcp/upload/<token> with a JSON body ({ "add": [...], "update": [...],
 * "delete": [...] } or an array of elements to add): kept by the user's tab
 * until edit_scene / save_scene names it as payloadId.
 */
const uploadPayload = async (
  request: Request,
  env: Env,
  access: Access,
  id: string,
  bytes: Uint8Array,
  answer: (status: number, body: unknown) => Response,
) => {
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    return answer(413, { error: `An edit payload may be at most ${MAX_PAYLOAD_BYTES / 1_000_000} MB: split it into several edits` });
  }
  const res = await pairingStub(env, access).fetch(
    toPairing(
      "/api/app/command",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "upload-payload", payload: { id, json: new TextDecoder().decode(bytes) } }),
      },
      new URL(request.url).origin,
    ),
  );
  const body = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown>; error?: string };
  if (!res.ok || !body.result) {
    return answer(res.status >= 400 ? res.status : 502, {
      error: body.error || "The Kurviq tab did not take the edit. Is Kurviq open in the browser where the user allowed this agent?",
    });
  }
  return answer(200, {
    ...body.result,
    use: `Apply it with edit_scene(name, payloadId: "${id}") (or save_scene(name, payloadId: "${id}") for a new scene); add basedOn, upsert, view etc. as usual.`,
  });
};

/** tools that work without the user's tab (everything else runs there) */
const WITHOUT_TAB = new Set(["read_me"]);

/** JSON-RPC tool calls in a request (single or batch), if any */
const toolCalls = async (request: Request): Promise<Array<{ id: unknown; name: string }>> => {
  if (request.method !== "POST") {
    return [];
  }
  try {
    const body = await request.clone().json();
    return (Array.isArray(body) ? body : [body])
      .filter((message) => message?.method === "tools/call")
      .map((message) => ({ id: message.id, name: String(message.params?.name ?? "") }));
  } catch {
    return [];
  }
};

/** tool calls answered with an error text each, without running them (JSON-RPC results, isError) */
const toolErrors = (calls: Array<{ id: unknown }>, text: string, status = 200) => {
  const answers = calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text }], isError: true } }));
  return withCors(new Response(JSON.stringify(answers.length === 1 ? answers[0] : answers), { status, headers: { "Content-Type": "application/json" } }));
};

const handleMcp = async (request: Request, env: Env, access: Access, ctx: ExecutionContext) => {
  const url = new URL(request.url);
  const app = url.origin;
  const stub = pairingStub(env, access);
  const unreachable = `Kurviq could not reach the user's browser: no Kurviq tab is open in the browser where the user allowed this agent, or the user signed out all agents since (then sign in again: in Claude Code /mcp → kurviq → Re-authenticate). Ask the user to open ${app} there.`;
  // no tab behind this link: nothing runs (and nothing is fetched on its behalf)
  const allCalls = await toolCalls(request);
  mcpStats(env, ctx, allCalls.map((call) => call.name));
  const calls = allCalls.filter((call) => !WITHOUT_TAB.has(call.name));
  if (calls.length) {
    const state = (await (await stub.fetch(toPairing("/api/app/state", {}, app))).json()) as { connected?: boolean };
    if (!state.connected) {
      return toolErrors(calls, unreachable);
    }
  }
  // the upload address (a sealed token) only where it is shown: read_me's reference
  const uploadUrl = allCalls.some((call) => call.name === "read_me") ? `${app}/mcp/upload/${await uploadToken(env, access.pairing)}` : undefined;
  const server = createScenesMcp({
    name: "Kurviq",
    mode: "detached",
    appHint: app,
    driveOptional: true,
    // scenes full of images: read without their bytes (CPU budget), the tab fills them in for pictures
    leanReads: true,
    // no access to the agent's files here: images and big edits are uploaded
    localFiles: false,
    uploadUrl,
    skill: kurviqSkill(app),
    reference: kurviqReference(uploadUrl),
    unreachable,
    serverFetch: (pathname: string, init: RequestInit = {}) => stub.fetch(toPairing(pathname, init, app)),
    registerUpstream: (mcp: unknown, store: unknown) => registerTools(mcp as any, "/bundle", store as any),
    // bug reports / change requests from the agent (counted per agent pairing)
    sendFeedback: async (report: unknown) => {
      const saved = await saveFeedback(env, report, { source: "agent", sender: await senderHash(env, `pairing:${access.pairing}`) });
      if ("id" in saved) {
        feedbackStats(env, ctx, "agent");
      }
      return saved;
    },
    // export_pdf is not offered online (localFiles: false); should it ever be called, it says why
    savePdf: () => Promise.reject(new Error("PDF export is not available through the Kurviq MCP; the user exports PDFs in Kurviq (Slides sidebar → PDF).")),
  });
  // stateless: a new server per request, nothing kept between requests
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    server.close().catch(() => {});
  }
};

const handleMcpRoute = async (request: Request, env: Env, ctx: ExecutionContext, url: URL, mcp: RegExpExecArray) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  // no server-sent event stream (stateless: it would end at once, and clients
  // reconnect every second, forever); 405 tells them not to ask again
  if (request.method === "GET") {
    return withCors(new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE, OPTIONS" } }));
  }
  if (!mcp[1]) {
    // signed in (OAuth); without a token: where to sign in
    const pairing = await bearerPairing(request, env);
    if (!pairing || pairing === "invalid") {
      return unauthorized(url.origin, pairing === "invalid");
    }
    return handleMcp(request, env, { pairing }, ctx);
  }
  if (!AGENT_KEY_RE.test(mcp[1])) {
    return withCors(
      new Response(
        JSON.stringify({
          error: `Not a Kurviq agent address. Add ${url.origin}/mcp as a remote MCP server: the agent signs in and the user allows it in Kurviq. See ${url.origin}/llms.txt`,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  // the old link: nothing runs; tool calls get the explanation as their result, anything else 410
  const calls = await toolCalls(request);
  if (calls.length) {
    return toolErrors(calls, legacyRefused(url.origin));
  }
  return withCors(new Response(JSON.stringify({ error: legacyRefused(url.origin) }), { status: 410, headers: { "Content-Type": "application/json" } }));
};

const handleLiveRoute = async (request: Request, env: Env, url: URL, key: string) => {
  if (!AGENT_KEY_RE.test(key)) {
    return new Response("Unknown agent link", { status: 404 });
  }
  // only Kurviq's own pages (browsers always send Origin with a WebSocket)
  if (request.headers.get("Origin") !== url.origin) {
    return new Response("Forbidden", { status: 403 });
  }
  const stub = env.PAIRING.get(env.PAIRING.idFromName(await pairingName(key)));
  return stub.fetch(new Request(`https://pairing/live${url.search}`, request));
};

const handleSignedUpload = async (request: Request, env: Env, token: string) => {
  const pairing = await uploadPairing(env, token);
  return handleUpload(request, env, pairing ? { pairing } : null);
};

const driveOpenRedirect = (url: URL) => {
  let id = "";
  try {
    id = String(JSON.parse(url.searchParams.get("state") || "{}").ids?.[0] ?? "");
  } catch {}
  return Response.redirect(new URL(FILE_ID_RE.test(id) ? `/s/${id}` : "/", url).toString(), 302);
};

const handlePageRoutes = async (request: Request, env: Env, ctx: ExecutionContext, url: URL) => {
  // bug reports and change requests from Kurviq's pages
  if (url.pathname === "/api/feedback") {
    const feedback = await handleFeedback(request, env);
    if (feedback.ok) {
      feedbackStats(env, ctx, "app");
    }
    return feedback;
  }

  // usage statistics, local tests only (./stats.ts)
  if (url.pathname === "/api/stats-dev/flush" || url.pathname === "/api/stats-dev/retention") {
    return handleStatsDev(request, env, () => runRetention(env));
  }

  // the contact form (./contact.ts)
  const contact = await handleContact(request, env, ctx);
  if (contact) {
    return contact;
  }

  if (url.pathname === "/llms.txt") {
    return new Response(String(llmsTxt).replaceAll("https://kurviq.com", url.origin), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }

  const fonts = await handleFonts(request, ctx);
  if (fonts) {
    return fonts;
  }
  const pubApi = await handlePubApi(request, env);
  if (pubApi) {
    return pubApi;
  }
  const publicApi = handlePublicApi(request, env, ctx);
  if (publicApi) { // NOSONAR S6544: preserve the existing Promise short-circuit; awaiting its nullable result changes routing
    publicReadStats(request, env, ctx);
    return publicApi;
  }
  // Drive's "Open with Kurviq" (Drive UI integration): state={"ids":[…],"action":"open"}
  if (url.pathname === "/drive/open") {
    return driveOpenRedirect(url);
  }
  const page = await handleSharedPage(request, env, env.ASSETS, ctx);
  if (page) {
    pageStats(request, page, env, ctx);
    return page;
  }
  // the app (any scene) and the plain pages; page loads are counted (navigations only, ./stats.ts)
  const asset = await env.ASSETS.fetch(request);
  pageStats(request, asset, env, ctx);
  return asset;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // a development configuration (the fake Google) never serves a non-local host
    if (env.FAKE_GOOGLE === "1" && !devGate(env, request)) {
      return new Response("Development configuration: only served on localhost", { status: 503 });
    }
    // dev builds only (FAKE_GOOGLE=1, local DEV_ORIGIN): the fake Google of ./fakeGoogle.ts
    const fakeGoogle = __KURVIQ_DEV__ ? handleFakeGoogle(request, env as Env & { FAKE_GOOGLE_STORE?: DurableObjectNamespace }) : null;
    if (fakeGoogle) { // NOSONAR S6544: preserve the existing Promise short-circuit; awaiting its nullable result changes routing
      return fakeGoogle;
    }
    const url = new URL(request.url);
    if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.hostname = env.CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    // live sync (docs/live-sync): tickets, the scene WebSocket, Drive's webhook, sign out everywhere
    const sceneRoute = await handleSceneRoutes(request, env);
    if (sceneRoute) {
      routeStats(request, sceneRoute, env, ctx);
      return sceneRoute;
    }

    // shared folders through the owner's sign-in (docs/folders/CONCEPT.md)
    const folderRoute = await handleFolderRoutes(request, env);
    if (folderRoute) {
      routeStats(request, folderRoute, env, ctx);
      return folderRoute;
    }

    const auth = await handleAuth(request, env);
    if (auth) {
      routeStats(request, auth, env, ctx);
      return auth;
    }

    const live = /^\/live\/([^/]+)$/.exec(url.pathname);
    if (live) {
      return handleLiveRoute(request, env, url, live[1]);
    }

    const oauth = await handleOAuth(request, env);
    if (oauth) {
      return oauth;
    }

    // uploads of a signed-in agent: /mcp/upload/<token> (curl can't sign in; the token names the pairing, for a week)
    const signedUpload = /^\/mcp\/upload\/([^/]+)\/?$/.exec(url.pathname);
    if (signedUpload) {
      return handleSignedUpload(request, env, signedUpload[1]);
    }
    // the old link: /mcp/<key>/upload (refused without reading the body)
    if (/^\/mcp\/[^/]+\/upload\/?$/.test(url.pathname)) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }
      return withCors(new Response(JSON.stringify({ error: legacyRefused(url.origin) }), { status: 410, headers: { "Content-Type": "application/json" } }));
    }

    const mcp = /^\/mcp(?:\/([^/]*))?\/?$/.exec(url.pathname);
    if (mcp) {
      return handleMcpRoute(request, env, ctx, url, mcp);
    }

    return handlePageRoutes(request, env, ctx, url);
  },

  // hourly (wrangler.jsonc triggers): feedback older than 2 years, contact messages older than 1 year are deleted,
  // sender hashes older than a day blanked
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { // NOSONAR S7503: async preserves the Worker handler promise and synchronous failure rejection
    ctx.waitUntil(runRetention(env));
  },
};
