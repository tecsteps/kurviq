#!/usr/bin/env node
/**
 * Kurviq's local scenes server: serves the agent side of the local install.
 * Scenes live in the user's browser and in their Google Drive; the browser
 * tab saves them there itself (with the user's Google sign-in). This server
 * only relays: the MCP server's requests (/api/scenes…, agent commands) go
 * to the open Kurviq tab, which answers them, the same way kurviq.com's
 * pairing does (online/worker/pairing.ts). It also prints PDFs with a
 * headless Chrome, and renders pictures there when no tab is open.
 *
 * Config (read from ../.env and ../.env.local next to this folder, then process.env):
 *   SCENES_SERVER_PORT   port to listen on (default: 3101)
 *   SCENES_ALLOWED_ORIGIN  more browser origins allowed to use this server,
 *                        comma-separated (always allowed: SCENES_APP_URL,
 *                        localhost and 127.0.0.1 on the app's port)
 *   SCENES_APP_URL       the app's URL (default: http://localhost:3001)
 *
 * Stateless: it keeps no data, only the open browser connections and the
 * commands waiting for their answer, in memory.
 *
 * No dependencies besides node >= 18.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { loadEnv } from "../scripts/env.mjs";
import { bestTab, commandTimeout, FLUSH_TIMEOUT_MS } from "../scenes-mcp/tabRelay.mjs";

import { httpError, pdfHtmlProblem, printPdf } from "./pdf.mjs";

const env = loadEnv();

const PORT = Number(env.SCENES_SERVER_PORT || 3101);
const ALLOWED_ORIGINS_EXTRA = String(env.SCENES_ALLOWED_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter((origin) => origin && origin !== "*");

/** a request body larger than this is refused (413): generous, only a runaway caller gets there */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// -----------------------------------------------------------------------------
// live channel to the browser app (lets agents drive the open editor)
// -----------------------------------------------------------------------------

/** connected browser tabs (Server-Sent Events): tabId -> { res, connectedAt } */
const clients = new Map();
/** last state reported per tab: tabId -> { current, dirty, visible, focusedAt, at } */
const tabStates = new Map();
/** commands sent to the app, awaiting its result */
const pending = new Map();
let commandSeq = 0;

const broadcast = (event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const { res } of clients.values()) {
    res.write(payload);
  }
};

/**
 * commands a hidden renderer tab may serve when no user tab is open (they
 * don't touch the user's editor; checkpoints are agent drafts kept in the
 * browser's IndexedDB)
 */
const RENDERER_COMMANDS = new Set(["render", "convert", "checkpoint-save", "checkpoint-load"]);

/**
 * The tab agents talk to: the most recently focused visible user tab.
 * Hidden renderer tabs are only used for render/convert when no user tab is open.
 */
const activeTabId = ({ allowRenderer = false, scene } = {}) => {
  const rank = (tabId) => {
    const state = tabStates.get(tabId) || {};
    return { visible: state.visible, focusedAt: state.focusedAt, connectedAt: clients.get(tabId).connectedAt };
  };
  const pick = (role, onlyScene) => {
    const candidates = [...clients]
      .filter(([, client]) => (client.role === "renderer") === (role === "renderer"))
      .filter(([tabId]) => onlyScene === undefined || (tabStates.get(tabId)?.current ?? null) === onlyScene)
      .map(([tabId]) => tabId);
    return bestTab(candidates, rank);
  };
  // an agent working on a specific scene talks to the tab that shows it
  if (scene !== undefined) {
    const tab = pick("user", scene);
    if (tab) {
      return tab;
    }
  }
  return pick("user") || (allowRenderer ? pick("renderer") : null);
};

const userTabCount = () =>
  [...clients.values()].filter((client) => client.role !== "renderer").length;

const appState = () => {
  const tab = activeTabId();
  return {
    connected: !!tab,
    tabs: userTabCount(),
    activeTab: tab,
    ...(tab ? tabStates.get(tab) : { current: null, dirty: false }),
  };
};

// -----------------------------------------------------------------------------
// hidden renderer: a headless Chrome tab of the app, started on demand so
// agents can render/convert scenes even when nobody has the app open
// -----------------------------------------------------------------------------

