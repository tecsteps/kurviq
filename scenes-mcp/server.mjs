#!/usr/bin/env node
/**
 * Kurviq's MCP server (stdio), for the local install: the tools of
 * ./tools.mjs against the scenes server on this machine (../scenes-server).
 *
 * The agent always works through the user's open Kurviq tab: the scenes
 * server relays its requests there, the tab reads/edits/renders with the real
 * Excalidraw, merges the edits and saves them to Google Drive with the user's
 * sign-in (local-only scenes stay in the browser). By default
 * (SCENES_AGENT_MODE=detached) the agent edits scenes as data, merged into
 * what the user does; in live mode it co-edits the open canvas live.
 */
import { constants, existsSync, readFileSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "../excalidraw-mcp/dist/server.js";

import { createScenesMcp } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
const LOCAL_ROOT = process.cwd();

const readEnv = () => {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    const full = path.join(WORKSPACE, file);
    if (!existsSync(full)) {
      continue;
    }
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/); // NOSONAR S8786: trusted local configuration lines, not remote input
      if (match) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
  return { ...env, ...process.env };
};

const env = readEnv();
const SERVER_URL = (env.SCENES_SERVER_URL || "http://localhost:3101").replace(/\/$/, "");

const server = createScenesMcp({
  serverFetch: (pathname, init) => fetch(`${SERVER_URL}${pathname}`, init),
  unreachable: `Scenes server not reachable at ${SERVER_URL}. Start it with \`npm run start\` in ${WORKSPACE}.`,
  /**
   * detached (default): the agent's edits run in the user's open tab, which
   * merges them and saves them to Drive. live: the agent edits the user's
   * open canvas directly (co-working in the same tab, undoable).
   */
  mode: env.SCENES_AGENT_MODE === "live" ? "live" : "detached",
  appHint: (env.SCENES_APP_URL || "http://localhost:3001").replace(/\/$/, ""),
  skill: readFileSync(path.join(HERE, "skill", "kurviq-scenes", "SKILL.md"), "utf8"),
  registerUpstream: (mcp, store) => registerTools(mcp, path.join(WORKSPACE, "excalidraw-mcp", "dist"), store),
  livePreview: process.env.SCENES_LIVE_PREVIEW !== "false",
  savePdf: async (name, pdf, file) => {
    const base = await realpath(LOCAL_ROOT);
    const target = path.resolve(base, file || `${name}.pdf`);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`file "${target}": must be inside ${LOCAL_ROOT}`);
    }
    let resolved;
    try {
      resolved = path.resolve(base, await realpath(target));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      resolved = path.resolve(base, await realpath(path.dirname(target)), path.basename(target));
    }
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`file "${target}": must be inside ${LOCAL_ROOT}`);
    }
    // Do not follow a dangling or newly swapped final symlink when creating the file.
    await writeFile(resolved, pdf, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
    return { file: resolved };
  },
});

await server.connect(new StdioServerTransport());
