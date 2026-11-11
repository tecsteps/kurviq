// Shared folders e2e (docs/folders/CONCEPT.md, "Shared folders through the owner's sign-in"): the
// owner shares their Kurviq folder in Drive; their Kurviq tells the server; the person it is shared
// with sees the folder as a group in their scene list (also scenes added later), opens its scenes
// read-only through Kurviq's server, and loses it when the owner stops sharing. The server lets
// only reads of that folder through, for the people Drive lists.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node shared-folder.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const [OWNER, GUEST, STRANGER] = ["own", "gst", "str"].map((who) => `${who}${RUN}@example.test`);
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
/** the owner's Kurviq checks its folder's sharing now (it does so on its own every 30 minutes) */
const ownerChecks = (page) =>
  page.evaluate(async (email) => {
    localStorage.removeItem(`kurviq-folder-share:${email}`);
    await window.__scenes.syncNow({ refresh: true });
  }, OWNER);
const folders = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { status: res.status, body: await res.json() };
  });
const proxy = (page, folderId, method, path) =>
  page.evaluate(
    async (folderId, method, path) => {
      const res = await fetch(`/folders/${folderId}/drive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, path }) });
      return { status: res.status, body: await res.json() };
    },
    folderId, method, path,
  );
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

// 1. the owner has two scenes in Drive and shares the Kurviq folder with the guest (in Drive)
const owner = await signIn(OWNER);
const [ALPHA, BETA, LATER] = [`Alpha ${RUN}`, `Beta ${RUN}`, `Later ${RUN}`];
ok(await create(owner, ALPHA, 100), "owner: first scene in Drive");
ok(await create(owner, BETA, 300), "owner: second scene in Drive");
const folderId = await owner.evaluate((email) => localStorage.getItem(`kurviq-drive-folder:${email}`), OWNER);
ok(!!folderId, "owner's Kurviq folder known", folderId);
await admin("share", { fileId: folderId, email: GUEST, role: "reader" });
await ownerChecks(owner);
const registered = await waitFor("registration", async () => {
  const known = await owner.evaluate((email) => JSON.parse(localStorage.getItem(`kurviq-folder-share:${email}`) || "null"), OWNER);
  return { done: known?.shared === true, known };
});
ok(registered.done, "owner's Kurviq registered the shared folder");

// 2. the guest finds the folder with its scenes; the stranger finds nothing
const guest = await signIn(GUEST);
const found = await folders(guest);
const shared = found.body.folders?.find((folder) => folder.folderId === folderId);
ok(found.status === 200 && !!shared, "guest: the folder is shared with them", found);
ok(shared?.role === "reader" && shared.scenes.map((s) => s.name).join() === [ALPHA, BETA].join(), "with role and both scenes", shared);
const stranger = await signIn(STRANGER);
const none = await folders(stranger);
ok(none.status === 200 && !none.body.folders?.some((folder) => folder.folderId === folderId), "stranger: not shared with them", none);

// 3. the scene list shows the folder as a group
await guest.click(".scenes-pill");
await sleep(1500);
const menu = await guest.evaluate(() => document.querySelector(".scenes-switcher__menu")?.innerText ?? "");
ok(menu.includes("MY SCENES") || menu.includes("My scenes"), "list: own scenes group", menu.slice(0, 200));
ok(menu.includes(`shared by`) && menu.includes(ALPHA) && menu.includes(BETA), "list: the shared folder's group with its scenes", menu.slice(0, 300));

// 4. opening a scene of it: the folder's space, read-only, the right content
await guest.evaluate((name) => {
  const row = [...document.querySelectorAll(".scenes-switcher__item")].find((el) => el.textContent.includes(name));
  row?.click();
}, BETA);
await sleep(1000);
await ready(guest);
for (let i = 0; i < 40 && (await guest.evaluate(() => window.__scenes?.getState().current).catch(() => null)) !== BETA; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
const opened = await guest.evaluate(() => ({
  space: localStorage.getItem("kurviq-space"),
  current: window.__scenes.getState().current,
  list: window.__scenes.getState().list.map((item) => item.name).filter(Boolean),
  elements: window.__scenes.getApi().getSceneElements().map((e) => Math.round(e.x)),
  viewMode: window.__scenes.getApi().getAppState().viewModeEnabled,
  readOnly: window.__scenes.getState().sync.readOnly,
}));
ok(opened.space === `d:${folderId}` && opened.current === BETA, "guest: in the folder's space with the scene open", opened);
ok(opened.list.includes(ALPHA) && opened.list.includes(BETA), "the folder's scenes are the list", opened.list);
ok(opened.elements.join() === "300", "the scene's content came through the server", opened.elements);
ok(opened.viewMode === true && !!opened.readOnly, "read-only", opened);

// 5. a scene the owner adds later shows up
ok(await create(owner, LATER, 500), "owner: a third scene");
const later = await waitFor("the new scene", async () => {
  const list = await guest.evaluate(async () => {
    await window.__scenes.syncNow({ refresh: true });
    return window.__scenes.getState().list.map((item) => item.name);
  });
  return { done: list.includes(LATER), list };
});
ok(later.done, "the new scene is listed for the guest", later.list);

// 6. the server lets only reads of this folder through
const listPath = `/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id,name)`;
const okList = await proxy(guest, folderId, "GET", listPath);
ok(okList.status === 200 && okList.body.status === 200, "proxy: the folder's listing", okList.body.status);
const alphaId = shared?.scenes.find((s) => s.name === ALPHA)?.fileId;
const write = await proxy(guest, folderId, "PATCH", `/files/${alphaId}`);
ok(write.status === 403 && write.body.code === "refused", "proxy: writes refused", write);
const otherList = await proxy(guest, folderId, "GET", `/files?q=${encodeURIComponent("trashed=false")}`);
ok(otherList.status === 403, "proxy: other listings refused", otherList.status);
const strangerRead = await proxy(stranger, folderId, "GET", listPath);
ok(strangerRead.status === 403 && strangerRead.body.code === "no-access", "proxy: someone it isn't shared with is refused", strangerRead);
// a file of the owner that is not in the folder: the owner's Kurviq folder holds all their scenes, so
// make one elsewhere through the fake Google (a file "from outside Kurviq" in their Drive root)
const outside = await admin("write", { email: OWNER, content: "{}", name: "Outside.excalidraw" });
const outsideId = outside.fileId ?? outside.id ?? outside.file?.id;
const outsideRead = await proxy(guest, folderId, "GET", `/files/${outsideId}?alt=media`);
ok(!!outsideId && outsideRead.status === 200 && outsideRead.body.status === 404, "proxy: a file outside the folder is not found", { outsideId, outsideRead });

// 7. the owner stops sharing: the guest loses the folder
await admin("unshare", { fileId: folderId, email: GUEST });
await ownerChecks(owner);
const gone = await waitFor("unshare", async () => {
  const answer = await folders(guest);
  return { done: !answer.body.folders?.some((folder) => folder.folderId === folderId), answer };
});
ok(gone.done, "guest: the folder is gone after unsharing");
const afterRead = await proxy(guest, folderId, "GET", listPath);
ok(afterRead.status === 404 || afterRead.status === 403, "proxy: no more reads", afterRead);

ok(errors.length === 0, "no page errors", errors);
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
