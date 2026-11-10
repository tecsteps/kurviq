// e2e: an agent's edit that adds an image whose picture is nowhere (not in the edit, not in the
// scene, not among this browser's uploads) is refused and changes nothing; with its picture it
// is added and shows. (Before, the image was added without its picture: a broken placeholder.)
// Works against a build with the fake Google (window.__agentCommand), signed out: KURVIQ_URL
// (default http://localhost:8790), CHROME. Usage: node agent-image-missing.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1300, height: 850 },
});
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failed++;
};
const page = await (await browser.createIncognitoBrowserContext()).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${BASE}/`, { waitUntil: "load" });
for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__scenes?.getApi() && !!window.__agentCommand).catch(() => false)); i++) await sleep(250); // NOSONAR S9382: in order on purpose (polling)
await page.evaluate(() => window.__scenes.ready);
await sleep(1500);
const name = `pictures-${Date.now() % 100000}`;
await page.evaluate((n) => window.__scenes.create(n), name);
await sleep(500);
const agent = (command) => page.evaluate((c) => window.__agentCommand(c), command);
const images = () => page.evaluate(() => window.__scenes.getApi().getSceneElements().filter((el) => el.type === "image").map((el) => ({ id: el.id, fileId: el.fileId, status: el.status })));

const fileId = "e2e0000000000000000000000000000000000001";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#e03131"/></svg>`;
const image = (id) => ({ type: "image", id, x: 100, y: 100, width: 40, height: 40, fileId });

const refused = await agent({ type: "local-edit", name, requestId: `missing-${Date.now()}`, add: [image("im1"), { type: "text", id: "t1", x: 200, y: 100, text: "next to it", fontSize: 20 }] });
ok(!refused.ok && /Pictures missing for im1/.test(refused.error || ""), "an image whose picture is nowhere is refused, naming it", refused.error);
ok((await images()).length === 0, "nothing of that edit was added", await images());
ok(!(await page.evaluate(() => window.__scenes.getApi().getSceneElements().some((el) => el.id === "t1"))), "not even the text of the same edit");

const files = { [fileId]: { id: fileId, mimeType: "image/svg+xml", dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, created: Date.now() } };
const added = await agent({ type: "local-edit", name, requestId: `with-${Date.now()}`, add: [image("im2")], files });
ok(added.ok, "with its picture the image is added", added.error);
await sleep(800);
const shown = await images();
ok(shown.length === 1 && shown[0].id === "im2" && shown[0].status !== "error", "and it shows (not a broken placeholder)", shown);

const again = await agent({ type: "local-edit", name, requestId: `reuse-${Date.now()}`, add: [{ ...image("im3"), x: 300 }] });
ok(again.ok, "a second image with a picture already in the scene needs no upload", again.error);
await browser.close();
process.exitCode = failed ? 1 : 0;
