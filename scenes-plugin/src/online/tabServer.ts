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
    const result = await driveScenes.rename(from, String(to ?? "").trim());
    afterAgentWrite(header("X-Scenes-Source"));
    return json(200, { from, to, ...result });
  }
  const agentMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/agent-version$/);
  if (agentMatch && method === "GET") {
    const name = decodeURIComponent(agentMatch[1]);
    return json(200, { name, version: await driveScenes.agentVersion(name) });
  }
  const match = url.pathname.match(/^\/api\/scenes\/(.+)$/);
  if (match) {
    const name = decodeURIComponent(match[1]);
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
