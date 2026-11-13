// Share panel e2e (specs/2026-11-13-share-with-organization.md and 2026-11-13-access-end-date.md):
// General access "Anyone at <domain> with the link" for Workspace accounts (a Drive "domain" permission;
// not offered to gmail.com accounts), opened by a colleague of the domain but not by an outsider; and
// "Access until…" on viewers' and commenters' rows (Drive's expirationTime), gone after the date.
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME. Usage: node share-panel.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const ORG = `acme${RUN}.test`;
const [OWNER, COLLEAGUE] = ["own", "col"].map((who) => `${who}${RUN}@${ORG}`);
const OUTSIDER = `out${RUN}@other${RUN}.test`;
const VIEWER = `viw${RUN}@example.test`;
const EDITOR = `edt${RUN}@example.test`;
const GMAIL = `kq${RUN}@gmail.com`;
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
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];

const ready = async (page) => {
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => !!window.__scenes?.getApi() && !window.__scenes.getState().busy).catch(() => false)) { // NOSONAR S9382: polling in order on purpose
      await sleep(1500); // NOSONAR S9382: polling in order on purpose
      return true;
    }
    await sleep(250); // NOSONAR S9382: polling in order on purpose
  }
  return false;
};
const signIn = async (email) => {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email.slice(0, 3)} PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
    await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(email)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
    await sleep(500); // NOSONAR S9382: in order on purpose
  }
  for (let i = 0; i < 40 && (await page.evaluate(() => localStorage.getItem("kurviq-own-space")).catch(() => null)) === null; i++) await sleep(250); // NOSONAR S9382: polling in order on purpose
  await ready(page);
  return page;
};
const waitFor = async (what, check, tries = 40) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await check(); // NOSONAR S9382: polling in order on purpose
    if (last.done) return last;
    await sleep(500); // NOSONAR S9382: polling in order on purpose
  }
  log("gave up waiting for", what, JSON.stringify(last).slice(0, 300));
  return last;
};
/** a scene with one rectangle, synced to Drive: its file id */
const create = async (page, name) => {
  await page.evaluate(async (name) => {
    await window.__scenes.create(name);
    window.__scenes.getApi().updateScene({
      elements: [{
        id: `r${Math.random().toString(36).slice(2, 10)}`, type: "rectangle", x: 100, y: 100, width: 80, height: 50, angle: 0, // NOSONAR S2245: not security relevant (test element id)
        strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
        roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 1,
        versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      }],
      captureUpdate: "IMMEDIATELY",
    });
  }, name);
  const found = await waitFor(`"${name}" in Drive`, async () => {
    await page.evaluate(() => window.__scenes.syncNow({ refresh: true })).catch(() => {});
    const id = await page.evaluate((name) => window.__scenes.fileIdOf(name) ?? null, name);
    return { done: !!id, id };
  }, 80);
  return found.id;
};

// the share panel (test builds expose it: no clicking through the menus)
const GENERAL = ".kq-share label.kq-field select";
const openShare = async (page, name) => {
  await page.evaluate(() => document.querySelector(".kq-share .kq-close")?.click());
  await sleep(300);
  await page.evaluate((name) => window.__openShareDialog(name), name);
  await page.waitForSelector(GENERAL, { timeout: 30000 }).catch(() => {});
  await sleep(500);
};
const generalAccess = (page) =>
  page.evaluate((selector) => {
    const select = document.querySelector(selector);
    return select ? { value: select.value, options: [...select.options].map((option) => option.textContent) } : null;
  }, GENERAL);
const chooseGeneral = async (page, value) => {
  await page.select(GENERAL, value);
  await sleep(300);
  // busy while Drive is asked: the field is disabled until the panel shows the new state
  await waitFor("the change", async () => ({ done: await page.evaluate((selector, value) => document.querySelector(selector)?.disabled === false && document.querySelector(selector).value === value, GENERAL, value) }));
  await sleep(300);
};
const permissionsOf = async (fileId) => (await admin(`file?fileId=${fileId}`)).permissions ?? [];
/** the text of a person's row and its buttons */
const row = (page, email) =>
  page.evaluate((email) => {
    const li = [...document.querySelectorAll(".kq-share__people li")].find((el) => el.textContent.includes(email));
    return li ? { text: li.textContent, buttons: [...li.querySelectorAll("button")].map((b) => b.textContent) } : null;
  }, email);
