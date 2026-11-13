// Comment polish e2e (specs/2026-11-13-comment-polish.md, criteria 1-5): Shift+C starts placing a
// comment and Esc cancels it / closes the popover, but not while typing; the list's filters (open,
// resolved, mine, mentioning me) with their counts; the unread dot per browser (cleared by opening the
// thread, kept after a reload, a second browser keeps its own); "hide resolved after 7 days" for pins and
// list; the number of open threads in the scene list.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node comments-polish.mjs
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `cpo${RUN}@example.test`;
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
/** scenes-mcp/sceneComments.mjs authorKey */
const authorKey = (email) => createHash("sha256").update(`kurviq-comment:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);

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
const signIn = async (email) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email.slice(0, 3)} PAGEERROR: ${e.message.slice(0, 200)}`));
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
  await ready(page);
  return { ctx, page };
};
const rect = (id, x) => ({
  id, type: "rectangle", x, y: 100, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0",
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
});

const placing = (page) => page.evaluate(() => !!document.querySelector(".kq-cm-placing"));
const popover = (page) => page.evaluate(() => document.querySelector(".kq-cm-popover")?.innerText ?? null);
const openList = async (page) => {
  if (!(await page.evaluate(() => !!document.querySelector(".kq-cm-panel")))) {
    await page.click(".kq-cm-button");
    await sleep(400);
  }
};
const closeList = async (page) => {
  if (await page.evaluate(() => !!document.querySelector(".kq-cm-panel"))) {
    await page.click(".kq-cm-button");
    await sleep(300);
  }
};
/** the list's filters with their counts, the chosen one, and the threads listed */
const listState = (page) =>
  page.evaluate(() => ({
    filters: Object.fromEntries([...document.querySelectorAll(".kq-cm-filter")].map((el) => [el.querySelector("input").value, Number(el.querySelector(".kq-cm-filter__count").textContent)])),
    chosen: document.querySelector(".kq-cm-filter input:checked")?.value ?? null,
    listed: [...document.querySelectorAll(".kq-cm-thread__text")].map((el) => el.textContent),
    unread: [...document.querySelectorAll(".kq-cm-thread--new .kq-cm-thread__text")].map((el) => el.textContent),
  }));
const pick = async (page, filter) => {
  await page.click(`.kq-cm-filter input[value="${filter}"]`);
  await sleep(300);
  return listState(page);
};
const pinCount = (page) => page.evaluate(() => document.querySelectorAll(".kq-cm-pin:not(.kq-cm-pin--draft)").length);

// 1. the owner's scene
const signedIn = await signIn(OWNER);
const ownerCtx = signedIn.ctx;
let page = signedIn.page;
const NAME = `Polish ${RUN}`;
await page.evaluate(async (name, element) => {
  await window.__scenes.create(name);
  window.__scenes.getApi().updateScene({ elements: [element], captureUpdate: "IMMEDIATELY" });
}, NAME, rect("pol000000001", 100));
const fileId = (
  await waitFor("the scene in Drive", async () => {
    await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
    const id = await page.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, NAME);
    return { done: !!id, id };
  }, 80)
).id;
ok(!!fileId, "the scene is in Drive", fileId);

// 2. Shift+C starts placing, Esc cancels; not while typing
await page.mouse.click(900, 600);
await sleep(300);
await page.keyboard.down("Shift");
await page.keyboard.press("KeyC");
await page.keyboard.up("Shift");
await sleep(300);
ok(await placing(page), "Shift+C starts placing a comment");
ok(await page.evaluate(() => document.querySelector(".kq-cm-placing__hint")?.textContent.includes("Esc")), "the hint says Esc cancels");
await page.keyboard.press("Escape");
await sleep(300);
ok(!(await placing(page)), "Esc cancels placing");
const tip = await page.evaluate(() => document.querySelector(".kq-cm-button")?.title ?? "");
ok(tip.includes("Shift+C"), "the Comments button's tooltip shows the shortcut", tip);
// typing in Excalidraw's text editor: Shift+C is a capital C
await page.keyboard.press("t");
await page.mouse.click(700, 400);
await sleep(400);
await page.keyboard.type("Hello ");
await page.keyboard.down("Shift");
await page.keyboard.press("KeyC");
await page.keyboard.up("Shift");
await sleep(300);
// (Kurviq's rich text editor is contenteditable, Excalidraw's a textarea)
const typed = await page.evaluate(() => {
  const el = document.activeElement;
  return el?.tagName === "TEXTAREA" ? el.value : el?.isContentEditable ? el.innerText.trim() : null;
});
ok(typed === "Hello C" && !(await placing(page)), "typing in a text: Shift+C types a C, no placing", typed);
await page.keyboard.press("Escape");
await sleep(300);
// typing in the scene switcher's filter
await page.click(".scenes-pill__open");
await sleep(400);
await page.keyboard.down("Shift");
await page.keyboard.press("KeyC");
await page.keyboard.up("Shift");
await sleep(200);
ok(!(await placing(page)), "typing in the scene list's filter: no placing");
await page.keyboard.press("Backspace"); // the filter is kept
await page.keyboard.press("Escape");
await sleep(300);

