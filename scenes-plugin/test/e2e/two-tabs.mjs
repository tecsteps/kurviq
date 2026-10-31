// Live sync e2e (One account, two tabs: edits both ways, a reload, a deletion.) Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME (a Chrome for Testing binary). Usage: node two-tabs.mjs [scene] [email] (new ones each run)
// Own headless Chromium (not the shared Playwright MCP browser): two tabs of one account on one live scene.
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = process.argv[2] || `live-smoke-${Date.now() % 100000}`;
const EMAIL = process.argv[3] || "alice@example.test";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  args: ["--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const watch = (page, tag) => {
  page.on("console", (m) => {
    const t = m.text();
    if (/live|scene|error|Error/i.test(t) && !/Download the React DevTools/.test(t)) log(tag, "console", m.type(), t.slice(0, 300));
  });
  page.on("pageerror", (e) => log(tag, "PAGEERROR", e.message));
  page.on("response", (r) => {
    if (/\/scene\//.test(r.url())) log(tag, "http", r.status(), r.url().replace(BASE, "").slice(0, 90));
  });
};
const ctx = await browser.createIncognitoBrowserContext();
const a = await ctx.newPage();
watch(a, "A");
await a.goto(`${BASE}/auth/login?return=${encodeURIComponent("/" + SCENE)}`, { waitUntil: "domcontentloaded" });
const authorize = a.url();
log("authorize url", authorize.slice(0, 120));
await a.goto(authorize.replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "networkidle2" });
log("A at", a.url());
await sleep(4000);
const draw = async (page, x, y) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
};
const count = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("excalidraw") || "[]").filter((e) => !e.isDeleted).length;
    } catch {
      return -1;
    }
  });

const els = (page) =>
  page.evaluate(() => (window.__live?.current()?.surface.elements() ?? []).filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y), v: e.version })));
const state = (page) =>
  page.evaluate(() => {
    const s = window.__live?.current();
    if (!s) return "no live scene";
    const canvas = s.surface.elements().map((e) => `${e.id.slice(0, 4)}${e.isDeleted ? "(del)" : ""}v${e.version}`);
    const conf = [...s.confirmed.values()].map((e) => `${e.id.slice(0, 4)}${e.isDeleted ? "(del)" : ""}v${e.version}`);
    return `phase=${s.phase} seq=${s.seq} canvas=[${canvas}] confirmed=[${conf}] batches=${s.batches.map((b) => b.counter + b.state).join(",")}`;
  });
const names = (page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("excalidraw-scenes") || "{}").scenes || {}));
await draw(a, 500, 400);
for (let i = 0; i < 22; i++) await sleep(1000);
log("A pill", await a.$eval(".scenes-pill", (el) => el.getAttribute("title")));
const b = await ctx.newPage();
watch(b, "B");
await b.goto(`${BASE}/${SCENE}`, { waitUntil: "networkidle2" });
await sleep(5000);
log("B sees", JSON.stringify(await els(b)));
const dumpQueue = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("kurviq-live-queue");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("batches")) return resolve([]);
          const req = db.transaction("batches").objectStore("batches").getAll();
          req.onsuccess = () => resolve(req.result.map((b) => ({ c: b.counter, state: b.state, via: b.via, live: b.live, changes: b.changes.map((ch) => [ch.k, ch.id.slice(0, 8), ch.keys, ch.k === "set" ? ch.value : undefined]) })));
        };
      }),
  );
log("B queue", JSON.stringify(await dumpQueue(b)));
log("A queue", JSON.stringify(await dumpQueue(a)));
// B draws one too
await b.bringToFront();
await draw(b, 400, 650);
await sleep(2500);
log("B queue after drag", JSON.stringify(await dumpQueue(b)));
log("A state", await state(a));
log("B state", await state(b));
log("after B drag: A", JSON.stringify(await els(a)), "B", JSON.stringify(await els(b)));
// A draws a second one
await a.bringToFront();
await draw(a, 300, 200);
await sleep(2500);
log("after A draw: A", (await els(a)).length, "B", (await els(b)).length);
log("A state", await state(a));
log("B state", await state(b));
// B reloads: persisted base + reconcile, nothing should become an offline copy
await b.reload({ waitUntil: "networkidle2" });
await sleep(6000);
log("B after reload", JSON.stringify(await els(b)));
log("B state after reload", await state(b));
// A deletes everything
await a.bringToFront();
await a.keyboard.down("Meta");
await a.keyboard.press("a");
await a.keyboard.up("Meta");
await a.keyboard.press("Delete");
await sleep(2500);
log("after A delete: A", (await els(a)).length, "B", (await els(b)).length);
log("scenes A", JSON.stringify(await names(a)), "B", JSON.stringify(await names(b)));
log("pills", await a.$eval(".scenes-pill", (el) => el.getAttribute("title")), "|", await b.$eval(".scenes-pill", (el) => el.getAttribute("title")));
const banner = await b.$eval(".kq-live", (el) => el.textContent).catch(() => null);
log("B banner", banner);
log("queue at end", JSON.stringify(await dumpQueue(b)));
await browser.close();
