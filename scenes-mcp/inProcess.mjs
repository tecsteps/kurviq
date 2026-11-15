// An MCP client connected to a server in the same JavaScript context (a
// memory transport, nothing leaves the page): Kurviq's WebMCP bridge
// (scenes-plugin/src/webmcp/bridge.ts) calls the scenes tools this way, so
// browser agents get exactly the tools, checks and answers of the MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Results are passed on unchecked: the scenes tools declare no output
 * schemas, and the SDK's default checker (Ajv) compiles with eval, which the
 * page's Content-Security-Policy forbids.
 */
export const passThroughValidator = {
  getValidator: () => (input) => ({ valid: true, data: input, errorMessage: undefined }),
};

/** a client of `server` (an McpServer that isn't connected yet) */
export const connectInProcess = async (server, name = "kurviq-page") => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name, version: "1.0.0" }, { jsonSchemaValidator: passThroughValidator });
  await client.connect(clientSide);
  return client;
};
