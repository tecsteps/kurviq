// Unit tests of the scenes plugin's pure parts (live sync: merge, crypto,
// queue). Run from the repo root:
//   excalidraw/node_modules/.bin/vitest run --config scenes-plugin/test/vitest.config.mts
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["*.test.ts"],
    environment: "node",
  },
});
