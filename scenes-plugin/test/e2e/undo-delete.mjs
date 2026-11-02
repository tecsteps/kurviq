// Live sync e2e: delete an element and undo it (⌘Z, the editor's own history), on a live scene:
// a plain rectangle and an image, each on its own and inside a frame. The element must come
// back in this tab, in the user's second tab and in the saved Drive file; redo deletes it again.
// Also: undo after an agent deleted something (reported, not asserted).
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node undo-delete.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const SCENE = `undo-${RUN}`;
const EMAIL = `undo${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};
const ctx = await browser.createIncognitoBrowserContext();
const A = await ctx.newPage();
const GA = A;
watch(A, "A");
await A.goto(`${BASE}/auth/login?return=${encodeURIComponent("/" + SCENE)}`, { waitUntil: "domcontentloaded" });
await A.goto(A.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "load" });
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
for (let i = 0; i < 90 && (await A.evaluate(() => window.__live?.current()?.phase).catch(() => null)) !== "ready"; i++) await sleep(500); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
if ((await A.evaluate(() => window.__live?.current()?.phase).catch(() => null)) !== "ready") {
  log("not live:", A.url(), await A.evaluate(() => JSON.stringify({ live: !!window.__live, scenes: !!window.__scenes, current: window.__scenes?.getState().current, list: window.__scenes?.getState().list.map((i) => `${i.name}:${i.status}`) })).catch((e) => e.message));
  process.exit(2);
}
log("live", await A.evaluate(() => window.__live.current().fileId));

// the cast: a rectangle and an image, on their own and inside a frame
const ids = await A.evaluate(() => {
  const api = window.__scenes.getApi();
  const rect = api.getSceneElements()[0];
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const fileId = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
  api.addFiles([{ id: fileId, mimeType: "image/png", dataURL: png, created: Date.now() }]);
  const base = { ...rect, groupIds: [], frameId: null, boundElements: null, index: null, version: 1, versionNonce: 1 };
  const frame = { ...base, id: "frame-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""), type: "frame", name: "Slide", x: 600, y: 100, width: 500, height: 400, roundness: null };
  const els = [
    { ...base, id: "img-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""), type: "image", fileId, status: "saved", scale: [1, 1], crop: null, x: 100, y: 100, width: 60, height: 60, roundness: null },
    frame,
    { ...base, id: "rectf-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""), x: 650, y: 150, frameId: frame.id },
    { ...base, id: "imgf-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""), type: "image", fileId, status: "saved", scale: [1, 1], crop: null, x: 800, y: 200, width: 60, height: 60, roundness: null, frameId: frame.id },
  ];
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...els], captureUpdate: "IMMEDIATELY" });
  return { rect: rect.id, img: els[0].id, rectInFrame: els[2].id, imgInFrame: els[3].id };
});
await sleep(2500);
const B = await ctx.newPage();
watch(B, "B");
await B.goto(`${BASE}/${SCENE}`, { waitUntil: "load" });
for (let i = 0; i < 60 && (await B.evaluate(() => window.__live?.current()?.phase).catch(() => null)) !== "ready"; i++) await sleep(500); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
await A.bringToFront();

const alive = (page, id) =>
  page.evaluate((id) => {
    const el = window.__scenes.getApi().getSceneElementsIncludingDeleted().find((e) => e.id === id);
    if (!el) return "missing";
    return el.isDeleted ? "deleted" : "alive";
  }, id);
let P = A; // the tab that deletes and undoes
const press = async (combo) => {
  const A = P;
  await A.bringToFront();
  await A.focus(".excalidraw");
  if (combo === "undo") {
    await A.keyboard.down("Meta");
    await A.keyboard.press("z");
    await A.keyboard.up("Meta");
  } else if (combo === "redo") {
    await A.keyboard.down("Meta");
    await A.keyboard.down("Shift");
    await A.keyboard.press("z");
    await A.keyboard.up("Shift");
    await A.keyboard.up("Meta");
  } else {
    await A.keyboard.press(combo);
  }
};
const driveState = async (id) =>
  A.evaluate(
    async (fileId, id) => {
      const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
      const res = await fetch(`/fake-google/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
      const el = (JSON.parse(await res.text()).elements || []).find((e) => e.id === id);
      if (!el) return "missing";
    return el.isDeleted ? "deleted" : "alive";
    },
    await A.evaluate(() => window.__live.current().fileId),
    id,
  );
