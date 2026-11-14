// The editor keeps one canvas for every space in the browser (the own scenes, each shared scene). A
// space never takes another space's canvas for one of its scenes: the own untitled draft never shows
// a shared scene's content, a shared scene never shows the own draft, and the draft is not lost.
//   1 the own untitled draft has content; the shared scene opens straight in its space (a typed link,
//     another tab: nothing stored the draft on leaving): it shows its own content
//   2 back to the own scenes the same way: the draft shows its own content, not the shared scene's
//   3 both ways again through the app's own switch (it stores the scene it leaves)
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node space-canvas.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `spc${RUN}@example.test`;
const NAME = `Shared canvas ${RUN}`;
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
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
page.on("dialog", (d) => d.accept().catch(() => {}));

const probe = () =>
  page.evaluate(() => ({
    space: localStorage.getItem("kurviq-space"),
    current: window.__scenes?.getState().current ?? null,
    busy: window.__scenes?.getApi() ? window.__scenes.getState().busy : "starting",
    ids: (window.__scenes?.getApi()?.getSceneElements() ?? []).map((e) => e.id).sort((a, b) => a.localeCompare(b)),
  })).catch(() => null);

/** the app is up with `current` open showing exactly `want`, and stays so for 3 s (no other canvas afterwards) */
const shows = async (current, want, label) => {
  let last = null;
  let since = null;
  const wrong = [];
  for (let i = 0; i < 120; i++) {
    last = await probe(); // NOSONAR S9382: polling in order on purpose
    const right = last && !last.busy && last.current === current && JSON.stringify(last.ids) === JSON.stringify(want);
    if (right) since ??= Date.now();
    else if (since !== null) wrong.push(last);
    if (since !== null && Date.now() - since > 3000) break;
    await sleep(100); // NOSONAR S9382: polling in order on purpose
  }
  ok(since !== null && wrong.length === 0, label, { last, wrong: wrong.slice(0, 2) });
};

const rect = (id, x) => ({
  id, type: "rectangle", x, y: 120, width: 80, height: 50, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
});
const draw = async (id, x) => {
  await page.evaluate((element) => {
    const api = window.__scenes.getApi();
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], captureUpdate: "IMMEDIATELY" });
  }, rect(id, x));
  await sleep(1000); // the editor stores its canvas (debounced)
};

/** the drawing reached Drive (the file's content has these element ids) */
const savedToDrive = async (fileId, want) => {
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

// signed in, with a scene shared with the user (a Drive file granted to the app, as "Open with" does)
await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(OWNER)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
  await sleep(500); // NOSONAR S9382: in order on purpose
}
for (let i = 0; i < 40 && (await page.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
const scene = { type: "excalidraw", version: 2, source: BASE, elements: [rect("s1", 100)], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
const file = await admin("write", { email: OWNER, name: `${NAME}.excalidraw`, mimeType: "application/vnd.excalidraw+json", content: JSON.stringify(scene), appProperties: { kurviq: "scene", fmt: "1" } });
const fileId = file.id ?? file.fileId;
await admin("grant", { email: OWNER, fileId });
const sceneUrl = `${BASE}/s/${fileId}/${encodeURIComponent(NAME)}`;
log("scene", fileId);

/** straight into a space, as a typed link or another tab does (nothing stores the scene left) */
const goShared = async () => {
  await page.evaluate((space) => localStorage.setItem("kurviq-space", space), `f:${fileId}`);
  await page.goto(sceneUrl, { waitUntil: "domcontentloaded" });
};
const goOwn = async () => {
  await page.evaluate(() => localStorage.removeItem("kurviq-space"));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
};
/** the app's own switch: the scene it leaves is stored, the canvas cleared (as enterSpace's callers do) */
const leave = () => page.evaluate(() => window.__scenes.leaveForReload());

// 1. the own untitled draft has content; the shared scene straight in its space
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await shows(null, [], "the own scenes start with an empty untitled draft");
await draw("mine1", 300);
const record = await page.evaluate(() => JSON.parse(localStorage.getItem("kurviq-canvas-owner") ?? "null"));
ok(record?.space === `a:${OWNER}` && record.scene === null, "the canvas is recorded as the own space's draft", record);
await goShared();
await shows(NAME, ["s1"], "1: the shared scene shows its own content, not the own draft");

// 2. back to the own scenes the same way
await draw("shared2", 450);
// (a page left this way stores nothing: what it drew is kept in Drive)
ok(await savedToDrive(fileId, ["s1", "shared2"]), "2: the shared scene's drawing is saved to Drive");
await goOwn();
await shows(null, ["mine1"], "2: the own draft shows its own content, not the shared scene's");
ok((await page.evaluate(() => window.__scenes.getState().list.map((item) => item.name))).every((name) => name !== NAME), "2: the shared scene is not among the own scenes");

// 3. both ways through the app's own switch
await draw("mine2", 600);
await leave();
await goShared();
await shows(NAME, ["s1", "shared2"], "3: the shared scene again, with what was drawn in it");
await draw("shared3", 750);
await leave();
await goOwn();
await shows(null, ["mine1", "mine2"], "3: the own draft again, with all that was drawn in it");

// and a reload keeps the draft (the canvas is the own draft's)
await page.reload({ waitUntil: "domcontentloaded" });
await shows(null, ["mine1", "mine2"], "a reload keeps the own draft");

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
