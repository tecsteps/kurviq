// The agent instructions of the Kurviq MCP and what its read_me returns: the
// local skill and reference (scenes-mcp/skill/kurviq-scenes/SKILL.md,
// REFERENCE.md), with what differs online.
import localReference from "../../scenes-mcp/skill/kurviq-scenes/REFERENCE.md";
import localSkill from "../../scenes-mcp/skill/kurviq-scenes/SKILL.md";

const INTRO = (app: string) => `# Kurviq: how to work with the user's drawings

The user works in **Kurviq** (${app}), an Excalidraw with **scenes** (named
drawings, URL \`${app}/<scene>\`). Scenes live in the user's browser and,
if the user signed in with Google, in their Google Drive (one file per
scene, in a folder "Kurviq"; scenes are shared with other people one by
one). The MCP server gives you tools for it. The user is often **looking
at Kurviq while you work** and edits by hand in between.

**You work through the user's open Kurviq tab.** Your MCP link belongs to
one browser: every tool needs Kurviq open there (any scene). Your edits run
in that tab with the real Excalidraw (text measured with the real fonts,
real PNG images); the tab merges them into what the user is doing and saves
them to Google Drive with the user's sign-in. Without sign-in
(\`app_status\` shows \`drive: false\`) all scenes are local-only: they
exist only in that browser, and you read and edit them there the same way.

If a tool answers "Kurviq is not open", ask the user to open ${app} and
keep the tab open, then try again.

**The MCP tools are all you need.** Do everything in Kurviq (read, draw,
edit, look, save, share, check decks) through them, never by driving the
app in a browser (no Playwright, Chrome, computer use or screenshots of the
page, no clicking in the UI): the tools are far faster and cheaper, return
exact data and an image of your change, and merge safely with what the user
is doing. Use a browser only if the user explicitly asks you to test the
app's interface itself.

`;

const TROUBLESHOOTING = (app: string) => `## Troubleshooting

- "Kurviq is not open in the user's browser": ask the user to open ${app}
  in the browser where they allowed this agent.
- "Google Drive is not connected": the user can sign in with Google in the
  scene list (Sign in with Google); until then, work with local-only scenes.
- Local file paths (edit files, image src) and PDF export are not available
  through the Kurviq MCP: upload images and big edits (read_me: "Images from
  your machine"); the user exports PDFs in Kurviq (Slides sidebar → PDF).
- A timeout or "the Kurviq tab did not answer": the edit may still land.
  Retry with the same \`requestId\` (never applied twice) and check
  \`app_status\` → \`health\`. Background tabs answer more slowly (browsers
  throttle them): keep working on other things; mention the tab to the user
  only if retries still fail after about 2 minutes.
`;

const UPLOADS = (uploadUrl: string) => `## Images from your machine (photos, illustrations, screenshots)

Kurviq's MCP runs on kurviq.com, so it can't read your files, and a data
URL would push the whole image through your context. Upload the file
instead, then refer to it by its fileId:

\`\`\`
curl -s --data-binary @/path/to/image.png ${uploadUrl}
→ { "fileId": "3f7a…", "width": 1600, "height": 900, … }
\`\`\`

Then \`edit_scene\` (or \`save_scene\`) with
\`{ "type": "image", "id": "hero", "x": 0, "y": 0, "width": 960, "fileId": "3f7a…" }\`
(\`width\` or \`height\` alone keeps the aspect ratio; on a slide add
\`"slide": 3\`). PNG, JPEG, GIF, WebP or SVG, up to 10 MB. **Size them for
the scene before uploading:** every picture travels inside the scene file and
counts toward Kurviq's 30 MB per scene (stored at about 1.8× its size), and big
pictures make the scene slow to load and present. A slide is 1920×1080: about
twice the size an image is shown at is plenty (longest side rarely over
2400 px). WebP (keeps transparency, good for illustrations and cut-outs) or
JPEG (photos) usually needs a fraction of a PNG's bytes. The answer tells you
the size (\`kb\`) and adds a \`note\` when it is large. Kurviq keeps what you
upload as it is: shrinking is your call. The upload goes straight
to the user's open Kurviq tab, which keeps it until a scene uses it (the same
fileId can be used on many slides). http(s) URLs as \`src\` work too.

**Big edits** (many elements, a whole deck): don't paste them into a tool
call. Write \`{ "add": [...], "update": [...], "delete": [...] }\` (or just an
array of elements to add) to a JSON file and upload it the same way:

\`\`\`
curl -s --data-binary @edit.json ${uploadUrl}
→ { "payloadId": "9c1e…", "add": 120, "update": 4, "delete": 0 }
\`\`\`

then \`edit_scene(name, payloadId: "9c1e…", basedOn: …)\` (or
\`save_scene(name, payloadId: …)\` for a new scene). Up to 1 MB per payload.
This upload URL is the one HTTP call you make yourself; everything else goes
through the tools.
`;

