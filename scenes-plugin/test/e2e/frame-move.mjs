// e2e: an agent's edit that moves slide frames keeps them where it put them (Kurviq's grid layout
// used to snap them back), and everything on a moved frame moves with it.
// Works against a build with the fake Google (window.__agentCommand), signed out: KURVIQ_URL
// (default http://localhost:8790), CHROME. Usage: node frame-move.mjs
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
const name = `frames-${Date.now() % 100000}`;
await page.evaluate((n) => window.__scenes.create(n), name);
await sleep(500);
const agent = (command) => page.evaluate((c) => window.__agentCommand(c), command);
const frame = (id, order) => ({ type: "frame", id, x: order * 2160, y: 0, width: 1920, height: 1080, name: id, customData: { slides: { order } } });
const added = await agent({
  type: "local-edit", name, requestId: `add-${Date.now()}`,
  add: [frame("f1", 0), frame("f2", 1), frame("f3", 2), { type: "text", id: "t2", x: 100, y: 100, text: "on f2", fontSize: 40, slide: "f2" }],
});
ok(added.ok, "three slides and a text on the second one are added", added.error);
const where = () => page.evaluate(() => Object.fromEntries(window.__scenes.getApi().getSceneElements().filter((el) => ["f1", "f2", "f3", "t2"].includes(el.id)).map((el) => [el.id, { x: Math.round(el.x), y: Math.round(el.y) }])));
const before = await where();
const moved = await agent({ type: "local-edit", name, requestId: `move-${Date.now()}`, update: [{ id: "f2", y: before.f2.y + 2000 }] });
ok(moved.ok, "the agent moves the second slide down by 2000", moved.error);
await sleep(500);
const after = await where();
ok(after.f2.y === before.f2.y + 2000 && after.f2.x === before.f2.x, "the slide stays where the agent put it", { before: before.f2, after: after.f2 });
ok(after.t2.y === before.t2.y + 2000, "its text moves along", { before: before.t2, after: after.t2 });
ok(after.f1.y === before.f1.y && after.f3.y === before.f3.y, "the other slides stay", { f1: after.f1, f3: after.f3 });
await browser.close();
process.exitCode = failed ? 1 : 0;