const APP_URL = (env.SCENES_APP_URL || `http://localhost:${env.VITE_APP_PORT || 3001}`).replace(/\/$/, "");
const CHROME_CANDIDATES = [
  env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

/** the headless Chrome started for rendering: { proc, profile, started: Promise }, or null */
let renderer = null;

const findChrome = () => CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

const waitFor = async (predicate, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250)); // NOSONAR S9382: in order on purpose (polling waits for the preceding observation)
  }
  return false;
};

/**
 * Starts the renderer. The entry is returned (and stored by the caller)
 * before anything is awaited, so two commands arriving together share one
 * Chrome instead of starting two and losing track of the first.
 */
const launchRenderer = (chrome) => {
  const entry = { proc: null, profile: null, started: null };
  entry.started = (async () => {
    // throwaway browser profile: nothing the renderer stores survives it
    entry.profile = await fs.mkdtemp(path.join(os.tmpdir(), "kurviq-renderer-"));
    entry.proc = spawn(
      chrome,
      [
        "--headless=new",
        `--user-data-dir=${entry.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1600,1200",
        `${APP_URL}/?scenes-renderer`,
      ],
      { stdio: "ignore" },
    );
    console.log(`started headless renderer (${chrome})`);
    entry.proc.on("exit", () => {
      // a later renderer may have replaced this one already: leave it alone
      if (renderer === entry) {
        renderer = null;
      }
      rmSync(entry.profile, { recursive: true, force: true });
    });
  })().catch((error) => {
    if (renderer === entry) {
      renderer = null;
    }
    throw error;
  });
  return entry;
};

const ensureRenderer = async () => {
  if (activeTabId({ allowRenderer: true })) {
    return;
  }
  if (!renderer) {
    const chrome = findChrome();
    if (!chrome) {
      throw httpError(409, "No browser tab is open and no Chrome found for headless rendering (set CHROME_PATH)");
    }
    renderer = launchRenderer(chrome);
  }
  await renderer.started;
  if (!(await waitFor(() => activeTabId({ allowRenderer: true }), 30000))) {
    throw httpError(504, `Headless renderer did not connect. Is the app running at ${APP_URL}?`);
  }
};

const stopRenderer = () => {
  renderer?.proc?.kill();
  if (renderer?.profile) {
    rmSync(renderer.profile, { recursive: true, force: true });
  }
};
process.on("exit", stopRenderer);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopRenderer();
    process.exit(0);
  });
}

const notOpen = () => `Kurviq is not open in a browser: open ${APP_URL}`;

/** run a command in the active app tab (render/convert: any tab, or a headless one) */
const sendCommand = async (command) => {
  // no headless Excalidraw for the agent's own work: it needs the user's
  // Google sign-in to save, so it runs in the user's tab too (as online)
  // (a render of a saved scene by name reads it in the tab: only a user tab has the user's scenes)
  const allowRenderer = RENDERER_COMMANDS.has(command?.type) && command?.sceneName === undefined;
  if (allowRenderer) {
    await ensureRenderer();
  }
  const tab = activeTabId({
    allowRenderer,
    ...(command?.targetScene !== undefined ? { scene: command.targetScene } : {}),
  });
  if (!tab) {
    throw httpError(409, notOpen());
  }
  return sendCommandTo(tab, command);
};

const sendCommandTo = (tab, command, timeoutMs = commandTimeout(command?.type)) => {
  const id = String(++commandSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(httpError(504, `Kurviq did not answer within ${Math.round(timeoutMs / 1000)} s (${command?.type || "command"})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    clients
      .get(tab)
      .res.write(`data: ${JSON.stringify({ type: "command", id, command })}\n\n`);
  });
};

const settleCommand = (id, { ok, result, error }) => {
  const entry = pending.get(id);
  if (!entry) {
    return false;
  }
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) {
    entry.resolve(result);
  } else {
    entry.reject(httpError(422, error || "Command failed in app"));
  }
  return true;
};

const readJson = async (req) => {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    throw error.status ? error : httpError(400, "Invalid JSON body");
  }
};

// -----------------------------------------------------------------------------
// http
// -----------------------------------------------------------------------------

const tooLarge = () => httpError(413, `Request body too large (at most ${MAX_BODY_BYTES / 1024 / 1024} MB)`);

/** the request body as text, at most MAX_BODY_BYTES (413 beyond; the rest is not kept) */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(tooLarge());
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** browser origins allowed to use this server: the app (any name it runs under locally) */
const allowedOrigins = () => {
  const port = env.VITE_APP_PORT || 3001;
  return new Set([APP_URL, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...ALLOWED_ORIGINS_EXTRA]);
};

