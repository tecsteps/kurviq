// e2e (the author on the public page, only when chosen): Share… "Show my name on the public page"
// puts the user's Google name on the file; the public deck carries it, the viewer shows "by …";
// unticking removes it. Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790),
// CHROME (a Chrome for Testing binary). Usage: node byline.mjs [email]
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);
const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const SCENE = `by-${Date.now() % 100000}`;
const EMAIL = process.argv[2] || `by${Date.now() % 100000}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra !== undefined ? " " + JSON.stringify(extra).slice(0, 300) : ""}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Users/fabianwesner/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: "new",
  defaultViewport: { width: 1400, height: 900 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
const scenePath = `/${SCENE}`;
await page.goto(`${BASE}/auth/login?return=${encodeURIComponent(scenePath)}`, { waitUntil: "domcontentloaded" });
await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(EMAIL)}`, { waitUntil: "networkidle2" });
await sleep(3000);
await page.keyboard.press("r");
await page.mouse.move(400, 300);
await page.mouse.down();
await page.mouse.move(480, 360, { steps: 5 });
await page.mouse.up();
await page.keyboard.press("Escape");
let fileId = null;
for (let i = 0; i < 30; i++) {
  fileId = await page.evaluate(() => window.__live?.current()?.fileId ?? null); // NOSONAR S9382: polling, one check after the other
  if (fileId) break;
  await sleep(1000); // NOSONAR S9382: polling, one check after the other
}
ok(!!fileId, "scene is in Drive", fileId);
await admin("share", { fileId, anyone: true, role: "reader" });
const userName = await page.evaluate(() => window.__scenes && document.querySelector(".kq-folder-actions")?.textContent);

// Share… → the checkbox (test builds expose the dialog: no clicking through the menus)
await page.evaluate((name) => window.__openShareDialog(name), SCENE);
await page.waitForSelector(".kq-share", { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => [...document.querySelectorAll(".kq-share .scenes-switch__label")].some((l) => /on the public page/.test(l.textContent || "")), { timeout: 20000 }).catch(() => {});
const label = await page.evaluate(() => [...document.querySelectorAll(".kq-share .scenes-switch__label")].map((l) => l.textContent).find((t) => /public page/.test(t || "")));
ok(!!label, "Share… offers to show the name", label);
await page.evaluate(() => {
  const input = [...document.querySelectorAll(".kq-share .scenes-switch")].find((l) => /public page/.test(l.textContent || ""))?.querySelector("input");
  input?.click();
});
await sleep(2500);
const file = await admin(`file?fileId=${fileId}`);
const props = file.properties ?? file.file?.properties;
ok(!!props?.kurviqBy, "the file names the author", props);

// the public deck carries it (no cache: a new version)
const res = await fetch(`${BASE}/api/public/${fileId}?v=${"0".repeat(31)}1`);
ok(res.ok && !!res.headers.get("X-Kurviq-By"), "the public deck carries the author", res.headers.get("X-Kurviq-By"));

// a visitor (no sign-in) sees "by …"
const visitorCtx = await browser.createIncognitoBrowserContext();
const visitor = await visitorCtx.newPage();
await visitor.goto(`${BASE}/s/${fileId}/${SCENE}`, { waitUntil: "networkidle2" });
await visitor.waitForSelector(".public-scene__meta", { timeout: 20000 }).catch(() => {});
const meta = await visitor.evaluate(() => document.querySelector(".public-scene__meta")?.textContent ?? null);
ok(!!meta && meta.startsWith("by "), "the viewer shows the author", meta);

// untick: gone again
await page.evaluate(() => {
  const input = [...document.querySelectorAll(".kq-share .scenes-switch")].find((l) => /public page/.test(l.textContent || ""))?.querySelector("input");
  input?.click();
});
await sleep(2500);
const after = await admin(`file?fileId=${fileId}`);
ok(!(after.properties ?? after.file?.properties)?.kurviqBy, "unticked: the file names nobody", after.properties ?? after.file?.properties);
console.log(userName ? `signed in: ${userName}` : "");
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
