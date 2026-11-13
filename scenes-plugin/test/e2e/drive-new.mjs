// Google Drive's "New → More → Kurviq" e2e (specs/2026-11-13-new-scene-from-drive.md, acceptance
// criteria 1-4). Drive's redirect is simulated: Drive opens /drive/new?state={"action":"create",
// "folderId":…,"userId":…} as the signed-in account; the folder is a plain folder of that account
// in My Drive, made "in Drive" (fake Google's admin/write), not Kurviq's folder.
// Real Worker started with --var DRIVE_NEW:on + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME. Usage: node drive-new.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const [OWNER, OTHER, LATE] = ["dno", "dnx", "dnl"].map((who) => `${who}${RUN}@example.test`);
const FOLDER_MIME = "application/vnd.google-apps.folder";
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
const newPage = async (label) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return page;
};
/** through the fake Google's sign-in page as this account (where the page is at Google's) */
const approve = async (page, email) => {
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
};
const signIn = async (email) => {
  const page = await newPage(email.slice(0, 3));
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  await approve(page, email);
  for (let i = 0; i < 40 && (await page.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
  await ready(page);
  return page;
};
/** the signed-in account as the app knows it ({ email, sub }) and its access token */
const account = (page) => page.evaluate(async () => (await fetch("/auth/token", { method: "POST" })).json());
/** the scene files in a folder, listed with this account's token */
const filesIn = (page, folderId) =>
  page.evaluate(async (folderId) => {
    const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const res = await fetch(`/fake-google/drive/v3/files?q=${q}&fields=files(id,name,parents,appProperties,mimeType)`, { headers: { Authorization: `Bearer ${token}` } });
    return (await res.json()).files ?? [];
  }, folderId);
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
const dialogText = (page) => page.evaluate(() => document.querySelector("dialog.kq-drive-new")?.innerText ?? "");
const driveNewUrl = (folderId, userId) => `${BASE}/drive/new?state=${encodeURIComponent(JSON.stringify({ action: "create", folderId, userId }))}`;
/** the scene list (pill), every group unfolded: its text */
const listText = async (page) => {
  await page.click(".scenes-pill__open");
  await sleep(1200);
  await page.evaluate(() => document.querySelectorAll(".scenes-switcher__group[aria-expanded='false']").forEach((el) => el.click()));
  await sleep(400);
  return page.evaluate(() => document.querySelector(".scenes-switcher__menu")?.innerText ?? "");
};

// the owner, signed in to Kurviq, with a project folder in their Drive (made in Drive, not by Kurviq)
const owner = await signIn(OWNER);
const { user } = await account(owner);
ok(typeof user?.sub === "string" && user.sub.length > 0, "the app knows the account id (sub)", user);
const folder = await admin("write", { email: OWNER, name: `Project ${RUN}`, mimeType: FOLDER_MIME, content: "" });
const folderId = folder.id ?? folder.fileId;
ok(!!folderId, "a project folder in the owner's Drive", folder);

// 4. the route only passes Drive's state on: a redirect to the app, no cookie, nothing kept (worker/driveNew.ts has no storage)
const route = await fetch(driveNewUrl(folderId, user.sub), { redirect: "manual" });
const location = new URL(route.headers.get("location") ?? "/", BASE);
const passed = JSON.parse(location.searchParams.get("drive-new") ?? "null");
ok(route.status === 302 && location.pathname === "/" && passed?.folderId === folderId && passed?.userId === user.sub, "4: /drive/new hands the state to the app", { status: route.status, location: location.href });
ok(!route.headers.get("set-cookie"), "4: no cookie set");
const broken = await fetch(`${BASE}/drive/new?state=${encodeURIComponent("{\"action\":\"open\"}")}`, { redirect: "manual" });
ok(broken.status === 400, "4: a broken state gets an explanation, not the app", broken.status);

// 2. signed in to Kurviq as another account: told which account to use, nothing created
const other = await signIn(OTHER);
await other.goto(driveNewUrl(folderId, user.sub), { waitUntil: "domcontentloaded" });
const otherText = (await waitFor("sign-in hint", async () => {
  const value = await dialogText(other);
  return { done: value.includes("Sign in as the account you used in Drive"), value };
})).value ?? "";
ok(otherText.includes(OTHER) && otherText.includes("Nothing was created"), "2: another account is told to sign in as Drive's account", otherText);
ok(!(await other.$("#kq-drive-new-name")), "2: no name field for another account");
ok((await filesIn(owner, folderId)).length === 0, "2: nothing created in the folder");

// signed out: the same hint; signing in from it (Google preselects Drive's account) comes back to the name dialog
const late = await newPage("late");
await late.goto(driveNewUrl(folderId, user.sub), { waitUntil: "domcontentloaded" });
const lateText = (await waitFor("signed-out hint", async () => {
  const value = await dialogText(late);
  return { done: value.includes("Sign in with Google"), value };
})).value ?? "";
ok(lateText.includes("sign in with the Google account you used in Drive"), "2: signed out: asked to sign in", lateText);
await Promise.all([late.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), late.evaluate(() => [...document.querySelectorAll("dialog.kq-drive-new button")].find((b) => b.textContent.includes("Sign in with Google"))?.click())]);
ok(late.url().includes("login_hint=" + encodeURIComponent(user.sub)) || late.url().includes(`login_hint=${user.sub}`), "2: Google is asked for Drive's account (login_hint)", late.url().slice(0, 200));
await approve(late, LATE);
const lateBack = (await waitFor("late account's hint", async () => {
  const value = await dialogText(late);
  return { done: value.includes(LATE), value };
})).value ?? "";
ok(lateBack.includes("Nothing was created"), "2: signed in as yet another account: still refused", lateBack);

// 1. signed in as Drive's account: asked for a name, the scene is created in that folder and opens.
// Without access to the folder (drive.file) Drive refuses the file: the dialog says so, nothing is made.
const NAME = `Drive New ${RUN}`;
await owner.goto(driveNewUrl(folderId, user.sub), { waitUntil: "domcontentloaded" });
await owner.waitForSelector("#kq-drive-new-name", { timeout: 20000 });
await owner.type("#kq-drive-new-name", NAME);
await owner.keyboard.press("Enter");
const refused = (await waitFor("refusal", async () => {
  const value = await dialogText(owner);
  return { done: value.includes("doesn't let Kurviq create"), value };
})).value ?? "";
ok(refused.includes("doesn't let Kurviq create") && (await filesIn(owner, folderId)).length === 0, "1: a folder Kurviq may not write to: said so, nothing created", refused);
// Drive's New opens Kurviq for that folder: the folder is granted to the app (as "Open with" grants a file;
// the fake models it with admin/grant, to verify with the real Google: spec "Open")
await admin("grant", { email: OWNER, fileId: folderId });
await owner.goto(driveNewUrl(folderId, user.sub), { waitUntil: "domcontentloaded" });
const nameText = (await waitFor("name dialog", async () => {
  const value = await dialogText(owner);
  return { done: value.includes("New Kurviq scene") && value.includes(`Project ${RUN}`), value };
})).value ?? "";
ok(nameText.includes(`Project ${RUN}`), "1: the dialog names the Drive folder", nameText);
await owner.waitForSelector("#kq-drive-new-name", { timeout: 10000 });
await owner.type("#kq-drive-new-name", NAME);
await Promise.all([owner.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}), owner.keyboard.press("Enter")]);
await ready(owner);
const created = await waitFor("scene file in the folder", async () => {
  const files = await filesIn(owner, folderId);
  return { done: files.length === 1, files };
});
const file = created.files?.[0];
ok(file?.name === `${NAME}.excalidraw` && file?.appProperties?.kurviq === "scene" && file?.mimeType === "application/vnd.excalidraw+json", "1: the scene's file is in the Drive folder, marked as a Kurviq scene", file);
const opened = await waitFor("scene open", async () => {
  const state = await owner.evaluate(() => ({ url: location.pathname, current: window.__scenes?.getState().current }));
  return { done: state.current === NAME, ...state };
});
ok(opened.current === NAME && opened.url === `/s/${file?.id}/${encodeURIComponent(NAME)}`, "1: it opens in Kurviq", opened);
ok(!(await dialogText(owner)), "1: no dialog left");
// drawing in it saves to that file
await owner.evaluate(() => {
  window.__scenes.getApi().updateScene({
    elements: [{
      id: "dnrect1", type: "rectangle", x: 100, y: 100, width: 80, height: 50, angle: 0,
      strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
      roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
      versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    }],
    captureUpdate: "IMMEDIATELY",
  });
});
const saved = await waitFor("drawing saved to Drive", async () => {
  await owner.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
  const info = await admin(`file?fileId=${file?.id}`);
  const revisions = await admin(`revisions?fileId=${file?.id}&content=1`);
  const text = JSON.stringify(revisions);
  return { done: text.includes("dnrect1"), size: info.size };
}, 30);
ok(saved.done, "1: what is drawn is saved into the file in the folder");

// 3. listed under "Other folders", and opens from there after a reload (from the owner's own scenes)
await owner.evaluate(() => localStorage.removeItem("kurviq-space"));
await owner.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await ready(owner);
const list = await listText(owner);
ok(/Other folders/i.test(list) && list.includes(NAME), "3: the scene list shows it under \"Other folders\"", list.slice(0, 400));
await Promise.all([
  owner.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
  owner.evaluate((name) => [...document.querySelectorAll(".scenes-switcher__item")].find((el) => el.textContent.includes(name))?.click(), NAME),
]);
await ready(owner);
const reopened = await waitFor("reopened from the list", async () => {
  const state = await owner.evaluate(() => ({ url: location.pathname, current: window.__scenes?.getState().current, elements: window.__scenes?.getApi()?.getSceneElements().length }));
  return { done: state.current === NAME && state.elements === 1, ...state };
});
ok(reopened.done, "3: it opens from the list, with what was drawn", reopened);
await owner.reload({ waitUntil: "domcontentloaded" });
await ready(owner);
const again = await listText(owner);
ok(again.includes(NAME), "3: still listed after a reload", again.slice(0, 300));
await owner.keyboard.press("Escape");

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
