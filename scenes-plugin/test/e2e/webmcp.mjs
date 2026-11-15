// Browser agents use Kurviq's scene tools through WebMCP (document.modelContext, scenes-plugin/src/webmcp):
//   1 the page offers the MCP's scene tools (no create_view, no send_feedback), read_me tells about the page
//   2 save_scene makes a scene in Drive, list_scenes and read_scene see it
//   3 edit_scene adds an element, saved to Drive; its picture is named, not inlined; view_scene the same
//   3b images from inline SVG and data URLs are made in the page; web addresses are refused with an error text
//   4 a failing call answers an error text; no page errors
// Real Worker + fake Google: KURVIQ_URL (default http://localhost:8790), CHROME (a Chrome with WebMCP,
// default the installed Google Chrome; started with --enable-features=WebMCP). Usage: node webmcp.mjs
import { createRequire } from "node:module";
const puppeteer = createRequire(import.meta.url)(new URL("../../../excalidraw/node_modules/puppeteer-core/cjs-entry-core.js", import.meta.url).pathname);

const BASE = process.env.KURVIQ_URL || "http://localhost:8790";
const RUN = Date.now() % 100000;
const OWNER = `wmcp${RUN}@example.test`;
const NAME = `Agent board ${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400)}`);
  if (!cond) failed++;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-features=WebMCP"],
  defaultViewport: { width: 1300, height: 850 },
});
const admin = (path, body) =>
  fetch(`${BASE}/fake-google/admin/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const errors = [];
const ctx = await browser.createIncognitoBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && errors.push(`CONSOLE: ${m.text().slice(0, 200)}`));

/** the page's tools, as a browser agent sees them */
const toolNames = () =>
  page.evaluate(async () => ((await document.modelContext?.getTools?.()) ?? []).map((tool) => tool.name)).catch(() => []);

/** call a tool the way a browser agent does (the browser passes the result on as a JSON string) */
const call = (name, input = {}) =>
  page.evaluate(
    async (name, input) => {
      const tool = (await document.modelContext.getTools()).find((t) => t.name === name);
      const result = await document.modelContext.executeTool(tool, input);
      // the text the tool answered (a browser may hand it on JSON-quoted)
      try {
        const parsed = JSON.parse(result);
        return typeof parsed === "string" ? parsed : result;
      } catch {
        return result;
      }
    },
    name,
    input,
  );

// signed in with Drive
await page.goto(`${BASE}/auth/login?return=${encodeURIComponent("/")}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 3 && page.url().includes("/fake-google/oauth/authorize"); i++) {
  await page.goto(page.url().replace("/authorize", "/approve") + `&email=${encodeURIComponent(OWNER)}`, { waitUntil: "domcontentloaded" }); // NOSONAR S9382: in order on purpose
  await sleep(500); // NOSONAR S9382: in order on purpose
}
let names = [];
for (let i = 0; i < 60 && !names.includes("edit_scene"); i++) {
  await sleep(250); // NOSONAR S9382: polling in order on purpose
  names = await toolNames(); // NOSONAR S9382: polling in order on purpose
}

// 1. the tools
ok(["read_me", "app_status", "list_scenes", "read_scene", "edit_scene", "save_scene", "view_scene", "delete_scene"].every((n) => names.includes(n)), "1: the scene tools are offered", names);
ok(!names.includes("create_view") && !names.includes("send_feedback"), "1: no create_view, no send_feedback");
const readMe = await call("read_me");
ok(typeof readMe === "string" && readMe.includes("the Kurviq page's own tools") && !readMe.includes("curl "), "1: read_me: the page reference, no upload address");
const status = await call("app_status");
ok(typeof status === "string" && /drive/i.test(status) && !status.startsWith("Error"), "1: app_status answers from this tab", status);

// 2. a new scene
const box = { type: "rectangle", id: "box1", x: 100, y: 100, width: 200, height: 80, label: { text: "From a browser agent" } };
const saved = await call("save_scene", { name: NAME, elements: JSON.stringify([box]) });
ok(typeof saved === "string" && !saved.startsWith("Error"), "2: save_scene made the scene", saved);
const listed = await call("list_scenes");
ok(typeof listed === "string" && listed.includes(NAME), "2: list_scenes lists it");
const read = await call("read_scene", { name: NAME });
const revision = /"revision":\s*"([^"]+)"/.exec(read)?.[1];
ok(typeof read === "string" && read.includes("box1") && !!revision, "2: read_scene reads it, with a revision", read.slice(0, 200));

// 3. an edit, saved to Drive
const edited = await call("edit_scene", {
  name: NAME,
  basedOn: revision,
  add: JSON.stringify([{ type: "ellipse", id: "dot1", x: 400, y: 100, width: 80, height: 80, backgroundColor: "#ffc9c9", fillStyle: "solid" }]),
});
ok(typeof edited === "string" && !edited.startsWith("Error"), "3: edit_scene applied the edit", edited.slice(0, 300));
ok(edited.includes("[picture: image/png"), "3: the edit's picture is named, not inlined", edited.slice(-200));
let driveIds = [];
for (let i = 0; i < 40; i++) {
  const fileId = await page.evaluate((name) => window.__scenes.fileIdOf(name), NAME); // NOSONAR S9382: polling in order on purpose
  if (fileId) {
    const revisions = await admin(`revisions?fileId=${fileId}&content=1`); // NOSONAR S9382: polling in order on purpose
    const head = (revisions.revisions ?? revisions).at(-1);
    const content = typeof head?.content === "string" ? JSON.parse(head.content) : head?.content;
    driveIds = (content?.elements ?? []).filter((e) => !e.isDeleted).map((e) => e.id);
    if (driveIds.includes("dot1")) break;
  }
  await sleep(500); // NOSONAR S9382: polling in order on purpose
}
ok(driveIds.includes("box1") && driveIds.includes("dot1"), "3: Drive has the scene with both elements", driveIds);
const view = await call("view_scene", { name: NAME });
ok(typeof view === "string" && view.includes("[picture: image/png"), "3: view_scene names its picture", view.slice(0, 200));

// 3b. an image, inline SVG and a data URL (made in the page: the browser shims of Buffer, SHA-1, path)
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#228be6"/></svg>';
const imaged = await call("edit_scene", {
  name: NAME,
  add: JSON.stringify([
    { type: "image", id: "img1", x: 100, y: 250, width: 48, svg },
    { type: "image", id: "img2", x: 200, y: 250, width: 48, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` },
  ]),
});
ok(typeof imaged === "string" && imaged.includes("img1") && imaged.includes("img2") && !imaged.startsWith("Error"), "3b: images from inline SVG and a data URL", imaged.slice(0, 300));
const remote = await call("edit_scene", { name: NAME, add: JSON.stringify([{ type: "image", id: "img3", x: 300, y: 250, width: 48, src: "https://example.com/logo.png" }]) });
ok(typeof remote === "string" && remote.startsWith("Error"), "3b: a web address can't be fetched from the page: an error text", remote.slice(0, 300));

// 4. errors
const missing = await call("read_scene", { name: `No such scene ${RUN}` });
ok(typeof missing === "string" && missing.startsWith("Error: Scene"), "4: a failing call answers an error text", missing.slice(0, 200));
// (the refused web address of 3b: the page's Content-Security-Policy says so in the console)
const unexpected = errors.filter((e) => !e.includes("https://example.com/logo.png"));
ok(unexpected.length === 0, "4: no page errors", unexpected);

await browser.close();
console.log(failed ? `FAIL ${failed}` : "FAIL 0");
process.exit(failed ? 1 : 0);
