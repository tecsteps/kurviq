#!/usr/bin/env node
/**
 * Scenes git server — a tiny local HTTP server that stores Excalidraw scenes
 * as `scenes/<name>.excalidraw` files in a git repository and commits/pushes
 * them using the git credentials already configured on this machine.
 *
 * Config (read from ../.env and ../.env.local next to this folder, then process.env):
 *   SCENES_GIT_REPO      remote URL of the scenes repo (required)
 *   SCENES_GIT_BRANCH    branch to use (default: main)
 *   SCENES_SERVER_PORT   port to listen on (default: 3101)
 *   SCENES_REPO_DIR      local checkout dir (default: scenes-server/.repo)
 *   SCENES_ALLOWED_ORIGIN  more browser origins allowed to use this server,
 *                        comma-separated (always allowed: SCENES_APP_URL,
 *                        localhost and 127.0.0.1 on the app's port)
 *   SCENES_APP_URL       the app's URL (default: http://localhost:3001)
 *
 * Stateless: scene data lives only on GitHub and in the browser
 * (localStorage / IndexedDB). This process keeps no data of its own — the
 * local clone is a transport that is reset to GitHub's state on every commit
 * (safe to delete), and the only things in memory are the open browser
 * connections and the last GitHub reachability check, both rebuilt on restart.
 *
 * No dependencies besides node >= 18 and the git CLI.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSceneName } from "../scenes-mcp/sceneName.mjs";

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

const REPO_URL = env.SCENES_GIT_REPO;
const BRANCH = env.SCENES_GIT_BRANCH || "main";
const PORT = Number(env.SCENES_SERVER_PORT || 3101);
const REPO_DIR = path.resolve(ROOT, env.SCENES_REPO_DIR || "scenes-server/.repo");
const ALLOWED_ORIGINS_EXTRA = String(env.SCENES_ALLOWED_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter((origin) => origin && origin !== "*");
const SCENES_SUBDIR = "scenes";
const EXTENSION = ".excalidraw";
const PULL_INTERVAL_MS = 5000;

if (!REPO_URL) {
  console.error("SCENES_GIT_REPO is not set (put it into .env.local)");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// git helpers
// -----------------------------------------------------------------------------

const git = (args, { cwd = REPO_DIR, allowFail = false, timeout = 0 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error && !allowFail) {
          error.message = `git ${args.join(" ")} failed: ${stderr || error.message}`;
          reject(error);
          return;
        }
        resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });

// serialize all git operations so they never run concurrently
let queue = Promise.resolve();
const serialized = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

// -----------------------------------------------------------------------------
// remote (GitHub) state — everything works offline from the last fetch
// -----------------------------------------------------------------------------

const REMOTE_REF = `origin/${BRANCH}`;
const NETWORK_TIMEOUT_MS = 20000;

/** what the app shows: are we reaching GitHub, when did we last check */
const remoteState = { online: null, lastFetchAt: null, lastError: null };
let repoReady = false;

const ensureRepo = async () => {
  if (repoReady) {
    return true;
  }
  if (!existsSync(path.join(REPO_DIR, ".git"))) {
    await fs.mkdir(path.dirname(REPO_DIR), { recursive: true });
    console.log(`cloning ${REPO_URL} into ${REPO_DIR}`);
    const res = await git(["clone", REPO_URL, REPO_DIR], {
      cwd: ROOT,
      allowFail: true,
      timeout: NETWORK_TIMEOUT_MS * 3,
    });
    if (!res.ok) {
      Object.assign(remoteState, { online: false, lastError: firstLine(res.stderr) });
      await fs.rm(REPO_DIR, { recursive: true, force: true });
      return false;
    }
  }
  repoReady = true;
  return true;
};

const firstLine = (text) => (text || "").split("\n").find(Boolean) || "unknown error";

const fetchRemote = async () => {
  if (!(await ensureRepo())) {
    return false;
  }
  const res = await git(["fetch", "--prune", "origin"], {
    allowFail: true,
    timeout: NETWORK_TIMEOUT_MS,
  });
  if (res.ok) {
    Object.assign(remoteState, { online: true, lastFetchAt: new Date().toISOString(), lastError: null });
  } else {
    Object.assign(remoteState, { online: false, lastError: firstLine(res.stderr) });
  }
  return res.ok;
};

let lastFetch = 0;
const maybeFetch = async (force = false) => {
  if (force || Date.now() - lastFetch > PULL_INTERVAL_MS) {
    lastFetch = Date.now();
    await fetchRemote();
  }
};

