// Live sync e2e (Offline collision (a copy, independent changes still sent), delete through the trash.) Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME (a Chrome for Testing binary). Usage: node offline-delete.mjs [ownerEmail] [guestEmail]
// Two accounts on one shared live scene: concurrent edits of one element (live collision), save rounds.
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = `shared-${Date.now() % 100000}`;
const [OWNER, GUEST] = [process.argv[2] || "henry@example.test", process.argv[3] || "ivy@example.test"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1400, height: 900 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const watch = (page, tag) => {
  page.on("console", (m) => /\[live\]|error/i.test(m.text()) && !/editor is gone/.test(m.text()) && log(tag, "console", m.text().slice(0, 300)));
  page.on("pageerror", (e) => log(tag, "PAGEERROR", e.message));
};
const signIn = async (email, path, space) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  watch(page, email.slice(0, 4));
  if (space) {
    await page.evaluateOnNewDocument((s) => localStorage.setItem("kurviq-space", s), space);
  }
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "networkidle2" });
  return page;
};
const state = (page) =>
  page.evaluate(() => {
    const s = window.__live?.current();
    if (!s) {
      return "no live scene";
    }
    const canvas = s.surface.elements().filter((e) => !e.isDeleted).map((e) => `${e.id.slice(0, 4)} x=${Math.round(e.x)} ${e.strokeColor} v${e.version}`);
    return `phase=${s.phase} role=${s.role} stage=${s.stage()} canvas=[${canvas}] batches=${s.batches.map((b) => b.counter + b.state).join(",")} notes=${JSON.stringify(s.notes.map((n) => n.text))} losers=${s.losers.length} presence=${s.presence.map((p) => p.name).join("/")}`;
  });
const edit = (page, props) =>
  page.evaluate((props) => {
    const s = window.__live.current();
    const el = s.surface.elements().find((e) => !e.isDeleted);
    s.surface.edit({ elements: [{ ...el, ...props, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }] }); // NOSONAR S2245: not security relevant (Excalidraw version nonce in a test)
    s.collect();
    return s.flush();
  }, props);
const draw = async (page, x, y) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
};


const owner = await signIn(OWNER, `/${SCENE}`);
await sleep(3000);
await draw(owner, 500, 400);
for (let i = 0; i < 25 && !(await state(owner)).includes("phase=ready"); i++) await sleep(1000); // NOSONAR S9382: in order on purpose (polling waits for the preceding observation)
const fileId = await owner.evaluate(() => window.__live.current().fileId);
await admin("share", { fileId, email: GUEST, role: "writer" });
await admin("grant", { fileId, email: GUEST });
const guest = await signIn(GUEST, `/${SCENE}`, `f:${fileId}`);
for (let i = 0; i < 20 && !(await state(guest)).includes("phase=ready"); i++) await sleep(1000); // NOSONAR S9382: in order on purpose (polling waits for the preceding observation)
// owner goes offline
await owner.setOfflineMode(true);
await owner.evaluate(() => window.__live.current().dropConnection());
await sleep(500);
await edit(owner, { x: 777 });
// an independent offline change too: a new rectangle
await owner.evaluate(() => {
  const s = window.__live.current();
  const el = s.surface.elements().find((e) => !e.isDeleted);
  s.surface.edit({ elements: [{ ...el, id: "offlinenew01", x: 1200, y: 100, version: 1, versionNonce: 5, index: null, boundElements: null }] });
  s.collect();
  return s.flush();
});
log("owner offline", await state(owner));
await edit(guest, { strokeColor: "#2f9e44" });
await sleep(1500);
log("guest", await state(guest));
await owner.setOfflineMode(false);
await owner.evaluate(() => window.__live.current().wake());
for (let i = 0; i < 15 && !(await state(owner)).includes("phase=ready"); i++) await sleep(1000); // NOSONAR S9382: in order on purpose (polling waits for the preceding observation)
await sleep(3000);
log("owner back", await state(owner));
log("guest", await state(guest));
log("owner scenes", JSON.stringify(await owner.evaluate(() => window.__scenes.getState().list.map((i) => `${i.name}:${i.status}`))));
const independent = await guest.evaluate(() => window.__live.current().surface.elements().find((e) => e.id === "offlinenew01" && !e.isDeleted));
ok(independent?.x === 1200, "independent offline work reaches the other account", independent);
const copies = await owner.evaluate((name) => window.__scenes.getState().list.filter((i) => i.name !== name), SCENE);
ok(copies.length > 0, "offline collision creates a recovery copy", copies);
const recovered = await owner.evaluate(async (names) => Promise.all(names.map(async (name) => {
  const text = await window.__scenes.localJson(name);
  return text ? JSON.parse(text).elements : [];
})), copies.map((copy) => copy.name));
ok(recovered.some((elements) => elements.some((e) => !e.isDeleted && e.x === 777)), "recovery copy retains colliding offline position", recovered);
// delete: lifecycle trash, then Drive's trash
await owner.evaluate((n) => window.__scenes.remove(n), SCENE);
await sleep(2000);
const f = await admin(`file?fileId=${fileId}`);
ok((f.trashed ?? f.file?.trashed) === true, "deletion trashes the Drive file");
ok(await guest.evaluate(() => window.__live.current()?.lifecycle === "trashed"), "trash propagates to guest", await state(guest));
log("trashed", JSON.stringify(f.trashed ?? f.file?.trashed), "guest", await state(guest));
log("owner scenes", JSON.stringify(await owner.evaluate(() => window.__scenes.getState().list.map((i) => `${i.name}:${i.status}`))));
await browser.close();
process.exitCode = failed ? 1 : 0;
