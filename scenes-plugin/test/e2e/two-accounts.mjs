// Live sync e2e (Two accounts on a shared scene: per-property merge, same property (later wins, restore offered), save round.) Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME (a Chrome for Testing binary). Usage: node two-accounts.mjs [ownerEmail] [guestEmail]
// Two accounts on one shared live scene: concurrent edits of one element (live collision), save rounds.
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = `shared-${Date.now() % 100000}`;
const [OWNER, GUEST] = [process.argv[2] || "henry@example.test", process.argv[3] || "ivy@example.test"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
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
    if (!s) return "no live scene";
    const canvas = s.surface.elements().filter((e) => !e.isDeleted).map((e) => `${e.id.slice(0, 4)} x=${Math.round(e.x)} ${e.strokeColor} v${e.version}`);
    return `phase=${s.phase} role=${s.role} stage=${s.stage()} canvas=[${canvas}] batches=${s.batches.map((b) => b.counter + b.state).join(",")} notes=${JSON.stringify(s.notes.map((n) => n.text))} losers=${s.losers.length} presence=${s.presence.map((p) => p.name).join("/")}`;
  });
const edit = (page, props) =>
  page.evaluate((props) => {
    const s = window.__live.current();
    const el = s.surface.elements().find((e) => !e.isDeleted);
    s.surface.edit({ elements: [{ ...el, ...props, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }] });
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
for (let i = 0; i < 25 && !(await state(owner)).includes("phase=ready"); i++) await sleep(1000);
log("owner", await state(owner));
const fileId = await owner.evaluate(() => window.__live.current().fileId);
log("fileId", fileId);
await admin("share", { fileId, email: GUEST, role: "writer" });
await admin("grant", { fileId, email: GUEST });
const guest = await signIn(GUEST, `/${SCENE}`, `f:${fileId}`);
for (let i = 0; i < 20 && !(await state(guest)).includes("phase=ready"); i++) await sleep(1000);
log("guest", await state(guest));
// the same element at the same moment: owner moves it, guest recolors it
await Promise.all([edit(owner, { x: 900 }), edit(guest, { strokeColor: "#e03131" })]);
await sleep(2500);
log("owner after collision", await state(owner));
log("guest after collision", await state(guest));
// same property at the same moment: later wins, the other is offered "restore yours?"
await Promise.all([edit(owner, { x: 100 }), edit(guest, { x: 200 })]);
await sleep(2500);
log("owner after same-property", await state(owner));
log("guest after same-property", await state(guest));
log("waiting for the save round…");
await sleep(75_000);
log("owner later", await state(owner));
log("guest later", await state(guest));
const file = await admin(`file?fileId=${fileId}`);
log("revisions", JSON.stringify((file.revisions || file.file?.revisions || []).map((r) => r.lastModifyingUser?.emailAddress ?? r.lastModifyingUser ?? r.modifiedBy ?? "?")), "appProperties", JSON.stringify(file.appProperties ?? file.file?.appProperties ?? {}).slice(0, 200));
await browser.close();
