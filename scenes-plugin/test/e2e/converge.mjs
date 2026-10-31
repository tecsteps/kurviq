// Randomized convergence test of live sync against the real Worker + fake Google
// (own headless Chromium, not the shared Playwright MCP browser).
//   node converge.mjs <seed> [ops]
// 3 tabs: owner (2 tabs, one browser context) and guest (1 tab, another context)
// on one shared live scene; random operations, brief offline windows, reloads;
// then quiet, and checks: identical canvases, empty queues, Drive file = canvases,
// no unexpected offline copies, no console errors.
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SEED = Number(process.argv[2] ?? Date.now() % 100000);
const OPS = Number(process.argv[3] ?? 300);
// users and scene are new each run (the operations follow the seed)
const RUN = `${SEED}-${Date.now() % 100000}`;
const SCENE = `conv-${RUN}`;
const OWNER = `own${RUN}@example.test`;
const GUEST = `gst${RUN}@example.test`;

// mulberry32: a fixed seed gives the same operations
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
log("seed", SEED, "ops", OPS, "scene", SCENE);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());

const errors = [];
const dialogs = [];
const watch = (page, tag) => {
  // "leave the page?" (unsaved changes) on a reload: yes, the test reloads on purpose
  page.on("dialog", (dialog) => {
    dialogs.push(`${tag}: ${dialog.type()} ${dialog.message().slice(0, 80)}`);
    dialog.accept().catch(() => {});
  });
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() !== "error") return;
    // expected noise: the startup unmount note, and network failures while a tab is offline on purpose
    if (/editor is gone|Failed to load resource|net::ERR_INTERNET_DISCONNECTED|WebSocket connection|ERR_NETWORK|JSHandle@error/.test(text)) return;
    errors.push(`${tag}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 300)}`));
};

const signIn = async (ctx, email, path, space) => {
  const page = await ctx.newPage();
  if (space) await page.evaluateOnNewDocument((s) => localStorage.setItem("kurviq-space", s), space);
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "networkidle2" });
  return page;
};
const phase = (page) => page.evaluate(() => window.__live?.current()?.phase ?? "none").catch(() => "gone");
const waitReady = async (page, ms = 40_000) => {
  for (let i = 0; i < ms / 500; i++) {
    if ((await phase(page)) === "ready") return true;
    await sleep(500);
  }
  return false;
};

// --- set up: owner creates the scene, shares it, guest and the owner's 2nd tab join
const ownerCtx = await browser.createIncognitoBrowserContext();
const guestCtx = await browser.createIncognitoBrowserContext();
const A1 = await signIn(ownerCtx, OWNER, `/${SCENE}`);
watch(A1, "A1");
// a first rectangle by hand (the template for the others), then the old path creates the file and live sync starts
for (let i = 0; i < 10; i++) {
  await sleep(1500);
  await A1.keyboard.press("Escape");
  await A1.keyboard.press("r");
  await A1.mouse.move(400, 300);
  await A1.mouse.down();
  await A1.mouse.move(480, 360, { steps: 4 });
  await A1.mouse.up();
  await A1.keyboard.press("Escape");
  const drawn = await A1.evaluate(() => window.__scenes?.getApi()?.getSceneElements().length ?? 0).catch(() => 0);
  if (drawn) break;
}
if (!(await waitReady(A1, 45_000))) {
  log("A1 state", await A1.evaluate(() => JSON.stringify({ n: window.__scenes?.getApi()?.getSceneElements().length, current: window.__scenes?.getState().current, list: window.__scenes?.getState().list.map((i) => `${i.name}:${i.status}:${i.fileId}`), live: window.__live?.current() ? { phase: window.__live.current().phase, error: window.__live.current().error, enabled: window.__live.current().enabled } : null, activity: window.__scenes?.getState().activity.slice(0, 5).map((a) => a.text), sync: window.__scenes?.getState().sync })).catch((e) => e.message));
  throw new Error("A1 never became live");
}
const fileId = await A1.evaluate(() => window.__live.current().fileId);
await admin("share", { fileId, email: GUEST, role: "writer" });
await admin("grant", { fileId, email: GUEST });
const B = await signIn(guestCtx, GUEST, `/${SCENE}`, `f:${fileId}`);
watch(B, "B");
const A2 = await ownerCtx.newPage();
watch(A2, "A2");
await A2.goto(`${BASE}/${SCENE}`, { waitUntil: "load" });
for (const [tag, page] of [["B", B], ["A2", A2]]) {
  if (!(await waitReady(page))) throw new Error(`${tag} never became live`);
}
log("live in 3 tabs, file", fileId);

