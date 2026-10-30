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
 * Stateless: it keeps no data — only the open browser connections and the
 * commands waiting for their answer, in memory.
 *
 * No dependencies besides node >= 18.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const loadEnvFile = (file) => {
  if (!existsSync(file)) {
    return {};
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
};

const env = {
  ...loadEnvFile(path.join(ROOT, ".env")),
  ...loadEnvFile(path.join(ROOT, ".env.local")),
  ...process.env,
};

const PORT = Number(env.SCENES_SERVER_PORT || 3101);
const ALLOWED_ORIGINS_EXTRA = String(env.SCENES_ALLOWED_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter((origin) => origin && origin !== "*");


const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

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
const COMMAND_TIMEOUT_MS = 30000;

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
    return [state.visible ? 1 : 0, state.focusedAt || 0, clients.get(tabId).connectedAt];
  };
  const pick = (role, onlyScene) => {
    let best = null;
    for (const [tabId, client] of clients) {
      if ((client.role === "renderer") !== (role === "renderer")) {
        continue;
      }
      if (onlyScene !== undefined && (tabStates.get(tabId)?.current ?? null) !== onlyScene) {
        continue;
      }
      if (!best) {
        best = tabId;
        continue;
      }
      const [a, b] = [rank(tabId), rank(best)];
      if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0) {
        best = tabId;
      }
    }
    return best;
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

let renderer = null; // { proc, ready: Promise }

const waitFor = async (predicate, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

/** dedicated: the agent's own headless tab is needed even if user tabs are open */
const rendererTab = () => {
  for (const [tabId, client] of clients) {
    if (client.role === "renderer") {
      return tabId;
    }
  }
  return null;
};

const ensureRenderer = async ({ dedicated = false } = {}) => {
  if (dedicated ? rendererTab() : activeTabId({ allowRenderer: true })) {
    return;
  }
  if (!renderer) {
    const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!chrome) {
      const error = new Error(
        "No browser tab is open and no Chrome found for headless rendering (set CHROME_PATH)",
      );
      error.status = 409;
      throw error;
    }
    // throwaway browser profile: nothing the renderer stores survives it
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-scenes-renderer-"));
    const proc = spawn(
      chrome,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1600,1200",
        `${APP_URL}/?scenes-renderer`,
      ],
      { stdio: "ignore" },
    );
    console.log(`started headless renderer (${chrome})`);
    renderer = { proc, profile };
    proc.on("exit", () => {
      renderer = null;
      rmSync(profile, { recursive: true, force: true });
    });
  }
  const ok = await waitFor(
    () => (dedicated ? rendererTab() : activeTabId({ allowRenderer: true })),
    30000,
  );
  if (!ok) {
    const error = new Error(
      `Headless renderer did not connect — is the app running at ${APP_URL}?`,
    );
    error.status = 504;
    throw error;
  }
};

// -----------------------------------------------------------------------------
// PDF: slides arrive as one HTML page of SVGs (real text, embedded fonts) and
// are printed by headless Chrome, so the PDF keeps text as text
// -----------------------------------------------------------------------------

/** what the printed page may do: nothing but show its inline content */
const PDF_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">`;
/** how the app's export starts: the policy is in force before any content (not merely somewhere in the text) */
const PDF_START = `<!doctype html>\n<html><head><meta charset="utf-8">\n${PDF_CSP}\n`;

