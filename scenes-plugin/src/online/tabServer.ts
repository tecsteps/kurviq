// Kurviq: the scenes server's HTTP API (/api/scenes…), answered by a tab.
// The MCP server (online/worker, or the local one) asks "the scenes server";
// its requests arrive here (through the pairing WebSocket, or relayed by the
// local scenes server) and are served with the Google Drive API (./drive.ts):
// the agent's edits are saved with this browser's Google sign-in.

import { leanScene } from "../leanFiles";
import { scenesController } from "../controller";

import { connection, driveScenes } from "./drive";

export type TabRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

export type TabResponse = { status: number; headers?: Record<string, string>; body: string };

const json = (status: number, body: unknown): TabResponse => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const NOT_CONNECTED =
  "Google Drive is not connected in this Kurviq browser: scenes are kept only in the browser (local-only). " +
  "Work with local-only scenes, or ask the user to sign in with Google (Scenes sidebar → Sign in with Google).";

/**
 * Names of a scene version on the wire: md5 (the content's MD5, Drive's
 * md5Checksum) and driveRevision (Drive's revision id). Answers carry the
 * old names too (sha / commit, header X-Scene-Sha) and requests may still use
 * them (?sha=, X-Base-Sha): pre-rename MCP servers and tabs; remove after 2027-02.
 */
const withOldNames = <T extends Record<string, unknown>>(result: T) => ({
  ...result,
  ...("md5" in result ? { sha: result.md5 } : {}),
  ...("driveRevision" in result ? { commit: result.driveRevision } : {}),
});
const versionHeaders = (md5: string) => ({ "Content-Type": "application/json", "X-Scene-Md5": md5, "X-Scene-Sha": md5 });

/** an agent changed Drive through this tab: sync the editor right away */
const afterAgentWrite = (source?: string) => {
  if (source?.startsWith("agent")) {
    Promise.resolve(scenesController.syncNow({ refresh: true })).catch((error) => console.error("[tab] background operation failed", error));
  }
};

/** a scene that saves through live sync (known here, or marked on its Drive file) */
const liveFileOf = async (name: string) =>
  scenesController.liveFileId(name) ?? (await driveScenes.liveFileOf(name).catch(() => null));

/** ?md5= (?sha=: pre-rename MCP servers; remove after 2027-02) */
const versionParam = (url: URL) => url.searchParams.get("md5") ?? url.searchParams.get("sha");

const parseRequestBody = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
};

const renameScene = async (renameMatch: RegExpExecArray, body: string, source: () => string | undefined) => {
  const from = decodeURIComponent(renameMatch[1]);
  const { to } = parseRequestBody(body || "{}");
  if (scenesController.liveFileId(from)) {
    // live: a name event through the scene's Durable Object
    await scenesController.rename(from, String(to ?? "").trim());
    return json(200, withOldNames({ from, to, md5: "", driveRevision: null }));
  }
  const result = await driveScenes.rename(from, String(to ?? "").trim());
  afterAgentWrite(source());
  return json(200, withOldNames({ from, to, ...result }));
};

const readLiveScene = async (name: string, liveFile: string, url: URL) => {
  // live: the scene as its Durable Object has it now (Drive is up to a minute behind)
  const wanted = versionParam(url);
  let text: string | null;
  let revision: string;
  if (wanted?.startsWith("live-")) {
    text = await scenesController.liveRevision(liveFile, wanted);
    revision = wanted;
  } else if (wanted) {
    const scene = await driveScenes.load(name, wanted);
    text = scene.json;
    revision = scene.md5;
  } else {
    const live = await scenesController.liveSessionFor(name);
    if (!live) {
      return json(404, { error: `Scene not found: ${name}` });
    }
    await live.flushNow();
    const snapshot = live.snapshot();
    text = snapshot.json;
    revision = snapshot.revision;
    await scenesController.rememberLiveRevision(liveFile, revision, text);
  }
  if (text === null) {
    return json(404, { error: `Revision ${wanted} of "${name}" is not kept in this browser any more` });
  }
  const body = url.searchParams.has("lean") ? JSON.stringify(leanScene(JSON.parse(text))) : text;
  return { status: 200, headers: versionHeaders(revision), body };
};