const failures = [];
const results = {};
const cycle = async (P0, what, id, group, reconnect = false) => {
  P = P0;
  const A = P0;
  // moved first like a drag does (many local versions; the DO's answer re-stamps it lower)
  for (let step = 0; step < 15; step++) {
    await A.evaluate((id) => { // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
      const api = window.__scenes.getApi();
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => (e.id === id ? { ...e, x: e.x + 2, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e)), captureUpdate: "EVENTUALLY" }); // NOSONAR S2245: not security relevant (Excalidraw versionNonce)
    }, id);
    await sleep(20); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
  }
  await sleep(1500);
  log(what, "versions after the move: canvas", await A.evaluate((id) => window.__scenes.getApi().getSceneElements().find((e) => e.id === id)?.version, id));
  // select it (as a click does), Delete, wait for the DO's answer, then ⌘Z
  await A.evaluate(
    (id, group) => {
      const api = window.__scenes.getApi();
      const members = group ? api.getSceneElements().filter((e) => e.groupIds.includes(group)).map((e) => e.id) : [id];
      api.updateScene({ appState: { selectedElementIds: Object.fromEntries(members.map((m) => [m, true])), ...(group ? { selectedGroupIds: { [group]: true } } : {}) } });
    },
    id,
    group ?? null,
  );
  await press("Delete");
  await sleep(1500);
  if (reconnect) {
    // a reconnect after the delete was answered: the welcome replays this tab's own batches
    await A.evaluate(() => window.__live.current().dropConnection());
    for (let i = 0; i < 40 && (await A.evaluate(() => window.__live.current().phase)) !== "ready"; i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
  }
  const other = P0 === B ? GA : B;
  const afterDelete = [await alive(A, id), await alive(other, id)];
  await press("undo");
  await sleep(1500);
  const afterUndo = [await alive(A, id), await alive(other, id)];
  await press("redo");
  await sleep(1500);
  const afterRedo = [await alive(A, id), await alive(other, id)];
  await press("undo");
  await sleep(1500);
  const final = [await alive(A, id), await alive(other, id)];
  results[what] = { afterDelete, afterUndo, afterRedo, final };
  log(what, JSON.stringify(results[what]));
  if (afterDelete.join() !== "deleted,deleted") failures.push(`${what}: delete not everywhere ${afterDelete}`);
  if (afterUndo.join() !== "alive,alive") failures.push(`${what}: undo did not bring it back ${afterUndo}`);
  if (afterRedo.join() !== "deleted,deleted") failures.push(`${what}: redo did not delete it again ${afterRedo}`);
  if (final.join() !== "alive,alive") failures.push(`${what}: second undo ${final}`);
};
for (const [what, id] of Object.entries(ids)) {
  await cycle(A, what, id); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
}
// the second tab loaded the scene (not made in it): the same there, with an image grouped with its label
const grouped = await B.evaluate(() => {
  const api = window.__scenes.getApi();
  const img = api.getSceneElements().find((e) => e.type === "image" && !e.frameId);
  const group = "g-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
  const label = { ...img, id: "label-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join(""), type: "text", text: "New SaaS", originalText: "New SaaS", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, y: img.y + 70, width: 90, height: 25, fileId: undefined, status: undefined, scale: undefined, crop: undefined, groupIds: [group], index: null, version: 1, versionNonce: 3 };
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted().map((e) => (e.id === img.id ? { ...e, groupIds: [group], version: e.version + 1, versionNonce: 5 } : e)), label], captureUpdate: "IMMEDIATELY" });
  return { img: img.id, label: label.id, group };
});
await sleep(2000);
await cycle(B, "B:groupedImage", grouped.img, grouped.group);
await cycle(B, "B:rect", ids.rectInFrame);
await cycle(A, "A:image, reconnect between delete and undo", ids.img, null, true);
await cycle(B, "B:grouped, reconnect between delete and undo", grouped.img, grouped.group, true);
P = A;
// the saved Drive file after the save round
for (let i = 0; i < 40 && (await A.evaluate(() => window.__live.current().stage())) !== "drive"; i++) await sleep(3000); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
for (const [what, id] of Object.entries(ids)) {
  const saved = await driveState(id); // NOSONAR S9382: in order on purpose (polling and dependent browser actions)
  log(what, "in Drive:", saved);
  if (saved !== "alive") failures.push(`${what}: Drive has it ${saved}`);
}
// the image still has its picture after the round trip
const pictures = await A.evaluate((ids) => {
  const api = window.__scenes.getApi();
  return [ids.img, ids.imgInFrame].map((id) => !!api.getFiles()[api.getSceneElements().find((e) => e.id === id)?.fileId]);
}, ids);
if (pictures.some((has) => !has)) failures.push(`image data missing after undo: ${pictures}`);

// an agent deletes the plain rectangle; what does the user's ⌘Z do?
await A.evaluate(async (id) => {
  const s = window.__live.current();
  const el = s.elements().find((e) => e.id === id);
  await s.agentEdit([{ ...el, isDeleted: true, version: el.version + 1, versionNonce: 7 }], [], "agent-delete-" + Date.now());
}, ids.rect);
await sleep(1500);
const agentDeleted = [await alive(A, ids.rect), await alive(B, ids.rect)];
await press("undo");
await sleep(1500);
log("agent delete", JSON.stringify(agentDeleted), "then the user's undo:", JSON.stringify([await alive(A, ids.rect), await alive(B, ids.rect)]));
if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
log(failures.length ? `FAIL:\n  ${failures.join("\n  ")}` : "PASS");
await browser.close();
process.exit(failures.length ? 1 : 0);