const printPdf = async (html) => {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) {
    const error = new Error("No Chrome found to print the PDF (set CHROME_PATH)");
    error.status = 409;
    throw error;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-scenes-pdf-"));
  try {
    const page = path.join(dir, "slides.html");
    const out = path.join(dir, "slides.pdf");
    await fs.writeFile(page, html);
    await new Promise((resolve, reject) =>
      execFile(
        chrome,
        [
          "--headless=new",
          `--user-data-dir=${path.join(dir, "profile")}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--no-pdf-header-footer",
          // the page is only printed: no scripts, no network (on top of its CSP)
          "--blink-settings=scriptEnabled=false",
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--virtual-time-budget=15000",
          `--print-to-pdf=${out}`,
          `file://${page}`,
        ],
        { timeout: 120000 },
        (error) => (error && !existsSync(out) ? reject(error) : resolve()),
      ),
    );
    return await fs.readFile(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const stopRenderer = () => {
  if (renderer) {
    renderer.proc.kill();
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

/** run a command in the active app tab (render/convert: any tab, or a headless one) */
const sendCommand = async (command) => {
  // no headless Excalidraw for the agent's own work: it needs the user's
  // Google sign-in to save, so it runs in the user's tab too (as online)
  if (command) {
    delete command.agentSide;
  }
  const allowRenderer = RENDERER_COMMANDS.has(command?.type);
  if (allowRenderer) {
    await ensureRenderer();
  }
  const tab = activeTabId({
    allowRenderer,
    ...(command?.targetScene !== undefined ? { scene: command.targetScene } : {}),
  });
  if (!tab) {
    const error = new Error(
      `The Excalidraw app is not open in a browser — open ${APP_URL}`,
    );
    error.status = 409;
    throw error;
  }
  return sendCommandTo(tab, command);
};

const sendCommandTo = (tab, command, timeoutMs = COMMAND_TIMEOUT_MS) => {
  const id = String(++commandSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error("The Excalidraw app did not answer in time");
      error.status = 504;
      reject(error);
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
    const err = new Error(error || "Command failed in app");
    err.status = 422;
    entry.reject(err);
  }
  return true;
};

const readJson = async (req) => {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
};

// -----------------------------------------------------------------------------
// http
// -----------------------------------------------------------------------------

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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
  const hosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
  try {
    hosts.add(new URL(env.SCENES_SERVER_URL || "").host);
  } catch {}
  return hosts;
};

/** the CORS origin to answer with: the request's own, if allowed */
const corsOrigin = (res) => res.kqCorsOrigin || "null";

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": corsOrigin(res),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Scenes-Source, X-Scenes-Client, X-Base-Sha",
    "Access-Control-Expose-Headers": "X-Scene-Sha",
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.kqCorsOrigin = req.headers.origin && allowedOrigins().has(req.headers.origin) ? req.headers.origin : null;
  try {
    const refused = refuse(req);
    if (refused) {
      return send(res, 403, { error: `Forbidden: ${refused}` });
    }
    if (req.method === "OPTIONS") {
      return send(res, 204, "");
    }
    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": corsOrigin(res),
        Vary: "Origin",
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
      return;
    }
    if (url.pathname === "/api/app/state") {
      if (req.method === "POST") {
        const { tab, ...state } = await readJson(req);
        if (tab) {
          tabStates.set(tab, { ...state, at: new Date().toISOString() });
        }
        return send(res, 200, { ok: true });
      }
      return send(res, 200, appState());
    }
    if (url.pathname === "/api/app/flush" && req.method === "POST") {
      // before an agent reads/edits a scene: the user's tabs push their
      // unpushed changes of it (sync only — nothing in the user's UI changes)
      const { name } = await readJson(req);
      const showing = [...clients.entries()]
        .filter(([tabId, client]) => client.role !== "renderer" && tabStates.get(tabId)?.current === name)
        .map(([tabId]) => tabId);
      // tabs of one browser share their stored scenes: one tab is enough for the rest
      const targets = showing.length ? showing : [activeTabId()].filter(Boolean);
      const results = [];
      for (const tabId of targets) {
        try {
          results.push(await sendCommandTo(tabId, { type: "flush", name }, 15000));
        } catch (error) {
          results.push({ error: error.message });
        }
      }
      return send(res, 200, { tabs: targets.length, results });
    }
    if (url.pathname === "/api/app/command" && req.method === "POST") {
      const command = await readJson(req);
      const result = await sendCommand(command);
      return send(res, 200, { ok: true, result });
    }
    if (url.pathname === "/api/pdf" && req.method === "POST") {
      // JSON body: cross-site pages can't send it without CORS approval
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
        return send(res, 415, { error: "Send JSON" });
      }
      const { html } = await readJson(req);
      // the page must forbid scripts and network (CSP set by the app's export)
      if (typeof html !== "string" || !html.startsWith(PDF_START)) {
        return send(res, 400, { error: "Expected { html }" });
      }
      const pdf = await printPdf(html);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": pdf.length,
        "Access-Control-Allow-Origin": corsOrigin(res),
        Vary: "Origin",
      });
      return res.end(pdf);
    }
    const resultMatch = url.pathname.match(/^\/api\/app\/result\/(\w+)$/);
    if (resultMatch && req.method === "POST") {
      const settled = settleCommand(resultMatch[1], await readJson(req));
      return send(res, 200, { ok: settled });
    }
    if (url.pathname === "/api/scenes" || url.pathname.startsWith("/api/scenes/")) {
      // scenes are written only by the app and the MCP tools — never by
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
        throw httpError(409, `Kurviq is not open in a browser — open ${APP_URL}`);
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
      res.writeHead(answer?.status ?? 500, {
        "Content-Type": "application/json",
        ...(answer?.headers ?? {}),
        "Access-Control-Allow-Origin": corsOrigin(res),
        "Access-Control-Expose-Headers": "X-Scene-Sha",
        Vary: "Origin",
      });
      return res.end(answer?.body ?? "");
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error.message);
    return send(res, error.status || 500, {
      error: error.message,
      ...(error.remoteSha !== undefined ? { remoteSha: error.remoteSha } : {}),
      ...(error.offline ? { offline: true } : {}),
      ...(error.exists ? { exists: true } : {}),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `scenes server listening on http://localhost:${PORT} (scenes: the open Kurviq tab, Google Drive)`,
  );
});
