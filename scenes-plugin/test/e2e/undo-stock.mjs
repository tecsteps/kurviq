// Live sync e2e: undo / redo are Excalidraw's own (stock) on a live scene. Each case runs in the
// tab that made the elements, in a second tab that loaded the scene, and with a reconnect between
// the step and its undo:
//   labeled shape: Delete → ⌘Z (shape and label back) → ⇧⌘Z (gone again)
//   stroke and background color → ⌘Z → ⇧⌘Z;  text edit → ⌘Z;  multi-select Delete → ⌘Z;  image Delete → ⌘Z
// The other tab sees every result. Finally a two-editor case (another account changes the shape
// between my change and my undo) is reported, not asserted: what stock undo does.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node undo-stock.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const SCENE = `stock-undo-${RUN}`;
const OWNER = `su${RUN}@example.test`;
const OTHER = `so${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};
const signIn = async (ctx, email, path, space) => {
  const page = await ctx.newPage();
  if (space) await page.evaluateOnNewDocument((s) => localStorage.setItem("kurviq-space", s), space);
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "load" });
  return page;
};
const ready = async (page) => {
  for (let i = 0; i < 120 && (await page.evaluate(() => window.__live?.current()?.phase).catch(() => null)) !== "ready"; i++) await sleep(500); // NOSONAR S9382: polling, one check after the other
};

const ownerCtx = await browser.createIncognitoBrowserContext();
const A = await signIn(ownerCtx, OWNER, `/${SCENE}`);
watch(A, "A");
for (let i = 0; i < 10; i++) {
  await sleep(1500);
  await A.keyboard.press("Escape");
  await A.keyboard.press("r");
  await A.mouse.move(300, 300);
  await A.mouse.down();
  await A.mouse.move(380, 360, { steps: 4 });
  await A.mouse.up();
  await A.keyboard.press("Escape");
  if (await A.evaluate(() => window.__scenes?.getApi()?.getSceneElements().length ?? 0).catch(() => 0)) break;
}
await ready(A);
const fileId = await A.evaluate(() => window.__live.current().fileId);
log("live", fileId);

// the elements of a case (made in the tab `page`, one undoable step, as the editor would)
const make = (page, kind) =>
  page.evaluate((kind) => {
    const api = window.__scenes.getApi();
    const template = api.getSceneElements().find((e) => e.type === "rectangle");
    const id = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`; // NOSONAR S2245: not security relevant (test element ids)
    const base = { ...template, groupIds: [], frameId: null, boundElements: null, index: null, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent" }; // NOSONAR S2245: not security relevant (versionNonce of test data)
    const x = 100 + Math.random() * 700; // NOSONAR S2245: not security relevant (test position)
    const y = 100 + Math.random() * 400; // NOSONAR S2245: not security relevant (test position)
    let els;
    if (kind === "labeled") {
      const shape = { ...base, id: id("box"), x, y, width: 160, height: 80 };
      const label = { ...base, id: id("label"), type: "text", x: x + 40, y: y + 28, width: 80, height: 25, text: "Label", originalText: "Label", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: shape.id, autoResize: true, lineHeight: 1.25, roundness: null };
      shape.boundElements = [{ type: "text", id: label.id }];
      els = [shape, label];
    } else if (kind === "text") {
      els = [{ ...base, id: id("text"), type: "text", x, y, width: 80, height: 25, text: "Hello", originalText: "Hello", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, roundness: null }];
    } else if (kind === "image") {
      const fileId = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
      api.addFiles([{ id: fileId, mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", created: Date.now() }]);
      els = [{ ...base, id: id("img"), type: "image", fileId, status: "saved", scale: [1, 1], crop: null, x, y, width: 60, height: 60, roundness: null }];
    } else if (kind === "multi") {
      els = [0, 1, 2].map((i) => ({ ...base, id: id("m"), x: x + i * 70, y, width: 50, height: 50 }));
    } else {
      els = [{ ...base, id: id("shape"), x, y, width: 100, height: 60 }];
    }
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...els], captureUpdate: "IMMEDIATELY" });
    return els.map((e) => e.id);
  }, kind);
const stateOf = (page, ids) =>
  page.evaluate((ids) => {
    const all = window.__scenes.getApi().getSceneElementsIncludingDeleted();
    return ids.map((id) => {
      const el = all.find((e) => e.id === id);
      if (!el) return "missing";
      if (el.isDeleted) return "deleted";
      const text = el.type === "text" ? "/" + el.text : "";
      return `${el.strokeColor}/${el.backgroundColor}${text}`;
    });
  }, ids);
const modifiersOf = (combo) => {
  if (combo === "undo") return ["Meta"];
  if (combo === "redo") return ["Meta", "Shift"];
  return [];
};
const key = async (page, combo) => {
  await page.bringToFront();
  await page.focus(".excalidraw");
  const mods = modifiersOf(combo);
  for (const m of mods) await page.keyboard.down(m); // NOSONAR S9382: keys go down in order on purpose
  await page.keyboard.press(combo === "undo" || combo === "redo" ? "z" : combo);
  for (const m of [...mods].reverse()) await page.keyboard.up(m); // NOSONAR S9382: keys go up in order on purpose
};
const select = (page, ids) =>
  page.evaluate((ids) => window.__scenes.getApi().updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) } }), ids);