/** host names this server answers to (anything else: DNS rebinding) */
const allowedHosts = () => {
  const hosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  try {
    hosts.add(new URL(env.SCENES_SERVER_URL || "").host);
  } catch {}
  return hosts;
};

/**
 * CORS headers: the request's own origin, if allowed. A disallowed origin
 * gets no Access-Control-Allow-Origin at all ("null" would approve sandboxed
 * iframes, whose origin is "null").
 */
const corsHeaders = (res) =>
  res.kqCorsOrigin
    ? { "Access-Control-Allow-Origin": res.kqCorsOrigin, Vary: "Origin" } // NOSONAR S8348: kqCorsOrigin is set only after an exact allowedOrigins membership check
    : { Vary: "Origin" };

/** the scene version headers the tab answers with (X-Scene-Sha: pre-rename name, remove after 2027-02) */
const SCENE_VERSION_HEADERS = "X-Scene-Md5, X-Scene-Sha";

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { // NOSONAR S8348: corsHeaders reflects Origin only after an exact allowedOrigins membership check
    "Content-Type": type,
    ...corsHeaders(res),
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    // X-Base-Sha / X-Scene-Sha: pre-rename names (older tabs and MCP servers); remove after 2027-02
    "Access-Control-Allow-Headers": "Content-Type, X-Scenes-Source, X-Scenes-Client, X-Base-Md5, X-Base-Sha",
    "Access-Control-Expose-Headers": SCENE_VERSION_HEADERS,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/**
 * Only the app and local tools (the MCP server, scripts: no Origin header)
 * may use this server. Websites the user visits may not: they get no CORS
 * approval, their requests are refused, and DNS rebinding fails the Host check.
 */
const refuse = (req) => {
  if (!allowedHosts().has(String(req.headers.host || "").toLowerCase())) {
    return "unknown host";
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins().has(origin)) {
    return "origin not allowed";
  }
  // no Origin is fine for local tools, which send no Fetch Metadata either; a
  // browser leaves out Origin on no-cors GETs (<img>, <script>) of other
  // sites, and marks them with Sec-Fetch-Site
  if (origin === undefined && ["cross-site", "same-site"].includes(String(req.headers["sec-fetch-site"]))) {
    return "cross-site request";
  }
  // a body is always JSON (a cross-site form or text/plain request can't be)
  if (
    (req.method === "POST" || req.method === "PUT") &&
    Number(req.headers["content-length"] || 0) > 0 &&
    !String(req.headers["content-type"] || "").startsWith("application/json")
  ) {
    return "send JSON";
  }
  return null;
};

const serveEvents = async (req, res, url) => {
  res.writeHead(200, { // NOSONAR S8348: corsHeaders reflects Origin only after an exact allowedOrigins membership check
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders(res),
  });
  res.write(": connected\n\n");
  const tabId = url.searchParams.get("tab") || `anon-${Date.now()}`;
  clients.set(tabId, {
    res,
    connectedAt: Date.now(),
    role: url.searchParams.get("role") === "renderer" ? "renderer" : "user",
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    if (clients.get(tabId)?.res === res) {
      clients.delete(tabId);
      tabStates.delete(tabId);
    }
  });
};

const flushTabs = async (req, res) => {
  // before an agent reads/edits a scene: the user's tabs push their
  // unpushed changes of it (sync only; nothing in the user's UI changes)
  const { name } = await readJson(req);
  const showing = [...clients.entries()]
    .filter(([tabId, client]) => client.role !== "renderer" && tabStates.get(tabId)?.current === name)
    .map(([tabId]) => tabId);
  // tabs of one browser share their stored scenes: one tab is enough for the rest
  const targets = showing.length ? showing : [activeTabId()].filter(Boolean);
  const results = [];
  for (const tabId of targets) {
    try {
      results.push(await sendCommandTo(tabId, { type: "flush", name }, FLUSH_TIMEOUT_MS)); // NOSONAR S9382: in order on purpose (preserves event, queue and side effect order)
    } catch (error) {
      results.push({ error: error.message });
    }
  }
  return send(res, 200, { tabs: targets.length, results });
};

const servePdf = async (req, res) => {
  // JSON body: cross-site pages can't send it without CORS approval
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return send(res, 415, { error: "Send JSON" });
  }
  const { html } = await readJson(req);
  // the page must forbid scripts and network (CSP set by the app's export)
  const problem = pdfHtmlProblem(html);
  if (problem) {
    return send(res, 400, { error: problem });
  }
  const pdf = await printPdf(html, findChrome());
  res.writeHead(200, { // NOSONAR S8348: corsHeaders reflects Origin only after an exact allowedOrigins membership check
    "Content-Type": "application/pdf",
    "Content-Length": pdf.length,
    ...corsHeaders(res),
  });
  return res.end(pdf);
};

