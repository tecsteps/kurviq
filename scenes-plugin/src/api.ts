// Client for the scenes backend: the local scenes git server (see
// ../../scenes-server), or — in the online build (Kurviq) — GitHub's API,
// called from the browser (./online/github.ts).

import { githubScenes } from "./online/github";

export type RemoteScene = {
  name: string;
  sha: string;
  updatedAt: string | null;
  /** online: in the space's public repository (kurviq-public) */
  public?: boolean;
};

/** a version of a scene in the git history (newest first in lists) */
export type SceneVersion = {
  commit: string;
  at: string | null;
  author: string | null;
  message: string;
  /** made by an agent (commit trailer) */
  agent: boolean;
  /** local: the scene's blob sha in that commit (online: looked up when loaded) */
  sha?: string;
};

export type RemoteInfo = {
  /** GitHub reachable at the last attempt (null = not tried yet) */
  online: boolean | null;
  lastFetchAt: string | null;
  lastError: string | null;
  /** online: GitHub lets this user read the space's repository, not change it (why) */
  readOnly?: string | null;
};

/** Kurviq: the online build (GitHub API in the browser, no scenes server) */
export const IS_ONLINE = import.meta.env.VITE_APP_SCENES_TARGET === "online";

export const BASE_URL: string = (
  import.meta.env.VITE_APP_SCENES_SERVER_URL || "http://localhost:3101"
).replace(/\/$/, "");

/** identifies this browser tab, so it can ignore its own save events */
export const TAB_ID = Math.random().toString(36).slice(2, 10);

export type ApiError = Error & {
  status: number;
  /** server or GitHub not reachable — keep working locally, retry later */
  offline?: boolean;
  remoteSha?: string | null;
  /** rename: the target name already exists */
  exists?: boolean;
  /** online: GitHub is not connected (or no repo chosen) — work locally */
  notConnected?: boolean;
  /** online: the space is read only on GitHub — nothing can be pushed */
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

const scenePath = (name: string) => `/api/scenes/${encodeURIComponent(name)}`;

const localScenesApi = {
  /** online only: move a scene to the space's public repository and back */
  setPublic: undefined as undefined | ((name: string, on: boolean) => Promise<unknown>),
  list: async (
    refresh = false,
  ): Promise<{ scenes: RemoteScene[]; remote: RemoteInfo }> =>
    (await request(`/api/scenes${refresh ? "?refresh" : ""}`)).json(),
  /** latest version, or a specific one (blob sha) */
  load: async (
    name: string,
    sha?: string,
  ): Promise<{ json: string; sha: string }> => {
    const res = await request(
      `${scenePath(name)}${sha ? `?sha=${encodeURIComponent(sha)}` : ""}`,
    );
    return { json: await res.text(), sha: res.headers.get("X-Scene-Sha") || sha || "" };
  },
  /**
   * Commit & push. baseSha = the version this content is based on ("none" for
   * a new scene) — the server answers 409 if GitHub has something else.
   */
  save: async (
    name: string,
    json: string,
    baseSha: string,
    /** who saves: this tab (default) or "agent" (the agent's headless tab) */
    source = `app:${TAB_ID}`,
  ): Promise<{ sha: string; commit: string | null; changed: boolean }> =>
    (
      await request(scenePath(name), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Scenes-Source": source,
          "X-Scenes-Client": "app",
          "X-Base-Sha": baseSha,
        },
        body: json,
      })
    ).json(),
  /** delete on GitHub; baseSha: only if GitHub still has that version (else 409) */
  remove: async (name: string, baseSha?: string | null) =>
    (
      await request(scenePath(name), {
        method: "DELETE",
        headers: {
          "X-Scenes-Source": `app:${TAB_ID}`,
          "X-Scenes-Client": "app",
          ...(baseSha ? { "X-Base-Sha": baseSha } : {}),
        },
      })
    ).json(),
  /** rename on GitHub (one commit, content unchanged, so the blob sha stays) */
  rename: async (from: string, to: string): Promise<{ sha: string; commit: string | null }> =>
    (
      await request(`${scenePath(from)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": `app:${TAB_ID}`, "X-Scenes-Client": "app" },
        body: JSON.stringify({ to }),
      })
    ).json(),
  /** the scene's versions, newest first */
  history: async (name: string): Promise<SceneVersion[]> =>
    (await (await request(`${scenePath(name)}/history`)).json()).versions,
  /** the scene as it was in one of those versions */
  loadVersion: (name: string, version: SceneVersion) => localScenesApi.load(name, version.sha),
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

/** online: the same calls against GitHub; the live channel is a WebSocket (live.ts) */
const onlineScenesApi: typeof localScenesApi = {
  list: githubScenes.list,
  load: githubScenes.load,
  save: (name, json, baseSha, source = `app:${TAB_ID}`) => githubScenes.save(name, json, baseSha, source),
  remove: githubScenes.remove,
  rename: githubScenes.rename,
  setPublic: githubScenes.setPublic,
  history: githubScenes.history,
  loadVersion: (name, version) => githubScenes.loadAt(name, version.commit),
  reportState: async () => {},
  sendResult: async () => {},
};

export const scenesApi = IS_ONLINE ? onlineScenesApi : localScenesApi;
