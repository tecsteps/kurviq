// "Add comment" in Excalidraw's toolbar (scenes-plugin/src/comments/ui.tsx CommentToolButton):
//   1 a scene in Drive: the button is in the toolbar, right after the sticky note
//   2 a click starts placing a comment (the button shows pressed), a second click cancels
//   3 Shift+C shows it pressed too; a click on the canvas opens the new comment; Esc closes it
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node comment-tool.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `ctl${RUN}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const errors = [];
const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));

await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(OWNER)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
  await sleep(500); // NOSONAR S9382: in order on purpose
}
for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy).catch(() => false)); i++) { // NOSONAR S9382: polling in order on purpose
  await sleep(250); // NOSONAR S9382: polling in order on purpose
}
// a scene in Drive (comments live in the scene file)
const NAME = `Comment tool ${RUN}`;
await page.evaluate(async (name) => {
  await window.__scenes.create(name);
  window.__scenes.getApi().updateScene({
    elements: [{ id: "ctl000000001", type: "rectangle", x: 100, y: 100, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0", roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
    captureUpdate: "IMMEDIATELY",
  });
}, NAME);
for (let i = 0; i < 80 && !(await page.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, NAME)); i++) { // NOSONAR S9382: polling in order on purpose
  await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {}); // NOSONAR S9382: polling in order on purpose
  await sleep(500); // NOSONAR S9382: polling in order on purpose
}

const button = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="toolbar-kurviq-comment"]');
    const buttons = [...document.querySelectorAll(".App-toolbar [data-testid^='toolbar-']")].map((b) => b.dataset.testid);
    const input = el?.querySelector("input") ?? el;
    return el ? { after: buttons[buttons.indexOf("toolbar-kurviq-comment") - 1], label: el.getAttribute("aria-label") ?? el.querySelector("[aria-label]")?.getAttribute("aria-label"), pressed: !!(input?.checked ?? el.getAttribute("aria-pressed") === "true") } : null;
  });
const placing = () => page.evaluate(() => !!document.querySelector(".kq-cm-placing"));
const clickButton = async () => {
  await page.click('[data-testid="toolbar-kurviq-comment"]');
  await sleep(300);
};

// 1
const first = await button();
ok(first?.after === "toolbar-stickynote", "1: the button is in the toolbar, right after the sticky note", first);

// 2
await clickButton();
ok((await placing()) && (await button())?.pressed, "2: a click starts placing a comment, the button shows pressed", await button());
await clickButton();
ok(!(await placing()) && !(await button())?.pressed, "2: a second click cancels");

// 3
await page.mouse.click(650, 450);
await page.keyboard.down("Shift");
await page.keyboard.press("C");
await page.keyboard.up("Shift");
await sleep(300);
ok((await placing()) && (await button())?.pressed, "3: Shift+C shows the button pressed too", await button());
await page.mouse.click(160, 140);
let draft = false;
for (let i = 0; i < 10 && !draft; i++) {
  await sleep(200); // NOSONAR S9382: polling in order on purpose
  draft = await page.evaluate(() => !!document.querySelector(".kq-cm-popover textarea")); // NOSONAR S9382: polling in order on purpose
}
ok(draft && !(await placing()), "3: a click on the canvas opens the new comment");
await page.keyboard.press("Escape");
await sleep(300);
ok(errors.length === 0, "no page errors", errors);

await browser.close();
console.log(failed ? `FAIL ${failed}` : "FAIL 0");
process.exit(failed ? 1 : 0);
