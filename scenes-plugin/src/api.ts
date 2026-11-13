// Shared types and settings of the scenes client. Scenes are read and written
// through their homes (./homes: Google Drive in both builds, via
// ./online/drive.ts). The local install also talks to its scenes server
// (../../scenes-server), which relays agent commands to this tab
// (agentRelay); online that is the pairing WebSocket (live.ts).

export type RemoteScene = {
  name: string;
  /** the version in Drive: MD5 of the content (Drive's md5Checksum) */
  md5: string;
  updatedAt: string | null;
  /** shared "anyone with the link" in Drive */
  public?: boolean;
  /** the scene's Google Drive file */
  fileId?: string;
};

/** a version of a scene in Drive's revisions (newest first in lists) */
export type SceneVersion = {
  /** Drive's revision id */
  driveRevision: string;
  at: string | null;
  author: string | null;
  /** made by an agent (the file's appProperties.agentRev names this revision) */
  agent: boolean;
  /** the scene's version (MD5 of its content) in that revision */
  md5?: string;
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
  /** server or Google Drive not reachable: keep working locally, retry later */
  offline?: boolean;
  remoteMd5?: string | null;
  /** rename: the target name already exists */
  exists?: boolean;
  /** not signed in with Google (or no Drive access): work locally */
  notConnected?: boolean;
  /** a shared scene that may only be viewed: nothing can be saved */
  readOnly?: boolean;
};

/** a POST to the local scenes server; nobody waits for the answer (the server may not run) */
const post = (path: string, body: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(
    () => {},
    () => {},
  );

/** this tab's state and its answers to agent commands, for the local scenes server (nothing online) */
export const agentRelay = IS_ONLINE
  ? { reportState: async () => {}, sendResult: async () => {} }
  : {
      reportState: (state: { current: string | null; dirty: boolean; visible: boolean; focusedAt: number }) =>
        post("/api/app/state", { ...state, tab: TAB_ID }),
      sendResult: (id: string, payload: { ok: boolean; result?: unknown; error?: string }) => post(`/api/app/result/${id}`, payload),
    };
