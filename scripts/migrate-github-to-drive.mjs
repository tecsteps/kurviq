#!/usr/bin/env node
/**
 * One-time move of scenes from GitHub repositories (the time before Google
 * Drive) into the "Kurviq" folder of a Google Drive, as Kurviq keeps them.
 *
 *   node scripts/migrate-github-to-drive.mjs [--dry-run] owner/repo [owner/repo…]
 *
 * - reads scenes/<name>.excalidraw of each repository (latest version) with
 *   the GitHub CLI (`gh`, signed in)
 * - the same name in several repositories: identical content is one scene;
 *   different content: the most recently committed one keeps the name, the
 *   others become "<name> (<repo>)"
 * - signs in to Google with Kurviq's own OAuth client (Drive's drive.file
 *   access: Kurviq only sees files its own client created), using the web
 *   client's registered callback http://localhost:8787/auth/callback — so
 *   `npm run dev:online` must not be running. Needs
 *   KURVIQ_GOOGLE_CLIENT_SECRET in .env and the client id in online/google.json.
 * - finds or creates the folder "Kurviq" (marked like the app does) and
 *   uploads each scene, skipping a file of the same name and content (safe
 *   to run again), then reads every file back and compares it
 *
 * Nothing on GitHub is changed.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSceneName } from "../scenes-mcp/sceneName.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const file of [".env", ".env.local"]) {
  const full = path.join(ROOT, file);
  if (existsSync(full)) {
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (match) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
}
const google = JSON.parse(readFileSync(path.join(ROOT, "online/google.json"), "utf8"));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const repos = args.filter((arg) => !arg.startsWith("--"));
if (!repos.length || repos.some((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
  console.error("usage: node scripts/migrate-github-to-drive.mjs [--dry-run] owner/repo [owner/repo…]");
  process.exit(1);
}

const SCENE_MIME = "application/vnd.excalidraw+json";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PORT = 8787;
const REDIRECT = `http://localhost:${PORT}/auth/callback`;
const md5 = (text) => createHash("md5").update(text, "utf8").digest("hex");

// -----------------------------------------------------------------------------
// GitHub: the latest version of each scene
// -----------------------------------------------------------------------------

const gh = (...ghArgs) => execFileSync("gh", ["api", ...ghArgs], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const readRepo = (repo) => {
  const entries = JSON.parse(gh(`repos/${repo}/contents/scenes`));
  return entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".excalidraw"))
    .map((entry) => {
      const name = entry.name.slice(0, -".excalidraw".length);
      const content = gh("-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}`);
      const [commit] = JSON.parse(gh(`repos/${repo}/commits?path=${encodeURIComponent(entry.path)}&per_page=1`));
      return { repo, name, content, at: commit?.commit?.committer?.date ?? "" };
    });
};

/** the scene renamed: its content says whose it is (appState.name), as the app checks */
const renamed = (scene, name) => {
  const data = JSON.parse(scene.content);
  data.appState = { ...(data.appState || {}), name };
  return { ...scene, name, content: JSON.stringify(data) };
};

const plan = () => {
  const byName = new Map();
  for (const repo of repos) {
    console.log(`reading ${repo}…`);
    for (const scene of readRepo(repo)) {
      byName.set(scene.name, [...(byName.get(scene.name) ?? []), scene]);
    }
  }
  const result = [];
  for (const [name, scenes] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const distinct = [];
    for (const scene of scenes.sort((a, b) => b.at.localeCompare(a.at))) {
      if (!distinct.some((other) => md5(other.content) === md5(scene.content))) {
        distinct.push(scene);
      }
    }
    const [newest, ...older] = distinct;
    result.push({ ...newest, note: scenes.length > 1 ? (distinct.length === 1 ? `same in ${scenes.map((s) => s.repo).join(" and ")}` : "newest") : "" });
    for (const scene of older) {
      const copyName = `${name} (${scene.repo.split("/")[1]})`;
      if (!isSceneName(copyName)) {
        throw new Error(`"${copyName}" is not a valid scene name`);
      }
      result.push({ ...renamed(scene, copyName), note: `older version of "${name}"` });
    }
  }
  return result;
};

// -----------------------------------------------------------------------------
// Google: sign in (loopback), Drive
// -----------------------------------------------------------------------------

