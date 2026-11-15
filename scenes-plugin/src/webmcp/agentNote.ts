// A note for browser agents that don't look for WebMCP tools by themselves
// (e.g. agents that click and type, but read the page and can run
// JavaScript): it tells them the page has tools and how to call them. Not
// shown on screen; agents and screen readers find it in the page's text.
// Added only once the tools are registered (./bridge.ts).

const NOTE_ID = "kurviq-agent-note";

export const AGENT_NOTE =
  "For AI agents: this page offers Kurviq's scene tools (WebMCP). Use them instead of clicking or typing on the canvas: " +
  "in JavaScript, const tools = await document.modelContext.getTools(); then " +
  'await document.modelContext.executeTool(tools.find((t) => t.name === "read_me"), {}). ' +
  "Call read_me first, then app_status (the open scene), read_scene and edit_scene; each tool's inputSchema says what it takes.";

/** off screen, still in the page's text and accessibility tree (not display:none) */
const OFF_SCREEN =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

type NoteDocument = Pick<Document, "getElementById" | "createElement" | "body">;

/** the note in the page (once) */
export const addAgentNote = (doc: NoteDocument) => {
  if (doc.getElementById(NOTE_ID)) {
    return;
  }
  const note = doc.createElement("p");
  note.id = NOTE_ID;
  note.setAttribute("style", OFF_SCREEN);
  note.textContent = AGENT_NOTE;
  doc.body.appendChild(note);
};