const hasRemoteBranch = async () =>
  repoReady &&
  (await git(["rev-parse", "--verify", "--quiet", REMOTE_REF], { allowFail: true })).ok;

/** scene name -> git blob sha, as of the last fetch */
const remoteBlobs = async () => {
  const blobs = new Map();
  if (!(await hasRemoteBranch())) {
    return blobs;
  }
  const res = await git(["ls-tree", REMOTE_REF, `${SCENES_SUBDIR}/`], { allowFail: true });
  for (const line of res.stdout.split("\n")) {
    const match = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
    if (match) {
      const file = path.basename(match[2].replace(/^"|"$/g, ""));
      if (file.endsWith(EXTENSION)) {
        blobs.set(file.slice(0, -EXTENSION.length), match[1]);
      }
    }
  }
  return blobs;
};

// -----------------------------------------------------------------------------
// scenes
// -----------------------------------------------------------------------------


const scenePath = (name) => {
  if (!isSceneName(name)) {
    throw httpError(400, `Invalid scene name: ${name}`);
  }
  return `${SCENES_SUBDIR}/${name}${EXTENSION}`;
};

/** last commit date per scene file, read from git (no cache — git is fast enough) */
const commitDates = async () => {
  const dates = new Map();
  if (!(await hasRemoteBranch())) {
    return dates;
  }
  const log = await git(
    ["log", "--format=%x00%cI", "--name-only", "--no-renames", REMOTE_REF, "--", `${SCENES_SUBDIR}/`],
    { allowFail: true },
  );
  let date = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith("\u0000")) {
      date = line.slice(1);
    } else if (line && date) {
      const file = path.basename(line.replace(/^"|"$/g, ""));
      if (file.endsWith(EXTENSION) && !dates.has(file.slice(0, -EXTENSION.length))) {
        dates.set(file.slice(0, -EXTENSION.length), date);
      }
    }
  }
  return dates;
};

const listScenes = async () => {
  const [blobs, dates] = [await remoteBlobs(), await commitDates()];
  const scenes = [...blobs].map(([name, sha]) => ({ name, sha, updatedAt: dates.get(name) ?? null }));
  scenes.sort((a, b) => a.name.localeCompare(b.name));
  return scenes;
};

/** scene content: latest known remote version, or a specific blob (`sha`) */
const readScene = async (name, sha) => {
  scenePath(name);
  if (!sha) {
    sha = (await remoteBlobs()).get(name);
    if (!sha) {
      throw httpError(404, `Scene not found: ${name}`);
    }
  } else if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw httpError(400, "Invalid sha");
  }
  const res = await git(["cat-file", "-p", sha], { allowFail: true });
  if (!res.ok) {
    throw httpError(404, `Version ${sha} of scene "${name}" not found`);
  }
  return { content: res.stdout, sha };
};

/**
 * The version of a scene an agent committed last (blob sha), read from the
 * git history — agents' change tracking needs no state anywhere else.
 */
const lastAgentVersion = async (name) => {
  const file = scenePath(name);
  if (!(await hasRemoteBranch())) {
    return null;
  }
  // --follow (the scene may have been renamed since) doesn't combine with
  // --grep, so scan the scene's recent history; --name-only gives its file
  // name as of each commit
  const log = await git(
    ["log", "-n", "300", "--follow", "--name-only", "--format=%x01%H%x00%cI%x00%(trailers:key=Scenes-Source,valueonly)", REMOTE_REF, "--", file],
    { allowFail: true },
  );
  const entries = log.stdout.split("\x01").filter(Boolean).map((entry) => {
    const [head, ...rest] = entry.split("\n");
    const [commit, at, source] = head.split("\0");
    const names = [source, ...rest].join("\n").split("\n").map((line) => line.trim()).filter(Boolean);
    return { commit, at, agent: (source || "").trim() === "agent", oldFile: names.find((n) => n.startsWith(`${SCENES_SUBDIR}/`)) };
  });
  const hit = entries.find((entry) => entry.agent);
  if (!hit) {
    return null;
  }
  const { commit, at } = hit;
  const oldFile = hit.oldFile || file;
  const blob = await git(["rev-parse", `${commit}:${oldFile}`], { allowFail: true });
  return blob.ok ? { sha: blob.stdout.trim(), commit, at } : null;
};

/**
 * The versions of a scene, newest first: commit, date, author, message,
 * whether an agent made it, and the scene's blob sha in it (to load it).
 */