const signIn = () =>
  new Promise((resolve, reject) => {
    if (!google.clientId || !env.KURVIQ_GOOGLE_CLIENT_SECRET) {
      reject(new Error("online/google.json clientId and KURVIQ_GOOGLE_CLIENT_SECRET in .env are needed"));
      return;
    }
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code) {
        res.writeHead(400).end("Sign-in failed, see the terminal.");
        server.close();
        reject(new Error(`sign-in failed: ${url.searchParams.get("error") || "wrong state"}`));
        return;
      }
      const token = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: google.clientId,
          client_secret: env.KURVIQ_GOOGLE_CLIENT_SECRET,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT,
        }),
      }).then((r) => r.json());
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Signed in. You can close this tab and go back to the terminal.");
      server.close();
      token.access_token ? resolve(token.access_token) : reject(new Error(`token exchange failed: ${JSON.stringify(token)}`));
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`\nSign in with Google in your browser (the Google account whose Drive gets the scenes):\n${auth}\n`);
      try {
        execFileSync("open", [auth.toString()]);
      } catch {}
    });
  });

const driveApi = (token) => async (url, { method = "GET", body, contentType, raw = false } = {}) => {
  const res = await fetch(url.startsWith("https://") ? url : `https://www.googleapis.com/drive/v3${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { "Content-Type": contentType } : body && typeof body === "object" && !(body instanceof Blob) ? { "Content-Type": "application/json" } : {}) },
    body: body && typeof body === "object" && !(body instanceof Blob) ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url}: ${res.status} ${text}`);
  }
  return raw ? text : text ? JSON.parse(text) : null;
};

const q = (value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const findFolder = async (drive) => {
  const found = await drive(
    `/files?q=${encodeURIComponent(`appProperties has { key='kurviqRoot' and value='1' } and mimeType=${q(FOLDER_MIME)} and trashed=false`)}&fields=files(id,name)&orderBy=createdTime&spaces=drive`,
  );
  if (found.files?.[0]) {
    console.log(`folder: ${found.files[0].name} (${found.files[0].id})`);
    return found.files[0].id;
  }
  const created = await drive("/files?fields=id", {
    method: "POST",
    body: { name: "Kurviq", mimeType: FOLDER_MIME, appProperties: { kurviqRoot: "1" } },
  });
  console.log(`folder: Kurviq created (${created.id})`);
  return created.id;
};

const upload = async (drive, folder, scene) => {
  const boundary = `kurviq${randomBytes(8).toString("hex")}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
      name: `${scene.name}.excalidraw`,
      mimeType: SCENE_MIME,
      parents: [folder],
      appProperties: { kurviq: "scene", fmt: "1" },
    })}\r\n`,
    `--${boundary}\r\nContent-Type: ${SCENE_MIME}\r\n\r\n`,
    scene.content,
    `\r\n--${boundary}--`,
  ]);
  return drive("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum", {
    method: "POST",
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  });
};

// -----------------------------------------------------------------------------

const scenes = plan();
console.log("\nplan:");
for (const scene of scenes) {
  console.log(`  ${scene.name.padEnd(48)} ${scene.repo.padEnd(28)} ${String(Math.round(scene.content.length / 1024)).padStart(6)} KB  ${scene.note}`);
}
console.log(`  ${scenes.length} scenes`);
if (dryRun) {
  console.log("\n--dry-run: nothing uploaded");
  process.exit(0);
}

const drive = driveApi(await signIn());
const folder = await findFolder(drive);
const existing = new Map(
  (await drive(`/files?q=${encodeURIComponent(`${q(folder)} in parents and trashed=false`)}&fields=files(id,name,md5Checksum)&pageSize=1000`)).files.map(
    (file) => [file.name, file],
  ),
);
let uploaded = 0;
let skipped = 0;
for (const scene of scenes) {
  const there = existing.get(`${scene.name}.excalidraw`);
  if (there?.md5Checksum === md5(scene.content)) {
    skipped++;
    continue;
  }
  if (there) {
    console.warn(`  ! "${scene.name}" is in the folder already with other content: left as it is (not uploaded)`);
    continue;
  }
  const file = await upload(drive, folder, scene);
  existing.set(`${scene.name}.excalidraw`, { id: file.id, md5Checksum: file.md5Checksum });
  uploaded++;
  console.log(`  ↑ ${scene.name}`);
}
console.log(`\nuploaded ${uploaded}, already there ${skipped}`);

console.log("verifying…");
let bad = 0;
for (const scene of scenes) {
  const file = existing.get(`${scene.name}.excalidraw`);
  const content = file ? await drive(`/files/${file.id}?alt=media`, { raw: true }) : null;
  if (content === null || md5(content) !== md5(scene.content)) {
    bad++;
    console.error(`  ✗ ${scene.name}`);
  }
}
console.log(bad ? `${bad} scene(s) differ — see above` : `all ${scenes.length} scenes are in Google Drive, byte for byte`);
process.exit(bad ? 1 : 0);