const clickInRow = (page, email, label) =>
  page.evaluate((email, label) => {
    const li = [...document.querySelectorAll(".kq-share__people li")].find((el) => el.textContent.includes(email));
    [...(li?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label)?.click();
  }, email, label);

/** a signed-in person opens the scene's link: what they see (after allowing Kurviq once, with the fake Picker) */
const openLink = async (page, email, fileId) => {
  await page.goto(`${BASE}/s/${fileId}/plan`, { waitUntil: "domcontentloaded" });
  const first = await waitFor("the viewer's answer", async () => {
    const state = await page.evaluate(() => ({
      shown: !!window.__publicViewer?.getSceneElements().length,
      missing: document.querySelector(".public-scene__missing")?.textContent ?? null,
    })).catch(() => ({}));
    return { done: state.shown || !!state.missing, ...state };
  }, 60);
  if (first.missing?.includes("Allow Kurviq to open it")) {
    await admin("picker", { email, ids: [fileId] });
    await page.evaluate(() => [...document.querySelectorAll(".public-scene__missing button")].find((b) => b.textContent.includes("Allow Kurviq"))?.click());
    await sleep(1500);
  }
  return waitFor("the scene after allowing Kurviq", async () => {
    const state = await page.evaluate(() => ({
      shown: !!window.__publicViewer?.getSceneElements().length,
      edit: [...document.querySelectorAll(".public-scene__bar button")].some((b) => b.textContent.trim() === "Edit"),
      missing: document.querySelector(".public-scene__missing")?.textContent ?? null,
    })).catch(() => ({}));
    return { done: state.shown || (!!state.missing && !state.missing.includes("Allow Kurviq")), ...state };
  }, 40);
};

// 1. a Workspace account: General access offers the organization (criterion 1)
const owner = await signIn(OWNER);
const NAME = `Plan ${RUN}`;
const fileId = await create(owner, NAME);
ok(!!fileId, "owner: the scene is in Drive", fileId);
await openShare(owner, NAME);
const offered = await generalAccess(owner);
ok(
  ["view", "comment", "edit"].every((verb) => offered?.options.includes(`Anyone at ${ORG} with the link can ${verb}`)),
  `General access offers "Anyone at ${ORG} with the link can view / comment / edit"`,
  offered?.options,
);

// 2. choosing it: a domain permission with that role, not findable; shown after reopening (criterion 2)
await chooseGeneral(owner, "domain:reader");
let perms = await permissionsOf(fileId);
const domainPerm = perms.find((perm) => perm.type === "domain");
ok(domainPerm?.domain === ORG && domainPerm.role === "reader" && domainPerm.allowFileDiscovery === false, "a domain permission (reader, allowFileDiscovery false)", domainPerm);
await openShare(owner, NAME);
ok((await generalAccess(owner))?.value === "domain:reader", "the panel shows it after reopening", await generalAccess(owner));
const hint = await owner.evaluate(() => [...document.querySelectorAll(".kq-share .kq-muted")].map((p) => p.textContent).find((t) => t.includes("People at")) ?? null);
ok(!!hint?.includes(ORG), "…with its hint", hint);

// 3. a colleague of the domain opens the link with that role; an outsider can't (criterion 3)
const colleague = await signIn(COLLEAGUE);
const seen = await openLink(colleague, COLLEAGUE, fileId);
ok(seen.shown && !seen.edit, "colleague: the scene opens, to view (no Edit)", seen);
await chooseGeneral(owner, "domain:writer");
ok((await permissionsOf(fileId)).find((perm) => perm.type === "domain")?.role === "writer", "owner: the organization may edit now");
const edits = await openLink(colleague, COLLEAGUE, fileId);
ok(edits.shown && edits.edit, "colleague: the scene opens with Edit", edits);
const outsider = await signIn(OUTSIDER);
const refused = await openLink(outsider, OUTSIDER, fileId);
ok(!refused.shown && !!refused.missing, "outsider: the scene doesn't open", refused);

// 4. back to "Only people added here": the domain permission goes (criterion 4)
await chooseGeneral(owner, "restricted");
perms = await permissionsOf(fileId);
ok(!perms.some((perm) => perm.type === "domain" || perm.type === "anyone"), "restricted: no domain (or anyone) permission left", perms.map((perm) => perm.type));
const after = await openLink(colleague, COLLEAGUE, fileId);
ok(!after.shown, "colleague: no access any more", after);

// 5. a gmail.com account: no organization to share with (criterion 1)
const personal = await signIn(GMAIL);
const PERSONAL = `Mine ${RUN}`;
await create(personal, PERSONAL);
await openShare(personal, PERSONAL);
const personalOptions = await generalAccess(personal);
ok(!!personalOptions && !personalOptions.options.some((text) => text.startsWith("Anyone at")), "gmail.com: no organization option", personalOptions?.options);

// end dates: a viewer and an editor added in Drive
await admin("share", { fileId, email: VIEWER, role: "reader" });
await admin("share", { fileId, email: EDITOR, role: "writer" });
await openShare(owner, NAME);
const viewerRow = await row(owner, VIEWER);
const editorRow = await row(owner, EDITOR);
ok(viewerRow?.buttons.includes("Access until…"), "a viewer's row offers \"Access until…\"", viewerRow);
ok(!!editorRow && !editorRow.buttons.includes("Access until…"), "an editor's row doesn't (criterion 2)", editorRow);

// 6. "Access until…": the date, the row says "until …", Drive's permission has it (criterion 1)
const until = new Date(Date.now() + 10 * 24 * 3600 * 1000);
const day = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")}`;
await clickInRow(owner, VIEWER, "Access until…");
await sleep(300);
await owner.evaluate((email, day) => {
  const li = [...document.querySelectorAll(".kq-share__people li")].find((el) => el.textContent.includes(email));
  const input = li.querySelector('input[type="date"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, day);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, VIEWER, day);
await clickInRow(owner, VIEWER, "Save");
const dated = await waitFor("the end date", async () => {
  const perm = (await permissionsOf(fileId)).find((entry) => entry.emailAddress === VIEWER);
  const text = (await row(owner, VIEWER))?.text ?? "";
  return { done: !!perm?.expirationTime && text.includes("until "), expirationTime: perm?.expirationTime, text };
});
const label = `until ${until.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
ok(dated.done && dated.text.includes(label), `the row says "${label}"`, dated.text);
const expires = new Date(dated.expirationTime ?? 0);
ok(expires.getDate() === until.getDate() && expires.getHours() === 23, "Drive's permission ends with that day", dated.expirationTime);

// 7. "No end date" removes it (criterion 2)
await clickInRow(owner, VIEWER, "No end date");
const undated = await waitFor("no end date", async () => {
  const perm = (await permissionsOf(fileId)).find((entry) => entry.emailAddress === VIEWER);
  const buttons = (await row(owner, VIEWER))?.buttons ?? [];
  return { done: !!perm && !perm.expirationTime && buttons.includes("Access until…"), perm, buttons };
});
ok(undated.done, "No end date: the permission has none, the row offers it again", undated);

// 8. after the date the person can't open the scene any more (criterion 3)
const viewer = await signIn(VIEWER);
const before = await openLink(viewer, VIEWER, fileId);
ok(before.shown, "viewer: opens the scene while the access lasts", before);
await admin("share", { fileId, email: VIEWER, role: "reader", expirationTime: new Date(Date.now() - 60_000).toISOString() });
const expired = await openLink(viewer, VIEWER, fileId);
ok(!expired.shown, "viewer: an expired access opens nothing", expired);
await openShare(owner, NAME);
ok(!(await row(owner, VIEWER)), "the expired access is gone from the panel");

ok(errors.length === 0, "no page errors", errors.slice(0, 5));
await browser.close();
log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