const tabs = { A1, A2, B };
const offlineUntil = { A1: 0, A2: 0, B: 0 };
/** elements a tab made while offline: it edits only those then (no collision expected) */
const counts = {};

// --- one operation in a tab (through Excalidraw's API, as user steps: undoable)
const offlineNow = { A1: false, A2: false, B: false };
const wasOffline = { A1: false, A2: false, B: false };
const op = async (tag, kind, r) =>
  tabs[tag].evaluate(
    (kind, r, offline) => {
      const api = window.__scenes.getApi();
      if (!api) return "no-api";
      const all = api.getSceneElementsIncludingDeleted();
      const alive = all.filter((el) => !el.isDeleted);
      const mine = window.__offlineMine ?? (window.__offlineMine = new Set());
      const editable = offline ? alive.filter((el) => mine.has(el.id)) : alive;
      const any = (list, i) => list[Math.floor(i * list.length) % Math.max(1, list.length)];
      const template = alive.find((el) => el.type === "rectangle") ?? all.find((el) => el.type === "rectangle");
      if (!template) return "no-template";
      const id = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      const bump = (el, patch) => ({ ...el, ...patch, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
      const commit = (changed) => {
        const byId = new Map(all.map((el) => [el.id, el]));
        changed.forEach((el) => byId.set(el.id, el));
        api.updateScene({ elements: [...byId.values()], captureUpdate: "IMMEDIATELY" });
        if (offline) changed.forEach((el) => mine.add(el.id));
        return `${kind}:${changed.map((el) => el.id.slice(0, 4)).join(",")}`;
      };
      const base = { ...template, groupIds: [], frameId: null, boundElements: null, link: null, locked: false, index: null, isDeleted: false };
      const palette = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5"];
      switch (kind) {
        case "add":
          return commit([{ ...base, id: id(), x: 50 + r[0] * 900, y: 50 + r[1] * 600, width: 40 + r[2] * 100, height: 30 + r[3] * 80, version: 1, versionNonce: 1, seed: 1 }]);
        case "move": {
          const el = any(editable, r[0]);
          return el ? commit([bump(el, { x: el.x + (r[1] - 0.5) * 200, y: el.y + (r[2] - 0.5) * 200 })]) : "skip";
        }
        case "recolor": {
          const el = any(editable, r[0]);
          return el ? commit([bump(el, { strokeColor: palette[Math.floor(r[1] * palette.length)] })]) : "skip";
        }
        case "delete": {
          const el = any(editable.filter((e) => e.type !== "text" || !e.containerId), r[0]);
          if (!el) return "skip";
          // what is bound to it (arrows, labels) lets go, like the editor does
          const changed = [bump(el, { isDeleted: true })];
          for (const other of alive) {
            if (other.id === el.id) continue;
            const patch = {};
            if (other.startBinding?.elementId === el.id) patch.startBinding = null;
            if (other.endBinding?.elementId === el.id) patch.endBinding = null;
            if (other.containerId === el.id) patch.isDeleted = true;
            // and nothing lists it as bound any more (the editor does the same)
            if ((other.boundElements || []).some((b) => b.id === el.id)) patch.boundElements = other.boundElements.filter((b) => b.id !== el.id);
            if (Object.keys(patch).length) changed.push(bump(other, patch));
          }
          return commit(changed);
        }
        case "group": {
          const a = any(editable, r[0]);
          const b = any(editable, r[1]);
          if (!a || !b || a.id === b.id) return "skip";
          const g = id();
          return commit([bump(a, { groupIds: [g] }), bump(b, { groupIds: [g] })]);
        }
        case "arrow": {
          const shapes = editable.filter((e) => e.type === "rectangle");
          const a = any(shapes, r[0]);
          const b = any(shapes, r[1]);
          if (!a || !b || a.id === b.id) return "skip";
          const arrowId = id();
          const arrow = {
            ...base,
            id: arrowId,
            type: "arrow",
            x: a.x + a.width,
            y: a.y + a.height / 2,
            width: Math.abs(b.x - a.x - a.width) || 1,
            height: Math.abs(b.y - a.y) || 1,
            points: [
              [0, 0],
              [b.x - a.x - a.width || 1, b.y - a.y || 1],
            ],
            lastCommittedPoint: null,
            startArrowhead: null,
            endArrowhead: "arrow",
            elbowed: false,
            roundness: null,
            startBinding: { elementId: a.id, fixedPoint: [1, 0.5], mode: "orbit" },
            endBinding: { elementId: b.id, fixedPoint: [0, 0.5], mode: "orbit" },
            version: 1,
            versionNonce: 1,
          };
          const withArrow = (el) => bump(el, { boundElements: [...(el.boundElements || []), { type: "arrow", id: arrowId }] });
          return commit([arrow, withArrow(a), withArrow(b)]);
        }
        case "text": {
          return commit([
            {
              ...base,
              id: id(),
              type: "text",
              x: 50 + r[0] * 900,
              y: 50 + r[1] * 600,
              width: 120,
              height: 25,
              text: `t${Math.floor(r[2] * 1000)}`,
              originalText: `t${Math.floor(r[2] * 1000)}`,
              fontSize: 20,
              fontFamily: 5,
              textAlign: "left",
              verticalAlign: "top",
              containerId: null,
              autoResize: true,
              lineHeight: 1.25,
              roundness: null,
              version: 1,
              versionNonce: 1,
            },
          ]);
        }
        case "edit-text": {
          const el = any(editable.filter((e) => e.type === "text"), r[0]);
          if (!el) return "skip";
          const text = `${el.text.slice(0, 20)}${Math.floor(r[1] * 10)}`;
          return commit([bump(el, { text, originalText: text })]);
        }
        case "z": {
          const el = any(editable, r[0]);
          if (!el) return "skip";
          // to the front: after the last element (the editor gives it its index)
          const rest = all.filter((e) => e.id !== el.id);
          api.updateScene({ elements: [...rest, bump(el, { index: null })], captureUpdate: "IMMEDIATELY" });
          if (offline) mine.add(el.id);
          return `z:${el.id.slice(0, 4)}`;
        }
        case "image": {
          const fileId = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
          const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
          api.addFiles([{ id: fileId, mimeType: "image/png", dataURL: png, created: Date.now() }]);
          return commit([{ ...base, id: id(), type: "image", fileId, status: "saved", scale: [1, 1], crop: null, x: 50 + r[0] * 900, y: 50 + r[1] * 600, width: 40, height: 40, roundness: null, version: 1, versionNonce: 1 }]);
        }
      }
      return "unknown";
    },
    kind,
    r,
    offlineNow[tag],
  );

const undo = (tag) => tabs[tag].evaluate(() => {
  // the editor's own undo (history), as ⌘Z
  const api = window.__scenes.getApi();
  document.querySelector(".excalidraw")?.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, ctrlKey: true, bubbles: true }));
  return api ? "undo" : "no-api";
});

