// Live sync e2e: a NEW scene, signed in, drawing at once and on through the scene's creation in
// Drive, its first live connection and the seeding of its Durable Object. Never an offline copy,
// and everything drawn ends up on the canvas and in the saved Drive file. Variants: a slow Drive
// (uploads delayed), and a second tab of the same account joining meanwhile.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node new-scene.mjs [plain|slow|two-tabs]
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const VARIANT = process.argv[2] || "plain";
const RUN = Date.now() % 100000;
const SCENE = `MyScene ${VARIANT} ${RUN}`;
const EMAIL = `new${RUN}${VARIANT.replace(/\W/g, "")}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};
const ctx = await browser.createIncognitoBrowserContext();
const A = await ctx.newPage();
watch(A, "A");
// the seed's way to the Durable Object as slow as on Cloudflare (a hook of dev / fake-Google builds)
await A.evaluateOnNewDocument(() => {
  window.__liveSeedDelayMs = 2000;
});
await A.goto(`${BASE}/auth/login?return=${encodeURIComponent("/" + SCENE)}`, { waitUntil: "domcontentloaded" });
await A.goto(A.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "load" });
for (let i = 0; i < 40 && !(await A.evaluate(() => !!window.__scenes?.getApi() && window.__scenes.getState().current).catch(() => null)); i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
log("scene open:", await A.evaluate(() => window.__scenes.getState().current));
if (VARIANT === "slow") {
  // Drive answers slowly: uploads (the scene's creation, its saves) and file reads take 2.5 s
  await admin("faults", { count: 30, delayMs: 2500, path: "/upload/" });
  await admin("faults", { count: 30, delayMs: 2500, path: "alt=media" });
}

// drawing starts at once: a rectangle every 400 ms, a pause after the first ten (the scene gets its
// file), then on through the first ticket, the seeding and the welcome
const drawn = [];
const draw = async (page) => {
  const id = await page.evaluate(() => {
    const api = window.__scenes.getApi();
    const id = "r" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("");
    const all = api.getSceneElementsIncludingDeleted();
    const el = {
      id, type: "rectangle", x: 50 + Math.random() * 800, y: 50 + Math.random() * 500, width: 60, height: 40, angle: 0, // NOSONAR S2245: not security relevant (test drawing positions and Excalidraw version nonces)
      strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
      roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: { type: 3 }, seed: 1,
      version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, boundElements: null, // NOSONAR S2245: not security relevant (test drawing positions and Excalidraw version nonces)
      updated: Date.now(), link: null, locked: false,
    };
    api.updateScene({ elements: [...all, el], captureUpdate: "IMMEDIATELY" });
    return id;
  });
  drawn.push(id);
};
let B = null;
for (let i = 0; i < 75; i++) {
  await draw(A); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  if (i === 9) {
    // a pause like a person's: the scene gets its Drive file (after 10 s idle), then live sync
    // starts (ticket, seeding) while drawing goes on
    for (let k = 0; k < 150 && !(await A.evaluate(() => !!window.__scenes.fileIdOf(window.__scenes.getState().current))); k++) { // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
      await sleep(100); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
    }
    log("the file exists; live phase", await A.evaluate(() => window.__live?.current()?.phase ?? "none")); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  }
  if (VARIANT === "two-tabs" && i === 20) {
    // a second tab of the same account opens the scene meanwhile
    B = await ctx.newPage(); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
    watch(B, "B");
    void B.goto(`${BASE}/${encodeURIComponent(SCENE)}`, { waitUntil: "load" }).catch(() => {}); // NOSONAR S7785: navigation deliberately overlaps drawing in the first tab
  }
  if (B && i > 30 && i % 3 === 0) {
    await draw(B).catch(() => {}); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  }
  await sleep(400); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
  if (i === 9) {
    // fast while the scene connects for the first time (ticket, seeding, the DO's welcome): the
    // seeding's round trip is a few ms locally and hundreds on Cloudflare; up to 40 s
    const until = Date.now() + 40_000;
    while (Date.now() < until && (await A.evaluate(() => window.__live?.current()?.phase ?? "none")) !== "ready") { // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
      await draw(A); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
      await sleep(15); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
    }
    for (let k = 0; k < 30; k++) {
      await draw(A); // NOSONAR S9382: drawing calls must run in order to reproduce connection timing
    }
    log("fast drawing through the first connection:", drawn.length, "shapes");
  }
}
log("drawn", drawn.length, "phase", await A.evaluate(() => window.__live?.current()?.phase ?? "none"));
await admin("faults", null).catch(() => {});
await fetch(`${BASE}/fake-google/admin/faults`, { method: "DELETE" }).catch(() => {});

// quiet: in Drive, then the checks
for (let i = 0; i < 60 && (await A.evaluate(() => window.__live?.current()?.stage() ?? "none")) !== "drive"; i++) await sleep(3000); // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
await sleep(3000);
const failures = [];
const pages = B ? [["A", A], ["B", B]] : [["A", A]];
for (const [tag, page] of pages) {
  const state = await page.evaluate(() => ({ // NOSONAR S9382: in order on purpose (polling, drawing and server operations preserve scenario order)
    list: window.__scenes.getState().list.map((item) => item.name),
    notes: window.__live?.current()?.notes.map((n) => n.text) ?? [],
    alive: window.__scenes.getApi().getSceneElements().map((e) => e.id),
    phase: window.__live?.current()?.phase,
    stage: window.__live?.current()?.stage(),
  }));
  log(tag, "phase", state.phase, "stage", state.stage, "elements", state.alive.length, "notes", JSON.stringify(state.notes));
  const copies = state.list.filter((name) => name?.includes("(offline changes)"));
  if (copies.length) failures.push(`${tag}: offline copies ${JSON.stringify(copies)}`);
  if (state.notes.some((note) => /offline|too old|copy/i.test(note))) failures.push(`${tag}: notes ${JSON.stringify(state.notes)}`);
  const missing = drawn.filter((id) => !state.alive.includes(id));
  if (missing.length) failures.push(`${tag}: ${missing.length} drawn elements missing on the canvas`);
}
const fileId = await A.evaluate(() => window.__live?.current()?.fileId);
if (fileId) {
  const json = await A.evaluate(async (fileId) => {
    const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
    return (await fetch(`/fake-google/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })).text();
  }, fileId);
  const inDrive = new Set((JSON.parse(json).elements || []).filter((e) => !e.isDeleted).map((e) => e.id));
  const missing = drawn.filter((id) => !inDrive.has(id));
  log("in Drive", inDrive.size, "missing", missing.length);
  if (missing.length) failures.push(`Drive misses ${missing.length} drawn elements`);
} else {
  failures.push("the scene never went live");
}
if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
log(failures.length ? `FAIL (${VARIANT}):\n  ${failures.join("\n  ")}` : `PASS (${VARIANT})`);
await browser.close();
process.exit(failures.length ? 1 : 0);
