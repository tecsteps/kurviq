// Shared folders (docs/folders/CONCEPT.md, "Shared folders through the
// owner's sign-in"). With drive.file, someone's Kurviq can't see files another
// person's Kurviq created, even in a folder shared with them. So Kurviq's
// server works on a shared Kurviq folder with its owner's sign-in, for the
// people Drive lists as having access to the folder:
//
//   POST /folders/register     the owner's Kurviq: "my Kurviq folder is shared"
//                              (or not any more). The Worker reads the folder's
//                              permissions itself and keeps the owner's refresh
//                              token sealed for this folder, with the members as
//                              keyed hashes of their emails / domains.
//   POST /folders              a person's Kurviq: the folders shared with them,
//                              with their scenes (checked with Drive, every time)
//   POST /folders/<id>/drive   one Drive call in that folder, made with the
//                              owner's access after checking the caller's role
//                              and that the call is about this folder only
//                              (./folderRules.ts). Read-only for now.
//
// The sign-in (cookie, or the local install's sealed session) and the sign-out
// everywhere guard are the live sync routes' (./sceneRoutes.ts).

import { accessFromRefresh, accountEpochOf, isLocalOrigin, sealSceneToken, unsealSceneToken } from "./auth";
import type { Session } from "./auth";
import { DOWNLOAD_BYTES, driveCall, driveUrls, getFile, problemOf, readLimited } from "./driveApi";
import { keyedHash } from "./feedback";
import { asRecipient, callUrl, classifyRead, listQuery, lookupKeys, memberKeys, roleFor } from "./folderRules";
import type { DrivePermission, FolderRole, ProxyCall } from "./folderRules";
import { answer, fail, sameSite, signedIn } from "./sceneRoutes";
import type { Ctx, SceneRoutesEnv } from "./sceneRoutes";

/** the D1 calls used here */
type D1 = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<unknown>;
      all: <T>() => Promise<{ results?: T[] }>;
    };
  };
};

export type FoldersEnv = SceneRoutesEnv & { FEEDBACK?: D1 };

type FolderRow = { folder_id: string; owner_sub: string; owner_name: string | null; folder_name: string | null; token: string };

const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const EXTENSION = ".excalidraw";
/** the owner's sealed token for a folder: renewed whenever the owner's Kurviq registers the folder */
const TOKEN_DAYS = 90;
/** a folder's permissions, as Drive gave them, are used this long before they are asked again */
const PERMISSIONS_MS = 2 * 60_000;
const BODY_BYTES = 32 * 1024;
const PERMISSION_FIELDS = "nextPageToken,permissions(type,role,emailAddress,domain,deleted)";

