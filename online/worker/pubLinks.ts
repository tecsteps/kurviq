// Short links: kurviq.com/pub/<name> → a scene's Google Drive file. An
// addition to /s/<fileId>/<name> (./shared.ts), which keeps working; most
// scenes have none. Names are global, first come first served, one per file
// (rules: scenes-plugin/src/online/pubName.ts). Stored in D1 (binding
// FEEDBACK, table pub_links): the name, the file id, when. Nothing about who.
//
//   GET    /api/pub/<name>        { fileId } (404: no such short link)
//   GET    /api/pub?file=<fileId> { name } (null: none)
//   POST   /api/pub               { fileId, name }: give the file this name (its old one is freed)
//   DELETE /api/pub/<name>        free the name
//
// Changes need the person's Google access token (Authorization: Bearer, the
// one the app already has): Drive must say they can edit the file. The token
// is used for that one question and not kept.
//
// /pub/<name> itself is the app page (./shared.ts handleSharedPage).

import { PUB_MAX, pubNameProblem } from "../../scenes-plugin/src/online/pubName";

import { isLocalOrigin } from "./auth";
import { getFile, problemOf } from "./driveApi";
import type { GoogleEnv } from "./google";

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};
type D1 = { prepare: (sql: string) => D1Statement; batch: (statements: D1Statement[]) => Promise<unknown> };

export type PubEnv = GoogleEnv & { FEEDBACK?: D1 };

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS pub_links (
  name TEXT PRIMARY KEY,
  file_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`;

let schemaReady = false;

const database = async (env: PubEnv) => {
  const db = env.FEEDBACK;
  if (db && !schemaReady) {
    await db.prepare(SCHEMA).bind().run();
    schemaReady = true;
  }
  return db ?? null;
};

/** the file a short name stands for, or null */
export const pubFile = async (env: PubEnv, name: string): Promise<string | null> => {
  if (name.length > PUB_MAX || !/^[a-z0-9-]+$/.test(name)) {
    return null;
  }
  const db = await database(env);
  const row = db && (await db.prepare("SELECT file_id FROM pub_links WHERE name = ?").bind(name).first<{ file_id: string }>());
  return row?.file_id ?? null;
};

/** may this token's owner edit the file? "unreachable": Google did not answer */
const canEdit = async (env: PubEnv, token: string, fileId: string): Promise<true | "signed-out" | "no-access" | "unreachable"> => {
  const file = await getFile(env, token, fileId, "id,trashed,capabilities(canEdit)");
  if (file.status === 200) {
    return file.data?.capabilities?.canEdit && !file.data.trashed ? true : "no-access";
  }
  const problem = problemOf(file);
  return problem === "unreachable" ? "unreachable" : problem === "token" ? "signed-out" : "no-access";
};

export const handlePubApi = async (request: Request, env: PubEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/pub(?:\/([^/]+))?\/?$/);
  if (!match) {
    return null;
  }
  const origin = request.headers.get("Origin");
  // Kurviq's pages, and the local install (it signs in through kurviq.com)
  const trusted = !origin || origin === url.origin || isLocalOrigin(origin) || (!!env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (origin && origin !== url.origin && trusted) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
  }
  const db = await database(env);
  if (!db) {
    return json(503, { error: "Short links are not available here" });
  }
  const name = match[1] ? decodeURIComponent(match[1]).toLowerCase() : null;

  if (request.method === "GET") {
    if (name) {
      const fileId = await pubFile(env, name);
      return fileId ? json(200, { fileId }) : json(404, { error: "No such short link" });
    }
    const fileId = url.searchParams.get("file") ?? "";
    if (!FILE_ID_RE.test(fileId)) {
      return json(400, { error: "file: a Drive file id" });
    }
    const row = await db.prepare("SELECT name FROM pub_links WHERE file_id = ?").bind(fileId).first<{ name: string }>();
    return json(200, { name: row?.name ?? null });
  }

  // changes: only from Kurviq's pages, with the person's Google access token
  if (!trusted || !origin) {
    return json(403, { error: "Forbidden" });
  }
  const token = (request.headers.get("Authorization") ?? "").match(/^Bearer (\S{10,4096})$/)?.[1];
  if (!token) {
    return json(401, { error: "Sign in with Google to make a short link", code: "signed-out" });
  }
  const refuse = (verdict: Exclude<Awaited<ReturnType<typeof canEdit>>, true>) =>
    verdict === "unreachable"
      ? json(503, { error: "Google is not reachable: try again in a moment" })
      : verdict === "signed-out"
        ? json(401, { error: "Your sign-in has expired: sign in again", code: "signed-out" })
        : json(403, { error: "Only someone who can edit this scene can change its short link" });

  if (request.method === "POST" && !name) {
    const text = await request.text();
    if (text.length > 2000) {
      return json(413, { error: "Too long" });
    }
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const fileId = String(body?.fileId ?? "");
    const wanted = String(body?.name ?? "");
    if (!FILE_ID_RE.test(fileId)) {
      return json(400, { error: "fileId: a Drive file id" });
    }
    const problem = pubNameProblem(wanted);
    if (problem) {
      return json(400, { error: problem, code: "invalid" });
    }
    const holder = await db.prepare("SELECT file_id FROM pub_links WHERE name = ?").bind(wanted).first<{ file_id: string }>();
    if (holder && holder.file_id !== fileId) {
      return json(409, { error: `kurviq.com/pub/${wanted} is already taken`, code: "taken" });
    }
    if (holder) {
      return json(200, { name: wanted });
    }
    const verdict = await canEdit(env, token, fileId);
    if (verdict !== true) {
      return refuse(verdict);
    }
    try {
      // one name per file: its old one is freed in the same step
      await db.batch([
        db.prepare("DELETE FROM pub_links WHERE file_id = ?").bind(fileId),
        db.prepare("INSERT INTO pub_links (name, file_id, created_at) VALUES (?, ?, ?)").bind(wanted, fileId, new Date().toISOString()),
      ]);
    } catch {
      // someone else took it a moment ago (the name is the primary key)
      return json(409, { error: `kurviq.com/pub/${wanted} is already taken`, code: "taken" });
    }
    return json(200, { name: wanted });
  }

  if (request.method === "DELETE" && name) {
    const fileId = await pubFile(env, name);
    if (!fileId) {
      return json(200, { name: null });
    }
    const verdict = await canEdit(env, token, fileId);
    if (verdict !== true) {
      return refuse(verdict);
    }
    await db.prepare("DELETE FROM pub_links WHERE name = ? AND file_id = ?").bind(name, fileId).run();
    return json(200, { name: null });
  }
  return json(405, { error: "Not allowed" });
};
