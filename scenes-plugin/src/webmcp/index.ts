// Kurviq's tools for browser agents (WebMCP): where the browser offers
// document.modelContext (Chrome with the WebMCP origin trial or
// chrome://flags/#enable-webmcp-testing), the scenes tools are registered
// with it (./bridge.ts, loaded only then). Elsewhere nothing is loaded.

import { modelContextOf } from "./adapter";

let started = false;

/** offer the scenes tools to browser agents (once per page) */
export const startWebMcp = () => {
  if (started) {
    return;
  }
  const context = modelContextOf(document, navigator);
  if (!context) {
    return;
  }
  started = true;
  import("./bridge")
    .then(({ registerSceneTools }) => registerSceneTools(context))
    .catch((error) => console.error("[kurviq] the scene tools could not be offered to browser agents (WebMCP)", error));
};