export const FOLDERS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shared_folders (
    folder_id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    owner_name TEXT,
    folder_name TEXT,
    token TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shared_folder_members (
    member TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    PRIMARY KEY (member, folder_id)
  )`,
];

let schemaReady = false;

const database = async (env: FoldersEnv) => {
  const db = env.FEEDBACK;
  if (!db) {
    throw Object.assign(new Error("no database"), { status: 503 });
  }
  if (!schemaReady) {
    for (const sql of FOLDERS_SCHEMA) {
      await db.prepare(sql).bind().run(); // NOSONAR S9382: the tables are created one after the other on purpose (once per isolate)
    }
    schemaReady = true;
  }
  return db;
};

const tokenPurpose = (folderId: string) => `folder:${folderId}`;
const memberHash = (env: FoldersEnv, key: string) => keyedHash(env.COOKIE_KEY, `folder-member:${key}`);

// -----------------------------------------------------------------------------
// the owner's access (cached per isolate)
// -----------------------------------------------------------------------------

const ownerTokens = new Map<string, { sealed: string; token: string; expiresAt: number }>();
const permissionCache = new Map<string, { at: number; permissions: DrivePermission[] }>();

/** the share is over (owner signed out everywhere, removed Kurviq, the folder is gone): forgotten */
const forgetFolder = async (env: FoldersEnv, folderId: string) => {
  const db = await database(env);
  await db.prepare("DELETE FROM shared_folder_members WHERE folder_id = ?").bind(folderId).run();
  await db.prepare("DELETE FROM shared_folders WHERE folder_id = ?").bind(folderId).run();
  ownerTokens.delete(folderId);
  permissionCache.delete(folderId);
};

/** an access token of the folder's owner; null: the share is over (and forgotten) */
const ownerAccess = async (env: FoldersEnv, row: FolderRow): Promise<string | null> => {
  const cached = ownerTokens.get(row.folder_id);
  if (cached?.sealed === row.token && cached.expiresAt - Date.now() > 5 * 60_000) {
    return cached.token;
  }
  const sealed = await unsealSceneToken(env, row.token, tokenPurpose(row.folder_id), row.owner_sub);
  if (!sealed) {
    await forgetFolder(env, row.folder_id);
    return null;
  }
  const epoch = await accountEpochOf(env, row.owner_sub);
  if (epoch === null && env.ACCOUNT) {
    throw Object.assign(new Error("account guard unavailable"), { status: 503 });
  }
  if (epoch && sealed.iat < epoch) {
    // the owner signed out everywhere: their sign-in ends here too
    await forgetFolder(env, row.folder_id);
    return null;
  }
  const access = await accessFromRefresh(env, sealed.r);
  if (access === "unreachable") {
    throw Object.assign(new Error("Google not reachable"), { status: 503 });
  }
  if (access === "expired") {
    await forgetFolder(env, row.folder_id);
    return null;
  }
  ownerTokens.set(row.folder_id, { sealed: row.token, token: access.token, expiresAt: access.expiresAt });
  return access.token;
};

const listPermissions = async (env: FoldersEnv, token: string, folderId: string): Promise<DrivePermission[] | number> => {
  const permissions: DrivePermission[] = [];
  let pageToken = "";
  do {
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await driveCall( // NOSONAR S9382: each page needs the preceding page's token
      `${driveUrls(env).api}/files/${folderId}/permissions?fields=${encodeURIComponent(PERMISSION_FIELDS)}&pageSize=100&supportsAllDrives=true${page}`,
      token,
    );
    if (res.status !== 200) {
      return res.status;
    }
    permissions.push(...((res.data?.permissions ?? []) as DrivePermission[]));
    pageToken = String(res.data?.nextPageToken ?? "");
  } while (pageToken);
  return permissions;
};

/** the folder's permissions with the owner's access (cached a little); null: unreadable (the share is over) */
const folderPermissions = async (env: FoldersEnv, row: FolderRow, token: string) => {
  const cached = permissionCache.get(row.folder_id);
  if (cached && Date.now() - cached.at < PERMISSIONS_MS) {
    return cached.permissions;
  }
  const permissions = await listPermissions(env, token, row.folder_id);
  if (typeof permissions === "number") {
    if (permissions === 0 || permissions >= 500 || permissions === 429) {
      throw Object.assign(new Error("Google Drive not reachable"), { status: 503 });
    }
    // the folder is gone, or no longer the owner's to read
    await forgetFolder(env, row.folder_id);
    return null;
  }
  permissionCache.set(row.folder_id, { at: Date.now(), permissions });
  return permissions;
};

/** the caller's way into a shared folder: the owner's token and the caller's role, or the answer to give */
const enter = async (ctx: Ctx, env: FoldersEnv, row: FolderRow, session: Session) => {
  const token = await ownerAccess(env, row);
  const permissions = token ? await folderPermissions(env, row, token) : null;
  if (!token || !permissions) {
    return fail(ctx, 404, "not-shared", "This folder is not shared any more");
  }
  const role = roleFor(permissions, session.user.email);
  if (!role) {
    return fail(ctx, 403, "no-access", "This folder is not shared with you (any more)");
  }
  return { token, role };
};

const folderRow = async (env: FoldersEnv, folderId: string) =>
  (await database(env)).prepare("SELECT * FROM shared_folders WHERE folder_id = ?").bind(folderId).first<FolderRow>();

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

/** the owner's Kurviq: its Kurviq folder is shared (or not any more) */
const register = async (ctx: Ctx, env: FoldersEnv) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const { session } = who;
  const folderId = String(ctx.body.folderId ?? "");
  if (!FOLDER_ID_RE.test(folderId)) {
    return fail(ctx, 400, "bad-request", "folderId missing");
  }
  const folder = await getFile(env, session.a, folderId, "id,name,mimeType,ownedByMe,trashed,appProperties");
  if (folder.status !== 200) {
    return problemOf(folder) === "unreachable"
      ? fail(ctx, 503, "google-unreachable", "Google Drive is not reachable")
      : fail(ctx, 403, "no-access", "Not your Kurviq folder");
  }
  // only the owner's own Kurviq folder (Kurviq made it and its scenes)
  if (folder.data.mimeType !== FOLDER_MIME || folder.data.ownedByMe !== true || folder.data.appProperties?.kurviqRoot !== "1") {
    return fail(ctx, 403, "no-access", "Not your Kurviq folder");
  }
  const permissions = folder.data.trashed ? [] : await listPermissions(env, session.a, folderId);
  if (typeof permissions === "number") {
    return fail(ctx, 503, "google-unreachable", "The folder's sharing could not be read");
  }
  const members = memberKeys(permissions, session.user.email);
  if (!members.length) {
    await forgetFolder(env, folderId);
    return answer(ctx, 200, { shared: false, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
  }
  const token = await sealSceneToken(env, tokenPurpose(folderId), session.sub!, session.r, session.iat ?? 0, Date.now() + TOKEN_DAYS * 86_400_000);
  const db = await database(env);
  await db
    .prepare(
      `INSERT INTO shared_folders (folder_id, owner_sub, owner_name, folder_name, token, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(folder_id) DO UPDATE SET owner_sub = excluded.owner_sub, owner_name = excluded.owner_name,
       folder_name = excluded.folder_name, token = excluded.token, updated_at = excluded.updated_at`,
    )
    .bind(folderId, session.sub, session.user.name ?? session.user.email, String(folder.data.name ?? "Kurviq"), token, new Date().toISOString())
    .run();
  await db.prepare("DELETE FROM shared_folder_members WHERE folder_id = ?").bind(folderId).run();
  for (const member of members) {
    await db // NOSONAR S9382: a handful of rows, written one after the other
      .prepare("INSERT OR IGNORE INTO shared_folder_members (member, folder_id) VALUES (?, ?)")
      .bind(await memberHash(env, member), folderId)
      .run();
  }
  permissionCache.delete(folderId);
  ownerTokens.delete(folderId);
  return answer(ctx, 200, { shared: true, members: members.length, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

type SceneEntry = { name: string; fileId: string; modifiedTime: string | null };

/** a folder's scenes, read with the owner's access */
const folderScenes = async (env: FoldersEnv, token: string, folderId: string): Promise<SceneEntry[] | null> => {
  const scenes: SceneEntry[] = [];
  let pageToken = "";
  do {
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await driveCall( // NOSONAR S9382: each page needs the preceding page's token
      `${driveUrls(env).api}/files?q=${encodeURIComponent(listQuery(folderId))}&fields=${encodeURIComponent("nextPageToken,files(id,name,modifiedTime)")}&pageSize=1000${page}`,
      token,
    );
    if (res.status !== 200) {
      return null;
    }
    for (const file of (res.data?.files ?? []) as { id: string; name: string; modifiedTime?: string }[]) {
      if (file.name.endsWith(EXTENSION)) {
        scenes.push({ name: file.name.slice(0, -EXTENSION.length), fileId: file.id, modifiedTime: file.modifiedTime ?? null });
      }
    }
    pageToken = String(res.data?.nextPageToken ?? "");
  } while (pageToken);
  return scenes.sort((a, b) => a.name.localeCompare(b.name));
};

/** one folder for the discovery answer, or null (not for this person, or the share is over) */
const discovered = async (ctx: Ctx, env: FoldersEnv, row: FolderRow, session: Session) => {
  const way = await enter(ctx, env, row, session);
  if (way instanceof Response) {
    return null;
  }
  const scenes = await folderScenes(env, way.token, row.folder_id);
  if (!scenes) {
    return null;
  }
  return { folderId: row.folder_id, name: row.folder_name ?? "Kurviq", owner: row.owner_name ?? "Someone", role: way.role, scenes };
};

/** the folders shared with the signed-in person, with their scenes */
const discover = async (ctx: Ctx, env: FoldersEnv) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const { session } = who;
  const keys = await Promise.all(lookupKeys(session.user.email).map((key) => memberHash(env, key)));
  const db = await database(env);
  const { results = [] } = await db
    .prepare(
      `SELECT DISTINCT f.* FROM shared_folders f JOIN shared_folder_members m ON m.folder_id = f.folder_id
       WHERE m.member IN (?, ?) AND f.owner_sub != ?`,
    )
    .bind(keys[0], keys[1], session.sub)
    .all<FolderRow>();
  const folders = (await Promise.all(results.map((row) => discovered(ctx, env, row, session)))).filter(Boolean);
  return answer(ctx, 200, { folders, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

/** a file (or its revision) of the call is in the folder: asked with the owner's access */
const inFolder = async (env: FoldersEnv, token: string, call: ProxyCall, folderId: string) => {
  if (call.kind === "list") {
    return true;
  }
  const file = await getFile(env, token, call.fileId, "parents,trashed");
  if (file.status !== 200) {
    return problemOf(file) === "unreachable" ? ("unreachable" as const) : false;
  }
  return Array.isArray(file.data?.parents) && file.data.parents.includes(folderId);
};

/** one Drive call in a shared folder, made with the owner's access */
const proxy = async (ctx: Ctx, env: FoldersEnv, folderId: string) => {
  const who = await signedIn(ctx);
  if (who instanceof Response) {
    return who;
  }
  const row = await folderRow(env, folderId);
  if (!row) {
    return fail(ctx, 404, "not-shared", "This folder is not shared (any more)");
  }
  const way = await enter(ctx, env, row, who.session);
  if (way instanceof Response) {
    return way;
  }
  const call = classifyRead(folderId, String(ctx.body.method ?? "GET"), String(ctx.body.path ?? ""));
  if ("refused" in call) {
    return fail(ctx, 403, "refused", `Not allowed in a shared folder: ${call.refused}`);
  }
  const contained = await inFolder(env, way.token, call, folderId);
  if (contained === "unreachable") {
    return fail(ctx, 503, "google-unreachable", "Google Drive is not reachable");
  }
  if (!contained) {
    return answer(ctx, 200, { status: 404, text: JSON.stringify({ error: { code: 404, message: "File not found in this folder" } }) });
  }
  const media = call.kind !== "list" && call.kind !== "revisions" && call.media;
  const res = await driveCall(callUrl(driveUrls(env).api, call), way.token, media ? { timeoutMs: 60_000, maxBytes: DOWNLOAD_BYTES } : {});
  const text = !media && res.status === 200 && res.data ? JSON.stringify(asRecipient(res.data, way.role as FolderRole)) : res.text;
  return answer(ctx, 200, { status: res.status, text, role: way.role, ...(who.sealedLocal ? { session: who.sealedLocal } : {}) });
};

const dispatch = async (ctx: Ctx, env: FoldersEnv, path: string) => {
  try {
    if (path === "/folders/register") {
      return await register(ctx, env);
    }
    if (path === "/folders") {
      return await discover(ctx, env);
    }
    const folder = /^\/folders\/([^/]+)\/drive$/.exec(path);
    if (folder && FOLDER_ID_RE.test(folder[1])) {
      return await proxy(ctx, env, folder[1]);
    }
    return fail(ctx, 404, "not-found", "Not found");
  } catch (error: any) {
    if (error?.status === 503) {
      return fail(ctx, 503, "unavailable", "Try again in a moment");
    }
    throw error;
  }
};

export const handleFolderRoutes = async (request: Request, env: FoldersEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/folders" && !url.pathname.startsWith("/folders/")) {
    return null;
  }
  const origin = request.headers.get("Origin");
  const ctx: Ctx = { request, env, url, origin, local: false, body: {}, cookies: [] };
  ctx.local = isLocalOrigin(origin) && !sameSite(ctx);
  if (request.method === "OPTIONS" && ctx.local) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }
  if (request.method !== "POST") {
    return fail(ctx, 405, "method", "POST only");
  }
  if (!sameSite(ctx) && !ctx.local) {
    return fail(ctx, 403, "forbidden", "Forbidden");
  }
  if (!env.TOKEN_KEY) {
    return fail(ctx, 503, "not-configured", "Shared folders are not configured on this server");
  }
  const text = await readLimited(request.body, BODY_BYTES);
  if (text === null) {
    return fail(ctx, 413, "too-big", "Request too big");
  }
  try {
    const body = text ? JSON.parse(text) : {};
    ctx.body = body && typeof body === "object" ? body : {};
  } catch {
    ctx.body = {};
  }
  return dispatch(ctx, env, url.pathname);
};
