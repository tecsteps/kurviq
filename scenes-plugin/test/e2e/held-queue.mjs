// Live sync e2e (a change refused for an element another queue of this browser still holds waits
// for it instead of turning the scene into an offline copy). Real Worker + fake Google:
// KURVIQ_URL (default http://localhost:8790), CHROME (a Chrome for Testing binary).
// Usage: node held-queue.mjs [email]
// As on 1 Nov 2026: a reload left a queue with a new frame that never reached the server; the
// open tab then put an element on that frame, the server refused it ("reference"), and the tab
// let the server's version win (the frame and everything on it gone, the work only in a copy).
// Here a queue of another (held) tab id has the frame, the open tab adds an element on it: it
// must wait, keep both on the canvas and make no copy; once the other queue goes out, both land.
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = `held-${Date.now() % 100000}`;
const EMAIL = process.argv[2] || `held${Date.now() % 100000}@example.test`;
const GHOST = "ghosttab00000001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra !== undefined ? " " + JSON.stringify(extra).slice(0, 400) : ""}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1400, height: 900 },
});
const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => log("PAGEERROR", e.message));
await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(`/${SCENE}`)}`, { waitUntil: "domcontentloaded" });
await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "networkidle2" });
await sleep(3000);
await page.keyboard.press("r");
await page.mouse.move(400, 300);
await page.mouse.down();
await page.mouse.move(480, 360, { steps: 5 });
await page.mouse.up();
await page.keyboard.press("Escape");
const report = () => page.evaluate(() => window.__live?.current()?.queueReport() ?? null);
for (let i = 0; i < 30 && (await report())?.phase !== "ready"; i++) await sleep(1000);
for (let i = 0; i < 20 && (await report())?.unsent; i++) await sleep(1000);
ok((await report())?.phase === "ready", "scene is live");

// the other queue: tab GHOST (held by a lock here, as if its page were still busy) has a new frame
await page.evaluate(async (ghost) => {
  const s = window.__live.current();
  const now = Date.now();
  const frame = {
    id: "frameX", type: "frame", x: 1000, y: 100, width: 800, height: 450, angle: 0, strokeColor: "#bbb", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 3, version: 1, versionNonce: 31, isDeleted: false, boundElements: null, updated: now, link: null, locked: false, name: "Held frame", index: "b9",
  };
  // the lock a live page holds for its tab id: the queue is not a closed tab's yet
  window.__releaseGhost = await new Promise((held) => {
    navigator.locks.request(`kurviq-live-tab:${s.fileId}:${ghost}`, () => new Promise((release) => held(release)));
  });
  const batch = { sub: s.sub, fileId: s.fileId, tab: ghost, counter: 1, made: now, live: true, via: "user", changes: [{ k: "el", id: "frameX", value: frame, base: null, keys: null }], state: "queued", ...(s.epoch ? { epoch: s.epoch } : {}) };
  await new Promise((done, fail) => {
    const req = indexedDB.open("kurviq-live-queue");
    req.onsuccess = () => {
      const tx = req.result.transaction("batches", "readwrite");
      tx.objectStore("batches").put(batch, [batch.sub, batch.fileId, batch.tab, batch.counter]);
      tx.oncomplete = done;
      tx.onerror = () => fail(tx.error);
    };
    req.onerror = () => fail(req.error);
  });
  // the frame is on this canvas too (the browser's tabs share the canvas storage): not this tab's change
  s.surface.apply({ elements: [frame] });
  // as the reconcile after a handshake leaves it: on the canvas, the other queue's to send
  s.known.set(frame.id, { v: frame.version, n: frame.versionNonce });
}, GHOST);
// this tab reads the other queues every 15 s: then it knows the frame is theirs
await sleep(17000);

// the open tab puts a text on the held frame: the server doesn't know frameX
await page.evaluate(() => {
  const s = window.__live.current();
  const now = Date.now();
  s.surface.edit({
    elements: [
      {
        id: "onFrame", type: "rectangle", x: 1100, y: 200, width: 100, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
        fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: "frameX", roundness: null,
        seed: 4, version: 1, versionNonce: 41, isDeleted: false, boundElements: null, updated: now, link: null, locked: false, index: "ba",
      },
    ],
  });
  s.collect();
  return s.flush();
});
await sleep(8000);
log("this tab's batches", await page.evaluate(() => JSON.stringify(window.__live.current().batches.map((b) => `${b.counter}:${b.state}:${b.changes.map((c) => c.id).join("+")}`))));
let r = await report();
log("while held", JSON.stringify(r));
const scenesWhile = await page.evaluate(() => window.__scenes.getState().list.map((i) => i.name));
ok(!scenesWhile.some((n) => /offline changes/.test(n)), "no offline copy while the frame is held elsewhere", scenesWhile);
// (whether the server refused it at all depends on the timing: logged, not checked)
log("refusals while held", JSON.stringify(r.problems));
const canvas = () =>
  page.evaluate(() => {
    const s = window.__live.current();
    const live = s.surface.elements().filter((e) => !e.isDeleted).map((e) => e.id);
    return { frameX: live.includes("frameX"), onFrame: live.includes("onFrame") };
  });
const shown = await canvas();
ok(shown.frameX && shown.onFrame, "frame and element stay on the canvas", shown);
await sleep(20000);
const still = await canvas();
ok(still.frameX && still.onFrame, "still there after the canvas caught up with the server", still);

// the other queue's page goes: its queue is a closed tab's, sent from here; then the waiting change lands
await page.evaluate(() => window.__releaseGhost());
for (let i = 0; i < 90 && (await report())?.unsent; i++) await sleep(1000);
r = await report();
ok(r.unsent === 0, "everything confirmed after the other queue went out", r);
const after = await canvas();
ok(after.frameX && after.onFrame, "frame and element on the canvas", after);
const scenesAfter = await page.evaluate(() => window.__scenes.getState().list.map((i) => i.name));
ok(!scenesAfter.some((n) => /offline changes/.test(n)), "no offline copy at all", scenesAfter);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
