// node:fs/promises in the Worker: there are no files. The upstream
// excalidraw-mcp tools read their widget (mcp-app.html), which is bundled;
// anything else (e.g. an image `src` given as a local file path) is not
// reachable from Kurviq's server.
import widgetHtml from "../../../excalidraw-mcp/dist/mcp-app.html";

const missing = (path) =>
  Object.assign(
    new Error(
      `"${path}": local files are not available with the Kurviq MCP (it runs on kurviq.com, not on your machine). Pass the content inline instead (e.g. an http(s) URL or a data URL for images, the JSON itself instead of a file).`,
    ),
    { code: "ENOENT" },
  );

export const readFile = async (path) => {
  if (String(path).endsWith("mcp-app.html")) {
    return widgetHtml;
  }
  throw missing(path);
};

export const writeFile = async (path) => {
  throw missing(path);
};

// scenes-mcp/media.mjs confines local paths with realpath first: no local files here either
export const realpath = async (path) => {
  throw missing(path);
};

export default { readFile, writeFile, realpath };
