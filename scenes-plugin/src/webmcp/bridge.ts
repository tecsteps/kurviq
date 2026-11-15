// Kurviq's WebMCP bridge (loaded only where the browser has WebMCP, see
// ./index.ts): the MCP's scenes tools (scenes-mcp/tools.mjs) run in this page
// with an in-memory MCP client, and each is registered with the browser
// (document.modelContext.registerTool), so a browser agent reads and edits
// scenes like an MCP agent does, instead of clicking on the canvas. Calls go
// straight to this tab (./adapter.ts localServerFetch): nothing passes
// through Kurviq's server.

import { kurviqPageReference } from "../../../online/worker/skill";
import { connectInProcess } from "../../../scenes-mcp/inProcess.mjs";
import { createScenesMcp } from "../../../scenes-mcp/tools.mjs";
import { agentTabState, runAgentCommand } from "../live";

import { localServerFetch, registerReadMeOnly, webTool } from "./adapter";
import { addAgentNote } from "./agentNote";
import type { McpTool, ModelContext } from "./adapter";

/** a tool call may take long (a picture of a big scene, a merge): the tab's own limits apply */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** registers the scenes tools with the page's WebMCP; the returned function removes them */
export const registerSceneTools = async (context: ModelContext): Promise<() => void> => {
  const app = window.location.origin;
  const server = createScenesMcp({
    name: "Kurviq",
    mode: "detached",
    appHint: app,
    leanReads: true,
    // a page has no files: images inline, edits in the call
    localFiles: false,
    // the server instructions don't reach WebMCP agents; read_me does
    skill: "",
    reference: kurviqPageReference(),
    unreachable: `This Kurviq page could not answer. Reload ${app} and try again.`,
    serverFetch: localServerFetch(runAgentCommand, agentTabState),
    registerUpstream: registerReadMeOnly,
  });
  const client = await connectInProcess(server);
  const { tools } = await client.listTools();
  const stop = new AbortController();
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal });
  for (const tool of tools as McpTool[]) {
    await context.registerTool(webTool(tool, call), { signal: stop.signal }); // NOSONAR S9382: one after the other on purpose (the browser's tool list keeps their order)
  }
  console.info(`[kurviq] ${tools.length} scene tools offered to browser agents (WebMCP)`);
  // agents that don't ask the browser for tools: the page's text tells them
  addAgentNote(document);
  return () => {
    stop.abort();
    client.close().catch(() => {});
  };
};
