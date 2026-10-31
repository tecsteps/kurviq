// Live sync e2e: the shared-link viewer (kurviq.com/s/<fileId>/…) of a signed-in
// Drive "reader" watches live: the owner's edits show within about a second,
// the viewer never sends anything, presence lists it as a viewer, and a
// viewer opened with ?present follows live too.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME
// (a Chrome for Testing binary). Usage: node live-viewer.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const SCENE = `viewer-${RUN}`;
const OWNER = `vown${RUN}@example.test`;
const READER = `vread${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];
const watch = (page, tag) => {
  page.on("console", (m) => m.type() === "error" && !/editor is gone|JSHandle@error|Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};
const signIn = async (ctx, email, path) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "load" });
  return page;
};
const failures = [];

// the owner's live scene with one rectangle
const ownerCtx = await browser.createIncognitoBrowserContext();
const owner = await signIn(ownerCtx, OWNER, `/${SCENE}`);
watch(owner, "owner");
for (let i = 0; i < 10; i++) {
  await sleep(1500);
  await owner.keyboard.press("Escape");
  await owner.keyboard.press("r");
  await owner.mouse.move(400, 300);
  await owner.mouse.down();
  await owner.mouse.move(480, 360, { steps: 4 });
  await owner.mouse.up();
  await owner.keyboard.press("Escape");
  if (await owner.evaluate(() => window.__scenes?.getApi()?.getSceneElements().length ?? 0).catch(() => 0)) break;
}
for (let i = 0; i < 90 && (await owner.evaluate(() => window.__live?.current()?.phase).catch(() => null)) !== "ready"; i++) await sleep(500);
const fileId = await owner.evaluate(() => window.__live.current().fileId);
log("owner live, file", fileId);
await admin("share", { fileId, email: READER, role: "reader" });
await admin("grant", { fileId, email: READER });

// the reader opens the shared link (signed in): the viewer goes live
const readerCtx = await browser.createIncognitoBrowserContext();
const reader = await signIn(readerCtx, READER, `/s/${fileId}/${SCENE}`);
watch(reader, "reader");
const viewer = (page) =>
  page.evaluate(() => {
    const v = window.__live?.viewerScene;
    return v ? { phase: v.phase, role: v.role, xs: v.surface.elements().filter((e) => !e.isDeleted).map((e) => Math.round(e.x)), batches: v.batches.length, draft: v.draft.size } : null;
  });
for (let i = 0; i < 60 && (await viewer(reader))?.phase !== "ready"; i++) await sleep(500);
const before = await viewer(reader);
log("reader viewer", JSON.stringify(before));
if (before?.phase !== "ready") failures.push(`viewer not live: ${JSON.stringify(before)}`);
if (before?.role !== "read") failures.push(`viewer role ${before?.role}`);

// presence: the owner sees the reader, as a viewer
await sleep(1500);
const presence = await owner.evaluate(() => window.__live.current().presence.map((p) => `${p.name}:${p.role}`));
log("owner sees presence", JSON.stringify(presence));
if (!presence.some((p) => p.endsWith(":read"))) failures.push(`reader not in presence as a viewer: ${JSON.stringify(presence)}`);

// the owner moves the rectangle: the reader sees it within about a second
const moveTo = async (x) => {
  await owner.evaluate((x) => {
    const api = window.__scenes.getApi();
    const el = api.getSceneElements()[0];
    api.updateScene({ elements: [{ ...el, x, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }], captureUpdate: "IMMEDIATELY" });
  }, x);
  const start = Date.now();
  for (;;) {
    const now = await viewer(reader);
    if (now?.xs.includes(x)) return Date.now() - start;
    if (Date.now() - start > 5000) return null;
    await sleep(50);
  }
};
const delays = [];
for (const x of [700, 900, 300]) {
  const ms = await moveTo(x);
  delays.push(ms);
  log(`moved to ${x}: reader sees it after`, ms === null ? "TIMEOUT" : `${ms} ms`);
}
if (delays.some((ms) => ms === null || ms > 1500)) failures.push(`live delays ${JSON.stringify(delays)}`);
const after = await viewer(reader);
if (after.batches || after.draft) failures.push(`the viewer queued something: ${JSON.stringify(after)}`);

// a presentation link (?present) follows live as well
const presenter = await readerCtx.newPage();
watch(presenter, "present");
await presenter.goto(`${BASE}/s/${fileId}/${SCENE}?present`, { waitUntil: "load" });
for (let i = 0; i < 60 && (await viewer(presenter))?.phase !== "ready"; i++) await sleep(500);
const ms = await (async () => {
  await owner.evaluate(() => {
    const api = window.__scenes.getApi();
    const el = api.getSceneElements()[0];
    api.updateScene({ elements: [{ ...el, x: 555, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }], captureUpdate: "IMMEDIATELY" });
  });
  const start = Date.now();
  for (;;) {
    const now = await viewer(presenter);
    if (now?.xs.includes(555)) return Date.now() - start;
    if (Date.now() - start > 5000) return null;
    await sleep(50);
  }
})();
log("?present viewer sees the change after", ms === null ? "TIMEOUT" : `${ms} ms`, "url", presenter.url().replace(BASE, ""));
if (ms === null || ms > 1500) failures.push(`?present viewer delay ${ms}`);
if (errors.length) failures.push(`console errors: ${errors.slice(0, 5).join(" | ")}`);
log(failures.length ? `FAIL:\n  ${failures.join("\n  ")}` : "PASS");
await browser.close();
process.exit(failures.length ? 1 : 0);
