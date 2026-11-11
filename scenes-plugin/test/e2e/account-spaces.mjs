// Accounts e2e: one browser, several Google accounts, signed in one after another. Each account
// sees only its own scenes; scenes made signed out go to the account signing in next (offered in
// the dialog after sign-in); signing out leaves an account's scenes in the browser for its next
// sign-in; another tab follows a sign-in; the scenes of before spaces per account go to their
// account. Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME.
// Usage: node account-spaces.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const [A, B, C, D] = ["ann", "bob", "cid", "dee"].map((who) => `${who}${RUN}@example.test`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
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
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
};

/** the tab is up in `space` (its own scenes' space; "" signed out) with its scenes loaded */
const settled = async (page, space) => {
  let last = null;
  for (let i = 0; i < 120; i++) {
    last = await page // NOSONAR S9382: polling in order on purpose
      .evaluate(() => ({
        space: localStorage.getItem("kurviq-own-space") || "",
        ready: !!window.__scenes?.getApi() && !window.__scenes.getState().busy,
        user: document.body.innerText.includes("Checking Google sign-in"),
      }))
      .catch(() => null);
    if (last?.ready && last.space === space) {
      await sleep(1500); // NOSONAR S9382: polling in order on purpose
      const again = await page.evaluate(() => localStorage.getItem("kurviq-own-space") || "").catch(() => null); // NOSONAR S9382: polling in order on purpose
      if (again === space && (await page.evaluate(() => !!window.__scenes?.getApi()).catch(() => false))) { // NOSONAR S9382: polling in order on purpose
        return true;
      }
    }
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
  log("not settled", space, last);
  return false;
};
const names = (page) => page.evaluate(() => window.__scenes.getState().list.map((item) => item.name).filter(Boolean));
const signIn = async (page, email, { dialog = false } = {}) => {
  if (dialog) {
    // as if the user clicked "Sign in with Google" in this tab (the dialog after sign-in appears)
    await page.evaluate(() => sessionStorage.setItem("kurviq-connecting", String(Date.now())));
  }
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  // the fake Google's pages: approve each (an account signing in again is asked for consent once more)
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
};
const signOut = (page) =>
  page.evaluate(async () => {
    // what "Sign out" does: the Worker forgets the sign-in, every tab hears it
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    new BroadcastChannel("kurviq-google").postMessage("disconnected");
  });
const create = async (page, name) => {
  await page.evaluate(async (name) => {
    await window.__scenes.create(name);
    const api = window.__scenes.getApi();
    api.updateScene({
      elements: [{
        id: `r${Math.random().toString(36).slice(2, 10)}`, type: "rectangle", x: 100, y: 100, width: 80, height: 50, angle: 0, // NOSONAR S2245: not security relevant (test element id)
        strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
        roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
        versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      }],
      captureUpdate: "IMMEDIATELY",
    });
  }, name);
  await sleep(1500);
};
const inDrive = async (page, name) => {
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate((name) => !!window.__scenes.fileIdOf(name), name).catch(() => false)) return true; // NOSONAR S9382: polling in order on purpose
    await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {}); // NOSONAR S9382: polling in order on purpose
    await sleep(500); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};

const ctx = await browser.createIncognitoBrowserContext();
const P = await ctx.newPage();
watch(P, "P");

// 1. signed out: a scene made without an account
const GUEST = `Guest ${RUN}`;
await P.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
ok(await settled(P, ""), "starts signed out");
await create(P, GUEST);
ok((await names(P)).includes(GUEST), "guest scene made", await names(P));

// 2. sign in as A: the tab moves to A's scenes, the guest scene goes along, offered for Drive
await signIn(P, A, { dialog: true });
ok(await settled(P, `a:${A}`), "signed in as A: in A's space");
const afterA = await names(P);
ok(afterA.includes(GUEST), "the guest scene went to A", afterA);
const dialogText = await P.evaluate(() => document.body.innerText);
ok(/only in this browser/.test(dialogText) && dialogText.includes(GUEST), "the dialog after sign-in offers it");
ok(await P.evaluate(() => localStorage.getItem("excalidraw-scenes") === null), "nothing left in the signed-out space");
const A_ONLY = `A only ${RUN}`;
await create(P, A_ONLY);
ok(await inDrive(P, A_ONLY), "A's scene is in A's Drive");

// 3. sign out: A's scenes leave the screen (they stay in the browser)
await signOut(P);
ok(await settled(P, ""), "signed out: back in the signed-out space");
const out = await names(P);
ok(!out.includes(A_ONLY) && !out.includes(GUEST), "A's scenes are not shown signed out", out);

// 4. sign in as B: none of A's scenes
await signIn(P, B);
ok(await settled(P, `a:${B}`), "signed in as B: in B's space");
const afterB = await names(P);
ok(!afterB.includes(A_ONLY) && !afterB.includes(GUEST), "B doesn't see A's scenes", afterB);
const B_ONLY = `B only ${RUN}`;
await create(P, B_ONLY);
ok(await inDrive(P, B_ONLY), "B's scene is in B's Drive");

// 5. straight to A again (no sign-out): A's scenes are back, B's are not
await signIn(P, A);
ok(await settled(P, `a:${A}`), "signed in as A again");
const backA = await names(P);
ok(backA.includes(A_ONLY) && backA.includes(GUEST) && !backA.includes(B_ONLY), "A's scenes back, not B's", backA);

// 6. another tab follows a sign-in in this one
const Q = await ctx.newPage();
watch(Q, "Q");
await Q.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
ok(await settled(Q, `a:${A}`), "second tab opens in A's space");
await signIn(P, B);
ok(await settled(P, `a:${B}`), "first tab: B");
// (the space key is shared by the tabs: the second tab's scenes tell where it is)
let qNames = [];
for (let i = 0; i < 80; i++) {
  qNames = await names(Q).catch(() => []); // NOSONAR S9382: polling in order on purpose
  if (qNames.includes(B_ONLY)) break;
  await sleep(250); // NOSONAR S9382: polling in order on purpose
}
ok(qNames.includes(B_ONLY) && !qNames.includes(A_ONLY), "second tab followed to B's scenes", qNames);
await Q.close();

// 7. scenes from before spaces per account: they belong to the account synced last
const ctx2 = await browser.createIncognitoBrowserContext();
const L = await ctx2.newPage();
watch(L, "L");
const LEGACY = `Legacy ${RUN}`;
await L.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
ok(await settled(L, ""), "fresh browser, signed out");
await create(L, LEGACY);
await L.evaluate((email) => localStorage.setItem("kurviq-drive-account", email), C);
await L.reload({ waitUntil: "domcontentloaded" });
ok(await settled(L, `a:${C}`), "the old scenes went to their account's space (signed out)");
ok((await names(L)).includes(LEGACY), "with the scene", await names(L));
ok(await L.evaluate(() => localStorage.getItem("kurviq-drive-account") === null), "the old account key is gone");
await signIn(L, D);
ok(await settled(L, `a:${D}`), "another account signs in");
ok(!(await names(L)).includes(LEGACY), "and doesn't see them", await names(L));

ok(errors.length === 0, "no page errors", errors);
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
