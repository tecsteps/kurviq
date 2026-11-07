// Unit tests of the scenes plugin's pure parts (live sync: merge, crypto,
// queue; the stored scene metadata's migration; the tab API's version
// names). Run from the repo root:
//   excalidraw/node_modules/.bin/vitest run --config scenes-plugin/test/vitest.config.mts
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // .md files as text, like the Worker build (online/build-worker.mjs): the agent instructions
  plugins: [{ name: "md-as-text", transform: (code: string, id: string) => (id.endsWith(".md") ? `export default ${JSON.stringify(code)};` : undefined) }],
  resolve: {
    alias: {
      "fractional-indexing": fileURLToPath(
        new URL(
          "../../excalidraw-mcp/node_modules/fractional-indexing/src/index.js",
          import.meta.url
        )
      ),
    },
  },
  test: {
    include: ["*.test.ts"],
    environment: "node",
  },
});