const sceneHistory = async (name, limit = 40) => {
  const file = scenePath(name);
  if (!(await hasRemoteBranch())) {
    return [];
  }
  const log = await git(
    ["log", "-n", String(limit), "--follow", "--name-only", "--format=%x01%H%x00%cI%x00%an%x00%s%x00%(trailers:key=Scenes-Source,valueonly)", REMOTE_REF, "--", file],
    { allowFail: true },
  );
  const versions = [];
  for (const entry of log.stdout.split("\x01").filter(Boolean)) {
    const [head, ...rest] = entry.split("\n");
    const [commit, at, author, message, source] = head.split("\0");
    const names = [source, ...rest].join("\n").split("\n").map((line) => line.trim()).filter(Boolean);
    const oldFile = names.find((n) => n.startsWith(`${SCENES_SUBDIR}/`)) || file;
    const blob = await git(["rev-parse", `${commit}:${oldFile}`], { allowFail: true });
    if (blob.ok) {
      versions.push({ commit, at, author, message, agent: (source || "").trim() === "agent", sha: blob.stdout.trim() });
    }
  }
  return versions;
};

/**
 * One commit on top of the latest remote state, pushed right away. The local
 * clone is only a transport: it is reset to GitHub's state before every
 * commit and after every failed push, so it never holds anything GitHub
 * doesn't have (it can be deleted at any time).
 *
 * prepare(blobs) runs against the freshly fetched remote listing, checks
 * preconditions (throws 404/409) and returns { message, write?: {name: content},
 * remove?: [name], move?: [from, to], result(blobs) }.
 * Offline: 503 — the browser keeps the change and retries later.
 */
/** the path itself if it is a symlink (never what it points to) */
const dropSymlink = async (target) => {
  const info = await fs.lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) {
    await fs.unlink(target);
  }
};

/** scenes/ as a real directory of the checkout (not a symlink to elsewhere) */
const realScenesDir = async () => {
  const dir = path.join(REPO_DIR, SCENES_SUBDIR);
  await dropSymlink(dir);
  await fs.mkdir(dir, { recursive: true });
};

const commitToRemote = async (prepare) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await fetchRemote())) {
      throw httpError(503, `GitHub not reachable (${remoteState.lastError})`, { offline: true });
    }
    const plan = prepare(await remoteBlobs());
    if (await hasRemoteBranch()) {
      await git(["checkout", "-B", BRANCH, REMOTE_REF, "--force"]);
      await git(["reset", "--hard", REMOTE_REF]);
    } else {
      await git(["checkout", "-B", BRANCH], { allowFail: true });
    }
    const paths = [];
    for (const [name, content] of Object.entries(plan.write || {})) {
      const rel = scenePath(name);
      await realScenesDir();
      // a symlink committed in place of the scene (by anyone with push access)
      // must not redirect the write outside the checkout: replace the link itself
      await dropSymlink(path.join(REPO_DIR, rel));
      await fs.writeFile(path.join(REPO_DIR, rel), content);
      await git(["add", "--", rel]);
      paths.push(rel);
    }
    if (plan.move) {
      const [fromRel, toRel] = plan.move.map(scenePath);
      await fs.mkdir(path.join(REPO_DIR, SCENES_SUBDIR), { recursive: true });
      await git(["mv", "--", fromRel, toRel]);
      paths.push(fromRel, toRel);
    }
    for (const name of plan.remove || []) {
      const rel = scenePath(name);
      await git(["rm", "--quiet", "--", rel]);
      paths.push(rel);
    }

    const unchanged = (await git(["diff", "--cached", "--quiet", "--", ...paths], { allowFail: true })).ok;
    if (unchanged) {
      return { ...plan.result(await remoteBlobs()), commit: (await git(["rev-parse", "HEAD"], { allowFail: true })).stdout || null, changed: false };
    }
    await git(["commit", "-m", plan.message, "--", ...paths]);
    const push = await git(["push", "-u", "origin", `HEAD:${BRANCH}`], {
      allowFail: true,
      timeout: NETWORK_TIMEOUT_MS,
    });
    if (push.ok) {
      const commit = (await git(["rev-parse", "HEAD"])).stdout;
      await git(["fetch", "origin"], { allowFail: true, timeout: NETWORK_TIMEOUT_MS });
      return { ...plan.result(await remoteBlobs()), commit, changed: true };
    }
    // rejected (someone pushed meanwhile) or network gone: drop our local
    // commit and re-evaluate against the remote
    await git(["reset", "--hard", (await hasRemoteBranch()) ? REMOTE_REF : "HEAD"], { allowFail: true });
    console.warn(`push failed (attempt ${attempt + 1}): ${firstLine(push.stderr)}`);
  }
  throw httpError(409, "Could not push — GitHub keeps changing, try again");
};

