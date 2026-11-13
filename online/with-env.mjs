// Runs a command (wrangler) with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
// from the project's .env / .env.local, without putting them on the command line.
import { spawnSync } from "node:child_process";

import { readEnvFiles } from "../scripts/env.mjs";

// only the Cloudflare settings, and the files win over the shell here (the
// token in .env is the one meant for this project)
const env = { ...process.env };
for (const [name, value] of Object.entries(readEnvFiles())) {
  if (name.startsWith("CLOUDFLARE_") && value) {
    env[name] = value;
  }
}
const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, { stdio: "inherit", env, shell: false });
process.exit(result.status ?? 1);
