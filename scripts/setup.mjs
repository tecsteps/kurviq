// Clones upstream excalidraw + excalidraw-mcp (if missing) at the versions
// our code was built against, installs and builds them, and links their
// node_modules for our code living next to them.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Our Vite wrapper and plugin hook into excalidraw internals, so a fresh
// setup uses these tested versions. To upgrade: change a hash, run setup, test.
const UPSTREAM = [
  {
    dir: "excalidraw",
    url: "https://github.com/excalidraw/excalidraw.git",
    commit: "4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e",
    install: "yarn install --frozen-lockfile",
  },
  {
    dir: "excalidraw-mcp",
    url: "https://github.com/excalidraw/excalidraw-mcp.git",
    commit: "157aa23ceb1976008aadc89eb05e3444060f09d6",
    install: "pnpm install --frozen-lockfile && pnpm run build",
  },
];

const run = (cmd, cwd) => execSync(cmd, { stdio: "inherit", cwd });
const head = (cwd) =>
  execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim(); // NOSONAR S4036: local developer setup intentionally uses the developer-provided git installation from PATH

for (const { dir, url, commit, install } of UPSTREAM) {
  if (!existsSync(`${dir}/.git`)) {
    run(`git clone ${url} ${dir}`);
    run(`git -c advice.detachedHead=false checkout ${commit}`, dir);
  } else if (head(dir) !== commit) {
    console.warn(
      `[setup] ${dir} is at ${head(dir).slice(0, 7)}, tested with ${commit.slice(0, 7)}, leaving it as is`,
    );
  }
  run(install, dir);
}

// Kurviq's own dependencies (package.json: the database client, loaded only
// when a database home is used), from the lockfile
run("npm ci --ignore-scripts", ".");

// let our sources (outside the checkouts) resolve the checkouts' deps
run("ln -sfn ../excalidraw/node_modules scenes-plugin/node_modules");
run("ln -sfn ../excalidraw-mcp/node_modules scenes-mcp/node_modules");
