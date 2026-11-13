// What a build is: shared by the app's build (scenes-plugin/vite.config.mts)
// and the Worker's (build-worker.mjs), which must give the same answers.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The commit a build is made from (Actions: GITHUB_SHA), 12 characters. The
 * app and the Worker both carry it: agent commands send it along, and a tab
 * whose value differs from the Worker's knows it is outdated.
 */
export const kurviqBuild = () => {
  try {
    return (process.env.GITHUB_SHA || execSync("git rev-parse HEAD", { cwd: HERE, encoding: "utf8" })).trim().slice(0, 12); // NOSONAR S4036: local build tool runs a constant git command in the developer or CI environment
  } catch {
    return "";
  }
};

/** where the app's build records what it was built for (outside dist/app: not published) */
export const APP_BUILD_INFO = path.join(HERE, "dist/app-build.json");
