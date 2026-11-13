// Google Drive calls of the Worker (the relay's ticket route, the drain of the
// retired live sync's scene objects, the public scenes' names), with the
// user's own access token.
//
// Every answer is sorted into what it means for saving: a refusal (the
// author can't be saved as), Drive full or rate-limited (wait, it is not the
// author's fault), or Google not reachable (5xx, timeouts: retry). Only
// refusals ever end someone's access or block an author.

import { readText } from "./bytes";
import { googleUrls } from "./google";
import type { GoogleEnv } from "./google";

export type DriveAnswer = { status: number; data: any; text: string };

export type DriveProblem = "unreachable" | "rate-limited" | "drive-full" | "token" | "access" | "not-picked" | "other";

/** a Drive request may take this long (shorter than the key-creation lease) */
const TIMEOUT_MS = 20_000;
/** answers are read at most this big (metadata, listings); downloads have their own limit */
const ANSWER_BYTES = 4 * 1024 * 1024;
/** a scene file downloaded from Drive (an outside file bigger than this is not imported): LIMITS.sceneBytes + room */
export const DOWNLOAD_BYTES = 34 * 1024 * 1024;

/** a body read up to `max` bytes as text; null: too big (the shared reader, ./bytes.ts) */
export { readText as readLimited } from "./bytes";

/** a Drive file id (also the ids of scenes, short links and shared folders) */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/** a scene file: its MIME type and name extension in Drive */
export const SCENE_MIME = "application/vnd.excalidraw+json";
export const SCENE_EXTENSION = ".excalidraw";

/**
 * A multipart/related body (Drive's multipart upload): the metadata as JSON,
 * then the content. Returns the body and its Content-Type.
 */
export const multipartBody = (metadata: unknown, content: Uint8Array, contentType = SCENE_MIME) => {
  const boundary = `kurviq${crypto.randomUUID().replaceAll("-", "")}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + content.length + tail.length);
  body.set(head);
  body.set(content, head.length);
  body.set(tail, head.length + content.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
};

export const driveUrls = (env: GoogleEnv) => googleUrls(env, env.DEV_ORIGIN);

/** dev cost measurement only (scene.ts sets it on its env when the dev gate is on): each call's kind and wait */
type DriveObserver = (kind: string, ms: number) => void;
const observerOf = (env: GoogleEnv) => (env as { observeDrive?: DriveObserver }).observeDrive;

/** a call's kind for the cost counters: method + the path's shape (ids left out) */
const kindOf = (method: string, url: string) => {
  const path = new URL(url).pathname.replace(/^.*?\/(upload\/drive|drive)\/v3/, (_, base) => (base === "drive" ? "" : "upload "));
  return `${method} ${path.replace(/\/files\/[^/]+/, "/files/:id").replace(/\/revisions\/[^/]+/, "/revisions/:rev")}${url.includes("alt=media") ? " media" : ""}`;
};

/** a Drive API call; status 0: no answer (network, timeout) */
export const driveCall = async (
  url: string,
  token: string,
  init: { method?: string; json?: unknown; body?: BodyInit; contentType?: string; timeoutMs?: number; observe?: DriveObserver; maxBytes?: number } = {},
): Promise<DriveAnswer> => {
  const started = Date.now();
  try {
    return await driveFetch(url, token, init);
  } finally {
    init.observe?.(kindOf(init.method || "GET", url), Date.now() - started);
  }
};

const driveFetch = async (
  url: string,
  token: string,
  init: { method?: string; json?: unknown; body?: BodyInit; contentType?: string; timeoutMs?: number; maxBytes?: number },
): Promise<DriveAnswer> => {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.contentType) {
    headers["Content-Type"] = init.contentType;
  }
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    });
    const text = await readText(res.body, init.maxBytes ?? ANSWER_BYTES);
    if (text === null) {
      // bigger than allowed: not read (status 413, so callers can tell it from a refusal)
      return { status: 413, data: null, text: "" };
    }
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data, text };
  } catch {
    return { status: 0, data: null, text: "" };
  }
};

/** what a failed answer means (Google's error reasons tell quota from permissions) */
export const problemOf = (answer: DriveAnswer): DriveProblem => {
  const { status } = answer;
  const reason = String(answer.data?.error?.errors?.[0]?.reason ?? answer.data?.error?.status ?? "");
  if (status === 0 || status >= 500) {
    return "unreachable";
  }
  if (status === 429 || /rateLimit|RateLimit/.test(reason)) {
    return "rate-limited";
  }
  if (/storageQuotaExceeded|quotaExceeded/.test(reason)) {
    return "drive-full";
  }
  if (status === 401) {
    return "token";
  }
  if (status === 403) {
    return "access";
  }
  if (status === 404) {
    return "not-picked";
  }
  return "other";
};

/** problems that pass by themselves: retried, never anyone's fault */
export const isTransient = (problem: DriveProblem) =>
  problem === "unreachable" || problem === "rate-limited" || problem === "drive-full";

const FILE_FIELDS = "id,name,trashed,headRevisionId,md5Checksum,capabilities(canEdit),appProperties";

export const getFile = (env: GoogleEnv, token: string, fileId: string, fields = FILE_FIELDS) =>
  driveCall(`${driveUrls(env).api}/files/${fileId}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, token, { observe: observerOf(env) });

export const patchFile = (env: GoogleEnv, token: string, fileId: string, metadata: unknown) =>
  driveCall(`${driveUrls(env).api}/files/${fileId}?fields=id&supportsAllDrives=true`, token, { method: "PATCH", json: metadata, observe: observerOf(env) });

export const downloadFile = (env: GoogleEnv, token: string, fileId: string, revision?: string) =>
  driveCall(
    revision
      ? `${driveUrls(env).api}/files/${fileId}/revisions/${revision}?alt=media`
      : `${driveUrls(env).api}/files/${fileId}?alt=media&supportsAllDrives=true`,
    token,
    { timeoutMs: 60_000, observe: observerOf(env), maxBytes: DOWNLOAD_BYTES },
  );

export type Revision = { id: string; md5Checksum?: string; keepForever?: boolean; modifiedTime?: string };

/** all revisions, oldest first; Drive's answer instead when it did not answer or refused */
export const listRevisions = async (env: GoogleEnv, token: string, fileId: string): Promise<Revision[] | DriveAnswer> => {
  const all: Revision[] = [];
  let pageToken = "";
  do {
    const answer = await driveCall(
      `${driveUrls(env).api}/files/${fileId}/revisions?fields=nextPageToken,revisions(id,md5Checksum,keepForever,modifiedTime)&pageSize=200${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
      token,
      { observe: observerOf(env) },
    );
    if (answer.status !== 200) {
      return answer;
    }
    all.push(...(answer.data?.revisions || []));
    pageToken = answer.data?.nextPageToken || "";
  } while (pageToken);
  return all;
};

/** a new version of the file: content and metadata (appProperties, name) in one multipart PATCH */
export const uploadVersion = (env: GoogleEnv, token: string, fileId: string, metadata: unknown, content: Uint8Array) => {
  const { body, contentType } = multipartBody(metadata, content);
  return driveCall(
    `${driveUrls(env).upload}/files/${fileId}?uploadType=multipart&fields=id,name,headRevisionId,md5Checksum&supportsAllDrives=true`,
    token,
    { method: "PATCH", body, contentType, timeoutMs: 90_000, observe: observerOf(env) },
  );
};