const relayScene = async (req, res, url) => {
  // scenes are written only by the app and the MCP tools, never by
  // scripts calling this API directly (that bypasses merging, change
  // tracking and the user's unsaved work)
  if (
    ["PUT", "POST", "DELETE"].includes(req.method) &&
    !["app", "mcp"].includes(String(req.headers["x-scenes-client"] || ""))
  ) {
    return send(res, 403, {
      error:
        "Direct writes to the scenes server are not allowed. Agents: change scenes only with the Kurviq MCP tools (read_scene / edit_scene, save_scene for new scenes); the app syncs everything with Google Drive. If you don't have these tools, your MCP server is outdated: ask the user to restart your session.",
    });
  }
  // the open tab answers (it reads and saves with the user's Google sign-in)
  const tab = activeTabId();
  if (!tab) {
    throw httpError(409, notOpen());
  }
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith("x-") || key === "content-type") {
      headers[key] = String(value);
    }
  }
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
  const answer = await sendCommandTo(tab, {
    type: "http",
    request: { method: req.method, path: url.pathname + url.search, headers, body },
  });
  if (answer?.status >= 200 && answer.status < 300 && req.method !== "GET") {
    // the other tabs sync right away
    broadcast({ type: "scene-saved", source: "agent" });
  }
  res.writeHead(answer?.status ?? 500, { // NOSONAR S8348: corsHeaders reflects Origin only after an exact allowedOrigins membership check
    "Content-Type": "application/json",
    ...answer?.headers,
    ...corsHeaders(res),
    "Access-Control-Expose-Headers": SCENE_VERSION_HEADERS,
  });
  return res.end(answer?.body ?? "");
};

const serveAppState = async (req, res) => {
  if (req.method === "POST") {
    const { tab, ...state } = await readJson(req);
    if (tab) {
      tabStates.set(tab, { ...state, at: new Date().toISOString() });
    }
    return send(res, 200, { ok: true });
  }
  return send(res, 200, appState());
};

const sendError = (res, error) => {
  console.error(error.message);
  return send(res, error.status || 500, { error: error.message });
};

const handleRequest = async (req, res, url) => {
  const refused = refuse(req);
  if (refused) {
    return send(res, 403, { error: `Forbidden: ${refused}` });
  }
  if (req.method === "OPTIONS") {
    return send(res, 204, "");
  }
  if (url.pathname === "/api/events" && req.method === "GET") {
    return await serveEvents(req, res, url);
  }
  if (url.pathname === "/api/app/state") {
    return await serveAppState(req, res);
  }
  if (url.pathname === "/api/app/flush" && req.method === "POST") {
    return await flushTabs(req, res);
  }
  if (url.pathname === "/api/app/command" && req.method === "POST") {
    const command = await readJson(req);
    const result = await sendCommand(command);
    return send(res, 200, { ok: true, result });
  }
  if (url.pathname === "/api/pdf" && req.method === "POST") {
    return await servePdf(req, res);
  }
  const resultMatch = /^\/api\/app\/result\/(\w+)$/.exec(url.pathname);
  if (resultMatch && req.method === "POST") {
    const settled = settleCommand(resultMatch[1], await readJson(req));
    return send(res, 200, { ok: settled });
  }
  if (url.pathname === "/api/scenes" || url.pathname.startsWith("/api/scenes/")) {
    return await relayScene(req, res, url);
  }
  return send(res, 404, { error: "Not found" });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.kqCorsOrigin = req.headers.origin && allowedOrigins().has(req.headers.origin) ? req.headers.origin : null;
  try {
    return await handleRequest(req, res, url);
  } catch (error) {
    if (error.status === 413) {
      // the rest of an oversized body is not read: close the connection once refused
      res.on("finish", () => req.destroy());
    }
    return sendError(res, error);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `scenes server listening on http://localhost:${PORT} (scenes: the open Kurviq tab, Google Drive)`,
  );
});
