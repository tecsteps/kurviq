// Comments by Drive's commenters e2e (specs/2026-11-13-drive-collaboration-without-server-data.md,
// "Comments by commenters"; criteria 17, 18, and 16 when an editor holds the pen): a commenter can't
// write the scene file. With no editor there, their comment goes into Drive's own comments on the file
// (the mailbox) and shows "waiting for an editor"; the next editor who opens the scene takes it into the
// file, recorded as the commenter's, and deletes the Drive comment. A forged change of someone else's
// comment is refused (commenterRefusal) and its Drive comment deleted too. Nothing passes through
// Kurviq's server's storage.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node commenter-mailbox.mjs
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const [OWNER, COMMENTER] = ["cmo", "cmc"].map((who) => `${who}${RUN}@example.test`);
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
/** the scene's comments in its Drive file now */
const fileComments = async (fileId) => {
  const revisions = (await admin(`revisions?fileId=${fileId}&content=1`)).revisions ?? [];
  try {
    return JSON.parse(revisions.at(-1)?.content ?? "{}").kurviqComments ?? [];
  } catch {
    return [];
  }
};
const driveComments = async (fileId) => (await admin(`comments?fileId=${fileId}`)).comments ?? [];

// 1. the owner's scene, with a comment of their own, shared with a commenter
const { ctx: ownerCtx, page: ownerPage } = await signIn(OWNER);
const NAME = `Comments ${RUN}`;
await ownerPage.evaluate(async (name, element) => {
  await window.__scenes.create(name);
  window.__scenes.getApi().updateScene({ elements: [element], captureUpdate: "IMMEDIATELY" });
}, NAME, rect("cmt000000001", 100));
const fileId = (
  await waitFor("the scene in Drive", async () => {
    await ownerPage.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
    const id = await ownerPage.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, NAME);
    return { done: !!id, id };
  }, 80)
).id;
ok(!!fileId, "owner: the scene is in Drive", fileId);
const ownerComment = { id: "owner0comment1", thread: "owner0comment1", by: { name: "Owner", key: authorKey(OWNER) }, text: "The owner's note", at: 1000, u: 1000, pin: { x: 300, y: 100 } };
await admin("write", {
  email: OWNER,
  fileId,
  content: JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [rect("cmt000000001", 100)], appState: { viewBackgroundColor: "#ffffff", name: NAME }, files: {}, kurviqComments: [ownerComment] }),
});
await admin("share", { fileId, email: COMMENTER, role: "commenter" });
await admin("grant", { email: COMMENTER, fileId });
// no editor there: the owner's tab goes
await ownerPage.close();

// 2. the commenter: their comment goes to Drive's comments and waits for an editor
const { page: commenter } = await signIn(COMMENTER);
await commenter.goto(`${BASE}/s/${fileId}/comments`, { waitUntil: "domcontentloaded" });
const viewer = await waitFor("the viewer", async () => {
  const xs = await commenter.evaluate(() => window.__publicViewer?.getSceneElements().length ?? null).catch(() => null);
  const button = await commenter.evaluate(() => !!document.querySelector(".kq-cm-button")).catch(() => false);
  return { done: xs === 1 && button, xs, button };
}, 60);
ok(viewer.done, "commenter: the scene in the viewer, with comments", viewer);
await commenter.click(".kq-cm-button");
await sleep(500);
const canAdd = await commenter.evaluate(() => [...document.querySelectorAll(".kq-cm-panel button")].some((el) => el.textContent.includes("New comment")));
ok(canAdd, "commenter: may add a comment");
await commenter.evaluate(() => [...document.querySelectorAll(".kq-cm-panel button")].find((el) => el.textContent.includes("New comment"))?.click());
await sleep(400);
await commenter.mouse.click(700, 500);
await sleep(600);
const TEXT = `From the commenter ${RUN}`;
await commenter.type(".kq-cm-popover textarea", TEXT);
await commenter.keyboard.press("Enter");
const waiting = await waitFor("waiting for an editor", async () => {
  const badge = await commenter.evaluate(() => document.querySelector(".kq-cm-badge--waiting")?.textContent ?? "");
  const mailbox = await driveComments(fileId);
  return { done: badge.includes("waiting for an editor") && mailbox.length === 1, badge, mailbox: mailbox.map((c) => c.content.slice(0, 60)) };
});
ok(waiting.done, "commenter: the comment is in Drive's comments, shown waiting for an editor", waiting);
const [mail] = await driveComments(fileId);
ok(mail?.content.includes("[kurviq-comments:v1]") && mail.content.includes(TEXT) && mail.email === COMMENTER, "the Drive comment carries the Kurviq comment, by the commenter", mail?.content.slice(0, 200));
// after a reload it still shows (from Drive's comments), still waiting
await commenter.reload({ waitUntil: "domcontentloaded" });
await waitFor("the viewer again", async () => ({ done: (await commenter.evaluate(() => window.__publicViewer?.getSceneElements().length ?? null).catch(() => null)) === 1 }), 60);
await sleep(1500);
await commenter.click(".kq-cm-button");
await sleep(500);
const panel = await commenter.evaluate(() => document.querySelector(".kq-cm-panel")?.innerText ?? "");
ok(panel.includes(TEXT) && panel.includes("The owner's note"), "after a reload: the waiting comment is listed with the file's", panel.slice(0, 300));
// (not Escape: that closes the viewer too)
await commenter.click(".kq-cm-button");

