// e2e: a scene that exists only in this browser and was empty when it was left (no stored copy,
// not in Drive) opens empty when it is clicked, instead of failing with "not found".
// Works against any build, signed out: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node empty-local-scene.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failed++;
};
const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "load" });
for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__scenes?.getApi()).catch(() => false)); i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling)
await page.evaluate(() => window.__scenes.ready);
await sleep(1500);
const name = `empty-${Date.now() % 100000}`;
await page.evaluate((n) => window.__scenes.create(n), name);
await page.evaluate(() => window.__scenes.create("other-scene"));
// the stored copy of the empty scene is gone (as when it was empty and cleaned up)
await page.evaluate(
  (n) =>
    new Promise((resolve) => {
      const open = indexedDB.databases().then((dbs) => {
        const info = dbs.find((d) => d.name.startsWith("excalidraw-scenes-db"));
        const request = indexedDB.open(info.name);
        request.onsuccess = () => {
          const tx = request.result.transaction("snapshots", "readwrite");
          tx.objectStore("snapshots").delete(n);
          tx.oncomplete = () => resolve(true);
        };
      });
      return open;
    }),
  name,
);
const error = await page.evaluate(async (n) => {
  try {
    await window.__scenes.open(n);
    return null;
  } catch (e) {
    return String(e?.message || e);
  }
}, name);
await sleep(800);
const state = await page.evaluate(() => ({ current: window.__scenes.getState().current, error: window.__scenes.getState().error, elements: window.__scenes.getApi().getSceneElements().length }));
ok(error === null, "opening the empty local scene does not fail", error);
ok(state.current === name && state.elements === 0 && !state.error, "it is the open scene, empty, no error", state);
await browser.close();
process.exitCode = failed ? 1 : 0;
