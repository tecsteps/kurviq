// The agent instructions of the Kurviq MCP: the local skill
// (scenes-mcp/skill/excalidraw-scenes/SKILL.md), with what differs online.
import localSkill from "../../scenes-mcp/skill/excalidraw-scenes/SKILL.md";

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

`;

const TROUBLESHOOTING = (app: string) => `## Troubleshooting

- "Kurviq is not open in the user's browser": ask the user to open ${app}
  in the browser where they allowed this agent.
- "Google Drive is not connected": the user can sign in with Google in the
  scene list (Sign in with Google); until then, work with local-only scenes.
- Local file paths (edit files, image src) and PDF export are not available
  through the Kurviq MCP: upload images and big edits (see "Images from your
  machine"); the user exports PDFs in Kurviq (Slides sidebar → PDF).
- "The Kurviq tab did not answer": the edit may still land. Call it again
  with the same \`requestId\` (it is never applied twice), and check
  \`app_status\` → \`health\`. A browser may pause a tab in the background:
  ask the user to bring Kurviq to the front.
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
\`"slide": 3\`). PNG, JPEG, GIF, WebP or SVG, up to 10 MB; prefer JPEG or
WebP for photos (the scene file carries the image). The upload goes straight
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

const section = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  if (start < 0) {
    return null;
  }
  const end = text.indexOf("\n## ", start + heading.length);
  return [start, end < 0 ? text.length : end + 1] as const;
};

export const kurviqSkill = (app: string, uploadUrl = "<the upload address from the MCP server's instructions>") => {
  let text = String(localSkill).replace(/^---[\s\S]*?---\s*/, "");
  const intro = text.indexOf("## Golden rules");
  text = INTRO(app) + text.slice(intro);
  for (const heading of ["## Live mode", "## Troubleshooting"]) {
    const range = section(text, heading);
    if (range) {
      text = text.slice(0, range[0]) + text.slice(range[1]);
    }
  }
  text = text
    .replace(/\s*\(localhost:3101\)/g, "")
    .replace(/the scenes server's HTTP API/g, "Kurviq's or Google's HTTP API")
    .replace(/absolute file path,\s+/g, "")
    .replace(
      /- \*\*Big edits:\*\* write[\s\S]*?instead of pasting it into the call\./,
      '- **Big edits:** upload them as JSON and pass \`payloadId\` (see "Images from your machine").',
    )
    .replace(
      /- PDF: \`export_pdf\(name\)\`[\s\S]*?selectable text\./,
      "- PDF: the user exports the deck in Kurviq (Slides sidebar → PDF).",
    );
  return `${text.trimEnd()}\n\n${UPLOADS(uploadUrl)}\n${TROUBLESHOOTING(app)}`;
};