const KINDS = ["add", "add", "move", "move", "move", "recolor", "recolor", "delete", "group", "arrow", "text", "edit-text", "z", "undo", "image"];
let offlineWindows = 0;
let offlineEdits = 0;
let reloads = 0;
for (let i = 0; i < OPS; i++) {
  const tag = pick(["A1", "A2", "B"]);
  const roll = rand();
  if (roll < 0.015 && Date.now() > offlineUntil[tag]) {
    // a brief offline window (the browser's network off; the socket is dropped like a network loss)
    const ms = int(1500, 4000);
    offlineUntil[tag] = Date.now() + ms;
    offlineWindows++;
    const page = tabs[tag];
    await page.evaluate(() => (window.__offlineMine = new Set())).catch(() => {});
    await page.setOfflineMode(true);
    await page.evaluate(() => window.__live.current()?.dropConnection()).catch(() => {});
    setTimeout(async () => {
      await page.setOfflineMode(false).catch(() => {});
      await page.evaluate(() => window.__live.current()?.wake()).catch(() => {});
    }, ms);
    log(`#${i} ${tag} offline ${ms} ms`);
    continue;
  }
  if (roll < 0.025 && Date.now() > offlineUntil[tag]) {
    reloads++;
    log(`#${i} ${tag} reload`);
    await tabs[tag].reload({ waitUntil: "load", timeout: 60_000 });
    await waitReady(tabs[tag], 30_000);
    continue;
  }
  const kind = pick(KINDS);
  const r = [rand(), rand(), rand(), rand()];
  // offline per the concept: not connected and up to date (also while reconnecting after an offline window)
  const connected = (await phase(tabs[tag])) === "ready";
  const offline = !connected || Date.now() < offlineUntil[tag];
  if (offline && !wasOffline[tag] && Date.now() >= offlineUntil[tag]) {
    // a new offline stretch (reconnecting): only what it makes in it from now on
    await tabs[tag].evaluate(() => (window.__offlineMine = new Set())).catch(() => {});
  }
  wasOffline[tag] = offline;
  // offline: only new things, or the tab's own offline elements (nothing that can clash)
  if (offline && !["add", "text", "image", "move", "recolor"].includes(kind)) {
    continue;
  }
  offlineNow[tag] = offline;
  const result = kind === "undo" ? (offline ? "skip" : await undo(tag)) : await op(tag, kind, r).catch((e) => `ERR ${e.message}`);
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (offline && result !== "skip") offlineEdits++;
  if (i % 25 === 0) log(`#${i} ${tag} ${result}`);
  await sleep(int(20, 250));
}
log("ops done", JSON.stringify(counts), "offline windows", offlineWindows, "offline edits", offlineEdits, "reloads", reloads);

