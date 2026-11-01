// Live sync e2e (a scene's size on the server: pictures no element shows any more don't count, and
// leave the server after a save; one brought back by undo is sent again). Real Worker + fake Google:
// KURVIQ_URL (default http://localhost:8790), CHROME (a Chrome for Testing binary).
// Usage: node scene-size.mjs [email]
// Pictures of ~3 MB are added and deleted again 8 times (about 45 MB on the server in all, over its
// 30 MB per scene): every change must be confirmed, none refused. Then the last picture comes back
// (undo) after the server dropped it: the tab sends it again, and a fresh session sees it.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = `size-${Date.now() % 100000}`;
const EMAIL = process.argv[2] || `size${Date.now() % 100000}@example.test`;
const PICTURES = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra !== undefined ? " " + JSON.stringify(extra).slice(0, 300) : ""}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1400, height: 900 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const signIn = async (path, email = EMAIL, space) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  if (space) {
    await page.evaluateOnNewDocument((s) => localStorage.setItem("kurviq-space", s), space);
  }
  page.on("pageerror", (e) => log("PAGEERROR", e.message));
  page.on("console", (m) => /\[live\]/.test(m.text()) && log("console", m.text().slice(0, 200)));
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "networkidle2" });
  return page;
};
const report = (page) => page.evaluate(() => window.__live?.current()?.queueReport() ?? null);
const drained = async (page, ms) => {
  for (let t = 0; t < ms; t += 1000) {
    const r = await report(page);
    if (r && r.phase === "ready" && r.unsent === 0) return r;
    await sleep(1000);
  }
  return report(page);
};

log("scene", SCENE, "as", EMAIL);
const page = await signIn(`/${SCENE}`);
await sleep(3000);
// a first element, so the scene goes live
await page.keyboard.press("r");
await page.mouse.move(400, 300);
await page.mouse.down();
await page.mouse.move(480, 360, { steps: 5 });
await page.mouse.up();
await page.keyboard.press("Escape");
let first = null;
for (let i = 0; i < 30 && !(first = await report(page))?.phase?.includes("ready"); i++) await sleep(1000);
ok(first?.phase === "ready", "scene is live", first);

// a ~3 MB picture, added and deleted again, eight times
const addPicture = (i, data) =>
  page.evaluate(
    async (i, data) => {
      const s = window.__live.current();
      const fileId = `pic${i}`.padEnd(40, "0");
      const now = Date.now();
      s.surface.edit({
        files: [{ id: fileId, mimeType: "image/png", dataURL: `data:image/png;base64,${data}`, created: now }],
        elements: [
          {
            id: `img${i}`, type: "image", x: 100 + i * 10, y: 100, width: 200, height: 200, angle: 0, strokeColor: "transparent",
            backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
            groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: i + 1, isDeleted: false,
            boundElements: null, updated: now, link: null, locked: false, status: "saved", fileId, scale: [1, 1], crop: null, index: null,
          },
        ],
      });
      s.collect();
      await s.flush();
    },
    i,
    data,
  );
const deletePicture = (i) =>
  page.evaluate(async (i) => {
    const s = window.__live.current();
    const el = s.surface.elements().find((e) => e.id === `img${i}`);
    s.surface.edit({ elements: [{ ...el, isDeleted: true, version: el.version + 1, versionNonce: el.versionNonce + 7 }] });
    s.collect();
    await s.flush();
  }, i);

for (let i = 0; i < PICTURES; i++) {
  const data = randomBytes(2_250_000).toString("base64"); // ~3 MB as base64
  await addPicture(i, data);
  let r = await drained(page, 150_000);
  ok(r?.unsent === 0, `picture ${i} confirmed`, r?.problems);
  await deletePicture(i);
  r = await drained(page, 150_000);
  ok(r?.unsent === 0, `picture ${i} deleted, confirmed`, r?.problems);
}
const end = await report(page);
ok(!end.problems.some((p) => /sceneBytes/.test(p)), "never refused for the scene's size", end.problems);
ok(!end.error, "no error", end.error);

// the server saves every minute and drops the unused pictures then; then picture 7 comes back (undo)
log("waiting for a save round (70 s)");
await sleep(70_000);
await page.evaluate(async () => {
  const s = window.__live.current();
  const el = s.surface.elements().find((e) => e.id === "img7");
  s.surface.edit({ elements: [{ ...el, isDeleted: false, version: el.version + 1, versionNonce: el.versionNonce + 11 }] });
  s.collect();
  await s.flush();
});
const back = await drained(page, 60_000);
ok(back?.unsent === 0, "the picture brought back is confirmed", back);
log("problems after undo", JSON.stringify(back?.problems));

// a fresh session (another account the scene is shared with, empty browser) gets the scene from
// the server: the picture must be there again
const fileId = await page.evaluate(() => window.__live.current().fileId);
const GUEST = `g${EMAIL}`;
await admin("share", { fileId, email: GUEST, role: "writer" });
await admin("grant", { fileId, email: GUEST });
const other = await signIn(`/${SCENE}`, GUEST, `f:${fileId}`);
let seen = null;
for (let i = 0; i < 90; i++) {
  seen = await other.evaluate(() => {
    const s = window.__live?.current();
    if (!s || s.phase !== "ready") return null;
    if (!s.surface.elements().some((e) => e.id === "img7")) return null;
    const files = s.surface.files();
    return { img7: !!s.surface.elements().find((e) => e.id === "img7" && !e.isDeleted), file7: !!files["pic7".padEnd(40, "0")]?.dataURL, file3: !!files["pic3".padEnd(40, "0")] };
  });
  if (seen) break;
  if (i % 15 === 14) log("fresh session", await other.evaluate(() => ({ url: location.pathname, current: window.__scenes?.getState().current, live: window.__live?.current()?.queueReport() ?? null })).then(JSON.stringify));
  await sleep(1000);
}
ok(seen?.img7 && seen?.file7, "a fresh session shows the picture brought back", seen);
ok(seen && !seen.file3, "a picture only a deleted element shows is not sent to new sessions", seen);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
