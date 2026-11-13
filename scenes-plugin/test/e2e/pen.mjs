// The pen e2e (specs/2026-11-13-drive-collaboration-without-server-data.md, criteria 5-11, 13-15):
// one editor at a time on a Drive scene, decided by the scene's memory-only relay.
//   owner (editor), editor (a second editor), viewer (Drive reader)
//   5  the first opener edits; a second editor sees "<Name> is editing · Ask to edit" and the changes live
//   11 a newcomer sees the holder's unsaved changes (catch-up)
//   6  Ask to edit → "<Name> asks to edit · Hand over / Keep"; Hand over saves first, then the pen moves
//   7  Take over (the same account's other tab: at once; after 5 idle minutes: unit tests)
//   8  two "Edit" clicks at once: exactly one gets the pen
//   9  closing the holder's tab frees the pen at once
//   10 only the holder writes the file; the viewer's tab never writes
//   13 the relay unreachable: the mark on the Drive file decides (and doesn't change md5 / modifiedTime)
//   14 an agent of a viewer is told who is editing
//   15 edits made without the pen (offline) are merged into Drive when back, nothing lost
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node pen.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const SCENE = `pen-${RUN}`;
const [OWNER, EDITOR, VIEWER] = ["peno", "pene", "penv"].map((who) => `${who}${RUN}@example.test`);
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
const watch = (page, tag) => {
  page.on("console", (m) => m.type() === "error" && !/editor is gone|JSHandle@error|Failed to load resource|WebSocket/.test(m.text()) && errors.push(`${tag}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};
/** Drive content writes a page makes (uploads of the scene file) */
const contentWrites = new Map();
const countWrites = (page, tag) => {
  contentWrites.set(tag, 0);
  page.on("request", (request) => {
    if (/\/upload\/drive\/v3\/files/.test(request.url()) && ["PATCH", "POST"].includes(request.method())) {
      contentWrites.set(tag, contentWrites.get(tag) + 1);
    }
  });
};
const contexts = new Map();
const signedInContexts = new Set();
const open = async (email, tag, { space, block = false } = {}) => {
  if (!contexts.has(email)) {
    contexts.set(email, await browser.createIncognitoBrowserContext());
  }
  const page = await contexts.get(email).newPage();
  watch(page, tag);
  countWrites(page, tag);
  if (block) {
    // the relay is not reachable from this tab (its tickets and its WebSocket)
    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["*/relay/*"] });
  }
  if (space) {
    await page.evaluateOnNewDocument((s) => localStorage.setItem("kurviq-space", s), space);
  }
  if (!signedInContexts.has(email)) {
    signedInContexts.add(email);
    const back = encodeURIComponent(`/${SCENE}`);
    await page.goto(`${BASE}/auth/login?return=${back}`, { waitUntil: "domcontentloaded" });
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "load" });
  } else {
    // this account is signed in in its browser context already (the cookie)
    await page.goto(`${BASE}/${SCENE}`, { waitUntil: "load" });
  }
  return page;
};
const view = (page) => page.evaluate(() => window.__pen?.getView() ?? null).catch(() => null);
const until = async (page, test, ms = 20_000) => {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await view(page); // NOSONAR S9382: polling in order on purpose
    if (last && test(last)) return last;
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
  return last;
};
const shapes = (page) =>
  page.evaluate(() => (window.__scenes?.getApi()?.getSceneElements() ?? []).map((e) => `${e.type}@${Math.round(e.x)},${Math.round(e.y)}`).sort((a, b) => a.localeCompare(b))).catch(() => []);
const ids = (page) => page.evaluate(() => (window.__scenes?.getApi()?.getSceneElements() ?? []).map((e) => e.id));
const viewMode = (page) => page.evaluate(() => !!window.__scenes?.getApi()?.getAppState().viewModeEnabled);
const barText = (page) => page.evaluate(() => document.querySelector(".kq-pen")?.textContent?.replaceAll(/\s+/g, " ").trim() ?? "");
const click = (page, label) =>
  page.evaluate((text) => {
    const button = [...document.querySelectorAll(".kq-pen button")].find((b) => b.textContent.trim() === text);
    button?.click();
    return !!button;
  }, label);
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
const driveShapes = async (fileId) => {
  const revisions = await admin(`revisions?fileId=${fileId}&content=1`);
  const list = revisions.revisions ?? revisions;
  const head = list.at(-1);
  const content = typeof head?.content === "string" ? JSON.parse(head.content) : head?.content;
  return {
    shapes: (content?.elements ?? []).filter((e) => !e.isDeleted).map((e) => `${e.type}@${Math.round(e.x)},${Math.round(e.y)}`).sort((a, b) => a.localeCompare(b)),
    authors: list.map((r) => r.lastModifyingUser?.emailAddress ?? r.lastModifyingUser ?? r.modifiedBy ?? r.email ?? "?"),
  };
};

// --- 5: the first opener edits ------------------------------------------------
const owner = await open(OWNER, "owner");
await sleep(2500);
await draw(owner, 300, 250);
await owner.evaluate(() => window.__scenes.save());
let fileId = null;
for (let i = 0; i < 40 && !fileId; i++) {
  fileId = await owner.evaluate(() => window.__scenes.fileIdOf(window.__scenes.getState().current) ?? null); // NOSONAR S9382: polling in order on purpose
  if (!fileId) await sleep(500); // NOSONAR S9382: polling in order on purpose
}
log("file", fileId);
const ownerView = await until(owner, (v) => v.me === "holder");
ok(ownerView?.me === "holder" && ownerView.relay === "connected", "5: the first person opening the scene holds the pen", ownerView);
ok(!(await viewMode(owner)), "5: the holder's canvas is editable");
for (const [email, role] of [[EDITOR, "writer"], [VIEWER, "reader"]]) {
  await admin("share", { fileId, email, role }); // NOSONAR S9382: one person after the other on purpose (test setup)
  await admin("grant", { fileId, email }); // NOSONAR S9382: one person after the other on purpose (test setup)
}

const editor = await open(EDITOR, "editor", { space: `f:${fileId}` });
const editorView = await until(editor, (v) => v.me === "viewer" && !!v.holder);
ok(editorView?.holder?.name && editorView.me === "viewer", "5: a second editor sees the scene read only", editorView);
const bar = await barText(editor);
ok(/is editing/.test(bar) && /Ask to edit/.test(bar), "5: \"<Name> is editing · Ask to edit\"", bar);
ok(await viewMode(editor), "5: the second editor's canvas is in view mode");
await draw(owner, 500, 250);
const drawnAt = Date.now();
let seen = false;
while (!seen && Date.now() - drawnAt < 5000) {
  seen = JSON.stringify(await shapes(editor)) === JSON.stringify(await shapes(owner)); // NOSONAR S9382: polling in order on purpose
  if (!seen) await sleep(100); // NOSONAR S9382: polling in order on purpose
}
ok(seen && Date.now() - drawnAt < 2500, "5: the holder's change shows for the other editor within about a second", { ms: Date.now() - drawnAt });

// --- 11: a newcomer sees the holder's unsaved changes -------------------------
await draw(owner, 700, 250);
const unsaved = await owner.evaluate(() => window.__scenes.getState().dirty);
const viewer = await open(VIEWER, "viewer", { space: `f:${fileId}` });
const viewerView = await until(viewer, (v) => v.me === "viewer" && !!v.holder);
let caught = false;
for (let i = 0; i < 40 && !caught; i++) {
  caught = JSON.stringify(await shapes(viewer)) === JSON.stringify(await shapes(owner)); // NOSONAR S9382: polling in order on purpose
  if (!caught) await sleep(250); // NOSONAR S9382: polling in order on purpose
}
ok(unsaved && caught, "11: a newcomer sees the holder's unsaved changes (catch-up)", { unsaved, viewer: await shapes(viewer), owner: await shapes(owner), role: viewerView?.role });

// --- 14: an agent of a viewer is told who is editing --------------------------
const refusal = await editor.evaluate((scene) => window.__pen.refusal(scene), SCENE);
ok(/is editing this scene/.test(refusal ?? ""), "14: an agent of a viewer is told who is editing", refusal);
ok((await owner.evaluate((scene) => window.__pen.refusal(scene), SCENE)) === null, "14: the holder's tab accepts agent edits");

// --- 6: ask, hand over (saved first) ------------------------------------------
await draw(owner, 300, 450);
const ownerShapesBefore = await shapes(owner);
ok(await click(editor, "Ask to edit"), "6: \"Ask to edit\" clicked");
const asked = await until(owner, (v) => v.askers.length > 0);
const ownerBar = await barText(owner);
ok(asked?.askers.length === 1 && /asks to edit/.test(ownerBar) && /Hand over/.test(ownerBar) && /Keep/.test(ownerBar), "6: the holder sees \"<Name> asks to edit · Hand over / Keep\"", ownerBar);
ok(await click(owner, "Hand over"), "6: \"Hand over\" clicked");
const handed = await until(editor, (v) => v.me === "holder");
const savedAtHandover = await driveShapes(fileId);
ok(handed?.me === "holder", "6: the asker can edit after the handover", handed);
ok(JSON.stringify(savedAtHandover.shapes) === JSON.stringify(ownerShapesBefore), "6: the holder's changes were saved to Drive first", { drive: savedAtHandover.shapes, owner: ownerShapesBefore });
const ownerAfter = await until(owner, (v) => v.me === "viewer");
ok(ownerAfter?.me === "viewer" && (await viewMode(owner)), "6: the former holder is read only", ownerAfter);
ok(!(await viewMode(editor)), "6: the new holder's canvas is editable");

// --- 10: the new holder saves; viewers never write ----------------------------
await draw(editor, 500, 450);
await editor.evaluate(() => window.__scenes.save());
await sleep(1500);
const afterEditorSave = await driveShapes(fileId);
ok(afterEditorSave.shapes.length === (await shapes(editor)).length, "10: the saved file has the holder's changes", afterEditorSave.shapes);
ok(contentWrites.get("viewer") === 0, "10: the viewer's tab never wrote the file", Object.fromEntries(contentWrites));
ok(!afterEditorSave.authors.some((a) => String(a).includes("penv")), "10: no Drive version by the viewer", afterEditorSave.authors);

// --- 7: take over (the same account's other tab) ------------------------------
const editor2 = await open(EDITOR, "editor2", { space: `f:${fileId}` });
const second = await until(editor2, (v) => v.me === "viewer" && v.canTakeOver);
ok(second?.canTakeOver && /Take over/.test(await barText(editor2)), "7: \"Take over\" is offered (this account's other tab)", second);
await click(editor2, "Take over");
const took = await until(editor2, (v) => v.me === "holder");
const tookFrom = await until(editor, (v) => v.me === "viewer");
ok(took?.me === "holder" && tookFrom?.me === "viewer", "7: taking over works", { took: took?.me, from: tookFrom?.me, note: tookFrom?.notice });

// --- 9: closing the holder's tab frees the pen at once -----------------------
await editor2.close();
const freed = await until(owner, (v) => v.holder === null, 10_000);
ok(freed?.holder === null && /Nobody is editing/.test(await barText(owner)), "9: closing the holder's tab frees the pen (the relay notices the close)", freed);

// --- 8: two "Edit" clicks at the same moment ---------------------------------
await until(editor, (v) => v.holder === null, 5000);
await Promise.all([click(owner, "Edit"), click(editor, "Edit")]);
await sleep(1500);
const both = [await view(owner), await view(editor)];
ok(both.filter((v) => v?.me === "holder").length === 1, "8: exactly one of two simultaneous \"Edit\" clicks gets the pen", both.map((v) => v?.me));
const holderPage = both[0]?.me === "holder" ? owner : editor;
const otherPage = holderPage === owner ? editor : owner;

// --- 13: the relay unreachable: the mark on the Drive file decides -----------
const fileBefore = await admin(`file?fileId=${fileId}`);
const markedMeta = fileBefore.file ?? fileBefore;
const blocked = await open(EDITOR, "blocked", { space: `f:${fileId}`, block: true });
const byMark = await until(blocked, (v) => v.me === "viewer" && v.byMark, 30_000);
ok(byMark?.byMark && byMark.me === "viewer" && (await viewMode(blocked)), "13: a fresh mark of someone else makes the scene read only for a tab without the relay", byMark);
ok(typeof markedMeta.appProperties?.kurviqPen === "string", "13: the holder's mark is on the Drive file", markedMeta.appProperties);
// the holder stops editing: its mark goes; the tab without relay may edit (and sets its own mark)
await click(holderPage, "Stop editing");
const free = await until(blocked, (v) => v.me === "holder", 45_000);
ok(free?.me === "holder" && !(await viewMode(blocked)), "13: no (or a stale) mark: the tab without the relay may edit", free);
await sleep(1500);
const fileAfter = await admin(`file?fileId=${fileId}`);
const meta = fileAfter.file ?? fileAfter;
log("mark", meta.appProperties?.kurviqPen, "modifiedTime", markedMeta.modifiedTime, "→", meta.modifiedTime, "md5", markedMeta.md5Checksum, "→", meta.md5Checksum);
ok(/"n":/.test(meta.appProperties?.kurviqPen ?? "") && meta.md5Checksum === markedMeta.md5Checksum, "13: the mark is metadata only (the content's md5 stays)", meta.appProperties);
ok(meta.modifiedTime === markedMeta.modifiedTime, "13: a mark update leaves modifiedTime alone (fake Google; to check with the real one)", { before: markedMeta.modifiedTime, after: meta.modifiedTime });
await blocked.close();

// --- 15: edits made offline merge into Drive when back -----------------------
// the other editor takes the pen; the one without goes offline, draws, comes back
await until(otherPage, (v) => v.holder === null, 10_000);
await click(otherPage, "Edit");
const otherHolds = await until(otherPage, (v) => v.me === "holder");
const offlinePage = holderPage;
// offline: no Drive, no relay (Chrome's offline mode leaves an open WebSocket alone: closed here, and blocked)
const offlineCdp = await offlinePage.target().createCDPSession();
await offlineCdp.send("Network.enable");
await offlineCdp.send("Network.setBlockedURLs", { urls: ["*/relay/*"] });
await offlinePage.setOfflineMode(true);
await offlinePage.evaluate(() => window.__pen.session?.ws?.close());
const offlineView = await until(offlinePage, (v) => v.relay === "offline" && v.me === "holder", 30_000);
ok(otherHolds?.me === "holder" && offlineView?.me === "holder", "15: offline (no relay, no Drive): the tab keeps editing", { other: otherHolds?.me, offline: offlineView });
const offlineBefore = new Set(await ids(offlinePage));
await draw(offlinePage, 300, 650);
const offlineNew = (await ids(offlinePage)).filter((id) => !offlineBefore.has(id));
const otherBefore = new Set(await ids(otherPage));
await draw(otherPage, 700, 650);
const otherNew = (await ids(otherPage)).filter((id) => !otherBefore.has(id));
await otherPage.evaluate(() => window.__scenes.save());
await offlineCdp.send("Network.setBlockedURLs", { urls: [] });
await offlinePage.setOfflineMode(false);
const backView = await until(offlinePage, (v) => v.relay === "connected" && v.me === "viewer", 45_000);
ok(backView?.me === "viewer", "15: back online, someone else holds the pen: read only", backView);
const wanted = [...offlineNew, ...otherNew];
let merged = [];
for (let i = 0; i < 40; i++) {
  const revisions = await admin(`revisions?fileId=${fileId}&content=1`); // NOSONAR S9382: polling in order on purpose
  const head = (revisions.revisions ?? revisions).at(-1);
  const content = typeof head?.content === "string" ? JSON.parse(head.content) : head?.content;
  merged = (content?.elements ?? []).filter((e) => !e.isDeleted).map((e) => e.id);
  if (wanted.every((id) => merged.includes(id))) break;
  await sleep(500); // NOSONAR S9382: polling in order on purpose
}
ok(offlineNew.length === 1 && otherNew.length === 1 && wanted.every((id) => merged.includes(id)), "15: the offline edit and the holder's edit are both in Drive (merged element by element)", { wanted, merged });

ok(errors.length === 0, "no page errors", errors);
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exitCode = failed ? 1 : 0;