// --- quiet: everyone connected, nothing unanswered, then the save round brings everything to Drive
for (const [tag, page] of Object.entries(tabs)) {
  await page.setOfflineMode(false);
  await page.evaluate(() => window.__live.current()?.wake()).catch(() => {});
  if (!(await waitReady(page, 60_000))) log(`!! ${tag} not ready`);
}
const stageOf = (page) => page.evaluate(() => window.__live.current()?.stage() ?? "none");
let stages = [];
for (let i = 0; i < 60; i++) {
  stages = await Promise.all(Object.values(tabs).map(stageOf));
  if (stages.every((stage) => stage === "drive")) break;
  await sleep(3000);
}
log("stages", JSON.stringify(stages));
// the tabs' catch-up with the DO's state runs every 5 s (claims of other tabs lapse meanwhile)
await sleep(8000);

// --- checks
const VOLATILE = new Set(["version", "versionNonce", "updated", "seed"]);
const norm = (value) => {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const field = value[key];
      if (VOLATILE.has(key) || field === null || field === undefined || (Array.isArray(field) && !field.length)) continue;
      out[key] = norm(field);
    }
    return out;
  }
  return value;
};
const sceneOf = (elements) =>
  Object.fromEntries(
    elements
      .filter((el) => !el.isDeleted)
      .map((el) => {
        // the editor's own render state of a picture is not content
        const { status, ...rest } = el;
        return [el.id, JSON.stringify(norm(rest))];
      }),
  );
