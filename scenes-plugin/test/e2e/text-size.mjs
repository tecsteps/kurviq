// e2e: the text toolbar's size popover takes any number (typed), besides the presets.
// Works against any build, signed out: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node text-size.mjs
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
const page = await (await browser.createIncognitoBrowserContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: "load" });
for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__scenes?.getApi()).catch(() => false)); i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling)
await page.evaluate(() => window.__scenes.ready);
await sleep(1500);
await page.evaluate(() => window.__scenes.create(`text-size-${Date.now() % 100000}`));
await page.evaluate(() => {
  const api = window.__scenes.getApi();
  api.updateScene({
    elements: [{
      id: "t1", type: "text", x: 300, y: 300, width: 200, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
      fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null,
      seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      text: "Initial discovery", originalText: "Initial discovery", fontSize: 25, fontFamily: 6, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25,
    }],
    captureUpdate: "IMMEDIATELY",
  });
});
await sleep(500);
await page.evaluate(() => window.__scenes.getApi().updateScene({ appState: { selectedElementIds: { t1: true } }, captureUpdate: "NEVER" }));
await sleep(300);
await page.keyboard.press("Enter"); // edit the selected text
await page.waitForSelector(".rt-toolbar", { timeout: 8000 });
await page.keyboard.down("Meta");
await page.keyboard.press("a");
await page.keyboard.up("Meta");
await page.click('.rt-toolbar button[aria-label^="Text size ("]');
await sleep(300);
await page.waitForSelector(".rt-toolbar__sizeform input", { timeout: 3000 });
ok(true, "the size popover has a field to type in");
await page.evaluate(() => { const input = document.querySelector(".rt-toolbar__sizeform input"); input.focus(); input.select(); });
await page.keyboard.type("27");
await page.keyboard.press("Enter");
await sleep(600);
const label = await page.$eval('.rt-toolbar button[aria-label^="Text size ("]', (el) => el.textContent.trim());
ok(label === "27", "the toolbar shows the typed size 27 (not one of the presets)", label);
await browser.close();
process.exitCode = failed ? 1 : 0;