/**
 * The local texts are cut to what applies online by exact passages. When a
 * passage is reworded in SKILL.md / REFERENCE.md, these fail loudly (the unit
 * test agentDocs.test.ts runs them before every deploy) instead of telling
 * online agents about local files again.
 */
const changed = (file: string, what: string) =>
  new Error(`[kurviq] ${file} changed: ${what} not found. Update online/worker/skill.ts.`);

/** text with one passage replaced; the passage must be there */
const replaceOnce = (file: string, text: string, from: string | RegExp, to: string) => {
  const found = typeof from === "string" ? text.includes(from) : from.test(text);
  if (!found) {
    throw changed(file, String(from).slice(0, 60));
  }
  return typeof from === "string" ? text.replaceAll(from, to) : text.replace(from, to);
};

const section = (file: string, text: string, heading: string) => {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw changed(file, heading);
  }
  const end = text.indexOf("\n## ", start + heading.length);
  return [start, end < 0 ? text.length : end + 1] as const;
};

/** what differs online in the instructions: Kurviq's server instead of the local one */
const onlineSkill = (text: string) => {
  // " (localhost:3101)" with the whitespace before it (no regex: Sonar S8786)
  const parts = text.split("(localhost:3101)");
  if (parts.length < 2) {
    throw changed("SKILL.md", "(localhost:3101)");
  }
  const withoutPort = parts.map((part, index) => (index < parts.length - 1 ? part.trimEnd() : part)).join("");
  return [
    ["the scenes server's HTTP API", "Kurviq's or Google's HTTP API (except the upload address from `read_me`)"] as const,
    [/ \(also in REFERENCE\.md next to this\s+file\)/, ""] as const,
  ].reduce((next, [from, to]) => replaceOnce("SKILL.md", next, from, to), withoutPort);
};

/** what differs online in the reference: no local files, no PDF export */
const onlineReference = (text: string) =>
  [
    [/absolute file path,\s+/g, ""] as const,
    [/ Local file paths must lie inside[\s\S]*?at most 5 MB\./, ""] as const,
    [/- \*\*Big edits:\*\* write[\s\S]*?instead of pasting it into the call\./, '- **Big edits:** upload them as JSON and pass `payloadId` (see "Images from your machine").'] as const,
    [/- PDF: `export_pdf\(name\)`[\s\S]*?selectable text\./, "- PDF: the user exports the deck in Kurviq (Slides sidebar → PDF)."] as const,
  ].reduce((next, [from, to]) => replaceOnce("REFERENCE.md", next, from, to), text);

/** the server's instructions: how to work with the user's scenes */
export const kurviqSkill = (app: string) => {
  let text = String(localSkill).replace(/^---[\s\S]*?---\s*/, "");
  const [intro] = section("SKILL.md", text, "## Golden rules");
  text = INTRO(app) + text.slice(intro);
  for (const heading of ["## Live mode", "## Troubleshooting"]) {
    const range = section("SKILL.md", text, heading);
    text = text.slice(0, range[0]) + text.slice(range[1]);
  }
  return `${onlineSkill(text).trimEnd()}\n\n${TROUBLESHOOTING(app)}`;
};

/** what read_me returns: the element reference, with the upload address for images and big edits */
export const kurviqReference = (uploadUrl = "<the upload address>") =>
  `${onlineReference(String(localReference)).trimEnd()}\n\n${UPLOADS(uploadUrl)}`;
