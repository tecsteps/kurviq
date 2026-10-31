// Kurviq: the scenes server's HTTP API (/api/scenes…), answered by a tab.
// The MCP server (online/worker, or the local one) asks "the scenes server";
// its requests arrive here (through the pairing WebSocket, or relayed by the
// local scenes server) and are served with the Google Drive API (./drive.ts)
// — the agent's edits are saved with this browser's Google sign-in.

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

/** an agent changed Drive through this tab: sync the editor right away */
const afterAgentWrite = (source?: string) => {
  if (source?.startsWith("agent")) {
    scenesController.syncNow({ refresh: true });
  }
};

/** a scene that saves through live sync (known here, or marked on its Drive file) */
const liveFileOf = async (name: string) =>
  scenesController.liveFileId(name) ?? (await driveScenes.liveFileOf(name).catch(() => null));

const route = async ({ method, path, headers = {}, body = "" }: TabRequest): Promise<TabResponse> => {
  const url = new URL(path, "http://tab");
  const header = (name: string) => headers[name] ?? headers[name.toLowerCase()];

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
  const renameMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/rename$/);
  if (renameMatch && method === "POST") {
    const from = decodeURIComponent(renameMatch[1]);
    const { to } = JSON.parse(body || "{}");
    if (scenesController.liveFileId(from)) {
      // live: a name event through the scene's Durable Object
      await scenesController.rename(from, String(to ?? "").trim());
      return json(200, { from, to, sha: "", commit: null });
    }
    const result = await driveScenes.rename(from, String(to ?? "").trim());
    afterAgentWrite(header("X-Scenes-Source"));
    return json(200, { from, to, ...result });
  }
  const agentMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/agent-version$/);
  if (agentMatch && method === "GET") {
    const name = decodeURIComponent(agentMatch[1]);
    const liveFile = await liveFileOf(name);
    // live: the agent's last edit as this browser keeps it, until Drive has a newer agent version
    const version = (liveFile ? await scenesController.liveAgentVersion(liveFile) : null) ?? (await driveScenes.agentVersion(name));
    return json(200, { name, version });
  }
  const match = url.pathname.match(/^\/api\/scenes\/(.+)$/);
  if (match) {
    const name = decodeURIComponent(match[1]);
    const liveFile = await liveFileOf(name);
    if (liveFile && method === "GET") {
      // live: the scene as its Durable Object has it now (Drive is up to a minute behind)
      const sha = url.searchParams.get("sha");
      let text: string | null;
      let revision: string;
      if (sha?.startsWith("live-")) {
        text = await scenesController.liveRevision(liveFile, sha);
        revision = sha;
      } else if (sha) {
        const scene = await driveScenes.load(name, sha);
        text = scene.json;
        revision = scene.sha;
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
        return json(404, { error: `Revision ${sha} of "${name}" is not kept in this browser any more` });
      }
      const body = url.searchParams.has("lean") ? JSON.stringify(leanScene(JSON.parse(text))) : text;
      return { status: 200, headers: { "Content-Type": "application/json", "X-Scene-Sha": revision }, body };
    }
    if (liveFile && method === "PUT") {
      const result = await scenesController.liveWrite(liveFile, name, body, header("X-Base-Sha"), header("X-Scenes-Source"));
      return json(200, { name, ...result });
    }
    if (liveFile && method === "DELETE") {
      await scenesController.remove(name);
      return json(200, { name, sha: null });
    }
    if (method === "GET") {
      const scene = await driveScenes.load(name, url.searchParams.get("sha") || undefined);
      // ?lean: without image bytes (the agent's server reads it; this tab keeps the images)
      const body = url.searchParams.has("lean") ? JSON.stringify(leanScene(JSON.parse(scene.json))) : scene.json;
      return { status: 200, headers: { "Content-Type": "application/json", "X-Scene-Sha": scene.sha }, body };
    }
    const baseHeader = header("X-Base-Sha");
    const baseSha = baseHeader === undefined ? undefined : String(baseHeader).trim();
    if (baseSha !== undefined && !/^([0-9a-f]{32}|none)$/.test(baseSha)) {
      return json(400, { error: 'X-Base-Sha must be a version (32 hex characters) or "none"' });
    }
    if (method === "DELETE") {
      const result = await driveScenes.remove(name, baseSha);
      afterAgentWrite(header("X-Scenes-Source"));
      return json(200, { name, ...result });
    }
    if (method === "PUT") {
      const result = await driveScenes.save(name, body, baseSha, header("X-Scenes-Source"));
      afterAgentWrite(header("X-Scenes-Source"));
      return json(200, { name, ...result });
    }
  }
  return json(404, { error: "Not found" });
};

export const serveRequest = async (request: TabRequest): Promise<TabResponse> => {
  try {
    return await route(request);
  } catch (error: any) {
    return json(error.status && error.status >= 400 ? error.status : error.offline ? 503 : 500, {
      error: error.message,
      ...(error.remoteSha !== undefined ? { remoteSha: error.remoteSha } : {}),
      ...(error.offline ? { offline: true } : {}),
      ...(error.exists ? { exists: true } : {}),
    });
  }
};