for (const [tag, page] of Object.entries(tabs)) {
  const info = await page.evaluate(() => {
    const s = window.__live.current();
    const out = [];
    for (const el of window.__scenes.getApi().getSceneElementsIncludingDeleted()) {
      const c = s.confirmed.get(el.id);
      if (!el.isDeleted && (!c || c.index !== el.index || c.version !== el.version)) {
        out.push(`${el.id.slice(0, 6)} canvas ${el.index}/v${el.version} confirmed ${c?.index}/v${c?.version}${c?.isDeleted ? "(del)" : ""}`);
      }
    }
    return out;
  });
  log(`${tag} canvas vs confirmed`, JSON.stringify(info.slice(0, 8)));
}
const canvases = {};
for (const [tag, page] of Object.entries(tabs)) {
  canvases[tag] = sceneOf(await page.evaluate(() => window.__scenes.getApi().getSceneElementsIncludingDeleted()));
}
const diff = (a, b) => {
  const out = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[id] === b[id]) continue;
    if (a[id] && b[id]) {
      const [x, y] = [JSON.parse(a[id]), JSON.parse(b[id])];
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((key) => JSON.stringify(x[key]) !== JSON.stringify(y[key]));
      out.push(`${id.slice(0, 6)} ${x.type}: ${keys.map((key) => `${key}=${JSON.stringify(x[key])?.slice(0, 40)}|${JSON.stringify(y[key])?.slice(0, 40)}`).join(" ")}`);
    } else {
      out.push(id.slice(0, 6) + (a[id] ? " only left" : " only right"));
    }
  }
  return out;
};
const failures = [];
for (const tag of ["A2", "B"]) {
  const d = diff(canvases.A1, canvases[tag]);
  if (d.length) failures.push(`canvas A1 vs ${tag}: ${d.length} (${d.slice(0, 8).join("; ")})`);
}
// the Drive file
const driveJson = await A1.evaluate(async (fileId) => {
  const { token } = await (await fetch("/auth/token", { method: "POST" })).json();
  const res = await fetch(`/fake-google/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  return res.text();
}, fileId);
const drive = sceneOf(JSON.parse(driveJson).elements || []);
const dDrive = diff(canvases.A1, drive);
if (dDrive.length) failures.push(`Drive vs canvas: ${dDrive.length} (${dDrive.slice(0, 8).join("; ")})`);
// queues
const queueOf = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("kurviq-live-queue");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("batches")) return resolve([]);
          const req = db.transaction("batches").objectStore("batches").getAll();
          req.onsuccess = () => resolve(req.result.map((b) => `${b.tab}:${b.counter}:${b.state}`));
        };
        open.onerror = () => resolve(["?"]);
      }),
  );
const queues = { owner: await queueOf(A1), guest: await queueOf(B) };
if (queues.owner.length || queues.guest.length) failures.push(`queues not empty: ${JSON.stringify(queues)}`);
// offline copies
const copies = [];
for (const [tag, page] of Object.entries(tabs)) {
  const names = await page.evaluate(() => window.__scenes.getState().list.map((item) => item.name).filter((name) => name && name.includes("(offline changes)")));
  copies.push(...names.map((name) => `${tag}: ${name}`));
}
if (copies.length) {
  failures.push(`offline copies: ${JSON.stringify(copies)}`);
  for (const [tag, page] of [["owner", A1], ["guest", B]]) {
    log(`${tag} copy reasons`, await page.evaluate(() => localStorage.getItem("kurviq-live-debug-copies")));
  }
}
const notes = [];
for (const [tag, page] of Object.entries(tabs)) {
  const n = await page.evaluate(() => window.__live.current()?.notes.map((note) => note.text) ?? []);
  notes.push(...n.map((text) => `${tag}: ${text}`));
}
if (errors.length) failures.push(`console errors: ${errors.length}: ${errors.slice(0, 5).join(" | ")}`);
log("dialogs", JSON.stringify(dialogs.slice(0, 5)));
log("elements", Object.keys(canvases.A1).length, "notes", JSON.stringify(notes));
if (failures.length) {
  const ids = new Set();
  for (const tag of ["A2", "B"]) diff(canvases.A1, canvases[tag]).forEach((line) => ids.add(line.slice(0, 6)));
  for (const [tag, page] of Object.entries(tabs)) {
    const trace = await page.evaluate((ids) => (window.__live.current()?.trace ?? []).filter((line) => ids.some((id) => line.includes(id))), [...ids]);
    log(`${tag} trace`, JSON.stringify(trace.slice(-12)));
    const holders = await page.evaluate((ids) => {
      const s = window.__live.current();
      const all = window.__scenes.getApi().getSceneElementsIncludingDeleted();
      return ids.map((id) => {
        const el = all.find((e) => e.id.startsWith(id));
        const c = el && s.confirmed.get(el.id);
        if (!el || !c) return `${id}: -`;
        const others = all.filter((e) => e.id !== el.id && e.index === c.index).map((e) => `${e.id.slice(0, 6)}${e.isDeleted ? "(del)" : ""}`);
        const pending = s.pendingIds().has(el.id);
        const keys = Object.keys({ ...el, ...c }).filter((k) => !["version", "versionNonce", "updated", "seed"].includes(k) && JSON.stringify(el[k] ?? null) !== JSON.stringify(c[k] ?? null));
        return `${id}: canvas ${el.index} conf ${c.index} holders [${others}] pending ${pending} others ${s.othersHave(el.id)} differ [${keys}]`;
      });
    }, [...ids]);
    log(`${tag} holders`, JSON.stringify(holders));
  }
}
log(failures.length ? `FAIL seed ${SEED}:\n  ${failures.join("\n  ")}` : `PASS seed ${SEED}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