// 3. a forged change of the owner's comment, left in the mailbox with the commenter's own access
const forged = await commenter.evaluate(async (fileId, comment) => {
  const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
  const content = `A comment on this Kurviq scene\n\n[kurviq-comments:v1]${JSON.stringify([{ ...comment, text: "Changed by the commenter", u: 5000 }])}`;
  const res = await fetch(`/fake-google/drive/v3/files/${fileId}/comments?fields=id`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
  return res.status;
}, fileId, ownerComment);
ok(forged === 200 && (await driveComments(fileId)).length === 2, "a forged change waits in the mailbox too", forged);

// 4. the owner opens the scene: both are taken care of; the commenter's comment is in the file as theirs
const ownerAgain = await ownerCtx.newPage();
ownerAgain.on("pageerror", (e) => errors.push(`owner PAGEERROR: ${e.message.slice(0, 200)}`));
await ownerAgain.goto(`${BASE}/${encodeURIComponent(NAME)}`, { waitUntil: "domcontentloaded" });
await ready(ownerAgain);
const taken = await waitFor("the mailbox taken in", async () => {
  const left = await driveComments(fileId);
  const stored = await fileComments(fileId);
  return { done: left.length === 0 && stored.some((c) => c.text === TEXT), left: left.length, stored: stored.map((c) => `${c.by.name}: ${c.text}`) };
}, 160);
ok(taken.done, "editor: the comment taken into the file, the Drive comments deleted", taken);
const stored = await fileComments(fileId);
const theirs = stored.find((c) => c.text === TEXT);
ok(theirs?.by.key === authorKey(COMMENTER) && /Cmc\d+/i.test(theirs?.by.name ?? ""), "recorded on the commenter's behalf (their key and name)", theirs?.by);
ok(stored.find((c) => c.id === ownerComment.id)?.text === "The owner's note", "the forged change was refused: the owner's comment is unchanged", stored.find((c) => c.id === ownerComment.id));

// 5. the commenter: no longer waiting
await commenter.goto(`${BASE}/s/${fileId}/comments`, { waitUntil: "domcontentloaded" });
await waitFor("the viewer again", async () => {
  const state = await commenter.evaluate(() => ({ url: location.pathname, xs: window.__publicViewer?.getSceneElements().length ?? null, text: document.querySelector(".public-scene")?.innerText.slice(0, 200) ?? null })).catch(() => null);
  return { done: state?.xs === 1, state };
}, 60);
await sleep(2000);
await commenter.click(".kq-cm-button");
await sleep(500);
await commenter.evaluate((text) => [...document.querySelectorAll(".kq-cm-thread")].find((el) => el.textContent.includes(text))?.click(), TEXT);
await sleep(800);
const after = await commenter.evaluate(() => ({
  popover: document.querySelector(".kq-cm-popover")?.innerText ?? "",
  badge: !!document.querySelector(".kq-cm-badge--waiting"),
}));
ok(after.popover.includes(TEXT) && !after.badge, "commenter: the comment is in the scene, not waiting any more", after);

// 6. an editor holds the pen (criterion 16): the comment goes through the relay to the holder's tab,
// which writes it into the file; nothing goes to Drive's comments
const holder = await waitFor("the owner holds the pen", async () => {
  const me = await ownerAgain.evaluate(() => window.__pen?.getView().me ?? null).catch(() => null);
  return { done: me === "holder", me };
}, 60);
ok(holder.done, "owner: holds the pen", holder.me);
// the commenter opens the scene in its own space: the editor shows it, joined to the relay as a commenter
await commenter.evaluate((fileId) => localStorage.setItem("kurviq-space", `f:${fileId}`), fileId);
await commenter.goto(`${BASE}/s/${fileId}/comments`, { waitUntil: "domcontentloaded" });
const joined = await waitFor("the commenter at the relay", async () => {
  // in the scene's own space the editor shows it (read only), with the pen bar
  const state = await commenter.evaluate(() => ({ me: window.__pen?.getView().me ?? null, current: window.__scenes?.getState().current ?? null })).catch(() => null);
  return { done: state?.me === "commenter" && !!state.current, state };
}, 60);
ok(joined.done, "commenter: joined the relay as a commenter", joined.state);
await commenter.click(".kq-cm-button");
await sleep(500);
await commenter.evaluate(() => [...document.querySelectorAll(".kq-cm-panel button")].find((el) => el.textContent.includes("New comment"))?.click());
await sleep(400);
await commenter.mouse.click(600, 600);
await sleep(600);
const RELAYED = `Through the relay ${RUN}`;
await commenter.type(".kq-cm-popover textarea", RELAYED);
await commenter.keyboard.press("Enter");
const relayed = await waitFor("the relayed comment at the holder", async () => {
  const atHolder = await ownerAgain.evaluate((text) => document.body.innerText.includes(text) || JSON.stringify(window.__scenes.getState()).includes(text), RELAYED).catch(() => false);
  const stored = (await fileComments(fileId)).some((c) => c.text === RELAYED);
  return { done: stored, atHolder, stored };
}, 120);
ok(relayed.done, "the comment through the relay is in the Drive file after the holder's save", relayed);
ok((await driveComments(fileId)).length === 0, "…and nothing went to Drive's comments");
const relayedBy = (await fileComments(fileId)).find((c) => c.text === RELAYED);
ok(relayedBy?.by.key === authorKey(COMMENTER), "…recorded as the commenter's", relayedBy?.by);

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