/** base check: "none" = must not exist, <sha> = must be exactly that version */
const checkBase = (name, current, baseSha) => {
  if (baseSha !== undefined && (current || "none") !== baseSha) {
    throw httpError(409, `"${name}" was changed on GitHub in the meantime`, {
      remoteSha: current || null,
    });
  }
};

/**
 * Commit & push a scene.
 * baseSha: undefined = overwrite whatever is there (agents);
 *          "none"    = the scene must not exist yet;
 *          <sha>     = the version the caller's copy is based on — if GitHub
 *                      has something else, 409 (the caller has to merge).
 */
const AGENT_TRAILER = "Scenes-Source: agent";
const isAgent = (source) => typeof source === "string" && source.startsWith("agent");

/** commit message; agent commits carry a trailer, so their versions can be found again */
const commitMessage = (text, source) =>
  isAgent(source) ? `Agent: ${text[0].toLowerCase()}${text.slice(1)}\n\n${AGENT_TRAILER}` : text;

const saveScene = async (name, content, baseSha, source) => {
  scenePath(name);
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw httpError(400, "Scene content is not valid JSON");
  }
  // the content names the scene it belongs to (appState.name): a stale tab or
  // a confused writer must not put one scene's drawing under another's name
  const owner = data?.appState?.name;
  if (typeof owner === "string" && owner !== name) {
    throw httpError(
      422, // not 409: that means "GitHub has a newer version" to the app
      `Refused: this content belongs to scene "${owner}", not "${name}". Nothing was written.`,
    );
  }
  return commitToRemote((blobs) => {
    const current = blobs.get(name);
    checkBase(name, current, baseSha);
    return {
      message: commitMessage(`${current ? "Update" : "Add"} scene: ${name}`, source),
      write: { [name]: content },
      result: (after) => ({ sha: after.get(name) ?? null }),
    };
  });
};

/** delete a scene; baseSha (optional): only if GitHub still has that version */
const deleteScene = async (name, baseSha) => {
  scenePath(name);
  return commitToRemote((blobs) => {
    const current = blobs.get(name);
    if (!current) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    checkBase(name, current, baseSha);
    return { message: `Delete scene: ${name}`, remove: [name], result: () => ({ sha: null }) };
  });
};

/**
 * Rename a scene in one commit (git sees a rename, history is kept). The
 * content is moved as it is on GitHub, so its blob sha stays the same.
 */
