// A scene link opened while signed out, then again after signing in (scenes-plugin/src/controller.ts onlyAName):
//   1 signed out, the link opens an empty scene of that name (nothing to find without Drive)
//   2 after signing in, the same link finds the scene shared with the guest: the tab goes there, with its drawing
//   3 the empty one is gone from the guest's own scenes (it was only a name)
//   4 an empty scene left for another is forgotten; one with a drawing stays
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node scene-link-signed-out.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `slo${RUN}@example.test`;
const GUEST = `slg${RUN}@example.test`;
const NAME = `Accounting ${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400)}`);
  if (!cond) failed++;
};
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const errors = [];
const newPage = async () => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
  return page;
};
const ready = async (page) => {
  for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy).catch(() => false)); i++) { // NOSONAR S9382: polling in order on purpose
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
};
const signIn = async (page, email, back) => {
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(back)}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
  await ready(page);
};
const rect = (id) => ({ id, type: "rectangle", x: 100, y: 100, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0", roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false });
const draw = (page, id) => page.evaluate((element) => window.__scenes.getApi().updateScene({ elements: [element], captureUpdate: "IMMEDIATELY" }), rect(id));
const sceneNames = (page) => page.evaluate(() => window.__scenes.getState().list.map((item) => item.name).filter(Boolean));

// the owner's scene in Drive, shared with the guest (who opened it with Kurviq once: the app may read it)
const owner = await newPage();
await signIn(owner, OWNER, "/");
await owner.evaluate((name) => window.__scenes.create(name), NAME);
await draw(owner, "own00000001");
let fileId = null;
for (let i = 0; i < 80 && !fileId; i++) {
  await owner.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {}); // NOSONAR S9382: polling in order on purpose
  fileId = await owner.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, NAME); // NOSONAR S9382: polling in order on purpose
  await sleep(500); // NOSONAR S9382: polling in order on purpose
}
ok(!!fileId, "owner's scene is in Drive", fileId);
await admin("share", { fileId, email: GUEST, role: "writer" });
await admin("grant", { email: GUEST, fileId });

// 1
const guest = await newPage();
await guest.goto(`${BASE}/${encodeURIComponent(NAME)}`, { waitUntil: "domcontentloaded" });
await ready(guest);
const before = await guest.evaluate(() => ({ current: window.__scenes.getState().current, elements: window.__scenes.getApi().getSceneElements().length }));
ok(before.current === NAME && before.elements === 0, "1: signed out, the link opens an empty scene of that name", before);

// 2
await signIn(guest, GUEST, `/${encodeURIComponent(NAME)}`);
let after = null;
for (let i = 0; i < 60; i++) {
  await sleep(500); // NOSONAR S9382: polling in order on purpose
  after = await guest.evaluate(() => ({ path: decodeURIComponent(location.pathname), current: window.__scenes?.getState().current, elements: window.__scenes?.getApi()?.getSceneElements().length ?? 0 })).catch(() => null); // NOSONAR S9382: polling in order on purpose
  if (after?.path.startsWith("/s/") && after.elements > 0) break;
}
ok(after?.path === `/s/${fileId}/${NAME}` && after.current === NAME && after.elements === 1, "2: signed in, the link goes to the scene shared with the guest", after);

// 3
await guest.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await guest.evaluate(() => localStorage.removeItem("kurviq-space")).catch(() => {});
await guest.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await ready(guest);
const own = await sceneNames(guest);
ok(!own.includes(NAME), "3: the empty scene of that name is not among the guest's own scenes", own);

// 4
await guest.evaluate(() => window.__scenes.create("Only a name"));
await guest.evaluate(() => window.__scenes.create("Drawn"));
await draw(guest, "drw00000001");
await guest.evaluate(() => window.__scenes.create("Next"));
await sleep(300);
const left = await sceneNames(guest);
ok(!left.includes("Only a name") && left.includes("Drawn"), "4: the empty one is forgotten when left, the drawn one stays", left);

ok(errors.length === 0, "no page errors", errors);
await browser.close();
console.log(failed ? `FAIL ${failed}` : "FAIL 0");
process.exit(failed ? 1 : 0);
