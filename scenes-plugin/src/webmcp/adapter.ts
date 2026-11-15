// Kurviq's WebMCP adapter (pure parts, no browser globals): browser agents
// call the scenes tools of the open Kurviq page (document.modelContext,
// https://webmachinelearning.github.io/webmcp/). The tools are the MCP's
// own (scenes-mcp/tools.mjs, see ./bridge.ts); this file connects them to the
// page:
//   - localServerFetch: "the scenes server" those tools ask is this tab
//     itself (the same commands the pairing WebSocket brings, ../live.ts)
//   - webTool / webResult: an MCP tool as a WebMCP tool, its result as text

/** what the tab answers for a command (../live.ts handleCommand) */
export type CommandAnswer = { ok: boolean; result?: unknown; error?: string };
export type RunCommand = (command: Record<string, unknown>) => Promise<CommandAnswer>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** the headers a tab request carries (like the pairing: x-… and content-type, lower case) */
const tabHeaders = (init: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    if (key.startsWith("x-") || key === "content-type") {
      headers[key] = value;
    }
  });
  return headers;
};

const bodyText = (init: RequestInit) => (typeof init.body === "string" ? init.body : "");

/**
 * The scenes server's API (what scenes-mcp/tools.mjs fetches), answered by
 * this tab: the same requests the pairing Durable Object answers online
 * (online/worker/pairing.ts), without a server in between.
 */
export const localServerFetch =
  (run: RunCommand, tabState: () => Record<string, unknown>) =>
  async (pathname: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(pathname, "https://tab.invalid");
    const method = (init.method || "GET").toUpperCase();
    if (url.pathname === "/api/app/state") {
      return json(200, { connected: true, tabs: 1, ...tabState() });
    }
    if (url.pathname === "/api/app/command" && method === "POST") {
      const answer = await run(JSON.parse(bodyText(init) || "{}"));
      return answer.ok
        ? json(200, { ok: true, result: answer.result })
        : json(422, { error: answer.error || "Command failed in the Kurviq tab" });
    }
    if (url.pathname === "/api/app/flush" && method === "POST") {
      const { name } = JSON.parse(bodyText(init) || "{}");
      const answer = await run({ type: "flush", name });
      return json(200, { tabs: 1, results: [answer.ok ? answer.result : { error: answer.error }] });
    }
    if (url.pathname.startsWith("/api/scenes")) {
      const answer = await run({
        type: "http",
        request: { method, path: url.pathname + url.search, headers: tabHeaders(init), body: bodyText(init) },
      });
      if (!answer.ok) {
        return json(500, { error: answer.error || "The Kurviq tab could not answer" });
      }
      const reply = (answer.result ?? {}) as { status?: number; headers?: Record<string, string>; body?: string };
      return new Response(reply.body ?? "", { status: reply.status ?? 500, headers: reply.headers ?? {} });
    }
    return json(404, { error: "Not found" });
  };

/** a tool as the MCP lists it */
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
};

/** a tool result as the MCP returns it */
export type McpResult = { content?: Array<Record<string, any>>; isError?: boolean };

/** tools whose answers carry no scene content (nothing anyone else wrote) */
const TRUSTED_ANSWERS = new Set(["read_me", "measure_text"]);

/** size of base64 data, in KB */
const kbOf = (base64: string) => Math.max(1, Math.round((base64.length * 3) / 4 / 1024));

/**
 * The answer as text: WebMCP passes a tool's result to the agent as a JSON
 * string, so pictures (base64 PNGs) are named, not inlined: the agent sees
 * the page itself. A failed call says so in its first line.
 */
export const webResult = (result: McpResult): string => {
  const parts = (result.content ?? []).map((item) => {
    if (item.type === "text") {
      return String(item.text ?? "");
    }
    if (item.type === "image") {
      return `[picture: ${item.mimeType || "image"}, ${kbOf(String(item.data ?? ""))} KB, not passed on to page tools; look at the Kurviq page instead]`;
    }
    return JSON.stringify(item);
  });
  const text = parts.join("\n\n");
  return result.isError && !text.startsWith("Error") ? `Error: ${text}` : text;
};

/** a WebMCP tool (document.modelContext.registerTool) */
export type WebTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean; untrustedContentHint: boolean };
  execute: (input: Record<string, unknown> | string | undefined, options?: { signal?: AbortSignal }) => Promise<string>;
};

/** the input as an object (Chrome before 155 may pass it JSON-encoded) */
const inputObject = (input: unknown): Record<string, unknown> => {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
};

/** an MCP tool as a WebMCP tool; `call` runs it (through the in-page MCP client) */
export const webTool = (
  tool: McpTool,
  call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpResult>,
): WebTool => ({
  name: tool.name,
  ...(tool.title ? { title: tool.title } : {}),
  description: tool.description || tool.title || tool.name,
  inputSchema: tool.inputSchema,
  annotations: {
    readOnlyHint: !!tool.annotations?.readOnlyHint,
    // deleting a scene: the browser may ask the user first
    consequentialHint: !!tool.annotations?.destructiveHint,
    // scenes may be shared: their text was written by other people
    untrustedContentHint: !TRUSTED_ANSWERS.has(tool.name),
  },
  execute: async (input, options) => {
    try {
      return webResult(await call(tool.name, inputObject(input), options?.signal));
    } catch (error: any) {
      return `Error: ${error?.message || String(error)}`;
    }
  },
});

/** the page's WebMCP object, if the browser has one (document.modelContext; navigator.modelContext before Chrome 150) */
export type ModelContext = {
  registerTool: (tool: WebTool, options?: { signal?: AbortSignal }) => unknown;
};

export const modelContextOf = (doc: unknown, nav: unknown): ModelContext | null => {
  const candidates = [(doc as any)?.modelContext, (nav as any)?.modelContext];
  return candidates.find((context) => typeof context?.registerTool === "function") ?? null;
};

/**
 * Of excalidraw-mcp's tools only read_me (scenes-mcp/tools.mjs answers it
 * with Kurviq's reference, whatever is registered here): create_view is an
 * inline chat widget, which has no place in a page.
 */
export const registerReadMeOnly = (server: unknown) => {
  (server as { registerTool: (name: string, config: object, handler: () => Promise<McpResult>) => void }).registerTool(
    "read_me",
    {},
    () => Promise.resolve({ content: [] }),
  );
};
