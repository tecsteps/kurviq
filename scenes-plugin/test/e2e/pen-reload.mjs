// Reloading a scene one was editing (the pen's holder): the content is there at once (never an empty
// or older canvas) and the pen is this user's again at once, not held by the ghost of their own page.
// The scene is a Drive file in a plain folder of the owner's My Drive, opened at /s/<fileId>/<name>
// (a space of its own, as a scene made with Drive's New or opened with "Open with").
//   1 the holder draws and reloads the page
//   2 the holder goes to their own scenes (another space), opens one, and opens the scene again
//   3 the holder's tab closes and the same user opens the scene in a new tab within a second
//   4 the page before a reload is still at the relay holding the pen (its close not noticed, e.g. a
//     network gone mid-unload): the reloaded page takes its place and its pen at once
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node pen-reload.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `prl${RUN}@example.test`;
const NAME = `Reload ${RUN}`;
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** the content and the pen must be back this soon after the app is up */
const AT_ONCE_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400)}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];
const ctx = await browser.createIncognitoBrowserContext();
const newPage = async (tag) => {
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/editor is gone|JSHandle@error|Failed to load resource|WebSocket/.test(m.text()) && errors.push(`${tag}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return page;
};

/** the app is up: the editor and the controller, nothing loading */
const appUp = async (page) => {
  for (let i = 0; i < 160; i++) {
    if (await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy && !!window.__pen).catch(() => false)) return true; // NOSONAR S9382: polling in order on purpose
    await sleep(100); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};
const probe = (page) =>
  page.evaluate(() => ({
    url: location.pathname,
    current: window.__scenes?.getState().current,
    ids: (window.__scenes?.getApi()?.getSceneElements() ?? []).map((e) => e.id).sort((a, b) => a.localeCompare(b)),
    me: window.__pen?.getView().me,
    holder: window.__pen?.getView().holder?.name ?? null,
    others: window.__pen?.getView().others,
    viewMode: !!window.__scenes?.getApi()?.getAppState().viewModeEnabled,
  })).catch(() => null);

/**
 * After the app is up: the scene shows `want` within AT_ONCE_MS and never anything else afterwards (no
 * empty or older canvas), and this tab holds the pen within AT_ONCE_MS (editable). Watched for 6 s.
 */
const reopened = async (page, want, label) => {
  const upAt = Date.now();
  await appUp(page);
  let contentAt = null;
  let holderAt = null;
  const wrong = [];
  let last = null;
  while (Date.now() - upAt < 6000) {
    last = await probe(page); // NOSONAR S9382: polling in order on purpose
    const at = Date.now() - upAt;
    const right = last?.current === NAME && JSON.stringify(last.ids) === JSON.stringify(want);
    if (right) contentAt ??= at;
    else if (contentAt !== null || at > AT_ONCE_MS) wrong.push({ at, ids: last?.ids, current: last?.current });
    if (last?.me === "holder" && !last.viewMode) holderAt ??= at;
    await sleep(100); // NOSONAR S9382: polling in order on purpose
  }
  ok(contentAt !== null && contentAt <= AT_ONCE_MS && wrong.length === 0, `${label}: the content is there at once, never an empty or older canvas`, { contentAt, wrong: wrong.slice(0, 3), last });
  ok(holderAt !== null && holderAt <= AT_ONCE_MS, `${label}: this user holds the pen again at once (editable)`, { holderAt, me: last?.me, holder: last?.holder, others: last?.others });
  ok(last?.others === 0, `${label}: no ghost of the earlier page at the relay`, { others: last?.others });
};

/** the drawing reached Drive (the file's content has these element ids) */
const savedToDrive = async (page, fileId, want) => {
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {}); // NOSONAR S9382: polling in order on purpose
    const file = await admin(`revisions?fileId=${fileId}&content=1`); // NOSONAR S9382: polling in order on purpose
    const head = (file.revisions ?? file).at(-1);
    const content = typeof head?.content === "string" ? JSON.parse(head.content) : head?.content;
    const ids = (content?.elements ?? []).filter((e) => !e.isDeleted).map((e) => e.id).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(ids) === JSON.stringify(want)) return true;
    await sleep(500); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};

const rect = (id, x) => ({
  id, type: "rectangle", x, y: 120, width: 80, height: 50, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
});
const drawRect = (page, id, x) =>
  page.evaluate((element) => {
    const api = window.__scenes.getApi();
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], captureUpdate: "IMMEDIATELY" });
  }, rect(id, x));

// the owner, signed in, and a scene file in a plain folder of their Drive (granted to the app, as "Open with" does)
const first = await newPage("owner");
await first.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 3 && first.url().includes("/fake-google/oauth/authorize"); i++) {
  await first.goto(first.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(OWNER)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
  await sleep(500); // NOSONAR S9382: in order on purpose
}
for (let i = 0; i < 40 && (await first.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
await appUp(first);
const folder = await admin("write", { email: OWNER, name: `Project ${RUN}`, mimeType: FOLDER_MIME, content: "" });
const scene = { type: "excalidraw", version: 2, source: BASE, elements: [rect("r1", 100)], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
const file = await admin("write", { email: OWNER, name: `${NAME}.excalidraw`, mimeType: "application/vnd.excalidraw+json", content: JSON.stringify(scene), parents: [folder.id ?? folder.fileId], appProperties: { kurviq: "scene", fmt: "1" } });
const fileId = file.id ?? file.fileId;
await admin("grant", { email: OWNER, fileId });
const sceneUrl = `${BASE}/s/${fileId}/${encodeURIComponent(NAME)}`;
/** the scene in its own space (as the scene list opens it), not the shared-scene viewer */
const openScene = async (page) => {
  await page.evaluate((space) => localStorage.setItem("kurviq-space", space), `f:${fileId}`);
  await page.goto(sceneUrl, { waitUntil: "domcontentloaded" });
};
log("scene", fileId);

let page = first;
await openScene(page);
await appUp(page);
let start = null;
for (let i = 0; i < 60 && !(start?.current === NAME && start.me === "holder" && start.ids.length === 1); i++) {
  start = await probe(page); // NOSONAR S9382: polling in order on purpose
  await sleep(250); // NOSONAR S9382: polling in order on purpose
}
ok(start?.current === NAME && start.me === "holder" && start.ids.length === 1, "the scene opens, this tab holds the pen", start);

// 1. draw (saved), draw more (not saved yet), reload
await drawRect(page, "r2", 250);
ok(await savedToDrive(page, fileId, ["r1", "r2"]), "1: the drawing is saved to Drive");
await drawRect(page, "r3", 400);
await sleep(300);
await page.reload({ waitUntil: "domcontentloaded" });
await reopened(page, ["r1", "r2", "r3"], "1 reload");

// 2. to the own scenes (another space: another canvas), then the scene again
ok(await savedToDrive(page, fileId, ["r1", "r2", "r3"]), "2: the drawing is saved to Drive");
await drawRect(page, "r4", 550);
ok(await savedToDrive(page, fileId, ["r1", "r2", "r3", "r4"]), "2: the next drawing is saved to Drive");
await page.evaluate(() => localStorage.removeItem("kurviq-space"));
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await appUp(page);
// a scene of the own space on the canvas (the browser keeps one canvas for all spaces)
await page.evaluate((name) => window.__scenes.create(name), `Other ${RUN}`);
await sleep(1500);
const away = await probe(page);
ok(away?.current === `Other ${RUN}` && away.ids.length === 0, "2: another scene of the own scenes is open (another space)", away);
await openScene(page);
await reopened(page, ["r1", "r2", "r3", "r4"], "2 away and back");

// 3. the tab closes; the same user opens the scene in a new tab within a second
await drawRect(page, "r5", 700);
ok(await savedToDrive(page, fileId, ["r1", "r2", "r3", "r4", "r5"]), "3: the drawing is saved to Drive");
await page.close();
await sleep(300);
page = await newPage("owner-new-tab");
await page.goto(sceneUrl, { waitUntil: "domcontentloaded" }); // the space is still this scene's (the closed tab's)
await reopened(page, ["r1", "r2", "r3", "r4", "r5"], "3 new tab");

// 4. a ghost: a connection of this user's earlier page that the relay still has, holding the pen. It is made
// in another page of the account (a socket that stays open); the reloaded page names it as the page it
// replaces, as a reload does through sessionStorage.
const ghost = await newPage("ghost");
await ghost.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" });
await page.evaluate((space) => localStorage.removeItem(space), "kurviq-space");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); // the holder's page goes: the pen is free
await appUp(page);
const ghostHolds = await ghost.evaluate(async (fileId) => {
  const { ticket } = await (await fetch(`/relay/${encodeURIComponent(fileId)}/ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/relay/${encodeURIComponent(fileId)}/live?ticket=${encodeURIComponent(ticket)}`);
  window.ghostSocket = ws;
  window.ghostStates = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === "welcome") {
      window.ghostId = msg.you;
      ws.send(JSON.stringify({ t: "hello", page: "ghostpage1" }));
      ws.send(JSON.stringify({ t: "claim" }));
    }
    if (msg.t === "state") window.ghostStates.push(msg);
  };
  for (let i = 0; i < 50; i++) {
    if (window.ghostStates.at(-1)?.holder?.id === window.ghostId) return true; // NOSONAR S9382: polling in order on purpose
    await new Promise((resolve) => setTimeout(resolve, 100)); // NOSONAR S9382: polling in order on purpose
  }
  return false;
}, fileId);
ok(ghostHolds, "4: the earlier page's connection (the ghost) holds the pen");
await page.evaluateOnNewDocument(() => {
  if (!sessionStorage.getItem("e2e-ghost-named")) {
    sessionStorage.setItem("e2e-ghost-named", "1");
    sessionStorage.setItem("kurviq-pen-page", "ghostpage1");
  }
});
await openScene(page);
await reopened(page, ["r1", "r2", "r3", "r4", "r5"], "4 ghost of the earlier page");
const ghostGone = await ghost.evaluate(() => window.ghostSocket.readyState);
ok(ghostGone === 3, "4: the relay closed the ghost's connection", { readyState: ghostGone });

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
