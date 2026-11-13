// Shared folders e2e (specs/2026-11-13-drive-collaboration-without-server-data.md, "Shared folders";
// criteria 19, 20): the owner shares their Kurviq folder in Drive; nothing about it reaches Kurviq's
// server. The person it is shared with picks the folder once in Google's Picker ("Shared with you…");
// their Kurviq lists it as a group with their own access. Picking a folder may or may not grant its
// files to Kurviq (drive.file; to verify with the real Google): both are run (the fake Google's setting
// folderPickGrantsChildren). Without the grant, the group says "N new scenes in this folder: open
// them", which picks them; scenes the owner adds later show the same way.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node shared-folder.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const [OWNER, GUEST, STRANGER, EDITOR] = ["own", "gst", "str", "edt"].map((who) => `${who}${RUN}@example.test`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400)}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];

const ready = async (page) => {
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy).catch(() => false)) { // NOSONAR S9382: polling in order on purpose
      await sleep(1500); // NOSONAR S9382: polling in order on purpose
      return true;
    }
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};
const signIn = async (email) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email.slice(0, 3)} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
  for (let i = 0; i < 40 && (await page.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
  await ready(page);
  return page;
};
const create = async (page, name, x) => {
  await page.evaluate(async (name, x) => {
    await window.__scenes.create(name);
    window.__scenes.getApi().updateScene({
      elements: [{
        id: `r${Math.random().toString(36).slice(2, 10)}`, type: "rectangle", x, y: 100, width: 80, height: 50, angle: 0, // NOSONAR S2245: not security relevant (test element id)
        strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
        roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
        versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      }],
      captureUpdate: "IMMEDIATELY",
    });
  }, name, x);
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate((name) => !!window.__scenes.fileIdOf(name), name)) return true; // NOSONAR S9382: polling in order on purpose
    await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {}); // NOSONAR S9382: polling in order on purpose
    await sleep(500); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};
const waitFor = async (what, check, tries = 40) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await check(); // NOSONAR S9382: polling in order on purpose
    if (last.done) return last;
    await sleep(500); // NOSONAR S9382: polling in order on purpose
  }
  log("gave up waiting for", what, JSON.stringify(last).slice(0, 300));
  return last;
};
/** the owner's Kurviq notes its folder's scene count now (it does so on its own at most every 10 minutes) */
const ownerNotes = (page) =>
  page.evaluate(async (email) => {
    localStorage.removeItem(`kurviq-folder-count:${email}`);
    await window.__scenes.syncNow({ refresh: true });
  }, OWNER);
const noted = async (folderId) => (await admin(`file?fileId=${folderId}`)).appProperties?.kurviqScenes ?? null;

/** the scene list (pill), the text of its menu, closed again */
const listText = async (page) => {
  await page.click(".scenes-pill__open");
  await sleep(1200);
  // unfold every folder group (folded ones list nothing)
  await page.evaluate(() =>
    document.querySelectorAll(".scenes-switcher__group[aria-expanded='false']").forEach((el) => el.click()),
  );
  await sleep(400);
  const text = await page.evaluate(() => document.querySelector(".scenes-switcher__menu")?.innerText ?? "");
  return text;
};
const closeList = async (page) => {
  await page.keyboard.press("Escape");
  await sleep(300);
};
/** "Shared with you…" in the scene list, with what the person picks queued in the fake Picker */
const pickShared = async (page, email, ids) => {
  await admin("picker", { email, ids });
  await page.click(".scenes-pill__open");
  await sleep(1000);
  await page.evaluate(() => [...document.querySelectorAll(".scenes-switcher__manage")].find((el) => el.textContent.includes("Shared with you"))?.click());
  await sleep(1500);
};

