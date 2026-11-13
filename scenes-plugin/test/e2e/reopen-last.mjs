// e2e: kurviq.com/ opens the scene the user left, signed in with Drive (each scene with its relay and pen), even
// with another tab left open in the background. Every tab writes the scene metadata (its sync
// does, now and then): a forgotten tab on Untitled or on another scene must not turn the stored
// "current scene" into its own one.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node reopen-last.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const EMAIL = `reopen${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const failures = [];
const errors = [];
const ctx = await browser.createIncognitoBrowserContext();
const page = async (tag) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${tag}: ${e.message.slice(0, 200)}`));
  p.on("dialog", (d) => d.accept().catch(() => {}));
  // counts this tab's writes of the scene metadata
  await p.evaluateOnNewDocument(() => {
    window.__metaWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "excalidraw-scenes" + (localStorage.getItem("kurviq-own-space") ? "@" + localStorage.getItem("kurviq-own-space") : "")) window.__metaWrites++; // the scenes of the signed-in account
      return setItem.call(this, key, value);
    };
  });
  return p;
};
const ready = async (p) => {
  for (let i = 0; i < 80 && !(await p.evaluate(() => !!window.__scenes?.getApi()).catch(() => false)); i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  await p.evaluate(() => window.__scenes.ready);
  await sleep(2500); // the router and the first sync
};
const current = (p) => p.evaluate(() => window.__scenes.getState().current);
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-scenes" + (localStorage.getItem("kurviq-own-space") ? "@" + localStorage.getItem("kurviq-own-space") : "")) || "{}").current ?? null);
const draw = (p) =>
  p.evaluate(() => {
    const api = window.__scenes.getApi();
    const el = {
      id: "r" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join(""), type: "rectangle", x: 50 + Math.random() * 800, y: 50 + Math.random() * 500, width: 60, height: 40, angle: 0, // NOSONAR S2245: not security relevant (test drawing positions and Excalidraw version nonces)
      strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
      roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: { type: 3 }, seed: 1,
      version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, // NOSONAR S2245: not security relevant (test drawing positions and Excalidraw version nonces)
    };
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), el], captureUpdate: "IMMEDIATELY" });
  });
// the user goes to a tab and uses it (a click on the canvas, a key)
const use = async (p) => {
  await p.bringToFront();
  await p.mouse.click(1250, 800);
  await p.keyboard.press("Escape");
};
const check = async (label, want) => {
  const p = await page("new");
  await p.goto(`${BASE}/`, { waitUntil: "load" });
  await ready(p);
  const got = await current(p);
  log(label, "→", JSON.stringify(got), "at", await p.evaluate(() => location.pathname));
  if (got !== want) failures.push(`${label}: opened ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  await p.close();
};

// signed in, three Drive scenes (live-synced), each drawn on
const A = await page("A");
await A.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
await A.goto(A.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "load" });
await ready(A);
for (const name of ["Alpha", "Bravo", "Charlie"]) {
  await A.evaluate((n) => window.__scenes.create(n), name); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  await draw(A); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  for (let k = 0; k < 200 && !(await A.evaluate(() => !!window.__scenes.fileIdOf(window.__scenes.getState().current))); k++) await sleep(100); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
}
for (let i = 0; i < 40 && (await A.evaluate(() => window.__pen?.getView().me)) !== "holder"; i++) await sleep(500); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
log("pen:", await A.evaluate(() => window.__pen?.getView().me ?? "none"));
if ((await A.evaluate(() => window.__pen?.getView().me)) !== "holder") failures.push("Charlie's tab never got the pen");

// plain: Bravo opened and drawn on, then / (navigation, reload, new tab)
await A.evaluate(() => window.__scenes.open("Bravo"));
await draw(A);
await sleep(3000);
await check("one tab, new tab at /", "Bravo");
await A.goto(`${BASE}/`, { waitUntil: "load" });
await ready(A);
if ((await current(A)) !== "Bravo") failures.push(`navigation to /: ${await current(A)}`);
await A.reload({ waitUntil: "load" });
await ready(A);
if ((await current(A)) !== "Bravo") failures.push(`reload at /: ${await current(A)}`);

// a tab left open in the background on Untitled, and one on Alpha
const T = await page("T");
await T.goto(`${BASE}/`, { waitUntil: "load" });
await ready(T);
await T.evaluate(() => window.__scenes.open(null));
const U = await page("U");
await U.goto(`${BASE}/Alpha`, { waitUntil: "load" });
await ready(U);
log("background tabs:", JSON.stringify(await current(T)), JSON.stringify(await current(U)));
// the user works in A (Bravo) again, then stops
await use(A);
for (let i = 0; i < 6; i++) {
  await draw(A); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  await sleep(700); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
}
log("stored after working in A:", JSON.stringify(await stored(A)));
// the user closes A; both background tabs write the metadata again later (their sync, here
// nudged by a change in Drive: another device saves Alpha)
await A.close();
const marks = [await T.evaluate(() => window.__metaWrites), await U.evaluate(() => window.__metaWrites)];
for (let i = 0; i < 90; i++) {
  const now = [await T.evaluate(() => window.__metaWrites), await U.evaluate(() => window.__metaWrites)];
  if (now[0] > marks[0] && now[1] > marks[1]) break;
  if (i % 15 === 2) {
    await U.evaluate(() => { // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
      const api = window.__scenes.getApi();
      const [el] = api.getSceneElements();
      if (el) api.updateScene({ elements: [{ ...el, x: el.x + 5, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }], captureUpdate: "IMMEDIATELY" }); // NOSONAR S2245: not security relevant (test drawing positions and Excalidraw version nonces)
    });
  }
  await sleep(2000); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
}
log("background writes:", marks, "→", [await T.evaluate(() => window.__metaWrites), await U.evaluate(() => window.__metaWrites)], "stored:", JSON.stringify(await stored(T)));
await check("A closed, Untitled + Alpha tabs in the background, new tab at /", "Bravo");

// the user goes to the Alpha tab and uses it: from now on it is the one left
await use(U);
await sleep(500);
await check("Alpha tab used, new tab at /", "Alpha");
// switching scenes in the Untitled tab makes Charlie the one left
await use(T);
await T.evaluate(() => window.__scenes.open("Charlie"));
await sleep(1000);
await check("Charlie opened in the other tab, new tab at /", "Charlie");

if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
log(failures.length ? `FAIL:\n  ${failures.join("\n  ")}` : "PASS");
await browser.close();
process.exit(failures.length ? 1 : 0);
