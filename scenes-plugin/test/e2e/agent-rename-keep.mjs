// Live sync e2e (Agent write, rename, Keep only here (refused while shared, then done), Keep a local copy.) Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME (a Chrome for Testing binary). Usage: node agent-rename-keep.mjs [ownerEmail] [guestEmail]
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
const fileId = await owner.evaluate(() => window.__live.current().fileId);
log("owner", await state(owner));
// an agent's whole-scene write (PUT through this tab): via live sync, never Drive directly
const put = await owner.evaluate(async (name) => {
  const s = window.__live.current();
  const data = JSON.parse(s.sceneJson());
  data.elements.push({ ...data.elements[0], id: "agentrect01", x: 50, y: 50, version: 1, versionNonce: 1, boundElements: null, index: null });
  return window.__scenes.liveWrite(s.fileId, name, JSON.stringify(data), undefined, "agent");
}, SCENE).catch((e) => "ERR " + e.message);
log("agent put", JSON.stringify(put));
const batches = await owner.evaluate(() => window.__live.current().batches.map((b) => `${b.counter}:${b.via}:${b.state}`));
log("batches", JSON.stringify(batches), await state(owner));
// rename: a name event; Drive's file follows with the save round
const renamed = `${SCENE}-renamed`;
await owner.evaluate((a, b) => window.__scenes.rename(a, b), SCENE, renamed).catch((e) => log("rename ERR", e.message));
await sleep(2000);
log("list after rename", JSON.stringify(await owner.evaluate(() => window.__scenes.getState().list.map((i) => `${i.name}:${i.status}`))));
log("current after rename", await owner.evaluate(() => window.__scenes.getState().current), await state(owner));
// keep only here: shared → refused, local copy offered
await admin("share", { fileId, email: GUEST, role: "reader" });
const keep = await owner.evaluate((n) => window.__scenes.keepOnlyHere(n).then(() => "ok", (e) => `refused: ${e.message} copy=${!!e.keepLocalCopy}`), renamed);
log("keepOnlyHere shared:", keep);
const copy = await owner.evaluate((n) => window.__scenes.keepLocalCopy(n).catch((e) => "ERR " + e.message), renamed);
log("local copy", copy);
await admin("unshare", { fileId, email: GUEST });
await sleep(62_000);
const meta = await admin(`file?fileId=${fileId}`);
log("drive name after save round", JSON.stringify(meta.name ?? meta.file?.name));
const keep2 = await owner.evaluate((n) => window.__scenes.keepOnlyHere(n).then(() => "ok", (e) => `refused: ${e.message}`), renamed);
log("keepOnlyHere unshared:", keep2, "status", await owner.evaluate((n) => window.__scenes.statusOf(n), renamed));
const after = await admin(`file?fileId=${fileId}`);
log("trashed", JSON.stringify(after.trashed ?? after.file?.trashed), "list", JSON.stringify(await owner.evaluate(() => window.__scenes.getState().list.map((i) => `${i.name}:${i.status}`))));
log("meta", JSON.stringify(await owner.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-scenes")).scenes)));
log("activity", JSON.stringify(await owner.evaluate(() => window.__scenes.getState().activity.map((a) => a.text))));
await browser.close();