const change = (page, ids, patch) =>
  page.evaluate(
    (ids, patch) => {
      const api = window.__scenes.getApi();
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map((e) =>
          ids.includes(e.id) ? { ...e, ...patch, ...(patch.text ? { originalText: patch.text } : {}), version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e, // NOSONAR S2245: not security relevant (versionNonce of test data)
        ),
        captureUpdate: "IMMEDIATELY",
      });
    },
    ids,
    patch,
  );
const reconnect = async (page) => {
  await page.evaluate(() => window.__live.current().dropConnection());
  await ready(page);
};

const failures = [];
const check = async (label, ids, expected, pages) => {
  await sleep(1500);
  for (const [tag, page] of pages) {
    const got = await stateOf(page, ids); // NOSONAR S9382: one tab after the other (bringToFront elsewhere, keep it simple and ordered)
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failures.push(`${label} [${tag}]: ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
    }
  }
};

// every case in tab `T` (the other tab `O` must show the same), optionally with a reconnect
const runCases = async (T, O, where, withReconnect) => {
  const both = [[where, T], ["other tab", O]];
  const tag = `${where}${withReconnect ? " + reconnect" : ""}`;
  const pause = async () => (withReconnect ? reconnect(T) : sleep(1200));
  const alive = (n) => new Array(n).fill("#1e1e1e/transparent");

  // labeled shape: Delete → undo → redo
  let ids = await make(T, "labeled");
  await sleep(1200);
  await select(T, [ids[0]]);
  await key(T, "Delete");
  await check(`${tag}: labeled delete`, ids, ["deleted", "deleted"], both);
  await pause();
  await key(T, "undo");
  await check(`${tag}: labeled undo`, ids, ["#1e1e1e/transparent", "#1e1e1e/transparent/Label"], both);
  await key(T, "redo");
  await check(`${tag}: labeled redo`, ids, ["deleted", "deleted"], both);

  // stroke and background color → undo → redo
  ids = await make(T, "shape");
  await sleep(1200);
  await change(T, ids, { strokeColor: "#e03131" });
  await sleep(600);
  await change(T, ids, { backgroundColor: "#a5d8ff" });
  await check(`${tag}: colors`, ids, ["#e03131/#a5d8ff"], both);
  await pause();
  await key(T, "undo");
  await check(`${tag}: background undo`, ids, ["#e03131/transparent"], both);
  await key(T, "undo");
  await check(`${tag}: stroke undo`, ids, alive(1), both);
  await key(T, "redo");
  await check(`${tag}: stroke redo`, ids, ["#e03131/transparent"], both);

  // text edit → undo
  ids = await make(T, "text");
  await sleep(1200);
  await change(T, ids, { text: "Hello world" });
  await check(`${tag}: text edit`, ids, ["#1e1e1e/transparent/Hello world"], both);
  await pause();
  await key(T, "undo");
  await check(`${tag}: text undo`, ids, ["#1e1e1e/transparent/Hello"], both);

  // multi-select Delete → undo
  ids = await make(T, "multi");
  await sleep(1200);
  await select(T, ids);
  await key(T, "Delete");
  await check(`${tag}: multi delete`, ids, ["deleted", "deleted", "deleted"], both);
  await pause();
  await key(T, "undo");
  await check(`${tag}: multi undo`, ids, alive(3), both);

  // image Delete → undo
  ids = await make(T, "image");
  await sleep(1200);
  await select(T, ids);
  await key(T, "Delete");
  await check(`${tag}: image delete`, ids, ["deleted"], both);
  await pause();
  await key(T, "undo");
  await check(`${tag}: image undo`, ids, ["#1e1e1e/transparent"], both);
  const picture = await T.evaluate((id) => {
    const api = window.__scenes.getApi();
    return !!api.getFiles()[api.getSceneElements().find((e) => e.id === id)?.fileId];
  }, ids[0]);
  if (!picture) failures.push(`${tag}: image without its picture after undo`);
  log(tag, "done");
};

const B = await ownerCtx.newPage();
watch(B, "B");
await B.goto(`${BASE}/${SCENE}`, { waitUntil: "load" });
await ready(B);
await runCases(A, B, "creating tab", false);
await runCases(B, A, "second tab", false);
await runCases(A, B, "creating tab", true);
await runCases(B, A, "second tab", true);

// two editors: another account changes the shape between my change and my undo (reported only)
await admin("share", { fileId, email: OTHER, role: "writer" });
await admin("grant", { fileId, email: OTHER });
const C = await signIn(await browser.createIncognitoBrowserContext(), OTHER, `/${SCENE}`, `f:${fileId}`);
watch(C, "C");
await ready(C);
const [shared] = await make(A, "shape");
await sleep(1500);
await change(A, [shared], { strokeColor: "#e03131" }); // mine
await sleep(1500);
await change(C, [shared], { strokeColor: "#2f9e44", backgroundColor: "#ffec99" }); // theirs, after mine
await sleep(1500);
await key(A, "undo");
await sleep(1500);
log("two editors: I set red, the other set green + yellow, then my ⌘Z →", JSON.stringify(await stateOf(A, [shared])), "(other editor sees", JSON.stringify(await stateOf(C, [shared])) + ")");

if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
log(failures.length ? `FAIL:\n  ${failures.join("\n  ")}` : "PASS");
await browser.close();
process.exit(failures.length ? 1 : 0);
