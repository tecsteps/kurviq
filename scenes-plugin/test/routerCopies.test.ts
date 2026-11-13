// The old "features" copies (router.ts): a hash over a few fields can't tell
// whether the visitor changed a copy, so no copy is deleted any more (B39).
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("starting the router deletes no scene, only the old note", () => {
  const router = readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
  expect(router).not.toMatch(/scenesController\.remove\(/);
  expect(router).toMatch(/localStorage\.removeItem\("kurviq-public-scenes"\)/);
});