// 3. a comment with the shortcut; its box takes Shift+C as text; Esc closes the popover
await page.mouse.click(900, 600);
await page.keyboard.down("Shift");
await page.keyboard.press("KeyC");
await page.keyboard.up("Shift");
await sleep(300);
await page.mouse.click(160, 140);
await sleep(600);
await page.type(".kq-cm-popover textarea", "Mine, with a capital ");
await page.keyboard.down("Shift");
await page.keyboard.press("KeyC");
await page.keyboard.up("Shift");
ok(!(await placing(page)), "typing in a comment box: Shift+C types, no placing");
await page.keyboard.press("Enter");
await sleep(800);
ok((await popover(page))?.includes("Mine, with a capital C"), "the new comment's thread is open", await popover(page));
// out of the comment box: Esc is the popover's
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Escape");
await sleep(300);
ok((await popover(page)) === null, "Esc closes the popover");

// 4. the file gets others' threads (written while no tab of the owner is open, like an editor elsewhere): open with a mention, resolved yesterday, resolved 8 days ago, new reply
const BOB = { name: "Bob", key: authorKey(`bob${RUN}@example.test`) };
const ME = { key: authorKey(OWNER) };
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const local = OWNER.split("@")[0];
const later = now + 10 * 60 * 1000; // after both browsers started keeping track: unread
const before = t0 - 60_000; // before this browser started keeping track: not unread
const inFile = await waitFor("my comment in the file", async () => {
  await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
  const revisions = (await admin(`revisions?fileId=${fileId}&content=1`)).revisions ?? [];
  const scene = JSON.parse(revisions.at(-1)?.content ?? "{}");
  return { done: (scene.kurviqComments ?? []).some((c) => c.text?.startsWith("Mine")), scene };
}, 60);
const stored = { ...inFile.scene, kurviqComments: inFile.scene.kurviqComments ?? [] };
const myComment = (stored.kurviqComments ?? []).find((c) => c.text?.startsWith("Mine"));
ok(!!myComment && myComment.by.key === ME.key, "my comment is in the file", myComment);
const pin = { x: 400, y: 300 };
const others = [
  { id: "polbob000001", thread: "polbob000001", by: BOB, text: `Mention @${local} please`, at: before, u: before, pin: { x: 400, y: 300 } },
  { id: "polbob000002", thread: "polbob000002", by: BOB, text: "Resolved yesterday", at: now - 2 * day, u: now - day, pin: { x: 500, y: 300 }, done: { name: "Bob", at: now - day } },
  { id: "polbob000003", thread: "polbob000003", by: BOB, text: "Resolved long ago", at: now - 10 * day, u: now - 8 * day, pin: { x: 600, y: 300 }, done: { name: "Bob", at: now - 8 * day } },
  { id: "polbob000004", thread: "polbob000004", by: BOB, text: "With a new reply", at: before, u: before, pin },
  { id: "polbob000005", thread: "polbob000004", by: BOB, text: "The new reply", at: later, u: later },
];
await page.close();
await sleep(3000);
await admin("write", { email: OWNER, fileId, content: JSON.stringify({ ...stored, kurviqComments: [...stored.kurviqComments, ...others] }) });
page = await ownerCtx.newPage();
page.on("pageerror", (e) => errors.push(`owner PAGEERROR: ${e.message.slice(0, 200)}`));
await page.goto(`${BASE}/${encodeURIComponent(NAME)}`, { waitUntil: "domcontentloaded" });
await ready(page);
const loaded = await waitFor("the file's comments", async () => {
  await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
  await openList(page);
  const state = await listState(page);
  await closeList(page);
  return { done: state.filters.open === 3, state };
}, 60);
ok(loaded.done, "the file's threads are there", loaded.state);

