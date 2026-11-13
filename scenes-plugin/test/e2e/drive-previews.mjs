// e2e (Drive previews and search words, specs/2026-11-13-drive-thumbnails.md and
// -drive-search-text.md): a save to Drive sets the file's contentHints (a PNG about 400 px
// wide of the scene, the words to index), the next save updates them, a deck shows its first
// slide, an empty scene has no preview, an agent's edit updates them too, a scene with a big
// picture still saves with a preview below 2 MB, local-only scenes never reach Drive, and no
// request to Kurviq's server carries any of it.
// Real Worker + fake Google (its GET /fake-google/admin/file shows the stored contentHints):
// KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node drive-previews.mjs [email]
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const SCENE = `previews-${RUN}`;
const EMAIL = process.argv[2] || `pv${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 240_000,
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const hintsOf = async (fileId) => (await admin(`file?fileId=${fileId}`)).contentHints ?? {};
/** polls until check(value) holds (or gives up after `seconds`), returns the last value */
const until = async (read, check, seconds = 40) => {
  let value;
  for (let i = 0; i < seconds * 2; i++) {
    value = await read(); // NOSONAR S9382: polling, one check after the other
    if (check(value)) break;
    await sleep(500); // NOSONAR S9382: polling, one check after the other
  }
  return value;
};

const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
// every request body the page sends (fetch, XHR, beacons, WebSocket messages), to check where hints go
await page.evaluateOnNewDocument(() => {
  const sent = (window.__sent = []);
  const record = (url, body) => {
    if (body === undefined || body === null) return;
    if (typeof body === "string") sent.push({ url: String(url), body });
    else if (body instanceof Blob) body.text().then((text) => sent.push({ url: String(url), body: text }), () => {});
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) sent.push({ url: String(url), body: new TextDecoder().decode(body) });
    else sent.push({ url: String(url), body: String(body) });
  };
  const fetch = window.fetch;
  window.fetch = function (input, init, ...rest) {
    record(input instanceof Request ? input.url : input, init?.body);
    return fetch.call(this, input, init, ...rest);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__url = url;
    return open.call(this, method, url, ...rest);
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    record(this.__url, body);
    return xhrSend.call(this, body);
  };
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    record(this.url, data);
    return wsSend.call(this, data);
  };
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) {
    navigator.sendBeacon = (url, data) => {
      record(url, data);
      return beacon(url, data);
    };
  }
});

await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/" + SCENE)}`, { waitUntil: "domcontentloaded" });
await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "networkidle2" });
for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__scenes?.getApi() && !!window.__agentCommand).catch(() => false)); i++) await sleep(250); // NOSONAR S9382: polling
await page.evaluate(() => window.__scenes.ready);
await sleep(1500);
const agent = (command) => page.evaluate((c) => window.__agentCommand(c), command);
const fileIdOf = (name) => until(() => page.evaluate((n) => window.__scenes.fileIdOf(n) ?? null, name), Boolean);
/** the color in the middle of a thumbnail, read in the page */
const centerColor = (thumbnail) =>
  page.evaluate(async ({ image, mimeType }) => {
    const img = new Image();
    img.src = `data:${mimeType};base64,${image.replaceAll("-", "+").replaceAll("_", "/")}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    return Array.from(context.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data.subarray(0, 3));
  }, thumbnail);
const reddish = ([r, g, b]) => r > 180 && g < 120 && b < 120;
const bluish = ([r, g, b]) => b > 150 && r < 120;

// 1. a scene drawn by the user (an edit of the open scene, saved by the app): preview + words
const WORD = `zebrafish${RUN}`;
const edit = (add) => agent({ type: "edit", expectScene: SCENE, requestId: `e-${Date.now()}-${Math.random()}`, add });
await edit([
  { type: "rectangle", id: "box", x: 100, y: 100, width: 400, height: 200, backgroundColor: "#e03131", fillStyle: "solid", label: { text: "Box label words" } },
  { type: "text", id: "words", x: 100, y: 340, text: `The ${WORD} roadmap`, fontSize: 28 },
]);
const fileId = await fileIdOf(SCENE);
ok(!!fileId, "the scene is in Drive", fileId);
let hints = await until(() => hintsOf(fileId), (h) => !!h.thumbnail && h.indexableText?.includes(WORD));
ok(hints.thumbnail?.mimeType === "image/png" && Math.abs((hints.thumbnail?.width ?? 0) - 400) <= 2, "1: the saved file has a PNG preview about 400 px wide", { ...hints.thumbnail, image: undefined });
ok(reddish(hints.thumbnail ? await centerColor(hints.thumbnail) : [0, 0, 0]), "1: the preview shows the scene (its red box in the middle)");
const thumbLink = await fetch(`${BASE}/fake-google/thumbnail/${fileId}`);
ok(thumbLink.ok && thumbLink.headers.get("Content-Type") === "image/png", "the file's thumbnailLink serves the picture", thumbLink.status);
ok(hints.indexableText?.split("\n")[0] === SCENE && hints.indexableText.includes(`The ${WORD} roadmap`) && hints.indexableText.includes("Box label words"),
  "search: the scene name, the text and the label are indexed", hints.indexableText);

// 3. the next edit and save: a new preview of the new state, new words
const before = hints.thumbnail.image;
await edit([{ type: "rectangle", id: "box2", x: 600, y: 100, width: 300, height: 300, backgroundColor: "#1971c2", fillStyle: "solid" }, { type: "text", id: "more", x: 600, y: 420, text: "okapi second words", fontSize: 28 }]);
hints = await until(() => hintsOf(fileId), (h) => h.indexableText?.includes("okapi") && h.thumbnail && h.thumbnail.image !== before);
ok(!!hints.thumbnail && hints.thumbnail.image !== before, "3: after the next save the preview shows the new state");
ok(hints.indexableText?.includes("okapi second words"), "3: and the new words are indexed");

// deleted elements' words go
await agent({ type: "edit", expectScene: SCENE, requestId: `d-${Date.now()}`, delete: ["more"] });
hints = await until(() => hintsOf(fileId), (h) => !h.indexableText?.includes("okapi"));
ok(!hints.indexableText?.includes("okapi") && hints.indexableText?.includes(WORD), "deleted elements' words are not indexed", hints.indexableText);

// 4. an agent's edit of the scene in Drive (detached, saved by this tab as the agent)
const AGENT_WORD = `axolotl${RUN}`;
const agentEdit = await agent({ type: "scene-edit", name: SCENE, requestId: `a-${Date.now()}`, add: [{ type: "text", id: "agent", x: 100, y: 500, text: `${AGENT_WORD} from the agent`, fontSize: 28 }] });
ok(!agentEdit?.error, "the agent's edit is saved", agentEdit?.error);
const beforeAgent = hints.thumbnail?.image;
hints = await until(() => hintsOf(fileId), (h) => h.indexableText?.includes(AGENT_WORD) && h.thumbnail && h.thumbnail.image !== beforeAgent);
ok(hints.indexableText?.includes(AGENT_WORD) && !!hints.thumbnail && hints.thumbnail.image !== beforeAgent, "4: an agent's edit updates the preview and the words");

// 2a. a deck: the preview is its first slide (16:9, the first slide's red, not the second's blue)
const DECK = `deck-${RUN}`;
await agent({ type: "create", name: DECK });
await sleep(1000);
await agent({
  type: "edit",
  expectScene: DECK,
  requestId: `deck-${Date.now()}`,
  isPresentation: true,
  add: [
    { type: "frame", id: "s1", x: 0, y: 0, width: 1920, height: 1080, name: "Opening slide title", customData: { slides: { order: 0 } } },
    { type: "rectangle", id: "r1", x: 0, y: 0, width: 1920, height: 1080, frameId: "s1", backgroundColor: "#e03131", fillStyle: "solid" },
    { type: "frame", id: "s2", x: 2100, y: 0, width: 1920, height: 1080, name: "Second slide title", customData: { slides: { order: 1, notes: "private speaker remark" } } },
    { type: "rectangle", id: "r2", x: 2100, y: 0, width: 1920, height: 1080, frameId: "s2", backgroundColor: "#1971c2", fillStyle: "solid" },
  ],
});
const deckId = await fileIdOf(DECK);
const deckHints = await until(() => hintsOf(deckId), (h) => !!h.thumbnail && h.indexableText?.includes("Second slide title"));
ok(deckHints.thumbnail?.width === 400 && Math.abs((deckHints.thumbnail?.height ?? 0) - 225) <= 1, "2: a deck's preview has a slide's shape (16:9)", { ...deckHints.thumbnail, image: undefined });
ok(reddish(deckHints.thumbnail ? await centerColor(deckHints.thumbnail) : [0, 0, 0]), "2: and shows the first slide");
ok(deckHints.indexableText?.includes("Opening slide title") && !deckHints.indexableText.includes("private speaker remark"), "slide titles are indexed, speaker notes not", deckHints.indexableText);

// 2b. an empty scene: no preview, no error
const EMPTY = `empty-${RUN}`;
await agent({ type: "create", name: EMPTY });
await sleep(800);
const saved = await agent({ type: "save", name: EMPTY });
ok(!saved?.error, "an empty scene saves", saved?.error);
const emptyId = await fileIdOf(EMPTY);
const emptyHints = emptyId ? await hintsOf(emptyId) : {};
ok(!!emptyId && !emptyHints.thumbnail && emptyHints.indexableText === EMPTY, "2: an empty scene has no preview (only its name to index)", emptyHints);

// 5. a scene with a ~10 MB picture still saves, its preview stays below 2 MB
const BIG = `picture-${RUN}`;
await agent({ type: "create", name: BIG });
await sleep(800);
const picture = await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1900;
  canvas.height = 1900;
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
  context.putImageData(pixels, 0, 0);
  const dataURL = canvas.toDataURL("image/png");
  return { dataURL, bytes: Math.round((dataURL.length * 3) / 4) };
});
const pictureId = `e2epicture${RUN}`.padEnd(40, "0");
const bigEdit = await agent({
  type: "edit",
  expectScene: BIG,
  requestId: `big-${Date.now()}`,
  add: [{ type: "image", id: "im", x: 0, y: 0, width: 1900, height: 1900, fileId: pictureId }],
  files: { [pictureId]: { id: pictureId, mimeType: "image/png", dataURL: picture.dataURL, created: Date.now() } },
});
ok(!bigEdit?.error, `the ${Math.round(picture.bytes / 1e6)} MB picture is added`, bigEdit?.error);
const bigId = await fileIdOf(BIG);
const bigHints = bigId ? await until(() => hintsOf(bigId), (h) => !!h.thumbnail, 90) : {};
const bigFile = bigId ? await admin(`file?fileId=${bigId}`) : {};
ok(bigFile.size > 5e6 && !!bigHints.thumbnail && bigHints.thumbnail.bytes < 2 * 1024 * 1024, "5: the scene with the big picture saves, its preview is below 2 MB", { size: bigFile.size, preview: bigHints.thumbnail?.bytes });

// 6. a local-only scene never reaches Drive (no file, no preview)
const LOCAL = `local-${RUN}`;
const LOCAL_WORD = `pangolin${RUN}`;
await page.evaluate((n) => window.__scenes.create(n, { localOnly: true }), LOCAL);
await sleep(800);
await agent({ type: "local-edit", name: LOCAL, requestId: `l-${Date.now()}`, add: [{ type: "text", id: "t", x: 0, y: 0, text: `${LOCAL_WORD} stays here`, fontSize: 28 }] });
await sleep(8000);
ok(!(await page.evaluate((n) => window.__scenes.fileIdOf(n) ?? null, LOCAL)), "6: a local-only scene has no Drive file");

// 7. the hints only ever go to Google; nothing of a local-only scene leaves the browser
const sent = await page.evaluate(() => window.__sent);
const isGoogle = (url) => new URL(url, BASE).pathname.startsWith("/fake-google/") || url.startsWith("https://www.googleapis.com/");
const toKurviq = sent.filter((entry) => !isGoogle(entry.url));
const leaks = toKurviq.filter((entry) => /contentHints|indexableText|thumbnail/.test(entry.body) || (before && entry.body.includes(before.slice(0, 64))));
ok(sent.some((entry) => isGoogle(entry.url) && entry.body.includes("contentHints")), "the hints went to Google's endpoints", sent.length);
ok(leaks.length === 0, "7: no request to Kurviq's server carries a preview or index text", leaks.map((entry) => entry.url));
ok(!sent.some((entry) => entry.body.includes(LOCAL_WORD)), "6: nothing of the local-only scene was sent anywhere");

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