const renameScene = async (from, to) => {
  scenePath(from);
  scenePath(to);
  if (from === to) {
    throw httpError(400, "New name is the same as the old one");
  }
  return commitToRemote((blobs) => {
    const sha = blobs.get(from);
    if (!sha) {
      throw httpError(404, `Scene not found: ${from}`);
    }
    if (blobs.has(to)) {
      throw httpError(409, `A scene named "${to}" already exists on GitHub`, { exists: true });
    }
    return {
      message: `Rename scene: ${from} → ${to}`,
      move: [from, to],
      result: (after) => ({ sha: after.get(to) ?? sha }),
    };
  });
};

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
  // agentSide: the agent's own Excalidraw (headless), never the user's tabs
  if (command?.agentSide) {
    await ensureRenderer({ dedicated: true });
    return sendCommandTo(rendererTab(), command);
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
    if (url.pathname === "/api/scenes" && req.method === "GET") {
      const scenes = await serialized(async () => {
        await maybeFetch(url.searchParams.has("refresh"));
        return listScenes();
      });
      return send(res, 200, { scenes, remote: remoteState });
    }
    // scenes are written only by the app and the MCP tools — never by
    // scripts calling this API directly (that bypasses merging, change
    // tracking and the user's unpushed work)
    if (
      url.pathname.startsWith("/api/scenes/") &&
      ["PUT", "POST", "DELETE"].includes(req.method) &&
      !["app", "mcp"].includes(String(req.headers["x-scenes-client"] || ""))
    ) {
      return send(res, 403, {
        error:
          "Direct writes to the scenes server are not allowed. Agents: change scenes only with the Excalidraw MCP tools (read_scene / edit_scene, save_scene for new scenes); the app syncs everything with GitHub. If you don't have these tools, your MCP server is outdated: ask the user to restart your session.",
      });
    }
    const renameMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/rename$/);
    if (renameMatch && req.method === "POST") {
      const from = decodeURIComponent(renameMatch[1]);
      const { to } = await readJson(req);
      const result = await serialized(() => renameScene(from, String(to ?? "").trim()));
      broadcast({ type: "scene-renamed", from, to, sha: result.sha, source: req.headers["x-scenes-source"] || "app" });
      return send(res, 200, { from, to, ...result });
    }
    const agentMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/agent-version$/);
    if (agentMatch && req.method === "GET") {
      const name = decodeURIComponent(agentMatch[1]);
      return send(res, 200, { name, version: await serialized(() => lastAgentVersion(name)) });
    }
    const historyMatch = url.pathname.match(/^\/api\/scenes\/(.+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const name = decodeURIComponent(historyMatch[1]);
      const versions = await serialized(async () => {
        await maybeFetch();
        return sceneHistory(name);
      });
      return send(res, 200, { name, versions });
    }
    const match = url.pathname.match(/^\/api\/scenes\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      if (req.method === "GET") {
        const sha = url.searchParams.get("sha");
        const { content, sha: blobSha } = await serialized(async () => {
          if (!sha) {
            await maybeFetch();
          }
          return readScene(name, sha);
        });
        res.setHeader("X-Scene-Sha", blobSha);
        res.setHeader("Access-Control-Expose-Headers", "X-Scene-Sha");
        return send(res, 200, content);
      }
      // X-Base-Sha: <blob sha> | "none" (must be new); absent = no check
      const baseHeader = req.headers["x-base-sha"];
      const baseSha = baseHeader === undefined ? undefined : String(baseHeader).trim();
      if (baseSha !== undefined && !/^([0-9a-f]{40}|none)$/.test(baseSha)) {
        throw httpError(400, 'X-Base-Sha must be a blob sha or "none"');
      }
      if (req.method === "DELETE") {
        const result = await serialized(() => deleteScene(name, baseSha));
        broadcast({ type: "scene-deleted", name, source: req.headers["x-scenes-source"] || "app" });
        return send(res, 200, { name, ...result });
      }
      if (req.method === "PUT") {
        const content = await readBody(req);
        const result = await serialized(() =>
          saveScene(name, content, baseSha, req.headers["x-scenes-source"]),
        );
        broadcast({
          type: "scene-saved",
          name,
          sha: result.sha,
          commit: result.commit,
          changed: result.changed,
          source: req.headers["x-scenes-source"] || "app",
        });
        return send(res, 200, { name, ...result });
      }
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

// never block startup on the network: work from the existing clone / offline
// -----------------------------------------------------------------------------
// watching GitHub: other people's (and other machines') pushes reach the open
// tabs within seconds. While a user tab is connected, the server fetches
// every SCENES_WATCH_INTERVAL_MS (default 60s) and announces the scenes that changed, so the app syncs
// right away instead of waiting for its own slower poll.
// -----------------------------------------------------------------------------

const WATCH_INTERVAL_MS = Number(env.SCENES_WATCH_INTERVAL_MS || 60000);
let watchedHead = null;

const remoteHead = async () =>
  (await git(["rev-parse", "--verify", "--quiet", REMOTE_REF], { allowFail: true })).stdout || null;

const sceneOf = (file) =>
  file.startsWith(`${SCENES_SUBDIR}/`) && file.endsWith(EXTENSION) ? path.basename(file, EXTENSION) : null;

const watchRemote = async () => {
  if (!userTabCount()) {
    return;
  }
  const events = await serialized(async () => {
    const before = watchedHead ?? (await remoteHead());
    lastFetch = Date.now();
    if (!(await fetchRemote())) {
      return [];
    }
    const after = await remoteHead();
    watchedHead = after;
    if (!before || !after || before === after) {
      return [];
    }
    const diff = await git(["diff", "-z", "--name-status", "-M", before, after, "--", `${SCENES_SUBDIR}/`], {
      allowFail: true,
    });
    const parts = diff.stdout.split("\0").filter(Boolean);
    const found = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++];
      if (status.startsWith("R")) {
        const [from, to] = [sceneOf(parts[i++]), sceneOf(parts[i++])];
        if (from && to) {
          found.push({ type: "scene-renamed", from, to, sha: null, source: "remote" });
        }
      } else {
        const name = sceneOf(parts[i++]);
        if (name) {
          found.push({ type: status === "D" ? "scene-deleted" : "scene-saved", name, source: "remote" });
        }
      }
    }
    return found;
  });
  events.forEach(broadcast);
};

setInterval(() => watchRemote().catch(() => {}), WATCH_INTERVAL_MS);

serialized(() => fetchRemote()).then((ok) =>
  console.log(ok ? "GitHub reachable" : `GitHub not reachable: ${remoteState.lastError}`),
);

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `scenes server listening on http://localhost:${PORT} (repo: ${REPO_URL}, branch: ${BRANCH})`,
  );
});
