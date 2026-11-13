// The typecheck for CI (and anyone): `npm run typecheck`, which passes when
// the only errors are the known ones in the upstream checkout (excalidraw/,
// which stays untouched) and fails on any error in Kurviq's own code or on
// more upstream errors than the known 17.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { ROOT } from "./env.mjs";

/** errors upstream's own sources have at the pinned commit (scripts/setup.mjs) */
const KNOWN_UPSTREAM_ERRORS = 17;

const tsc = path.join(ROOT, "excalidraw/node_modules/.bin/tsc");
const result = spawnSync(tsc, ["-p", "scenes-plugin/tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const errors = output.split("\n").filter((line) => /error TS\d+/.test(line));
const ours = errors.filter((line) => !line.startsWith("excalidraw/"));
const upstream = errors.length - ours.length;

if (result.error) {
  console.error(`[typecheck] could not run tsc: ${result.error.message}`);
  process.exit(1);
}
if (ours.length || upstream > KNOWN_UPSTREAM_ERRORS) {
  console.error(output);
  console.error(`[typecheck] ${ours.length} error(s) in Kurviq's code, ${upstream} upstream (known: ${KNOWN_UPSTREAM_ERRORS})`);
  process.exit(1);
}
console.log(`[typecheck] ok: no errors in Kurviq's code (${upstream} known upstream)`);