// 5. filters and counts
await openList(page);
let state = await pick(page, "open");
ok(JSON.stringify(state.filters) === JSON.stringify({ open: 3, resolved: 2, mine: 1, mentions: 1 }), "the filters' counts", state.filters);
ok(state.listed.length === 3 && !state.listed.some((t) => t.startsWith("Resolved")), "open: the open threads", state.listed);
state = await pick(page, "resolved");
ok(state.listed.length === 2 && state.listed.every((t) => t.startsWith("Resolved")), "resolved: the resolved threads", state.listed);
ok((await pinCount(page)) === 2, "resolved: their pins", await pinCount(page));
state = await pick(page, "mine");
ok(state.listed.length === 1 && state.listed[0].startsWith("Mine"), "mine: my thread", state.listed);
state = await pick(page, "mentions");
ok(state.listed.length === 1 && state.listed[0].startsWith("Mention"), "mentioning me: the thread that mentions me", state.listed);

// 6. hide resolved after 7 days: the pin and the entry go; off: back
await pick(page, "resolved");
await page.click(".kq-cm-switch input");
await sleep(400);
state = await listState(page);
ok(state.listed.length === 1 && state.listed[0] === "Resolved yesterday" && state.filters.resolved === 1 && (await pinCount(page)) === 1, "hidden: the thread resolved 8 days ago, its pin too", { ...state, pins: await pinCount(page) });
await page.click(".kq-cm-switch input");
await sleep(400);
state = await listState(page);
ok(state.listed.length === 2 && (await pinCount(page)) === 2, "turned off: shown again", { ...state, pins: await pinCount(page) });

// 7. unread: the thread with a new reply has a dot; opening it clears it; kept after a reload
state = await pick(page, "open");
ok(state.unread.length === 1 && state.unread[0] === "With a new reply", "the thread with a new reply is unread", state.unread);
await page.evaluate(() => [...document.querySelectorAll(".kq-cm-thread")].find((el) => el.textContent.includes("With a new reply"))?.click());
await sleep(800);
ok((await popover(page))?.includes("The new reply"), "the thread opens", await popover(page));
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Escape");
await sleep(300);
await openList(page);
state = await listState(page);
ok(state.unread.length === 0, "opened: no dot", state.unread);
await closeList(page);
await page.reload({ waitUntil: "domcontentloaded" });
await ready(page);
await sleep(1500);
await openList(page);
state = await listState(page);
ok(state.chosen === "open" && state.listed.length === 3 && state.unread.length === 0, "after a reload: still read, the filter kept", state);
await closeList(page);
// another browser keeps its own
const { page: other } = await signIn(OWNER);
await other.goto(`${BASE}/${encodeURIComponent(NAME)}`, { waitUntil: "domcontentloaded" });
await ready(other);
const otherState = await waitFor("the other browser's list", async () => {
  await openList(other);
  const s = await listState(other);
  await closeList(other);
  return { done: s.filters.open === 3, s };
}, 40);
ok(otherState.s?.unread.length === 1, "another browser: its own unread dot", otherState.s);

// 8. the scene list: the open threads of the open scene and of one this browser has stored
await page.evaluate(() => window.__scenes.create(`Other ${Date.now() % 100000}`));
await ready(page);
await sleep(1000);
await page.click(".scenes-pill__open");
await sleep(1200);
const counts = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll(".scenes-switcher__item")].map((el) => [el.querySelector(".scenes-switcher__name")?.textContent, el.querySelector(".kq-cm-scene-count")?.textContent ?? null])),
);
ok(counts[NAME]?.startsWith("3"), "the scene list shows the stored scene's open threads", counts);
await page.keyboard.press("Escape");

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await ownerCtx.close();
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
