// Client for the scenes backend: Google Drive, called from the browser
// (./online/drive.ts), in both builds. The local install also talks to its
// scenes server (../../scenes-server), which relays agent commands to this
// tab; online that is the pairing WebSocket (live.ts).

import { driveScenes } from "./online/drive";

export type RemoteScene = {
  name: string;
  sha: string;
  updatedAt: string | null;
  /** shared "anyone with the link" in Drive */
  public?: boolean;
  /** the scene's Google Drive file */
  fileId?: string;
  /** saves through its Durable Object (appProperties.kurviqSync): never written directly */
  live?: boolean;
};

/** a version of a scene in Drive's revisions (newest first in lists) */
export type SceneVersion = {
  commit: string;
  at: string | null;
  author: string | null;
  message: string;
  /** made by an agent (commit trailer) */
  agent: boolean;
  /** the scene's version (MD5 of its content) in that revision */
  sha?: string;
};

export type RemoteInfo = {
  /** Google Drive reachable at the last attempt (null = not tried yet) */
  online: boolean | null;
  lastFetchAt: string | null;
  lastError: string | null;
  /** a shared scene Drive lets this user read, not change (why) */
  readOnly?: string | null;
};

/** Kurviq: the online build (kurviq.com, no scenes server) */
export const IS_ONLINE = import.meta.env.VITE_APP_SCENES_TARGET === "online";

export const BASE_URL: string = (
  import.meta.env.VITE_APP_SCENES_SERVER_URL || "http://localhost:3101"
).replace(/\/$/, "");

/** identifies this browser tab, so it can ignore its own save events */
export const TAB_ID = Math.random().toString(36).slice(2, 10);

export type ApiError = Error & {
  status: number;
  /** server or Google Drive not reachable — keep working locally, retry later */
  offline?: boolean;
  remoteSha?: string | null;
  /** rename: the target name already exists */
  exists?: boolean;
  /** not signed in with Google (or no Drive access) — work locally */
  notConnected?: boolean;
  /** a shared scene that may only be viewed — nothing can be saved */
  readOnly?: boolean;
};

const request = async (path: string, init?: RequestInit) => {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch {
    throw Object.assign(
      new Error(`Scenes server not reachable at ${BASE_URL}`),
      { status: 0, offline: true },
    ) as ApiError;
  }
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {}
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), {
      status: res.status,
      offline: res.status === 503 || !!body.offline,
      remoteSha: body.remoteSha,
      exists: !!body.exists,
    }) as ApiError;
  }
  return res;
};

/** this tab's state and its answers to agent commands, for the local scenes server */
const localRelay = {
  reportState: (state: {
    current: string | null;
    dirty: boolean;
    visible: boolean;
    focusedAt: number;
  }) =>
    request("/api/app/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state, tab: TAB_ID }),
    }).catch(() => {}),
  sendResult: (
    id: string,
    payload: { ok: boolean; result?: unknown; error?: string },
  ) =>
    request(`/api/app/result/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {}),
};

export const scenesApi = {
  list: driveScenes.list,
  /** latest version, or a specific one (its MD5) */
  load: driveScenes.load,
  /**
   * Save to Drive. baseSha = the version this content is based on ("none"
   * for a new scene) — 409 if Drive has something else.
   */
  save: (name: string, json: string, baseSha: string, source = `app:${TAB_ID}`) => driveScenes.save(name, json, baseSha, source),
  /** delete in Drive; baseSha: only if Drive still has that version (else 409) */
  remove: driveScenes.remove,
  /** rename in Drive (content unchanged, so the version stays) */
  rename: driveScenes.rename,
  /** the scene's versions, newest first */
  history: driveScenes.history,
  /** the scene as it was in one of those versions */
  loadVersion: (name: string, version: SceneVersion) => driveScenes.loadAt(name, version.commit),
  ...(IS_ONLINE ? { reportState: async () => {}, sendResult: async () => {} } : localRelay),
};