// 0. the server keeps nothing about folders: the old routes are gone
const owner = await signIn(OWNER);
const oldRoute = await owner.evaluate(async () => (await fetch("/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
ok(oldRoute !== 200, "no folder route on the server any more", oldRoute);

// 1. the owner has two scenes in Drive and shares the Kurviq folder with the guest (in Drive)
await admin("config", { folderPickGrantsChildren: false });
const [ALPHA, BETA, LATER] = [`Alpha ${RUN}`, `Beta ${RUN}`, `Later ${RUN}`];
ok(await create(owner, ALPHA, 100), "owner: first scene in Drive");
ok(await create(owner, BETA, 300), "owner: second scene in Drive");
const folderId = await owner.evaluate((email) => localStorage.getItem(`kurviq-drive-folder:${email}`), OWNER);
const [alphaId, betaId] = await owner.evaluate((a, b) => [window.__scenes.fileIdOf(a), window.__scenes.fileIdOf(b)], ALPHA, BETA);
ok(!!folderId && !!alphaId && !!betaId, "owner's Kurviq folder and scenes known", { folderId, alphaId, betaId });
await admin("share", { fileId: folderId, email: GUEST, role: "reader" });
await ownerNotes(owner);
const count = await waitFor("the owner's count on the folder", async () => {
  const value = await noted(folderId);
  return { done: value === "2", value };
});
ok(count.done, "owner's Kurviq notes 2 scenes on the shared folder (Drive metadata)", count.value);

// 2. the guest: nothing until they pick the folder; then the group, with "2 new scenes: open them"
const guest = await signIn(GUEST);
const before = await listText(guest);
ok(!before.includes(ALPHA) && !/new scenes? in this folder/.test(before), "guest: no folder before the pick", before.slice(0, 200));
await closeList(guest);
await pickShared(guest, GUEST, [folderId]);
const picked = await listText(guest);
ok(/OWN\d+/i.test(picked) && /2 new scenes in this folder/.test(picked), "guest: the folder's group, 2 new scenes to open", picked.slice(0, 300));
ok(!picked.includes(ALPHA), "…its scenes not opened yet (picking the folder didn't grant them)", picked.slice(0, 300));
// "open them": the Picker on the folder, both picked
await admin("picker", { email: GUEST, ids: [alphaId, betaId] });
await guest.evaluate(() => [...document.querySelectorAll(".scenes-switcher__unseen button")][0]?.click());
const opened = await waitFor("the folder's scenes listed", async () => {
  const text = await guest.evaluate(() => document.querySelector(".scenes-switcher__menu")?.innerText ?? "");
  return { done: text.includes(ALPHA) && text.includes(BETA), text };
});
ok(opened.done && !/new scenes? in this folder/.test(opened.text), "guest: both scenes listed in the group, nothing new left", opened.text?.slice(0, 300));
await closeList(guest);

// 3. a scene the owner adds later: "1 new scene in this folder"
ok(await create(owner, LATER, 500), "owner: a third scene");
await ownerNotes(owner);
const three = await waitFor("count 3", async () => {
  const value = await noted(folderId);
  return { done: value === "3", value };
});
ok(three.done, "owner's count follows", three.value);
await guest.reload({ waitUntil: "domcontentloaded" });
await ready(guest);
const laterText = await listText(guest);
ok(/1 new scene in this folder/.test(laterText) && !laterText.includes(LATER), "guest: 1 new scene in the folder", laterText.slice(0, 300));
await closeList(guest);

// 4. opening a scene of it: the folder's space, read-only, with the guest's own access
await guest.click(".scenes-pill__open");
await sleep(1200);
await guest.evaluate(() => document.querySelectorAll(".scenes-switcher__group[aria-expanded='false']").forEach((el) => el.click()));
await sleep(400);
await guest.evaluate((name) => [...document.querySelectorAll(".scenes-switcher__item")].find((el) => el.textContent.includes(name))?.click(), BETA);
await sleep(1000);
await ready(guest);
for (let i = 0; i < 40 && (await guest.evaluate(() => window.__scenes?.getState().current).catch(() => null)) !== BETA; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
const inFolder = await guest.evaluate(() => ({
  space: localStorage.getItem("kurviq-space"),
  current: window.__scenes.getState().current,
  list: window.__scenes.getState().list.map((item) => item.name).filter(Boolean),
  elements: window.__scenes.getApi().getSceneElements().map((e) => Math.round(e.x)),
  readOnly: window.__scenes.getState().sync.readOnly,
}));
ok(inFolder.space === `d:${folderId}` && inFolder.current === BETA, "guest: in the folder's space with the scene open", inFolder);
ok(inFolder.list.includes(ALPHA) && inFolder.list.includes(BETA) && !inFolder.list.includes(LATER), "the folder's picked scenes are the list", inFolder.list);
ok(inFolder.elements.join() === "300" && !!inFolder.readOnly, "the scene's content, read-only (a viewer of the folder)", inFolder);
const folderCalls = (await admin("log?kind=request&limit=400")).log.filter((entry) => entry.email === GUEST && String(entry.path).includes(betaId));
ok(folderCalls.length > 0, "read from Drive with the guest's own sign-in", folderCalls.length);

// 5. the stranger: picking the folder gives them nothing
const stranger = await signIn(STRANGER);
await pickShared(stranger, STRANGER, [folderId]);
const strangerText = await listText(stranger);
ok(!/OWN\d+/i.test(strangerText) && !strangerText.includes(ALPHA), "stranger: the folder isn't shared with them, nothing listed", strangerText.slice(0, 200));
await closeList(stranger);

// 6. if picking the folder grants its files (Google: to verify), all of them are listed at once
await admin("config", { folderPickGrantsChildren: true });
await admin("share", { fileId: folderId, email: EDITOR, role: "writer" });
const editor = await signIn(EDITOR);
await pickShared(editor, EDITOR, [folderId]);
const all = await listText(editor);
ok(all.includes(ALPHA) && all.includes(BETA) && all.includes(LATER) && !/new scenes? in this folder/.test(all), "editor: all scenes of the picked folder, nothing to pick", all.slice(0, 400));
await closeList(editor);
await admin("config", { folderPickGrantsChildren: false });

// 7. the owner's share panel: the folder note says how guests get it, no server registration
const ownerPanel = await (async () => {
  await owner.evaluate((name) => window.__openShareDialog(name), ALPHA);
  const text = await waitFor("share panel", async () => {
    const value = await owner.evaluate(() => document.querySelector(".kq-share")?.innerText ?? "");
    return { done: !value.includes("asking who has access") && /folder/.test(value), value };
  });
  await owner.keyboard.press("Escape");
  return text.value ?? "";
})();
ok(/Your folder "Kurviq" is shared with 2 people/.test(ownerPanel) && /pick the\s+folder once/.test(ownerPanel), "share panel (owner): the folder note", ownerPanel.slice(0, 400));

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
