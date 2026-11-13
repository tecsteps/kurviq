// The project's settings: `.env` then `.env.local` in the repo root (the
// second wins). One reader for every local tool (the scenes server, the Vite
// build, the Worker's dev and deploy scripts), so they agree on the format
// and on values such as SCENES_SERVER_URL and SCENES_APP_URL.
//
// Format: `NAME=value` per line, whitespace around both allowed, the value
// optionally in single or double quotes. Anything else (comments, blank
// lines) is ignored. Values are single-line: a value that contains a line or
// paragraph separator (U+2028/U+2029, which `split` leaves in) is dropped.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** the repo root (this file is in scripts/) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** one line of a settings file: { name, value }, or null when it is not a setting */
export const parseEnvLine = (line) => {
  const match = /^\s*([\w.-]+)\s*=/.exec(line);
  if (!match) {
    return null;
  }
  const value = line.slice(match[0].length).trim();
  if (/[\r\n\u2028\u2029]/.test(value)) {
    return null;
  }
  return { name: match[1], value: value.replace(/^(['"])(.*)\1$/, "$2") };
};

/** the settings of one file's text */
export const parseEnv = (text) => {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const setting = parseEnvLine(line);
    if (setting) {
      env[setting.name] = setting.value;
    }
  }
  return env;
};

/** the settings of `.env` and `.env.local` in `root` (the files only) */
export const readEnvFiles = (root = ROOT) => {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    const full = path.join(root, file);
    if (existsSync(full)) {
      Object.assign(env, parseEnv(readFileSync(full, "utf8")));
    }
  }
  return env;
};

/** the files' settings with the process environment on top (a variable set in the shell wins) */
export const loadEnv = (root = ROOT) => ({ ...readEnvFiles(root), ...process.env });
