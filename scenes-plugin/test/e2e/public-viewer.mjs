// The public viewer e2e (specs/2026-11-13-drive-collaboration-without-server-data.md, criteria 4
// and 21 for short links): a scene shared "anyone with the link" is read by the visitor's browser
// straight from Drive (Kurviq's browser API key, no sign-in); the Worker serves no scene content, only
// the name for link previews, uncached. Changes the owner saves show in the open viewer (its version
// compared with the version it actually loaded), the background too. A short link opens it the same way.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node public-viewer.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `pvo${RUN}@example.test`;
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
const rect = (id, x) => ({
  id, type: "rectangle", x, y: 100, width: 80, height: 50, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null,
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
});

// 1. the owner's scene, shared "anyone with the link"
const ownerCtx = await browser.createIncognitoBrowserContext();
const owner = await ownerCtx.newPage();
owner.on("pageerror", (e) => errors.push(`owner PAGEERROR: ${e.message.slice(0, 200)}`));
await owner.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 3 && owner.url().includes("/fake-google/oauth/authorize"); i++) {
  await owner.goto(owner.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(OWNER)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
  await sleep(500); // NOSONAR S9382: in order on purpose
}
await ready(owner);
const NAME = `Public ${RUN}`;
await owner.evaluate(async (name, element) => {
  await window.__scenes.create(name);
  window.__scenes.getApi().updateScene({ elements: [element], captureUpdate: "IMMEDIATELY" });
}, NAME, rect("pub0000000001", 100));
const fileId = (
  await waitFor("the scene in Drive", async () => {
    await owner.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
    const id = await owner.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, NAME);
    return { done: !!id, id };
  }, 80)
).id;
ok(!!fileId, "owner: the scene is in Drive", fileId);
await admin("share", { fileId, anyone: true, role: "reader" });

// 2. the Worker: name and version only, uncached; the page titled for link previews, nothing preloaded
const meta = await fetch(`${BASE}/api/public/${fileId}`);
const metaBody = await meta.text();
ok(meta.ok && meta.headers.get("cache-control") === "no-store" && !metaBody.includes("elements"), "/api/public/<id>: metadata only, uncached", metaBody);
ok(JSON.parse(metaBody).name === NAME, "…with the scene's name", JSON.parse(metaBody));
const pageHtml = await (await fetch(`${BASE}/s/${fileId}/public`)).text();
ok(pageHtml.includes(`<title>${NAME} · Kurviq</title>`) && !pageHtml.includes(`/api/public/${fileId}"`), "the shared page: titled, no content preloaded", /<title>[^<]*<\/title>/.exec(pageHtml)?.[0]);

// 3. a visitor without sign-in: the viewer reads the scene from Drive in the browser
const visitorCtx = await browser.createIncognitoBrowserContext();
const visitor = await visitorCtx.newPage();
visitor.on("pageerror", (e) => errors.push(`visitor PAGEERROR: ${e.message.slice(0, 200)}`));
const requests = [];
visitor.on("request", (request) => requests.push(request.url()));
await visitor.goto(`${BASE}/s/${fileId}/public`, { waitUntil: "domcontentloaded" });
const shown = await waitFor("the viewer", async () => {
  const xs = await visitor.evaluate(() => window.__publicViewer?.getSceneElements().map((e) => Math.round(e.x)) ?? null).catch(() => null);
  return { done: xs?.join() === "100", xs };
});
ok(shown.done, "visitor: the scene is shown", shown.xs);
const fromDrive = requests.filter((url) => url.includes(`/fake-google/drive/v3/files/${fileId}`) && url.includes("alt=media"));
ok(fromDrive.length > 0 && fromDrive.every((url) => url.includes("key=")), "…read from Drive with the browser key", fromDrive.slice(0, 2));
ok(!requests.some((url) => url.includes(`/api/public/${fileId}`)), "…and not through Kurviq's Worker", requests.filter((url) => url.includes("/api/")).slice(0, 5));
const title = await visitor.evaluate(() => document.querySelector(".public-scene__title")?.textContent ?? "");
ok(title === NAME, "the viewer's title", title);

// 4. the owner saves a change (and a new background): the open viewer follows
const changed = { type: "excalidraw", version: 2, source: "test", elements: [rect("pub0000000001", 100), rect("pub0000000002", 400)], appState: { viewBackgroundColor: "#ffc9c9" }, files: {} };
await admin("write", { email: OWNER, fileId, content: JSON.stringify(changed) });
const followed = await waitFor("the viewer follows", async () => {
  const state = await visitor.evaluate(() => ({
    xs: window.__publicViewer?.getSceneElements().map((e) => Math.round(e.x)).sort((a, b) => a - b) ?? null,
    background: window.__publicViewer?.getAppState().viewBackgroundColor ?? null,
  }));
  return { done: state.xs?.join() === "100,400" && state.background === "#ffc9c9", state };
}, 120);
ok(followed.done, "visitor: the change shows, with its background", followed.state);
const versionChecks = requests.filter((url) => url.includes(`/fake-google/drive/v3/files/${fileId}?`) && url.includes("md5Checksum"));
ok(versionChecks.length > 0, "…noticed by asking Drive for the version", versionChecks.length);

// 5. a short link to it (D1 pub_links: name and file id only) opens the same viewer
const PUB = `pv-${RUN}`;
const claimed = await owner.evaluate(async (fileId, name) => {
  const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
  const res = await fetch("/api/pub", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ fileId, name }) });
  return { status: res.status, body: await res.json() };
}, fileId, PUB);
ok(claimed.status === 200 && claimed.body.name === PUB, "owner: a short link", claimed);
const lookup = await (await fetch(`${BASE}/api/pub/${PUB}`)).json();
ok(lookup.fileId === fileId, "the short link names the file", lookup);
const viaShort = await visitorCtx.newPage();
await viaShort.goto(`${BASE}/pub/${PUB}`, { waitUntil: "domcontentloaded" });
const shortShown = await waitFor("the viewer of the short link", async () => {
  const xs = await viaShort.evaluate(() => window.__publicViewer?.getSceneElements().length ?? null).catch(() => null);
  return { done: xs === 2, xs };
});
ok(shortShown.done, "visitor: the short link shows the scene", shortShown.xs);

// 6. no longer public: the Worker knows no name, the viewer asks to sign in
await admin("unshare", { fileId, anyone: true });
const gone = await fetch(`${BASE}/api/public/${fileId}`);
ok(gone.status === 404, "not public any more: no metadata either", gone.status);

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
