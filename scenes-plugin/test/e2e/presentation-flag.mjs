// e2e: presentation status is explicit and survives reload, independent of frame count.
// Works against any build, signed out: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node presentation-flag.mjs
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
const name = `presentation-${Date.now() % 100000}`;
await page.evaluate(async (n) => {
  const elements = [0, 1, 2].map((i) => ({
    id: `frame-${i}`, type: "frame", x: i * 220, y: 0, width: 200, height: 120,
    angle: 0, strokeColor: "#000000", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [],
    frameId: null, roundness: null, seed: i + 1, version: 1, versionNonce: i + 1,
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, name: `Page ${i + 1}`,
  }));
  // Import a legacy scene without any presentation flag, then open it.
  await window.__scenes.createLocalOnly(n, JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} }));
  await window.__scenes.open(n);
  window.__scenes.getApi().toggleSidebar({ name: "slides", force: true });
}, name);
await page.waitForSelector('input[type="checkbox"]');
const checked = () => page.evaluate(() => [...document.querySelectorAll("label")].find((el) => el.textContent.includes("This scene is a presentation"))?.querySelector("input")?.checked);
ok(await checked() === false, "three frames default to non presentation");
const presentVisible = () => page.evaluate(() => [...document.querySelectorAll(".scenes-top-right button")].some((el) => el.textContent.trim() === "Present"));
ok(await presentVisible() === false, "no Present button for three frames");
const togglePresentation = () => page.evaluate(() => [...document.querySelectorAll("label")].find((el) => el.textContent.includes("This scene is a presentation"))?.querySelector("input")?.click());
await togglePresentation();
await sleep(800);
ok(await checked() === true, "explicit toggle enables presentation");
ok(await presentVisible(), "Present button appears");
ok(await page.evaluate(() => !!document.querySelector('.slides-tabs')), "presentation sidebar appears");
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => !!window.__scenes?.getApi());
await page.evaluate(() => window.__scenes.ready);
await page.evaluate(() => window.__scenes.getApi().toggleSidebar({ name: "slides", force: true }));
await sleep(800);
ok(await checked() === true, "reload preserves flag");
await togglePresentation();
await sleep(500);
ok(await checked() === false, "explicit false disables presentation");
ok(await page.evaluate(() => window.__scenes.getApi().getSceneElements().filter((el) => el.type === "frame").length) === 3, "turning off preserves frames");
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => !!window.__scenes?.getApi());
await page.evaluate(() => window.__scenes.ready);
await page.evaluate(() => window.__scenes.getApi().toggleSidebar({ name: "slides", force: true }));
await sleep(800);
ok(await checked() === false, "reload preserves explicit false");
await browser.close();
process.exitCode = failed ? 1 : 0;
