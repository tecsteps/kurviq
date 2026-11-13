// Sets the Worker's secrets on Cloudflare. Name the ones to set:
//
//   npm run secrets -- GOOGLE_CLIENT_SECRET GOOGLE_API_KEY
//
// Without names it prints this help and sets nothing. Values:
//   GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY   from KURVIQ_GOOGLE_CLIENT_SECRET /
//                  KURVIQ_GOOGLE_API_KEY in ../.env
//   SUPABASE_CLIENT_SECRET   from KURVIQ_SUPABASE_CLIENT_SECRET in ../.env: the
//                  Supabase OAuth app's secret ("Connect with Supabase"; the
//                  Worker only adds it to the token exchange, keeps nothing)
//   COOKIE_KEY     a new random key. It seals far more than cookies: every
//                  browser's Google session (all are signed out: one click to
//                  sign in again), the local installs' sessions, every agent's
//                  OAuth registration and tokens (agents must be added again)
//                  and upload addresses; it also keys the rate-limit hashes
//                  (their history starts over). To rotate without signing
//                  everybody out at once, set the old value as
//                  COOKIE_KEY_PREVIOUS first (wrangler secret put
//                  COOKIE_KEY_PREVIOUS): what it sealed stays valid until it
//                  expires.
//   TOKEN_KEY      live sync: encrypts the refresh tokens a scene keeps until
//                  its changes are in Drive (a new one only makes those
//                  pending tokens useless: their authors' changes wait for
//                  their next visit)
//   PSEUDONYM_KEY  live sync: derives the per-scene author pseudonyms written
//                  into Drive files (a new one changes every pseudonym: never
//                  rotate it; refused unless --force)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../scripts/env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const args = process.argv.slice(2);
const force = args.includes("--force");
const names = args.filter((arg) => arg !== "--force");

const random = () => randomBytes(32).toString("base64");
const secrets = {
  GOOGLE_CLIENT_SECRET: () => env.KURVIQ_GOOGLE_CLIENT_SECRET,
  GOOGLE_API_KEY: () => env.KURVIQ_GOOGLE_API_KEY,
  SUPABASE_CLIENT_SECRET: () => env.KURVIQ_SUPABASE_CLIENT_SECRET,
  COOKIE_KEY: random,
  TOKEN_KEY: random,
  PSEUDONYM_KEY: random,
};

const usage = () =>
  console.log(
    "Sets the Worker's secrets on Cloudflare:\n  npm run secrets -- <NAME> [<NAME> …] [--force]\n" +
      `Names: ${Object.keys(secrets).join(", ")}\n` +
      "(the top of online/secrets.mjs says what each one does; a new COOKIE_KEY signs every browser and every agent out)",
  );

if (!names.length) {
  usage();
  process.exit(0);
}
const unknown = names.filter((name) => !(name in secrets));
if (unknown.length) {
  console.error(`[secrets] unknown: ${unknown.join(", ")}. Known: ${Object.keys(secrets).join(", ")}`);
  process.exit(1);
}
if (names.includes("PSEUDONYM_KEY") && !force) {
  console.error("[secrets] PSEUDONYM_KEY changes every author pseudonym in Drive files: add --force if you really mean it");
  process.exit(1);
}
for (const name of names) {
  const value = secrets[name]();
  if (!value) {
    console.error(`[secrets] ${name}: no value (set KURVIQ_${name} in .env)`);
    process.exit(1);
  }
  const result = spawnSync("node", [path.join(HERE, "with-env.mjs"), "npx", "wrangler", "secret", "put", name], { // NOSONAR S4036: local developer tooling invokes a fixed command in the developer-controlled environment
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
