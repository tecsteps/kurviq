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
// is used for that one question and not kept. A name whose file is in the
// bin can still be freed by the file's owner (else it would be lost for good).
//
// /pub/<name> itself is the app page (./shared.ts handleSharedPage).

import { PUB_MAX, pubNameProblem } from "../../scenes-plugin/src/online/pubName";

import { isLocalInstall } from "./auth";
import { readJson } from "./bytes";
import { database } from "./database";
import type { D1 } from "./database";
import { FILE_ID_RE, getFile, problemOf } from "./driveApi";
import type { GoogleEnv } from "./google";

export type PubEnv = GoogleEnv & { FEEDBACK?: D1 };

/** a claim's body: a file id and a name (a few hundred bytes) */
const MAX_BODY = 2000;

/** the file a short name stands for, or null */
export const pubFile = async (env: PubEnv, name: string): Promise<string | null> => {
  if (name.length > PUB_MAX || !/^[a-z0-9-]+$/.test(name)) {
    return null;
  }
  const db = await database(env.FEEDBACK);
  const row = db && (await db.prepare("SELECT file_id FROM pub_links WHERE name = ?").bind(name).first<{ file_id: string }>());
  return row?.file_id ?? null;
};

type Verdict = true | "signed-out" | "no-access" | "unreachable";

/**
 * May this token's owner change the file's short link? To claim one: edit the
 * file, which is not in the bin. To free one: edit it, or own it (in the bin
 * too). "unreachable": Google did not answer.
 */
const mayChange = async (env: PubEnv, token: string, fileId: string, change: "claim" | "free"): Promise<Verdict> => {
  const file = await getFile(env, token, fileId, "id,trashed,ownedByMe,capabilities(canEdit)");
  if (file.status === 200) {
    const canEdit = !!file.data?.capabilities?.canEdit;
    const allowed = change === "claim" ? canEdit && !file.data.trashed : canEdit || !!file.data?.ownedByMe;
    return allowed ? true : "no-access";
  }
  const problem = problemOf(file);
  if (problem === "unreachable" || problem === "rate-limited") {
    return "unreachable";
  }
  return problem === "token" ? "signed-out" : "no-access";
};

const readPubLink = async (name: string | null, url: URL, db: D1, env: PubEnv, json: PubJson) => {
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
};

const claimPubLink = async (request: Request, env: PubEnv, db: D1, token: string, json: PubJson, refuse: PubRefuse) => {
  const read = await readJson(request, MAX_BODY);
  if (read === "too-big") {
    return json(413, { error: "Too long" });
  }
  const body: any = read === "invalid" ? null : read.value;
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
  const verdict = await mayChange(env, token, fileId, "claim");
  if (verdict !== true) {
    return refuse(verdict);
  }
  if (holder) {
    return json(200, { name: wanted });
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
};

type PubJson = (status: number, body: unknown) => Response;
type PubRefuse = (verdict: Exclude<Verdict, true>) => Response;

const pubHeaders = (request: Request, env: PubEnv, url: URL) => {
  const origin = request.headers.get("Origin");
  // Kurviq's pages, and the local install (it signs in through kurviq.com)
  const trusted = !origin || origin === url.origin || isLocalInstall(origin) || (!!env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (origin && origin !== url.origin && trusted) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return { origin, trusted, headers };
};

const deletePubLink = async (name: string, env: PubEnv, db: D1, token: string, json: PubJson, refuse: PubRefuse) => {
  const fileId = await pubFile(env, name);
  if (!fileId) {
    return json(200, { name: null });
  }
  const verdict = await mayChange(env, token, fileId, "free");
  if (verdict !== true) {
    return refuse(verdict);
  }
  await db.prepare("DELETE FROM pub_links WHERE name = ? AND file_id = ?").bind(name, fileId).run();
  return json(200, { name: null });
};

export const handlePubApi = async (request: Request, env: PubEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = /^\/api\/pub(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  const { origin, trusted, headers } = pubHeaders(request, env, url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
  }
  const db = await database(env.FEEDBACK);
  if (!db) {
    return json(503, { error: "Short links are not available here" });
  }
  let name: string | null = null;
  try {
    name = match[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch {
    // malformed percent-encoding (%zz): no name a link could have
    return json(400, { error: "Not a short link name" });
  }

  if (request.method === "GET") {
    return readPubLink(name, url, db, env, json);
  }

  // changes: only from Kurviq's pages, with the person's Google access token
  if (!trusted || !origin) {
    return json(403, { error: "Forbidden" });
  }
  const token = /^Bearer (\S{10,4096})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) {
    return json(401, { error: "Sign in with Google to make a short link", code: "signed-out" });
  }
  const refuse = (verdict: Exclude<Verdict, true>) => {
    if (verdict === "unreachable") {
      return json(503, { error: "Google is not reachable: try again in a moment" });
    }
    if (verdict === "signed-out") {
      return json(401, { error: "Your sign-in has expired: sign in again", code: "signed-out" });
    }
    return json(403, { error: "Only someone who can edit this scene can change its short link" });
  };

  if (request.method === "POST" && !name) {
    return claimPubLink(request, env, db, token, json, refuse);
  }

  if (request.method === "DELETE" && name) {
    return deletePubLink(name, env, db, token, json, refuse);
  }
  return json(405, { error: "Not allowed" });
};
