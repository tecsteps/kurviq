// Own database e2e (specs/2026-11-13-own-database.md): a scene home in the user's own Supabase
// project, against the real shared test project (KURVIQ_TEST_SUPABASE_* in .env; scenes-plugin/test/e2e/supabaseTest.mjs
// applies Kurviq's schema over Postgres) and the real Worker with the fake Google.
// Connect by pasting URL + key (the shown SQL ran), the setting "New scenes are kept", the connection in
// Drive's app data (a second browser of the same Google account), two browsers in real time (strokes,
// pointers, selections, different and same elements), offline edits, an invited guest signing in by a
// generated link (no mail is sent: sign-in mails are answered here, codes and links come from the admin
// API), roles enforced by row-level security, removing access and an end date, a public scene without an
// account, "Move to…" browser → Drive → database → browser with everything, agents through the tab, a
// paused project, and no content or keys through Kurviq's server.
// KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node own-database.mjs
import { createRequire } from "node:module";

import { PROJECT_REF, PUBLISHABLE_KEY, SUPABASE_URL, applySchema, cleanup, configured, deleteUsers, rest, signInLink } from "./supabaseTest.mjs";

const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const TAG = `kq-e2e-${RUN}`;
const mail = (who) => `${who}-${TAG}@example.com`;
const [OWNER, EDITOR, VIEWER, COMMENTER] = ["owner", "editor", "viewer", "commenter"].map(mail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400)}`);
  if (!cond) failed++;
};
if (!configured()) {
  console.log("SKIP: the Supabase test project is not configured in .env");
  process.exit(0);
}

applySchema();
await cleanup("kq-e2e");
await deleteUsers("kq-e2e");

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const errors = [];
/** every request to Kurviq's server (URL and body), for the network check */
const toKurviq = [];
const supabaseHosts = new Set();

const waitFor = async (what, check, tries = 40, ms = 500) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await check().catch((error) => ({ done: false, error: error.message })); // NOSONAR S9382: polling in order on purpose
    if (last?.done) return last;
    await sleep(ms); // NOSONAR S9382: polling in order on purpose
  }
  log("gave up waiting for", what, JSON.stringify(last).slice(0, 300));
  return last ?? {};
};

const ready = async (page) => {
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy && !!window.__kurviqDb).catch(() => false)) { // NOSONAR S9382: polling in order on purpose
      await sleep(1000); // NOSONAR S9382: polling in order on purpose
      return true;
    }
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};

/**
 * A browser context: requests watched (Kurviq's server, the database's host), the database's sign-in
 * mails answered here (no mail is sent), optionally a paused database
 */
const context = async (who, { paused = () => false } = {}) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${who} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(BASE)) {
      toKurviq.push({ who, url, body: request.postData() ?? "" });
    } else if (url.includes(".supabase.co")) {
      supabaseHosts.add(new URL(url).host);
      if (paused()) {
        return request.respond({ status: 503, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "This project is paused" });
      }
      if (/\/auth\/v1\/otp/.test(url) && request.method() === "POST") {
        // the database would email a sign-in link: not in tests (its mailer allows only a few an hour)
        return request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
      }
    }
    return request.continue();
  });
  return page;
};

/** sign in with the fake Google (and Drive) */
const googleSignIn = async (page, email) => {
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
  for (let i = 0; i < 40 && (await page.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
  await ready(page);
};

const clickText = (page, selector, text) =>
  page.evaluate((selector, text) => {
    const target = [...document.querySelectorAll(selector)].find((el) => el.textContent.trim().includes(text));
    target?.click();
    return !!target;
  }, selector, text);

const session = (page) => page.evaluate((ref) => window.__kurviqDb.databases.session(ref), PROJECT_REF);
const state = (page) =>
  page.evaluate(() => {
    const s = window.__scenes.getState();
    const api = window.__scenes.getApi();
    return {
      current: s.current,
      access: s.homeAccess,
      status: s.list.find((item) => item.name === s.current)?.status,
      ids: api.getSceneElements().map((el) => el.id),
      viewMode: api.getAppState().viewModeEnabled,
      collaborators: [...api.getAppState().collaborators.values()].map((c) => ({ name: c.username, pointer: c.pointer, selected: Object.keys(c.selectedElementIds ?? {}) })),
      bar: document.querySelector(".kq-db-bar")?.textContent ?? null,
    };
  });

/** the code from a sign-in mail of the database, typed into the sign-in dialog */
const signInWithCode = async (page, email) => {
  const dialog = await waitFor("the sign-in dialog", async () => ({ done: (await page.evaluate(() => document.querySelector(".kq-db h2")?.textContent ?? "")).startsWith("Sign in to") }), 40);
  if (!dialog.done) {
    log("no sign-in dialog:", await page.evaluate(() => (document.querySelector(".kq-db")?.textContent ?? "(none)").slice(-300)));
  }
  await page.evaluate(() => {
    const input = document.querySelector(".kq-db input[type=email]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.type(".kq-db input[type=email]", email);
  await clickText(page, ".kq-db button", "Email me a sign-in link");
  await page.waitForSelector(".kq-db input[autocomplete=one-time-code]", { timeout: 10000 });
  const { code } = await signInLink(email);
  await page.type(".kq-db input[autocomplete=one-time-code]", code);
  await clickText(page, ".kq-db button", "Sign in with the code");
  return waitFor(`${email} signed in`, async () => ({ done: (await session(page)).status === "signed-in" }), 40);
};

/** a rectangle drawn with the mouse */
const draw = async (page, x, y) => {
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
};

const rowsOf = async (sceneId) => (await rest(`kurviq_elements?scene_id=eq.${sceneId}&select=id,version,data`)).body ?? [];

try {
  // ---------------------------------------------------------------------------
  log("owner: signed in with Google, connects the database by URL and key");
  const owner = await context("owner");
  await googleSignIn(owner, OWNER);
  await owner.click(".scenes-pill__open");
  await sleep(400);
  ok(await clickText(owner, ".scenes-switcher__manage", "Databases"), "the scene list offers Databases…");
  await sleep(300);
  await clickText(owner, ".kq-db-settings button", "Connect a database");
  await owner.waitForSelector(".kq-db__manual summary", { timeout: 10000 });
  await owner.click(".kq-db__manual summary");
  const sqlShown = await waitFor("the SQL", async () => ({ done: (await owner.$eval(".kq-db__manual textarea", (el) => el.value)).includes("create table if not exists public.kurviq_scenes") }), 20);
  ok(sqlShown.done, "the paste-it-yourself setup shows Kurviq's SQL");
  await owner.type('.kq-db__manual input[placeholder^="https://"]', SUPABASE_URL);
  await owner.type('.kq-db__manual input[placeholder^="sb_publishable"]', PUBLISHABLE_KEY);
  await clickText(owner, ".kq-db__manual button", "Connect");
  const signedIn = await signInWithCode(owner, OWNER);
  ok(signedIn.done, "the owner signs in to the database with the email's code");
  const ownerSession = await waitFor("the owner's role", async () => {
    const s = await session(owner);
    return { done: s.spaceRole === "owner", ...s };
  });
  ok(ownerSession.spaceRole === "owner", "the first one in a new space is its owner", ownerSession);
  const stored = await owner.evaluate(() => ({ ...localStorage }));
  const connections = JSON.parse(stored["kurviq-databases"] ?? "{}").connections ?? [];
  ok(connections[0]?.url === SUPABASE_URL && connections[0]?.key === PUBLISHABLE_KEY, "the connection (URL, public key, name) is in this browser", connections[0]?.name);
  ok(!JSON.stringify(stored).includes("sb_secret") && !/mgmt|management/i.test(Object.keys(stored).join()), "no secret key and no management token in the browser's storage");

  // ---------------------------------------------------------------------------
  log("settings: new scenes are kept in the database, after a reload too");
  await owner.evaluate(() => document.querySelector(".scenes-flyover__close")?.click());
  await owner.evaluate((ref) => window.__scenes.setNewScenesHome(`db:${ref}`), PROJECT_REF);
  await owner.reload({ waitUntil: "domcontentloaded" });
  await ready(owner);
  await waitFor("the session after reload", async () => ({ done: (await session(owner)).status === "signed-in" }));
  ok((await owner.evaluate(() => window.__scenes.newScenesHome())) === `db:${PROJECT_REF}`, "the setting survives a reload");
  await owner.click(".scenes-pill__open");
  await sleep(300);
  await clickText(owner, ".scenes-switcher__manage", "Google Drive");
  await sleep(300);
  const options = await owner.$$eval(".kq-db-setting select option", (list) => list.map((option) => option.textContent));
  ok(options.includes("in this browser") && options.includes("in Google Drive") && options.some((text) => text.startsWith("in Team space") || text.startsWith("in ")), "New scenes are kept: in this browser / in Google Drive / in the database", options);
  await owner.evaluate(() => document.querySelector(".scenes-flyover__close")?.click());

  log("a second browser of the same Google account gets the connection from Drive's app data");
  const second = await context("second");
  await googleSignIn(second, OWNER);
  const followed = await waitFor("the connection in the second browser", async () => {
    const list = await second.evaluate(() => window.__kurviqDb.databases.list().map((entry) => entry.ref));
    return { done: list.includes(PROJECT_REF), list };
  }, 30);
  ok(followed.done, "the connection follows through Drive's app data");
  await second.close();

  // ---------------------------------------------------------------------------
  log("a new scene goes to the database; strokes are rows");
  const SCENE = `Plan ${TAG}`;
  await owner.evaluate((name) => window.__scenes.create(name), SCENE);
  const made = await waitFor("the scene's row", async () => {
    const db = await owner.evaluate((name) => window.__scenes.databaseOf(name), SCENE);
    return { done: !!db?.id, db };
  });
  const sceneId = made.db?.id;
  ok(!!sceneId, "the new scene is in the database (its row)", made.db);
  ok(!!(await owner.$(".scenes-pill .scenes-place--database")), "the pill shows the database icon");
  await draw(owner, 400, 300);
  await draw(owner, 560, 300);
  const written = await waitFor("the strokes as rows", async () => {
    const rows = await rowsOf(sceneId);
    return { done: rows.filter((row) => !row.data.isDeleted).length >= 2, count: rows.length };
  });
  ok(written.done, "the owner's strokes are rows in the database", written);

  // ---------------------------------------------------------------------------
  log("sharing: the owner invites an editor by email (the database's mailer)");
  await owner.evaluate(() => document.querySelector(".scenes-pill .scenes-place--private button, .scenes-pill .scenes-place--public button")?.click());
  await owner.waitForSelector(".kq-db__invite input[type=email]", { timeout: 20000 });
  await owner.type(".kq-db__invite input[type=email]", EDITOR);
  await owner.select(".kq-db__invite select", "editor");
  await clickText(owner, ".kq-db__invite button", "Invite");
  const invited = await waitFor("the invitation", async () => {
    const text = await owner.$eval(".kq-db", (el) => el.textContent);
    return { done: text.includes("emailed") && text.includes(EDITOR), text: text.slice(0, 200) };
  });
  ok(invited.done, "the invitation went out through the database's mailer and the editor is listed");
  const link = await owner.evaluate((ref, id) => {
    const connection = window.__kurviqDb.databases.list().find((entry) => entry.ref === ref);
    return `${location.origin}/db/${ref}/${id}#k=${encodeURIComponent(connection.key)}`;
  }, PROJECT_REF, sceneId);
  await owner.evaluate(() => [...document.querySelectorAll(".kq-db button")].find((b) => b.textContent === "Done")?.click());

  log("the editor (no Google account) opens the link and signs in with the code");
  const editor = await context("editor");
  await editor.goto(link, { waitUntil: "domcontentloaded" });
  await ready(editor);
  ok((await editor.evaluate(() => location.hash)) === "", "the link's # part (the key) is cleared from the address");
  ok((await signInWithCode(editor, EDITOR)).done, "the invitee signs in with the email's code");
  const opened = await waitFor("the scene in the editor's browser", async () => {
    const s = await state(editor);
    return { done: s.current === SCENE && s.ids.length >= 2, ...s };
  });
  ok(opened.done, "the invitee is in the scene, with the owner's strokes", { current: opened.current, ids: opened.ids?.length });
  ok(opened.access === null, "an editor may edit (no read-only bar)", opened.access);

  // ---------------------------------------------------------------------------
  log("real time: strokes within a second, pointers with names, selections");
  await sleep(2000);
  const before = (await state(editor)).ids.length;
  await draw(owner, 400, 450);
  const drawnAt = Date.now();
  const seen = await waitFor("the owner's new stroke in the editor's browser", async () => ({ done: (await state(editor)).ids.length > before }), 60, 100);
  const latency = Date.now() - drawnAt;
  ok(seen.done && latency < 1500, "a stroke shows in the other browser within a second", { latency });
  await editor.bringToFront();
  await editor.mouse.move(700, 500);
  await editor.mouse.move(720, 520, { steps: 3 });
  const pointer = await waitFor("the editor's pointer in the owner's browser", async () => {
    const s = await state(owner);
    return { done: s.collaborators.some((c) => c.pointer && c.name?.startsWith("editor-")), collaborators: s.collaborators };
  }, 30, 200);
  ok(pointer.done, "the other's pointer shows with their name", pointer.collaborators?.[0]);
  const target = (await state(editor)).ids[0];
  await editor.evaluate((id) => window.__scenes.getApi().updateScene({ appState: { selectedElementIds: { [id]: true } } }), target);
  await editor.mouse.move(730, 530, { steps: 2 });
  const selection = await waitFor("the editor's selection in the owner's browser", async () => {
    const s = await state(owner);
    return { done: s.collaborators.some((c) => c.selected.includes(target)), collaborators: s.collaborators };
  }, 30, 200);
  ok(selection.done, "the other's selection shows");

  log("different elements at the same time never conflict; the same element: the later version wins");
  const add = (page, id, x) =>
    page.evaluate((id, x) => {
      const api = window.__scenes.getApi();
      const element = { id, type: "rectangle", x, y: 600, width: 40, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false };
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], captureUpdate: "IMMEDIATELY" });
    }, id, x);
  await Promise.all([add(owner, `own${RUN}`, 200), add(editor, `edt${RUN}`, 300)]);
  const both = await waitFor("both new elements in both browsers", async () => {
    const [a, b] = [await state(owner), await state(editor)];
    const want = [`own${RUN}`, `edt${RUN}`];
    return { done: want.every((id) => a.ids.includes(id) && b.ids.includes(id)) };
  }, 30, 200);
  ok(both.done, "two people adding different elements at once: both keep both");
  const setText = (page, id, version, color) =>
    page.evaluate((id, version, color) => {
      const api = window.__scenes.getApi();
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((el) => (el.id === id ? { ...el, strokeColor: color, version, versionNonce: version, updated: Date.now() } : el)), captureUpdate: "IMMEDIATELY" });
    }, id, version, color);
  await setText(owner, `own${RUN}`, 5, "#ff0000");
  await sleep(150);
  await setText(editor, `own${RUN}`, 9, "#0000ff");
  const color = (page) => page.evaluate((id) => window.__scenes.getApi().getSceneElements().find((el) => el.id === id)?.strokeColor, `own${RUN}`);
  const settled = await waitFor("the same element settled", async () => {
    const rows = await rowsOf(sceneId);
    const row = rows.find((entry) => entry.id === `own${RUN}`);
    const [a, b] = [await color(owner), await color(editor)];
    return { done: a === "#0000ff" && b === "#0000ff" && row?.data.strokeColor === "#0000ff", a, b, db: row?.data.strokeColor };
  }, 30, 300);
  ok(settled.done, "the same element changed in two places: the later (higher) version wins everywhere", settled);
  ok((await state(owner)).ids.includes(`edt${RUN}`), "nothing else is lost");

  // ---------------------------------------------------------------------------
  log("offline: the editor's edits wait and are written when back");
  await editor.setOfflineMode(true);
  await sleep(500);
  await add(editor, `off${RUN}`, 450);
  const pending = await waitFor("pending", async () => {
    const s = await state(editor);
    return { done: s.status === "database-pending", status: s.status };
  }, 30, 300);
  ok(pending.done, "offline, the scene shows changes not in the database yet", pending.status);
  await editor.setOfflineMode(false);
  const back = await waitFor("the offline edit in the database and the owner's browser", async () => ({ done: (await rowsOf(sceneId)).some((row) => row.id === `off${RUN}`) && (await state(owner)).ids.includes(`off${RUN}`) }), 60, 500);
  ok(back.done, "back online, the offline edit is written and the other browser has it");

  // ---------------------------------------------------------------------------
  log("an invited viewer signs in by a generated link: read only, a write is refused by the database");
  await owner.evaluate((ref, id, email) => window.__kurviqDb.sceneAccess.set(ref, id, email, "viewer", null), PROJECT_REF, sceneId, VIEWER);
  const viewer = await context("viewer");
  const viewerLink = await signInLink(VIEWER, link);
  await viewer.goto(viewerLink.link, { waitUntil: "domcontentloaded" });
  await ready(viewer);
  const viewing = await waitFor("the viewer in the scene", async () => {
    const s = await state(viewer);
    return { done: s.current === SCENE && s.viewMode && !!s.access, ...s };
  }, 60);
  ok(viewing.done && viewing.access?.comment === false, "the viewer is in, read only, without commenting", viewing.access);
  ok((await viewer.evaluate(() => location.hash)) === "", "the email link's tokens are cleared from the address");
  const refused = await viewer.evaluate(async (ref, id) => {
    const client = await window.__kurviqDb.clientFor(ref);
    const { error } = await client.rpc("kurviq_put_elements", { scene: id, elements: [{ id: "hack", version: 99, versionNonce: 1 }] });
    return error?.message ?? null;
  }, PROJECT_REF, sceneId);
  ok(/row-level security/.test(refused ?? ""), "a viewer's write is refused by the database (row-level security)", refused);

  log("a commenter comments, and only that; an end date ends the access");
  await owner.evaluate((ref, id, email) => window.__kurviqDb.sceneAccess.set(ref, id, email, "commenter", new Date(Date.now() + 25000).toISOString()), PROJECT_REF, sceneId, COMMENTER);
  const commenter = await context("commenter");
  await commenter.goto(link, { waitUntil: "domcontentloaded" });
  await ready(commenter);
  ok((await signInWithCode(commenter, COMMENTER)).done, "the commenter signs in");
  const commenting = await waitFor("the commenter in the scene", async () => {
    const s = await state(commenter);
    return { done: s.current === SCENE && !!s.access, ...s };
  }, 60);
  ok(commenting.access?.comment === true && commenting.viewMode, "a commenter may comment, not edit", commenting.access);
  const comment = await commenter.evaluate(async (ref, id, email) => {
    const client = await window.__kurviqDb.clientFor(ref);
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kurviq-comment:${email}`)));
    const key = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const now = Date.now();
    const own = { id: `cmt${now}`, thread: `cmt${now}`, by: { name: "C", key }, at: now, u: now, text: "Looks good", pin: { x: 10, y: 10 } };
    const mine = await client.rpc("kurviq_put_comments", { scene: id, comments: [own] });
    const forged = await client.rpc("kurviq_put_comments", { scene: id, comments: [{ ...own, id: `cmx${now}`, thread: `cmx${now}`, by: { name: "E", key: "0000000000000000" } }] });
    const edit = await client.rpc("kurviq_put_elements", { scene: id, elements: [{ id: "hack2", version: 1, versionNonce: 1 }] });
    return { mine: mine.error?.message ?? "ok", forged: forged.error?.message ?? "ok", edit: edit.error?.message ?? "ok" };
  }, PROJECT_REF, sceneId, COMMENTER);
  ok(comment.mine === "ok" && /own/.test(comment.forged) && /row-level security/.test(comment.edit), "a commenter's own comment is taken, one as someone else and any edit are refused", comment);
  const commentSeen = await waitFor("the comment in the owner's scene", async () => ({ done: await owner.evaluate(() => (JSON.parse(window.__scenes.currentSceneJson()).kurviqComments ?? []).some((c) => c.text === "Looks good")) }), 30);
  ok(commentSeen.done, "the comment shows in the others' scene (real time)");

  log("removing access ends it at the next request; the end date ends it then");
  await owner.evaluate((ref, id, email) => window.__kurviqDb.sceneAccess.remove(ref, id, email), PROJECT_REF, sceneId, VIEWER);
  const removed = await viewer.evaluate(async (ref, id) => {
    const client = await window.__kurviqDb.clientFor(ref);
    const { data } = await client.from("kurviq_elements").select("id").eq("scene_id", id);
    return data?.length ?? -1;
  }, PROJECT_REF, sceneId);
  ok(removed === 0, "a removed viewer reads nothing at their next request", removed);
  const ended = await waitFor("the viewer's tab says the access ended", async () => {
    const s = await state(viewer);
    return { done: /no access/.test(s.access?.readOnly ?? ""), access: s.access };
  }, 80, 500);
  ok(ended.done, "the removed viewer's open scene stops (no access any more)", ended.access);
  const expired = await waitFor("the commenter's end date", async () => {
    const role = await commenter.evaluate(async (ref, id) => (await (await window.__kurviqDb.clientFor(ref)).rpc("kurviq_scene_role", { scene: id })).data, PROJECT_REF, sceneId);
    return { done: role === null, role };
  }, 40, 1000);
  ok(expired.done, "an end date ends the access at that date");
  await viewer.close();
  await commenter.close();

  // ---------------------------------------------------------------------------
  log("a public scene opens without an account, read only, without comments");
  await owner.evaluate((name, ref) => window.__kurviqDb.databaseHome(ref).setPublic(name, true), SCENE, PROJECT_REF);
  const visitor = await context("visitor");
  await visitor.goto(link, { waitUntil: "domcontentloaded" });
  const shownPublic = await waitFor("the public viewer", async () => {
    const view = await visitor.evaluate(() => ({ title: document.querySelector(".public-scene__title")?.textContent ?? null, comments: !!document.querySelector(".public-scene .kq-comments-button, .public-scene [aria-label*=omment]"), elements: window.__publicViewer?.getSceneElements().length ?? 0 }));
    return { done: !!view.title && view.elements > 0, ...view };
  }, 60);
  ok(shownPublic.done && shownPublic.title === SCENE, "anyone with the link sees it without an account", shownPublic);
  ok(!shownPublic.comments, "the public view has no comments");
  const anonWrite = await visitor.evaluate(async (ref, id) => {
    const client = await window.__kurviqDb.clientFor(ref);
    return (await client.rpc("kurviq_put_elements", { scene: id, elements: [{ id: "x", version: 1, versionNonce: 1 }] })).error?.message ?? "ok";
  }, PROJECT_REF, sceneId);
  ok(anonWrite !== "ok", "an anonymous visitor can't write", anonWrite);
  await visitor.close();

  // ---------------------------------------------------------------------------
  log("agents through the user's tab: read with comments, edit, on the open scene and on one that isn't open");
  const agent = (command) => owner.evaluate((c) => window.__agentCommand(c), command);
  const flushed = await agent({ type: "flush", name: SCENE });
  ok(flushed?.ok !== false && (flushed.result?.localOnly ?? flushed.localOnly) === true, "flush: a database scene is read and edited through the tab", flushed);
  const read = await agent({ type: "local-read", name: SCENE });
  const readFile = read.result?.file ?? read.file;
  ok((readFile?.kurviqComments ?? []).some((c) => c.text === "Looks good") && readFile.elements.length >= 5, "read_scene through the tab has the elements and the comments", { elements: readFile?.elements?.length });
  const edited = await agent({ type: "local-edit", name: SCENE, add: [{ type: "rectangle", id: `agent${RUN}`, x: 800, y: 200, width: 80, height: 60 }], comments: [{ action: "add", text: "From the agent", element: `agent${RUN}` }] });
  ok(edited.ok !== false, "edit_scene through the tab", edited.error);
  const agentSeen = await waitFor("the agent's element in the editor's browser and the database", async () => ({
    done: (await state(editor)).ids.includes(`agent${RUN}`) && (await rowsOf(sceneId)).some((row) => row.id === `agent${RUN}`),
  }), 40);
  ok(agentSeen.done, "the agent's edit reaches the database and the other browser live");
  const agentComment = await waitFor("the agent's comment row", async () => ({ done: ((await rest(`kurviq_comments?scene_id=eq.${sceneId}&select=data`)).body ?? []).some((row) => row.data.text === "From the agent") }), 30);
  ok(agentComment.done, "the agent's comment is a row in the database");
  // the owner switches away: an agent edit of the scene that isn't open goes to the database too
  await owner.evaluate((name) => window.__scenes.create(name, { localOnly: true }), `Other ${TAG}`);
  await sleep(800);
  const edited2 = await agent({ type: "local-edit", name: SCENE, add: [{ type: "ellipse", id: `agent2${RUN}`, x: 900, y: 300, width: 50, height: 50 }] });
  ok(edited2.ok !== false, "edit_scene on a database scene that isn't open", edited2.error);
  const agentSeen2 = await waitFor("the agent's second element in the editor's browser", async () => ({ done: (await state(editor)).ids.includes(`agent2${RUN}`) }), 40);
  ok(agentSeen2.done, "it reaches the database and the browser that has it open");

  // ---------------------------------------------------------------------------
  log("Move to…: this browser → Google Drive → the database → this browser, with everything");
  const MOVED = `Move ${TAG}`;
  const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const file = {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [
      { id: `fr${RUN}`, type: "frame", x: 0, y: 0, width: 400, height: 300, angle: 0, strokeColor: "#bbb", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 2, versionNonce: 2, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, name: "Slide 1" },
      { id: `img${RUN}`, type: "image", fileId: `file${RUN}`, status: "saved", scale: [1, 1], crop: null, x: 20, y: 20, width: 50, height: 50, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: `fr${RUN}`, roundness: null, seed: 1, version: 2, versionNonce: 3, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false },
    ],
    appState: { name: MOVED, viewBackgroundColor: "#fdf6e3", kurviqPresentation: true },
    files: { [`file${RUN}`]: { id: `file${RUN}`, mimeType: "image/png", dataURL: picture, created: 1 } },
    kurviqComments: [{ id: `cmt${RUN}0`, thread: `cmt${RUN}0`, by: { name: "Ann", key: "0123456789abcdef" }, at: 1, u: 1, text: "Moved along", pin: { x: 5, y: 5 } }],
  };
  await agent({ type: "local-save", name: MOVED, json: JSON.stringify(file) });
  await owner.evaluate((name) => window.__scenes.open(name), MOVED);
  await sleep(800);
  const everything = (json) => {
    const data = JSON.parse(json);
    return {
      elements: data.elements.filter((el) => !el.isDeleted).map((el) => el.id).sort(),
      picture: data.files?.[`file${RUN}`]?.dataURL === picture,
      comments: (data.kurviqComments ?? []).map((c) => c.text),
      background: data.appState?.viewBackgroundColor,
      presentation: data.appState?.kurviqPresentation,
    };
  };
  const want = { elements: [`fr${RUN}`, `img${RUN}`].sort(), picture: true, comments: ["Moved along"], background: "#fdf6e3", presentation: true };
  const moveVia = async (target, label) => {
    if (!(await owner.$('button[aria-label="Move to…"]'))) {
      await owner.evaluate(() => document.querySelector(".scenes-pill__pen button")?.click());
      await sleep(300);
    }
    await owner.evaluate(() => document.querySelector('button[aria-label="Move to…"]')?.click());
    await owner.waitForSelector('input[name="kq-move"]', { timeout: 10000 });
    await owner.evaluate((label) => [...document.querySelectorAll(".kq-db__choice")].find((el) => el.textContent.includes(label))?.querySelector("input")?.click(), label);
    await clickText(owner, ".kq-db button", "Move");
    const moved = await waitFor(`moved to ${label}`, async () => ({ done: (await owner.evaluate(() => document.querySelector(".kq-db")?.textContent ?? "")).includes("is in") }), 60);
    return moved.done;
  };
  ok(await moveVia("drive", "Google Drive"), "Move to Google Drive");
  await owner.evaluate(() => [...document.querySelectorAll(".kq-db button")].find((b) => b.textContent === "Done")?.click());
  const inDrive = everything(await owner.evaluate(async (name) => (await window.__scenes.drive.load(name)).json, MOVED));
  ok(JSON.stringify(inDrive) === JSON.stringify(want), "in Drive with everything (elements, picture, comment, background, presentation)", inDrive);
  const fileId = await owner.evaluate((name) => window.__scenes.fileIdOf(name), MOVED);

  const spaceName = await owner.evaluate((ref) => window.__kurviqDb.databases.list().find((entry) => entry.ref === ref).name, PROJECT_REF);
  ok(await moveVia("db", spaceName), "Move from Drive to the database");
  const offered = await owner.evaluate(() => document.querySelector(".kq-db")?.textContent ?? "");
  ok(offered.includes("Delete the old copy"), "deleting the old copy is offered");
  const note = await owner.evaluate(async (id) => window.__scenes.drive.movedTo(id), fileId);
  ok(note?.home === "database" && note.link.includes(`/db/${PROJECT_REF}/`), "the old Drive file carries the 'moved' note with the new link", note);
  await clickText(owner, ".kq-db button", "Delete the old copy");
  await sleep(1500);
  const movedDb = await owner.evaluate((name) => window.__scenes.databaseOf(name), MOVED);
  const inDb = everything(await owner.evaluate(async (ref, name) => (await window.__kurviqDb.databaseHome(ref).load(name)).json, PROJECT_REF, MOVED));
  ok(JSON.stringify(inDb) === JSON.stringify(want), "in the database with everything (the picture in its storage bucket)", inDb);
  const stillInDrive = await owner.evaluate(async (name) => (await window.__scenes.drive.list(true)).scenes.some((scene) => scene.name === name), MOVED);
  ok(!stillInDrive, "the old copy is gone from Drive (its bin)");
  await owner.evaluate(() => [...document.querySelectorAll(".kq-db button")].find((b) => b.textContent === "Done")?.click());

  ok(await moveVia("browser", "This browser only"), "Move from the database to this browser");
  const movedRow = (await rest(`kurviq_scenes?id=eq.${movedDb.id}&select=moved_to`)).body?.[0];
  ok(movedRow?.moved_to?.home === "browser", "the database's row keeps a 'moved' note", movedRow);
  const inBrowser = everything(await owner.evaluate((name) => window.__scenes.sceneJsonHere(name), MOVED));
  ok(JSON.stringify(inBrowser) === JSON.stringify(want), "back in this browser with everything", inBrowser);
  await owner.evaluate(() => document.querySelector(".kq-db .kq-close")?.click());

  // a link to the moved database scene opens the note
  const linkPage = await context("old-link");
  await linkPage.goto(`${BASE}/db/${PROJECT_REF}/${movedDb.id}#k=${encodeURIComponent(PUBLISHABLE_KEY)}`, { waitUntil: "domcontentloaded" });
  await ready(linkPage);
  await waitFor("the guest's session state", async () => ({ done: (await session(linkPage)).status !== "unknown" }), 30);
  // (a signed-out guest gets the sign-in first; the owner's browser shows the note:)
  await owner.goto(`${BASE}/db/${PROJECT_REF}/${movedDb.id}`, { waitUntil: "domcontentloaded" });
  await ready(owner);
  const movedNote = await waitFor("the moved note", async () => ({ done: (await owner.evaluate(() => document.querySelector(".kq-db")?.textContent ?? "")).includes("This scene moved") }), 40);
  ok(movedNote.done, "a link to the old place says the scene moved, with the new link");
  await owner.evaluate(() => document.querySelector(".kq-db .kq-close")?.click());
  await linkPage.close();

  // ---------------------------------------------------------------------------
  log("a paused free project: the message, with the way to wake it");
  let pausedNow = false;
  const pausedPage = await context("paused", { paused: () => pausedNow });
  await googleSignIn(pausedPage, OWNER);
  await waitFor("the connection from Drive", async () => ({ done: (await pausedPage.evaluate(() => window.__kurviqDb.databases.list().length)) > 0 }), 30);
  await waitFor("signed in? (a fresh browser: not yet)", async () => ({ done: (await session(pausedPage)).status !== "unknown" }), 30);
  pausedNow = true;
  const probe = await pausedPage.evaluate(async (url, key) => {
    const { createProbe } = window.__kurviqDb;
    return createProbe ? createProbe({ url, key }) : null;
  }, SUPABASE_URL, PUBLISHABLE_KEY);
  await pausedPage.evaluate(() => {
    document.querySelector(".scenes-pill__open")?.click();
  });
  await sleep(300);
  await clickText(pausedPage, ".scenes-switcher__manage", "Databases");
  await sleep(300);
  await clickText(pausedPage, ".kq-db-settings button", "Connect a database");
  await pausedPage.waitForSelector(".kq-db__manual summary", { timeout: 10000 });
  await pausedPage.click(".kq-db__manual summary");
  await pausedPage.type('.kq-db__manual input[placeholder^="https://"]', SUPABASE_URL);
  await pausedPage.type('.kq-db__manual input[placeholder^="sb_publishable"]', PUBLISHABLE_KEY);
  await clickText(pausedPage, ".kq-db__manual button", "Connect");
  const pausedText = await waitFor("the paused message", async () => {
    const text = await pausedPage.evaluate(() => document.querySelector(".kq-db .scenes-error")?.textContent ?? "");
    return { done: text.includes("paused"), text };
  }, 30);
  ok(pausedText.text === "Your database is paused: open Supabase to wake it", "a paused project: “Your database is paused: open Supabase to wake it”", { probe, text: pausedText.text });
  pausedNow = false;
  await pausedPage.close();

  // ---------------------------------------------------------------------------
  log("Connect with Supabase: OAuth (PKCE) against a mocked Supabase, project created, schema run, token dropped");
  const oauth = await browser.createIncognitoBrowserContext();
  const oauthPage = await oauth.newPage();
  oauthPage.on("pageerror", (e) => errors.push(`oauth PAGEERROR: ${e.message.slice(0, 200)}`));
  oauthPage.on("dialog", (d) => d.accept().catch(() => {}));
  const management = [];
  const NEW_REF = "zyxwvutsrqponmlkjihg";
  let polls = 0;
  await oauthPage.setRequestInterception(true);
  oauthPage.on("request", (request) => {
    const url = new URL(request.url());
    const json = (body, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.host === "api.supabase.com" && url.pathname === "/v1/oauth/authorize") {
      management.push({ authorize: Object.fromEntries(url.searchParams) });
      // Supabase's consent page, allowed at once: back to Kurviq with a code and the state sent
      return request.respond({ status: 302, headers: { Location: `${BASE}/auth/supabase/callback?code=the-code&state=${url.searchParams.get("state")}` } });
    }
    if (url.origin === BASE && url.pathname === "/api/supabase/token") {
      management.push({ token: JSON.parse(request.postData()) });
      return json({ accessToken: "mgmt-token-e2e", expiresIn: 3600 });
    }
    if (url.origin === BASE && url.pathname.startsWith("/api/supabase/v1/")) {
      const path = url.pathname.slice("/api/supabase/v1".length);
      management.push({ call: `${request.method()} ${path}`, auth: request.headers().authorization, body: request.postData() ?? null });
      if (path === "/organizations") return json([{ id: "org1", name: "Tecsteps" }]);
      if (path === "/projects" && request.method() === "GET") return json([]);
      if (path === "/projects" && request.method() === "POST") return json({ id: NEW_REF, name: "Kurviq", region: "eu-central-1", organization_id: "org1", status: "COMING_UP" });
      if (path === `/projects/${NEW_REF}`) return json({ id: NEW_REF, name: "Kurviq", region: "eu-central-1", organization_id: "org1", status: ++polls > 1 ? "ACTIVE_HEALTHY" : "COMING_UP" });
      if (path.endsWith("/database/query")) return json([]);
      if (path.endsWith("/config/auth")) return json(request.method() === "GET" ? { site_url: "http://localhost:3000", uri_allow_list: "" } : {});
      if (path.endsWith("/api-keys")) return json([{ type: "publishable", name: "default", api_key: "sb_publishable_e2e_new_project" }]);
      return json({ message: "unexpected" }, 404);
    }
    if (url.host === `${NEW_REF}.supabase.co`) {
      return request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: "{}" });
    }
    return request.continue();
  });
  await oauthPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await ready(oauthPage);
  await oauthPage.click(".scenes-pill__open");
  await sleep(300);
  await clickText(oauthPage, ".scenes-switcher__manage", "Databases");
  await sleep(300);
  await clickText(oauthPage, ".kq-db-settings button", "Connect a database");
  await oauthPage.waitForSelector(".kq-db input[type=email]", { timeout: 10000 });
  await oauthPage.type(".kq-db input[type=email]", OWNER);
  await clickText(oauthPage, ".kq-db button", "Connect with Supabase");
  await waitFor("back from Supabase", async () => ({ done: (await oauthPage.evaluate(() => document.querySelector(".kq-db h2")?.textContent ?? "")) === "Connect with Supabase" }), 60);
  await ready(oauthPage);
  await waitFor("the projects", async () => ({ done: (await oauthPage.evaluate(() => document.querySelectorAll(".kq-db__choice").length)) > 0 }), 30);
  await clickText(oauthPage, ".kq-db button", "Create and connect");
  const password = await waitFor("the password shown once", async () => {
    const text = await oauthPage.evaluate(() => document.querySelector(".kq-db__secret")?.textContent ?? "");
    return { done: text.length === 24, text };
  }, 40);
  ok(password.done, "a new project's database password is shown once");
  const oauthSignIn = await waitFor("the sign-in step", async () => ({ done: (await oauthPage.evaluate(() => document.querySelector(".kq-db h2")?.textContent ?? "")).startsWith("Sign in to") }), 60);
  ok(oauthSignIn.done, "after the setup: sign in to the new database");
  const authorize = management.find((entry) => entry.authorize)?.authorize ?? {};
  ok(authorize.code_challenge_method === "S256" && authorize.code_challenge?.length === 43 && authorize.redirect_uri === `${BASE}/auth/supabase/callback`, "Supabase's OAuth with PKCE (S256)", authorize);
  const tokenCall = management.find((entry) => entry.token)?.token ?? {};
  ok(tokenCall.code === "the-code" && /^[\w-]{43}$/.test(tokenCall.codeVerifier ?? ""), "the code and its verifier go to the Worker's exchange");
  const calls = management.filter((entry) => entry.call).map((entry) => entry.call);
  ok(calls.includes("POST /projects") && calls.filter((call) => call.endsWith("/database/query")).length === 2 && calls.some((call) => call.endsWith("/api-keys")), "the project is created, the schema and owner run, the public key read", calls);
  const created = management.find((entry) => entry.call === "POST /projects");
  ok(JSON.parse(created.body).db_pass === password.text, "the password shown is the new database's");
  ok(management.filter((entry) => entry.call).every((entry) => entry.auth === "Bearer mgmt-token-e2e"), "the management token goes with each setup call");
  const oauthStorage = await oauthPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  ok(!oauthStorage.includes("mgmt-token-e2e") && !oauthStorage.includes(password.text), "neither the management token nor the password is kept in the browser's storage");
  ok(oauthStorage.includes("sb_publishable_e2e_new_project"), "the connection (with the public key) is kept");
  await oauth.close();

  // ---------------------------------------------------------------------------
  log("nothing passes Kurviq's servers: the browsers talk to supabase.co directly");
  // (the fake Google is served by the dev Worker: those requests are Google Drive's, e.g. the connection in its app data)
  const leaks = toKurviq.filter(({ url }) => !new URL(url).pathname.startsWith("/fake-google/")).filter(({ url, body }) => url.includes(PUBLISHABLE_KEY) || body.includes(PUBLISHABLE_KEY) || /access_token|refresh_token/.test(url + body) || body.includes(`own${RUN}`) || body.includes("Looks good") || body.includes(sceneId)); // (the link's path names the scene: /db/<ref>/<id>, by design)
  ok(leaks.length === 0, "no database content, key or session in any request to Kurviq's server", leaks.slice(0, 3));
  ok(supabaseHosts.has(new URL(SUPABASE_URL).host), "the browsers talked to the database directly", [...supabaseHosts]);
  const kurviqApis = [...new Set(toKurviq.map(({ url }) => new URL(url).pathname).filter((path) => path.startsWith("/api/") && !path.startsWith("/api/app")))];
  ok(!kurviqApis.some((path) => path.startsWith("/api/supabase")), "not even the setup's pass-through was used (paste URL + key)", kurviqApis);
} catch (error) {
  failed++;
  console.log("FAIL (exception)", error.stack ?? error);
} finally {
  if (errors.length) {
    console.log("page errors:", errors.slice(0, 10));
  }
  await browser.close().catch(() => {});
  await cleanup(TAG).catch((error) => console.log("cleanup failed", error.message));
  await deleteUsers(TAG).catch((error) => console.log("user cleanup failed", error.message));
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
}