const routeScene = async (match: RegExpExecArray, method: string, body: string, url: URL, header: (name: string) => string | undefined, baseHeader: () => string | undefined): Promise<TabResponse> => {
  const name = decodeURIComponent(match[1]);
  const liveFile = await liveFileOf(name);
  if (method === "PUT") {
    parseRequestBody(body);
  }
  if (liveFile && method === "GET") {
    return readLiveScene(name, liveFile, url);
  }
  if (liveFile && method === "PUT") {
    const result = await scenesController.liveWrite(liveFile, name, body, baseHeader(), header("X-Scenes-Source"));
    return json(200, withOldNames({ name, ...result }));
  }
  if (liveFile && method === "DELETE") {
    await scenesController.remove(name);
    return json(200, withOldNames({ name, md5: null }));
  }
  if (method === "GET") {
    const scene = await driveScenes.load(name, versionParam(url) || undefined);
    // ?lean: without image bytes (the agent's server reads it; this tab keeps the images)
    const body = url.searchParams.has("lean") ? JSON.stringify(leanScene(JSON.parse(scene.json))) : scene.json;
    return { status: 200, headers: versionHeaders(scene.md5), body };
  }
  const given = baseHeader();
  const baseMd5 = given === undefined ? undefined : String(given).trim();
  if (baseMd5 !== undefined && !/^([0-9a-f]{32}|none)$/.test(baseMd5)) {
    return json(400, { error: 'X-Base-Md5 must be a version (32 hex characters) or "none"' });
  }
  if (method === "DELETE") {
    const result = await driveScenes.remove(name, baseMd5);
    afterAgentWrite(header("X-Scenes-Source"));
    return json(200, withOldNames({ name, ...result }));
  }
  if (method === "PUT") {
    const result = await driveScenes.save(name, body, baseMd5, header("X-Scenes-Source"));
    afterAgentWrite(header("X-Scenes-Source"));
    return json(200, withOldNames({ name, ...result }));
  }
  return json(404, { error: "Not found" });
};

const route = async ({ method, path, headers = {}, body = "" }: TabRequest): Promise<TabResponse> => {
  const url = new URL(path, "http://tab"); // NOSONAR S5332: constant URL parsing base only; no HTTP request is made
  const header = (name: string) => headers[name] ?? headers[name.toLowerCase()];
  // X-Base-Sha: pre-rename MCP servers; remove after 2027-02
  const baseHeader = () => header("X-Base-Md5") ?? header("X-Base-Sha");

  if (url.pathname === "/api/scenes" && method === "GET") {
    if (!connection.isActive()) {
      return json(200, { scenes: [], remote: { online: false, lastFetchAt: null, lastError: NOT_CONNECTED } });
    }
    return json(200, await driveScenes.list(url.searchParams.has("refresh")));
  }
  if (!connection.isActive()) {
    return json(503, { error: NOT_CONNECTED, offline: true });
  }
  if (method !== "GET" && !["app", "mcp"].includes(String(header("X-Scenes-Client") || ""))) {
    return json(403, { error: "Direct writes are not allowed. Change scenes only with the Kurviq MCP tools." });
  }
  const renameMatch = /^\/api\/scenes\/(.+)\/rename$/.exec(url.pathname);
  if (renameMatch && method === "POST") {
    return renameScene(renameMatch, body, () => header("X-Scenes-Source"));
  }
  const agentMatch = /^\/api\/scenes\/(.+)\/agent-version$/.exec(url.pathname);
  if (agentMatch && method === "GET") {
    const name = decodeURIComponent(agentMatch[1]);
    const liveFile = await liveFileOf(name);
    // live: the agent's last edit as this browser keeps it, until Drive has a newer agent version
    const version = (liveFile ? await scenesController.liveAgentVersion(liveFile) : null) ?? (await driveScenes.agentVersion(name));
    return json(200, { name, version: version && withOldNames(version) });
  }
  const match = /^\/api\/scenes\/(.+)$/.exec(url.pathname);
  if (match) {
    return routeScene(match, method, body, url, header, baseHeader);
  }
  return json(404, { error: "Not found" });
};

export const serveRequest = async (request: TabRequest): Promise<TabResponse> => {
  try {
    return await route(request);
  } catch (error: any) {
    let status: number;
    if (error.status && error.status >= 400) {
      status = error.status;
    } else {
      status = error.offline ? 503 : 500;
    }
    return json(status, {
      error: error.message,
      // remoteSha: for pre-rename MCP servers; remove after 2027-02
      ...(error.remoteMd5 !== undefined ? { remoteMd5: error.remoteMd5, remoteSha: error.remoteMd5 } : {}),
      ...(error.offline ? { offline: true } : {}),
      ...(error.exists ? { exists: true } : {}),
    });
  }
};
