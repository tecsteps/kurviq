// Kurviq: the scenes server's job, done in the browser with the Google Drive
// API: list, load, save, rename and delete scenes in the user's Drive, with
// the same rules (a save must be based on the version Drive has, agent edits
// are marked).
//
// Each scene is one file `<name>.excalidraw` in the folder "Kurviq" of the
// user's Drive. Kurviq only has Drive's `drive.file` access: it sees the
// files it created and the ones the user opened with it (Google's Picker,
// or "Open with Kurviq" in Drive), nothing else. A scene's version is the
// MD5 of its content (Drive's md5Checksum), so it is known without asking.
//
// Drive is the only source of truth for who may do what: a scene someone
// shared is opened in a space of its own ("f:<fileId>", see ../storage.ts),
// editable if Drive says so (capabilities.canEdit). Kurviq stores no users
// or permissions.
//
// The browser never sees a long-lived Google credential: the Worker keeps
// the refresh token in an encrypted httpOnly cookie and hands out the
// short-lived access token (1 h) on request (see online/worker/auth.ts). The
// local install signs in through kurviq.com and keeps the sealed session.

import { createStore, del, get, set } from "idb-keyval";

import { isSceneName } from "../../../scenes-mcp/sceneName.mjs";
import { accountKey, spaceAccountOf } from "../spaces";
import { currentSpace, SPACE_KEY } from "../storage";

import google from "../../../online/google.json";

import { LIVE_MARKER } from "./liveProtocol";
import { md5 } from "./md5";

import type { ApiError, RemoteInfo, RemoteScene, SceneVersion } from "../api";

/** Google's Drive API; a dev build for the fake Google (online/worker/fakeGoogle.ts) sets VITE_APP_GOOGLE_API_BASE */
const GOOGLE_BASE = (import.meta.env.VITE_APP_GOOGLE_API_BASE || "").replace(/\/$/, "");
export const API = GOOGLE_BASE ? `${GOOGLE_BASE}/drive/v3` : "https://www.googleapis.com/drive/v3";
const UPLOAD = GOOGLE_BASE ? `${GOOGLE_BASE}/upload/drive/v3` : "https://www.googleapis.com/upload/drive/v3";
export const SCENE_MIME = "application/vnd.excalidraw+json";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const EXTENSION = ".excalidraw";
export const FOLDER_NAME = "Kurviq";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,headRevisionId,permissionIds,capabilities(canEdit,canShare),appProperties,owners(displayName,emailAddress),ownedByMe";

/** where sign-in lives: this site (online), or kurviq.com (the local install) */
const AUTH_BASE = (import.meta.env.VITE_APP_KURVIQ_AUTH_URL || "").replace(/\/$/, "");
const IS_LOCAL_INSTALL = AUTH_BASE !== "";

/** the space of a scene someone shared: "f:<fileId>" (see ../storage.ts) */
export const fileSpace = (fileId: string) => `f:${fileId}`;
export const sharedFileId = currentSpace.startsWith("f:") ? currentSpace.slice(2) : null;
/**
 * The space of a folder someone shared ("d:<folderId>"): Kurviq can't reach
 * its files with this person's own Drive access (drive.file), so every Drive
 * call goes through Kurviq's server, made with the owner's sign-in
 * (online/worker/folders.ts): reads for everyone it is shared with, Kurviq's
 * own writes for those who may edit.
 */
export const folderSpace = (folderId: string) => `d:${folderId}`;
export const sharedFolderId = currentSpace.startsWith("d:") ? currentSpace.slice(2) : null;

// -----------------------------------------------------------------------------
// connection: who is signed in (cookie, via the Worker)
// -----------------------------------------------------------------------------

/** sub: Google's stable account id (live sync keys its queues by it; older Workers don't send it) */
export type GoogleUser = { email: string; name: string | null; avatarUrl: string | null; sub?: string };

export type ConnectionState = {
  /** null = not signed in, undefined = not checked yet */
  user: GoogleUser | null | undefined;
  /** the user allowed Kurviq's Drive access (Google lets them untick it) */
  drive: boolean;
  /** last token / API problem, if any */
  error: string | null;
  /** a shared scene's space whose file can't be reached (any more): why */
  lost?: string | null;
  /** a shared scene's space: Kurviq may not read the file yet (the Picker grants it) */
  needsAccess?: boolean;
};

let state: ConnectionState = { user: undefined, drive: false, error: null };
const listeners = new Set<() => void>();

const setConnection = (patch: Partial<ConnectionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

/** the account this tab's own scenes belong to (null: the scenes made signed out, or a shared scene's space) */
export const spaceAccount = spaceAccountOf(currentSpace);

/**
 * Signed in with another account than the one this tab's scenes belong to
 * (or signed in while the tab shows the signed-out scenes): nothing may sync,
 * those scenes are not this account's. The tab moves to the account's own
 * space (online/ui.tsx). A shared scene's space works with any account.
 */
export const otherAccount = () => !sharedFileId && !sharedFolderId && !!state.user && accountKey(state.user.email) !== spaceAccount;

export const connection = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: () => state,
  /** signed in with Drive access: scenes sync */
  isActive: () => !!state.user && state.drive && !state.lost && !state.needsAccess && !otherAccount(),
};

// the local install's sealed session (kurviq.com can't set it a cookie here)
const LOCAL_SESSION_KEY = "kurviq-google-session";

const localSession = () => {
  try {
    return localStorage.getItem(LOCAL_SESSION_KEY);
  } catch {
    return null;
  }
};

/** the local install's sign-in: the state it sent along (sessionStorage), to recognise its answer */
const LOCAL_STATE_KEY = "kurviq-google-state";

/** the local install, back from signing in: #kurviq-google=connected&kurviq-state=…&session=… */
const takeLocalSession = () => {
  if (!IS_LOCAL_INSTALL || !window.location.hash.includes("kurviq-google=")) {
    return;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const session = params.get("session");
  // only the answer to this browser tab's own sign-in counts (its state): a link carrying someone
  // else's session (login CSRF) is dropped
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(LOCAL_STATE_KEY);
    sessionStorage.removeItem(LOCAL_STATE_KEY);
  } catch {}
  const ours = !!expected && params.get("kurviq-state") === expected;
  try {
    if (session && ours) {
      localStorage.setItem(LOCAL_SESSION_KEY, session); // NOSONAR S8475: sign-in state is verified above; the server authenticates the sealed session
    }
  } catch {}
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("google", ours ? params.get("kurviq-google") || "failed" : "failed");
  window.history.replaceState(window.history.state, "", url.toString());
};
takeLocalSession();

let token: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string | null> | null = null;

const clearLocalSession = () => {
  if (IS_LOCAL_INSTALL) {
    try {
      localStorage.removeItem(LOCAL_SESSION_KEY);
    } catch {}
  }
};

const requestToken = async (): Promise<string | null> => {
  const session = IS_LOCAL_INSTALL ? localSession() : null;
  if (IS_LOCAL_INSTALL && !session) {
    token = null;
    setConnection({ user: null, drive: false });
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/auth/token`, {
      method: "POST",
      credentials: IS_LOCAL_INSTALL ? "omit" : "same-origin",
      ...(session ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session }) } : {}),
    });
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
  if (!res.ok) {
    throw offlineError(res.status === 503 ? "Google not reachable" : `Kurviq server error (${res.status})`);
  }
  const body = await res.json();
  if (body.connected === false) {
    token = null;
    clearLocalSession();
    setConnection({ user: null, drive: false });
    return null;
  }
  if (body.session) {
    try {
      localStorage.setItem(LOCAL_SESSION_KEY, body.session);
    } catch {}
  }
  token = { value: body.token, expiresAt: Date.parse(body.expiresAt) };
  if (state.user?.email !== body.user?.email || state.drive !== !!body.drive) {
    setConnection({ user: body.user, drive: !!body.drive, error: null });
  }
  return token.value;
};

/** the current access token, refreshed when it is about to expire */
export const getToken = async (): Promise<string | null> => {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) {
    return token.value;
  }
  tokenRequest ??= (
    navigator.locks
      ? (navigator.locks.request("kurviq-google-token", requestToken) as unknown as Promise<string | null>)
      : requestToken()
  ).finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
};

/** find out whether this browser is signed in (on start) */
export const checkConnection = async () => {
  try {
    await getToken();
  } catch (error: any) {
    setConnection({ error: error.message });
  }
  return state;
};

/** this tab went to Google to sign in (sessionStorage) */
export const CONNECTING_KEY = "kurviq-connecting";

/**
 * Sign in with Google (full page redirect, back to this page afterwards).
 * consent: ask Google to show the consent screen again (e.g. the Drive
 * access was unticked the first time).
 */
export const connectGoogle = ({ consent = false }: { consent?: boolean } = {}) => {
  const back = IS_LOCAL_INSTALL ? window.location.href.split("#")[0] : window.location.pathname + window.location.search;
  try {
    // the answer (?google=connected) only counts in the tab that asked
    sessionStorage.setItem(CONNECTING_KEY, String(Date.now()));
  } catch {}
  let state = "";
  if (IS_LOCAL_INSTALL) {
    // a random state the answer has to carry back (16-128 of A-Za-z0-9_-)
    state = [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[byte % 64]).join("");
    try {
      sessionStorage.setItem(LOCAL_STATE_KEY, state);
    } catch {}
  }
  const stateQuery = state ? `&state=${state}` : "";
  window.location.href = `${AUTH_BASE}/auth/login?return=${encodeURIComponent(back)}${stateQuery}${consent ? "&consent=1" : ""}`;
};

/** the other tabs of this browser hear about a sign-out */
const tabsChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kurviq-google") : null;

/** signed out on purpose (this tab or another one): live sync closes its connections */
export const signOutListeners = new Set<() => void>();

const forgetConnection = () => {
  token = null;
  forgetListing();
  setConnection({ user: null, drive: false });
  signOutListeners.forEach((listener) => listener()); // NOSONAR S4158: exported set populated by live-sync subscribers
};
tabsChannel?.addEventListener("message", (event) => {
  if (event.data === "disconnected") {
    forgetConnection();
  } else if (event.data === "signed-in") {
    recheckConnection().catch(() => {});
  }
});

/** ask again who is signed in (another tab may have signed in with another account) */
export const recheckConnection = () => {
  token = null;
  return checkConnection();
};

/** this tab just signed in: the other tabs check which account it is */
export const announceSignIn = () => tabsChannel?.postMessage("signed-in");

export const disconnectGoogle = async () => {
  const session = IS_LOCAL_INSTALL ? localSession() : null;
  const logout = () =>
    fetch(`${AUTH_BASE}/auth/logout`, {
      method: "POST",
      credentials: IS_LOCAL_INSTALL ? "omit" : "same-origin",
      ...(session ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session }) } : {}),
    }).catch(() => {});
  await (navigator.locks ? navigator.locks.request("kurviq-google-token", logout) : logout());
  if (IS_LOCAL_INSTALL) {
    try {
      localStorage.removeItem(LOCAL_SESSION_KEY);
    } catch {}
  }
  forgetConnection();
  tabsChannel?.postMessage("disconnected");
};

/**
 * A POST to Kurviq's Worker with this browser's sign-in: the cookie, or the
 * local install's sealed session in the body (never in a URL). Live sync's
 * tickets, access-proof renewals and reconcile tokens use it.
 */
export const authPost = async (path: string, body: Record<string, unknown> = {}) => {
  const session = IS_LOCAL_INSTALL ? localSession() : null;
  if (IS_LOCAL_INSTALL && !session) {
    throw notConnectedError();
  }
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      credentials: IS_LOCAL_INSTALL ? "omit" : "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session ? { ...body, session } : body),
    });
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
  const answer = await res.json().catch(() => ({}));
  if (IS_LOCAL_INSTALL && typeof answer.session === "string") {
    // the local install's sealed session, renewed on use
    try {
      localStorage.setItem(LOCAL_SESSION_KEY, answer.session);
    } catch {}
  }
  if (!res.ok) {
    const error = Object.assign(new Error(answer.error || `Kurviq server error (${res.status})`), {
      status: res.status,
      code: answer.code,
      offline: res.status === 503 || res.status >= 500,
    }) as ApiError & { code?: string };
    throw error;
  }
  return answer;
};

/** the WebSocket of a scene's Durable Object (on kurviq.com also for the local install) */
export const liveSocketUrl = (fileId: string, ticket: string) => {
  const base = IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin;
  return `${base.replace(/^http/, "ws")}/scene/${encodeURIComponent(fileId)}/live?ticket=${encodeURIComponent(ticket)}`;
};

// -----------------------------------------------------------------------------
// REST helper
// -----------------------------------------------------------------------------

const offlineError = (message: string) =>
  Object.assign(new Error(message), { status: 0, offline: true }) as ApiError;

const httpError = (status: number, message: string, extra: Partial<ApiError> = {}) =>
  Object.assign(new Error(message), { status, ...extra }) as ApiError;

export const notConnectedError = () =>
  Object.assign(new Error("Google Drive is not connected"), {
    status: 0,
    offline: true,
    notConnected: true,
  }) as ApiError;

type DriveResponse = { status: number; data: any; text: string };

const checkDriveResponse = (res: Response, data: any) => {
  if (res.status === 401) {
    setConnection({ user: null, drive: false });
    throw notConnectedError();
  }
  const reason = data?.error?.errors?.[0]?.reason;
  if (res.status === 429 || (res.status === 403 && /rateLimit/i.test(String(reason)))) {
    throw Object.assign(offlineError("Google Drive rate limit reached, retrying later"), { status: 503 });
  }
  if (res.status === 403 && reason === "insufficientPermissions") {
    // the Drive access was unticked at sign-in
    setConnection({ drive: false });
    throw notConnectedError();
  }
  if (res.status >= 500) {
    throw Object.assign(offlineError(`Google Drive error ${res.status}`), { status: 503 });
  }
};

const readDriveResponse = async (res: Response, raw: boolean) => {
  const text = res.status === 204 ? "" : await res.text();
  let data: any = null;
  if (!raw || !res.ok) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
  }
  return { text, data };
};

const drive = async (
  url: string,
  {
    method = "GET",
    body,
    contentType,
    raw = false,
  }: { method?: string; body?: BodyInit | object; contentType?: string; raw?: boolean } = {},
): Promise<DriveResponse> => {
  const requestContentType = (isJson: boolean): Record<string, string> => {
    if (isJson) {
      return { "Content-Type": "application/json" };
    }
    if (contentType) {
      return { "Content-Type": contentType };
    }
    return {};
  };
  const requestBody = (isJson: boolean) => {
    if (body === undefined) {
      return undefined;
    }
    if (isJson) {
      return JSON.stringify(body);
    }
    return body as BodyInit;
  };

  if (sharedFolderId) {
    return folderDrive(sharedFolderId, url, { method, raw, body, contentType });
  }
  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    if (!value || otherAccount()) {
      throw notConnectedError();
    }
    const isJson = body !== undefined && !(typeof body === "string" || body instanceof Blob || body instanceof Uint8Array);
    let res: Response;
    try {
      res = await fetch(url.startsWith("https://") || url.startsWith(UPLOAD) ? url : `${API}${url}`, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${value}`,
          ...requestContentType(isJson),
        },
        body: requestBody(isJson),
      });
    } catch {
      throw offlineError("Google Drive not reachable");
    }
    if (res.status === 401 && attempt === 0) {
      token = null; // revoked or expired early: get a fresh one once
      continue;
    }
    const { text, data } = await readDriveResponse(res, raw);
    checkDriveResponse(res, data);
    return { status: res.status, data, text };
  }
};

/** why a shared folder can't be reached, as the user reads it */
const folderLost = (code: string | undefined) =>
  code === "no-access" ? "This folder is not shared with you any more" : "This folder is not shared any more (its owner stopped sharing it)";

/** what this user may do in the shared folder this tab shows (the server says with every answer) */
let folderRole: "writer" | "reader" | null = null;

/** a request body as the folder route takes it: text, or JSON */
const folderBody = async (body: BodyInit | object | undefined): Promise<{ text?: string; json?: unknown }> => {
  if (body === undefined) {
    return {};
  }
  if (typeof body === "string") {
    return { text: body };
  }
  if (body instanceof Blob) {
    return { text: await body.text() };
  }
  if (body instanceof Uint8Array) {
    return { text: new TextDecoder().decode(body) };
  }
  return { json: body };
};

/** the server's refusal of a folder call, as the app reads it */
const folderError = (error: any) => {
  if (error.code === "not-shared" || error.code === "no-access") {
    setConnection({ lost: folderLost(error.code) });
    return notConnectedError();
  }
  if (error.code === "read-only") {
    return readOnlyError("this folder is shared with you to view");
  }
  if (error.code === "live") {
    return httpError(423, error.message);
  }
  return error;
};

/**
 * A Drive call in a shared folder's space: through Kurviq's server, which
 * makes it with the owner's access after checking it (this folder and its
 * scenes only; writes for those who may edit).
 */
const folderDrive = async (
  folderId: string,
  url: string,
  { method, raw, body, contentType }: { method: string; raw: boolean; body?: BodyInit | object; contentType?: string },
): Promise<DriveResponse> => {
  if (!(await getToken())) {
    throw notConnectedError();
  }
  let target = "api";
  let path = url;
  if (url.startsWith(UPLOAD)) {
    target = "upload";
    path = url.slice(UPLOAD.length);
  } else if (url.startsWith(API)) {
    path = url.slice(API.length);
  } else if (url.startsWith("https://")) {
    throw httpError(400, "Not available in a shared folder");
  }
  let answer: { status: number; text: string; role?: "writer" | "reader" };
  try {
    answer = await authPost(`/folders/${folderId}/drive`, { method, target, path, ...(await folderBody(body)), ...(contentType ? { contentType } : {}) });
  } catch (error: any) {
    throw folderError(error);
  }
  setConnection({ lost: null });
  folderRole = answer.role ?? folderRole;
  let data: any = null;
  if (!raw || answer.status !== 200) {
    try {
      data = answer.text ? JSON.parse(answer.text) : null;
    } catch {
      data = null;
    }
  }
  return { status: answer.status, data, text: answer.text };
};

const fail = (res: DriveResponse, what: string): never => {
  const detail = typeof res.data?.error?.message === "string" ? `: ${res.data.error.message}` : "";
  throw httpError(res.status, `${what} (Google Drive ${res.status}${detail})`);
};

const q = (value: string) => {
  const escaped = value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
  return `'${escaped}'`;
};

const validateSceneContent = (name: string, json: string) => {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw httpError(400, "Scene content is not valid JSON");
  }
  const owner = data?.appState?.name;
  if (typeof owner === "string" && owner !== name) {
    throw httpError(422, `Refused: this content belongs to scene "${owner}", not "${name}". Nothing was written.`);
  }
};

const encodeBytes = (json: string) => new TextEncoder().encode(json);

// -----------------------------------------------------------------------------
// versions kept in this browser: a merge needs the version a scene is based
// on, and Drive only hands out old versions that were kept ("keep forever")
// -----------------------------------------------------------------------------

const versionStore = createStore("kurviq-drive-versions", "versions");
/** per file: the versions kept, newest first (a small index, so the scenes themselves are never read to prune) */
const versionIndex = createStore("kurviq-drive-version-index", "index");
/** versions kept per file (the newest; the base of a merge is among them) */
const KEEP_VERSIONS = 4;

const keepVersion = async (fileId: string, checksum: string, json: string) => {
  try {
    await set(`${fileId}:${checksum}`, json, versionStore);
    const kept = [checksum, ...((await get<string[]>(fileId, versionIndex)) ?? []).filter((other) => other !== checksum)];
    await set(fileId, kept.slice(0, KEEP_VERSIONS), versionIndex);
    await Promise.all(kept.slice(KEEP_VERSIONS).map((other) => del(`${fileId}:${other}`, versionStore)));
  } catch {}
};

const keptVersion = async (fileId: string, checksum: string) => {
  try {
    return (await get<string>(`${fileId}:${checksum}`, versionStore)) ?? null;
  } catch {
    return null;
  }
};

// -----------------------------------------------------------------------------
// the folder and its scenes
// -----------------------------------------------------------------------------

type DriveFile = {
  id: string;
  name: string;
  md5Checksum?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  permissionIds?: string[];
  capabilities?: { canEdit?: boolean; canShare?: boolean };
  appProperties?: Record<string, string>;
  owners?: { displayName?: string; emailAddress?: string }[];
  ownedByMe?: boolean;
};

type Listing = { files: Map<string, DriveFile>; fetchedAt: number };

let listing: Listing | null = null;
const remote: RemoteInfo = { online: null, lastFetchAt: null, lastError: null };
/** a shared scene's space: Drive lets this user read it, not change it */
let readOnly: string | null = null;

const forgetListing = () => {
  listing = null;
  folderRequest = null;
};

const sceneNameOf = (file: DriveFile) =>
  file.name.endsWith(EXTENSION) ? file.name.slice(0, -EXTENSION.length) : null;

const checkName = (name: string) => {
  if (!isSceneName(name)) {
    throw httpError(400, `Invalid scene name: ${name}`);
  }
};

const folderKey = () => `kurviq-drive-folder:${state.user?.email ?? ""}`;
let folderRequest: Promise<string> | null = null;

/**
 * The "Kurviq" folder in My Drive: found by its mark (appProperties, so the
 * user may rename or move it), created on first use. One tab at a time, so
 * two tabs never create two folders.
 */
const findFolder = async (): Promise<string> => {
  const known = localStorage.getItem(folderKey());
  if (known) {
    const res = await drive(`/files/${known}?fields=id,trashed`);
    if (res.status === 200 && !res.data.trashed) {
      return known;
    }
  }
  const search = await drive(
    `/files?q=${encodeURIComponent(
      `appProperties has { key='kurviqRoot' and value='1' } and mimeType=${q(FOLDER_MIME)} and trashed=false`,
    )}&fields=files(id,createdTime)&orderBy=createdTime&spaces=drive`,
  );
  if (search.status !== 200) {
    fail(search, "The Kurviq folder in Google Drive could not be found");
  }
  let id: string | undefined = search.data.files?.[0]?.id;
  if (!id) {
    const created = await drive("/files?fields=id", {
      method: "POST",
      body: { name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { kurviqRoot: "1" } },
    });
    if (created.status !== 200) {
      fail(created, "The Kurviq folder could not be created in Google Drive");
    }
    id = created.data.id as string;
  }
  try {
    localStorage.setItem(folderKey(), id);
  } catch {}
  return id;
};

const folderId = () => {
  if (sharedFolderId) {
    return Promise.resolve(sharedFolderId);
  }
  folderRequest ??= (
    navigator.locks ? (navigator.locks.request("kurviq-drive-folder", findFolder) as unknown as Promise<string>) : findFolder()
  ).catch((error) => {
    folderRequest = null;
    throw error;
  });
  return folderRequest;
};

/** a shared scene's space: its one file (null: no access, the Picker may grant it) */
const fetchSharedFile = async (fileId: string): Promise<DriveFile | null> => {
  const res = await drive(`/files/${fileId}?fields=${FILE_FIELDS},trashed&supportsAllDrives=true`);
  if (res.status === 404) {
    return null;
  }
  if (res.status !== 200) {
    fail(res, "The shared scene could not be read");
  }
  if (res.data.trashed) {
    throw httpError(404, "This scene was deleted in Google Drive");
  }
  return res.data;
};

const addFolderScene = (files: Map<string, DriveFile>, file: DriveFile) => {
  const name = sceneNameOf(file);
  const other = name ? files.get(name) : undefined;
  // two files of the same name (made in Drive): the newer one counts
  if (name && isSceneName(name) && (!other || (other.modifiedTime ?? "") < (file.modifiedTime ?? ""))) {
    files.set(name, file);
  }
};

const fetchFolderScenes = async (files: Map<string, DriveFile>) => {
  const folder = await folderId();
  let pageToken = "";
  do {
    const query = `${q(folder)} in parents and trashed=false`;
    const res = await drive( // NOSONAR S9382: each folder page needs the preceding page token
      `/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
    );
    if (res.status === 404) {
      // the folder is gone (deleted for good): find or make it again next time
      localStorage.removeItem(folderKey());
      folderRequest = null;
    }
    if (res.status !== 200) {
      fail(res, "The scenes in Google Drive could not be listed");
    }
    for (const file of res.data.files as DriveFile[]) {
      addFolderScene(files, file);
    }
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);
};

/** a shared scene's space: its one file */
const fetchSharedSpace = async (fileId: string, files: Map<string, DriveFile>) => {
  const file = await fetchSharedFile(fileId);
  if (!file) {
    setConnection({ needsAccess: true });
    throw notConnectedError();
  }
  setConnection({ needsAccess: false, lost: null });
  readOnly = file.capabilities?.canEdit === false ? `${ownerName(file)} shared "${sceneNameOf(file) ?? file.name}" with you to view` : null;
  const name = sceneNameOf(file);
  if (name && isSceneName(name)) {
    files.set(name, file);
  }
};

/** the user's own Kurviq folder, or a shared folder (read-only for now) */
const fetchFolderSpace = async (files: Map<string, DriveFile>) => {
  await fetchFolderScenes(files);
  if (sharedFolderId) {
    const owner = [...files.values()][0];
    readOnly = folderRole === "reader" ? `${owner ? ownerName(owner) : "Its owner"} shared this folder with you to view` : null;
  } else {
    registerShare().catch(() => {});
  }
};

/** the scenes of this space (name -> file); a cached copy for a few seconds */
const fetchScenes = async (force = false): Promise<Listing> => {
  if (listing && !force && Date.now() - listing.fetchedAt < 5_000) {
    return listing;
  }
  try {
    const files = new Map<string, DriveFile>();
    if (sharedFileId) {
      await fetchSharedSpace(sharedFileId, files);
    } else {
      await fetchFolderSpace(files);
    }
    listing = { files, fetchedAt: Date.now() };
    remote.online = true;
    remote.lastFetchAt = new Date().toISOString();
    remote.lastError = null;
    return listing;
  } catch (error: any) {
    if (error.offline && !error.notConnected) {
      remote.online = false;
      remote.lastError = error.message;
    }
    throw error;
  }
};

const ownerName = (file: DriveFile) => file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || "Someone";

const locate = async (name: string, force = true) => (await fetchScenes(force)).files.get(name) ?? null;

const checkBase = (name: string, current: string | undefined, baseMd5: string | undefined) => {
  if (baseMd5 !== undefined && (current || "none") !== baseMd5) {
    throw httpError(409, `"${name}" was changed in Google Drive in the meantime`, { remoteMd5: current || null });
  }
};

const readOnlyError = (reason: string) => httpError(403, `Read only: ${reason}`, { readOnly: true });

const requireWritable = () => {
  if (readOnly) {
    throw readOnlyError(readOnly);
  }
};

/**
 * A scene its owner saves live, in a shared folder: its Durable Object is its
 * only writer, and this person's Kurviq can't reach it (yet): changes stay here.
 */
const requireFolderWritable = (file: DriveFile | null, name: string) => {
  if (sharedFolderId && file?.appProperties?.kurviqSync === LIVE_MARKER) {
    throw httpError(423, `"${name}" is saved live by its owner: your changes to it stay in this browser (it can't be changed from a shared folder yet)`);
  }
};

const isAgent = (source?: string) => typeof source === "string" && source.startsWith("agent");

const download = async (fileId: string, revision?: string) => {
  const res = await drive(
    revision ? `/files/${fileId}/revisions/${revision}?alt=media` : `/files/${fileId}?alt=media&supportsAllDrives=true`,
    { raw: true },
  );
  return res;
};

/** an older version of a file, by its MD5: kept in this browser, else from Drive's revisions */
const loadVersion = async (file: DriveFile, name: string, checksum: string) => {
  const kept = await keptVersion(file.id, checksum);
  if (kept !== null) {
    return kept;
  }
  const revisions = await listRevisions(file.id);
  for (const revision of revisions.filter((entry) => entry.md5Checksum === checksum).reverse()) {
    const res = await download(file.id, revision.id);
    if (res.status === 200) {
      await keepVersion(file.id, checksum, res.text);
      return res.text;
    }
  }
  throw httpError(404, `Version ${checksum} of scene "${name}" not found (Google Drive keeps older versions about 30 days)`);
};

type Revision = {
  id: string;
  md5Checksum?: string;
  modifiedTime?: string;
  keepForever?: boolean;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
};

const listRevisions = async (fileId: string): Promise<Revision[]> => {
  const all: Revision[] = [];
  let pageToken = "";
  do {
    const res = await drive( // NOSONAR S9382: each revisions page needs the preceding page token
      `/files/${fileId}/revisions?fields=nextPageToken,revisions(id,md5Checksum,modifiedTime,keepForever,lastModifyingUser(displayName,emailAddress))&pageSize=200${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
    );
    if (res.status !== 200) {
      fail(res, "The versions of the scene could not be read");
    }
    all.push(...(res.data.revisions || []));
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);
  return all; // oldest first
};

/** a multipart upload: metadata + content in one request (a new file) */
const multipart = (metadata: object, json: string) => {
  const boundary = `kurviq${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${SCENE_MIME}\r\n\r\n`,
    json,
    `\r\n--${boundary}--`,
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
};

/**
 * An agent's edit: keep this version for good (Drive drops old versions
 * after about 30 days) and remember it on the file, so "what did the user
 * change since the agent's last edit" can be answered later. The previous
 * agent version is let go again.
 */
const markAgentVersion = async (file: DriveFile, revision: string) => {
  const previous = file.appProperties?.agentRev;
  await drive(`/files/${file.id}/revisions/${revision}`, { method: "PATCH", body: { keepForever: true } }).catch(() => null);
  await drive(`/files/${file.id}?fields=id`, {
    method: "PATCH",
    body: { appProperties: { agentRev: revision, agentAt: new Date().toISOString() } },
  }).catch(() => null);
  if (previous && previous !== revision) {
    await drive(`/files/${file.id}/revisions/${previous}`, { method: "PATCH", body: { keepForever: false } }).catch(() => null);
  }
};

// -----------------------------------------------------------------------------
// live sync: scenes marked appProperties.kurviqSync are written only through
// their Durable Object (online/liveSync.ts registers these)
// -----------------------------------------------------------------------------

export const isLiveFile = (file: { appProperties?: Record<string, string> }) => !sharedFolderId && file.appProperties?.kurviqSync === LIVE_MARKER;

export type LiveWrite = { fileId: string; name: string; json: string; baseMd5?: string; source?: string };
let liveWriter: ((write: LiveWrite) => Promise<{ md5: string; driveRevision: string | null; changed: boolean }>) | null = null;
let liveRenamer: ((rename: { fileId: string; from: string; to: string }) => Promise<void>) | null = null;
let liveRemover: ((remove: { fileId: string; name: string }) => Promise<void>) | null = null;

export const setLiveWriters = (writers: {
  write: NonNullable<typeof liveWriter>;
  rename: NonNullable<typeof liveRenamer>;
  remove: NonNullable<typeof liveRemover>;
}) => {
  liveWriter = writers.write;
  liveRenamer = writers.rename;
  liveRemover = writers.remove;
};

export const driveScenes = {
  remoteInfo: (): RemoteInfo => ({ ...remote, readOnly }),

  list: async (refresh = false): Promise<{ scenes: RemoteScene[]; remote: RemoteInfo }> => {
    if (state.user === undefined) {
      await checkConnection(); // first call: find out whether this browser is signed in
    }
    if (!state.user || !state.drive) {
      throw notConnectedError();
    }
    const entries = (current: Listing | null): RemoteScene[] =>
      current
        ? [...current.files]
            .map(([name, file]) => ({
              name,
              md5: file.md5Checksum ?? "",
              updatedAt: file.modifiedTime ?? null,
              public: !!file.permissionIds?.includes("anyoneWithLink"),
              fileId: file.id,
              ...(isLiveFile(file) ? { live: true } : {}),
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
    try {
      return { scenes: entries(await fetchScenes(refresh)), remote: driveScenes.remoteInfo() };
    } catch (error: any) {
      if (error.offline && !error.notConnected) {
        return { scenes: entries(listing), remote: driveScenes.remoteInfo() };
      }
      throw error;
    }
  },

  /** latest version, or a specific one (its MD5) */
  load: async (name: string, checksum?: string): Promise<{ json: string; md5: string }> => {
    checkName(name);
    const file = await locate(name);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    if (checksum && checksum !== file.md5Checksum) {
      return { json: await loadVersion(file, name, checksum), md5: checksum };
    }
    const res = await download(file.id);
    if (res.status !== 200) {
      fail(res, `"${name}" could not be read`);
    }
    // the content's own MD5 (the listing may be a moment older than what was read)
    const actual = md5(encodeBytes(res.text));
    await keepVersion(file.id, actual, res.text);
    return { json: res.text, md5: actual };
  },

  /**
   * Save a scene. baseMd5: undefined = overwrite, "none" = must be new,
   * <md5> = must be exactly that version in Drive (else 409: merge first).
   */
  save: async (name: string, json: string, baseMd5?: string, source?: string) => {
    checkName(name);
    validateSceneContent(name, json);
    requireWritable();
    const checksum = md5(encodeBytes(json));
    const file = await locate(name);
    requireFolderWritable(file, name);
    if (file && isLiveFile(file)) {
      // the scene saves through its Durable Object: never a second writer
      // (CONCEPT "Old app versions"); agents' writes go through live sync
      if (!liveWriter) {
        throw httpError(409, `"${name}" is saved through live sync: it can't be written to Drive directly`);
      }
      return liveWriter({ fileId: file.id, name, json, baseMd5, source });
    }
    checkBase(name, file?.md5Checksum, baseMd5);
    if (file?.md5Checksum === checksum) {
      return { md5: checksum, driveRevision: null, changed: false };
    }
    let res: DriveResponse;
    if (file) {
      // (Drive has no conditional write: the check above leaves a moment in
      // which someone else's save is overwritten; their app merges it back)
      res = await drive(`${UPLOAD}/files/${file.id}?uploadType=media&fields=${FILE_FIELDS}&supportsAllDrives=true`, {
        method: "PATCH",
        body: json,
        contentType: SCENE_MIME,
      });
    } else {
      if (sharedFileId) {
        throw httpError(403, "This is someone's shared scene: new scenes are made in your own scenes");
      }
      const upload = multipart(
        { name: `${name}${EXTENSION}`, mimeType: SCENE_MIME, parents: [await folderId()], appProperties: { kurviq: "scene", fmt: "1" } },
        json,
      );
      res = await drive(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
        method: "POST",
        body: upload.body,
        contentType: upload.contentType,
      });
    }
    if (res.status === 403 || res.status === 404) {
      if (sharedFileId) {
        readOnly = "you can't change this scene any more (its owner changed the sharing)";
        throw readOnlyError(readOnly);
      }
      fail(res, `Saving "${name}" to Google Drive failed`);
    }
    if (res.status !== 200) {
      fail(res, `Saving "${name}" to Google Drive failed`);
    }
    const saved = res.data as DriveFile;
    forgetListing();
    await keepVersion(saved.id, checksum, json);
    if (isAgent(source) && saved.headRevisionId) {
      await markAgentVersion({ ...saved, appProperties: file?.appProperties ?? saved.appProperties }, saved.headRevisionId);
    }
    return { md5: saved.md5Checksum ?? checksum, driveRevision: saved.headRevisionId ?? null, changed: true };
  },

  /** delete a scene (to Drive's bin); baseMd5 (optional): only if Drive still has that version */
  remove: async (name: string, baseMd5?: string | null) => {
    checkName(name);
    requireWritable();
    const file = await locate(name);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    if (sharedFileId) {
      throw httpError(403, `"${name}" belongs to ${ownerName(file)}: only they can delete it`);
    }
    requireFolderWritable(file, name);
    if (isLiveFile(file)) {
      // its Durable Object stops saving first (and confirms), then the file goes to the trash
      if (!liveRemover) {
        throw httpError(409, `"${name}" is saved through live sync: delete it in Kurviq`);
      }
      await liveRemover({ fileId: file.id, name });
      forgetListing();
      return { md5: null };
    }
    checkBase(name, file.md5Checksum, baseMd5 ?? undefined);
    const res = await drive(`/files/${file.id}?fields=id`, { method: "PATCH", body: { trashed: true } });
    if (res.status !== 200) {
      fail(res, `Deleting "${name}" failed`);
    }
    forgetListing();
    return { md5: null };
  },

  /** rename (the file keeps its id, so links to it keep working; the content and its MD5 stay) */
  rename: async (from: string, to: string): Promise<{ md5: string; driveRevision: string | null }> => {
    checkName(from);
    checkName(to);
    if (from === to) {
      throw httpError(400, "New name is the same as the old one");
    }
    requireWritable();
    const current = await fetchScenes(true);
    const file = current.files.get(from);
    if (!file) {
      throw httpError(404, `Scene not found: ${from}`);
    }
    if (current.files.has(to)) {
      throw httpError(409, `A scene named "${to}" already exists in Google Drive`, { exists: true });
    }
    requireFolderWritable(file, from);
    if (isLiveFile(file)) {
      // a rename of a live scene is an event like any other (the DO renames the file)
      if (!liveRenamer) {
        throw httpError(409, `"${from}" is saved through live sync: rename it in Kurviq`);
      }
      await liveRenamer({ fileId: file.id, from, to });
      forgetListing();
      return { md5: file.md5Checksum ?? "", driveRevision: null };
    }
    const res = await drive(`/files/${file.id}?fields=id&supportsAllDrives=true`, {
      method: "PATCH",
      body: { name: `${to}${EXTENSION}` },
    });
    if (res.status !== 200) {
      fail(res, "Rename failed");
    }
    forgetListing();
    return { md5: file.md5Checksum ?? "", driveRevision: null };
  },

  /** the versions of a scene, newest first (load one with loadAt) */
  history: async (name: string): Promise<SceneVersion[]> => {
    checkName(name);
    const file = await locate(name, false);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    const agentRev = file.appProperties?.agentRev;
    return (await listRevisions(file.id))
      .reverse()
      .slice(0, 60)
      .map((revision) => ({
        driveRevision: revision.id,
        at: revision.modifiedTime ?? null,
        author: revision.lastModifyingUser?.displayName ?? revision.lastModifyingUser?.emailAddress ?? null,
        message: revision.id === agentRev ? "Agent edit" : "",
        agent: revision.id === agentRev,
        md5: revision.md5Checksum,
      }));
  },

  /** the scene as it was in a revision */
  loadAt: async (name: string, revision: string): Promise<{ json: string; md5: string }> => {
    checkName(name);
    const file = await locate(name, false);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    const res = await download(file.id, revision);
    if (res.status !== 200) {
      throw httpError(res.status, `This version of "${name}" can't be read any more (Google Drive keeps older versions about 30 days)`);
    }
    return { json: res.text, md5: md5(encodeBytes(res.text)) };
  },

  /** the version of a scene an agent saved last (kept for good in Drive) */
  agentVersion: async (name: string) => {
    checkName(name);
    const file = await locate(name, false);
    const revision = file?.appProperties?.agentRev;
    if (!file || !revision) {
      return null;
    }
    const res = await drive(`/files/${file.id}/revisions/${revision}?fields=id,md5Checksum,modifiedTime`);
    if (res.status !== 200 || !res.data?.md5Checksum) {
      return null;
    }
    return { md5: res.data.md5Checksum as string, driveRevision: revision, at: res.data.modifiedTime ?? file.appProperties?.agentAt ?? null };
  },

  /** a scene that saves through live sync: its file id (null: Drive is written directly, or unknown) */
  liveFileOf: async (name: string) => {
    const file = await locate(name, false).catch(() => null);
    return file && isLiveFile(file) ? file.id : null;
  },

  /** a version of a file by its MD5: kept in this browser, else the current one if it is that version */
  loadFileVersion: async (fileId: string, checksum: string): Promise<string | null> => {
    const kept = await keptVersion(fileId, checksum);
    if (kept !== null) {
      return kept;
    }
    const res = await download(fileId);
    if (res.status !== 200) {
      return null;
    }
    const actual = md5(encodeBytes(res.text));
    await keepVersion(fileId, actual, res.text);
    return actual === checksum ? res.text : null;
  },

  /** move a file to Drive's trash (the live scene's DO was told first) */
  trashFile: async (fileId: string) => {
    const res = await drive(`/files/${fileId}?fields=id&supportsAllDrives=true`, { method: "PATCH", body: { trashed: true } });
    if (res.status !== 200 && res.status !== 404) {
      fail(res, "Moving the scene to Drive's trash failed");
    }
    forgetListing();
  },

  /** the Drive file of a scene of this space (for sharing) */
  fileOf: async (name: string) => {
    const file = await locate(name, false);
    return file ? { id: file.id, canShare: file.capabilities?.canShare !== false, ownedByMe: file.ownedByMe !== false, owner: ownerName(file) } : null;
  },
};

// -----------------------------------------------------------------------------
// sharing (Drive permissions)
// -----------------------------------------------------------------------------

export type Role = "reader" | "commenter" | "writer" | "owner" | "fileOrganizer" | "organizer";

export type Permission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: Role;
  emailAddress?: string;
  displayName?: string;
  photoLink?: string;
};

export type LinkAccess = "restricted" | "reader" | "writer";

export const listPermissions = async (fileId: string): Promise<Permission[]> => {
  const res = await drive(
    `/files/${fileId}/permissions?fields=permissions(id,type,role,emailAddress,displayName,photoLink,deleted)&supportsAllDrives=true`,
  );
  if (res.status !== 200) {
    fail(res, "Who has access could not be read");
  }
  return (res.data.permissions as (Permission & { deleted?: boolean })[]).filter((permission) => !permission.deleted);
};

export const linkAccessOf = (permissions: Permission[]): LinkAccess => {
  const permissionAccess = () => {
    if (anyone) {
      if (anyone.role === "writer") {
        return "writer";
      }
      return "reader";
    }
    return "restricted";
  };

  const anyone = permissions.find((permission) => permission.type === "anyone");
  return permissionAccess();
};

export const changeRole = async (fileId: string, permissionId: string, role: "reader" | "writer") => {
  const res = await drive(`/files/${fileId}/permissions/${permissionId}?supportsAllDrives=true&fields=id`, {
    method: "PATCH",
    body: { role },
  });
  if (res.status !== 200) {
    fail(res, "Could not change the access");
  }
};

export const removeAccess = async (fileId: string, permissionId: string) => {
  const res = await drive(`/files/${fileId}/permissions/${permissionId}?supportsAllDrives=true`, { method: "DELETE" });
  if (res.status !== 204 && res.status !== 200) {
    fail(res, "Could not remove the access");
  }
};

/** "anyone with the link": off, can view, or can edit */
export const setLinkAccess = async (fileId: string, access: LinkAccess) => {
  const anyone = (await listPermissions(fileId)).find((permission) => permission.type === "anyone");
  if (access === "restricted") {
    if (anyone) {
      await removeAccess(fileId, anyone.id);
    }
  } else if (anyone) {
    if (anyone.role !== access) {
      await changeRole(fileId, anyone.id, access);
    }
  } else {
    const res = await drive(`/files/${fileId}/permissions?supportsAllDrives=true&fields=id`, {
      method: "POST",
      body: { type: "anyone", role: access, allowFileDiscovery: false },
    });
    if (res.status !== 200) {
      fail(res, "Could not change who can open the link");
    }
  }
  forgetListing();
};

const trimHyphens = (value: string) => {
  let start = 0;
  let end = value.length;
  while (value[start] === "-") start++;
  while (end > start && value[end - 1] === "-") end--;
  return value.slice(start, end);
};

const slug = (name: string) =>
  trimHyphens(name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-"))
    .slice(0, 60);

/** the link to a scene for anyone: kurviq.com/s/<fileId>/<readable name> */
export const shareLink = (fileId: string, name: string) => {
  const base = IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin;
  const readable = slug(name);
  const suffix = readable ? `/${readable}` : "";
  return `${base}/s/${fileId}${suffix}`;
};

// -----------------------------------------------------------------------------
// the author on the public page: only when they choose (Share…), a public property of the file
// -----------------------------------------------------------------------------

const BYLINE_PROPERTY = "kurviqBy";

/** the name shown as the scene's author on its public page, or null */
export const getByline = async (fileId: string): Promise<string | null> => {
  const res = await drive(`/files/${fileId}?fields=properties&supportsAllDrives=true`);
  if (res.status !== 200) {
    fail(res, "Could not read the scene's details");
  }
  return res.data?.properties?.[BYLINE_PROPERTY] ?? null;
};

/** name the user as the author on the public page (their Google name), or not (null) */
export const setByline = async (fileId: string, name: string | null) => {
  const res = await drive(`/files/${fileId}?fields=id&supportsAllDrives=true`, {
    method: "PATCH",
    body: { properties: { [BYLINE_PROPERTY]: name ? name.slice(0, 80) : null } },
  });
  if (res.status !== 200) {
    fail(res, "Could not change who is named on the public page");
  }
};

// -----------------------------------------------------------------------------
// short links: kurviq.com/pub/<name> (online/worker/pubLinks.ts), besides the long link
// -----------------------------------------------------------------------------

/** kurviq.com/pub/<name> */
export const pubLink = (name: string) => `${IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin}/pub/${name}`;

/** the short names known in this tab, by file (null: none); kept fresh by the calls below */
const pubNames = new Map<string, string | null>();
const pubListeners = new Set<() => void>();
const setPubName = (fileId: string, name: string | null) => {
  pubNames.set(fileId, name);
  pubListeners.forEach((listener) => listener());
};

export const pubNameStore = {
  subscribe: (listener: () => void) => {
    pubListeners.add(listener);
    return () => {
      pubListeners.delete(listener);
    };
  },
  /** undefined: not asked yet */
  get: (fileId: string) => pubNames.get(fileId),
};

const pubCall = async (path: string, init: RequestInit = {}) => {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/api/pub${path}`, { credentials: "omit", ...init });
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as { fileId?: string; name?: string | null; error?: string; code?: string } };
};

/** a file's short name (null: none) */
export const loadPubName = async (fileId: string): Promise<string | null> => {
  const { status, body } = await pubCall(`?file=${encodeURIComponent(fileId)}`);
  if (status !== 200) {
    throw httpError(status, body.error || `Kurviq server error (${status})`);
  }
  setPubName(fileId, body.name ?? null);
  return body.name ?? null;
};

/** the file a short name stands for (null: free) */
export const pubNameHolder = async (name: string): Promise<string | null> => {
  const { status, body } = await pubCall(`/${encodeURIComponent(name)}`);
  if (status === 404) {
    return null;
  }
  if (status !== 200 || !body.fileId) {
    throw httpError(status, body.error || `Kurviq server error (${status})`);
  }
  return body.fileId;
};

const withToken = async () => {
  const token = await getToken();
  if (!token) {
    throw notConnectedError();
  }
  return { Authorization: `Bearer ${token}` };
};

/** give the file this short name (its old one is freed); Kurviq's server asks Drive whether the user may edit it */
export const claimPubName = async (fileId: string, name: string) => {
  const { status, body } = await pubCall("", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await withToken()) },
    body: JSON.stringify({ fileId, name }),
  });
  if (status !== 200) {
    throw httpError(status, body.error || `Kurviq server error (${status})`);
  }
  setPubName(fileId, name);
};

export const releasePubName = async (fileId: string, name: string) => {
  const { status, body } = await pubCall(`/${encodeURIComponent(name)}`, { method: "DELETE", headers: await withToken() });
  if (status !== 200) {
    throw httpError(status, body.error || `Kurviq server error (${status})`);
  }
  setPubName(fileId, null);
};

// -----------------------------------------------------------------------------
// scenes others shared with this user (each opens in a space of its own)
// -----------------------------------------------------------------------------

export type SharedWithMe = { fileId: string; name: string; owner: string; canEdit: boolean };

let sharedList: { at: number; value: Promise<SharedWithMe[]> } | null = null;

/**
 * Scenes shared with this user that Kurviq may open (Drive only shows Kurviq
 * those the user opened with it once); asked again after a minute
 */
export const sharedWithMe = (): Promise<SharedWithMe[]> => {
  if (sharedList && Date.now() - sharedList.at < 60_000) {
    return sharedList.value;
  }
  const value = (async () => {
    const query = `sharedWithMe and trashed=false and mimeType=${q(SCENE_MIME)}`;
    const res = await drive(
      `/files?q=${encodeURIComponent(query)}&fields=files(${FILE_FIELDS})&pageSize=200&includeItemsFromAllDrives=true&supportsAllDrives=true`,
    );
    if (res.status !== 200) {
      return [];
    }
    return (res.data.files as DriveFile[])
      .map((file) => ({ file, name: sceneNameOf(file) }))
      .filter((entry): entry is { file: DriveFile; name: string } => !!entry.name && isSceneName(entry.name))
      .map(({ file, name }) => ({ fileId: file.id, name, owner: ownerName(file), canEdit: file.capabilities?.canEdit !== false }));
  })();
  value.catch(() => {
    sharedList = null;
  });
  sharedList = { at: Date.now(), value };
  return value;
};

// -----------------------------------------------------------------------------
// shared folders (docs/folders/CONCEPT.md): a Kurviq folder its owner shared in
// Google Drive. The owner's Kurviq tells Kurviq's server (registerShare);
// everyone it is shared with finds it (sharedFolders) and opens it in its own
// space, read through the server with the owner's sign-in.
// -----------------------------------------------------------------------------

/** the owner's Kurviq asks Drive whether its folder is shared this often (and renews the server's copy of its sign-in) */
const SHARE_CHECK_MS = 30 * 60_000;
const shareKey = () => `kurviq-folder-share:${state.user?.email ?? ""}`;

/**
 * The owner's side: when the Kurviq folder is shared in Drive (or was, and
 * isn't any more), Kurviq's server is told; it reads the folder's sharing
 * itself and keeps (or forgets) the owner's sign-in for it.
 */
const registerShare = async () => {
  if (sharedFileId || sharedFolderId || !state.user || !state.drive) {
    return;
  }
  let known: { at: number; shared: boolean } | null = null;
  try {
    known = JSON.parse(localStorage.getItem(shareKey()) || "null");
  } catch {}
  if (known && Date.now() - known.at < SHARE_CHECK_MS) {
    return;
  }
  const folder = await folderId();
  const res = await drive(`/files/${folder}?fields=id,shared`);
  if (res.status !== 200) {
    return;
  }
  let shared = res.data?.shared === true;
  // not shared and known not to be: nothing to tell (a browser that doesn't know asks once,
  // so a share that ended while it was registered from another browser is forgotten too)
  if (shared || known?.shared !== false) {
    shared = (await authPost("/folders/register", { folderId: folder })).shared === true;
  }
  try {
    localStorage.setItem(shareKey(), JSON.stringify({ at: Date.now(), shared }));
  } catch {}
};

export type SharedFolderScene = { name: string; fileId: string; modifiedTime: string | null };
export type SharedFolder = { folderId: string; name: string; owner: string; role: "writer" | "reader"; scenes: SharedFolderScene[] };

let folderList: { at: number; value: Promise<SharedFolder[]> } | null = null;

/** the folders others shared with this user, with their scenes (asked again after a minute) */
export const sharedFolders = (): Promise<SharedFolder[]> => {
  if (folderList && Date.now() - folderList.at < 60_000) {
    return folderList.value;
  }
  const value = authPost("/folders").then((answer) => (Array.isArray(answer.folders) ? (answer.folders as SharedFolder[]) : []));
  value.catch(() => {
    folderList = null;
  });
  folderList = { at: Date.now(), value };
  return value;
};

/** open a scene of a shared folder in the folder's space (the page reloads into it) */
export const enterFolder = (folderId: string, name: string | null) => {
  try {
    localStorage.setItem(SPACE_KEY, folderSpace(folderId));
  } catch {}
  window.location.href = name ? `/${encodeURIComponent(name)}` : "/";
};

/** open a scene in its own space (the page reloads into it); null = the user's own scenes */
export const enterSpace = (fileId: string | null, path = "/") => {
  try {
    if (fileId) {
      localStorage.setItem(SPACE_KEY, fileSpace(fileId));
    } else {
      localStorage.removeItem(SPACE_KEY);
    }
  } catch {}
  window.location.href = path;
};

// -----------------------------------------------------------------------------
// a shared link (kurviq.com/s/<fileId>): public without sign-in, else with
// the visitor's own Drive access
// -----------------------------------------------------------------------------

export type SharedScene = {
  json: string;
  name: string;
  /** the author, if they chose to be named on the public page */
  by?: string;
  public: boolean;
  /** Drive lets this user change it */
  canEdit: boolean;
};

export type SharedSceneAnswer =
  | { scene: SharedScene }
  /** signed in, but Kurviq may not read it yet: the Picker grants it */
  | { needsAccess: true }
  /** not public, not signed in */
  | { signIn: true }
  /** no such file, or no access */
  | { missing: true };

/**
 * A shared scene's current version (Drive's MD5 of it): for public ones from
 * Kurviq's Worker, else from Drive with the visitor's sign-in; null: unknown
 */
export const sharedSceneVersion = async (fileId: string): Promise<string | null> => {
  try {
    const res = await fetch(`${AUTH_BASE}/api/public/${encodeURIComponent(fileId)}/version`);
    if (res.ok) {
      return (await res.json()).version ?? null;
    }
  } catch {}
  if (!(await getToken().catch(() => null))) {
    return null;
  }
  const file = await fetchSharedFile(fileId).catch(() => null);
  return file?.md5Checksum ?? null;
};

/** `version`: that version of a public scene (past the edge cache's copy) */
export const readSharedScene = async (fileId: string, { version }: { version?: string } = {}): Promise<SharedSceneAnswer> => {
  // public scenes: through Kurviq's edge cache (the page preloads this very URL), no sign-in needed
  const versionQuery = version ? `?v=${version}` : "";
  const publicCopy = fetch(`${AUTH_BASE}/api/public/${encodeURIComponent(fileId)}${versionQuery}`)
    .then(async (res) =>
      res.ok
        ? { json: await res.text(), name: decodeURIComponent(res.headers.get("X-Kurviq-Name") || ""), by: decodeURIComponent(res.headers.get("X-Kurviq-By") || "") }
        : null,
    )
    .catch(() => null);
  const signedIn = getToken().catch(() => null);
  const fetchAccessibleFile = async (value: string | null) => {
    if (!value) return null;
    try {
      return await fetchSharedFile(fileId);
    } catch {
      return null;
    }
  };
  const access = signedIn.then(fetchAccessibleFile);
  const pub = await publicCopy;
  if (pub) {
    // don't wait for the access check longer than a moment
    const file = await Promise.race([access, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
    return { scene: { json: pub.json, name: pub.name || (file ? sceneNameOf(file) ?? "" : ""), ...(pub.by ? { by: pub.by } : {}), public: true, canEdit: !!file?.capabilities?.canEdit } };
  }
  if (!(await signedIn)) {
    return { signIn: true };
  }
  const file = await access;
  if (!file) {
    return { needsAccess: true };
  }
  const name = sceneNameOf(file);
  if (!name) {
    return { missing: true };
  }
  const res = await download(file.id);
  if (res.status !== 200) {
    return { missing: true };
  }
  return { scene: { json: res.text, name, public: !!file.permissionIds?.includes("anyoneWithLink"), canEdit: !!file.capabilities?.canEdit } };
};

// -----------------------------------------------------------------------------
// Google's Picker: the user picks a file, which lets Kurviq open it
// (drive.file); with a file id it shows just that one file
// -----------------------------------------------------------------------------

let gapiScript: Promise<void> | null = null;
const gapiModules = new Map<string, Promise<void>>();

/** a module of Google's api.js ("picker", "drive-share"), loaded once */
const loadGapi = (module: string, what: string) => {
  gapiScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gapiScript = null;
      reject(offlineError(`${what} could not be loaded`));
    };
    document.head.appendChild(script);
  });
  let loaded = gapiModules.get(module);
  if (!loaded) {
    loaded = gapiScript.then(
      () =>
        new Promise<void>((resolve, reject) =>
          (window as any).gapi.load(module, { callback: () => resolve(), onerror: () => reject(new Error(`${what} could not be loaded`)) }),
        ),
    );
    loaded.catch(() => gapiModules.delete(module));
    gapiModules.set(module, loaded);
  }
  return loaded;
};

const loadPicker = () => loadGapi("picker", "Google Picker");

/**
 * Drive's own share dialog over the page (Google's ShareClient): invitations
 * sent from it are Google's normal ones (shares through the API land in the
 * recipient's Drive spam). Needs third-party cookies and the browser signed in
 * to Google with the same account; there is no "closed" event.
 */
export const showDriveShareDialog = async (fileId: string) => {
  const value = await getToken();
  if (!value) {
    throw notConnectedError();
  }
  await loadGapi("drive-share", "Google's share dialog");
  const client = new (window as any).gapi.drive.share.ShareClient();
  client.setOAuthToken(value);
  client.setItemIds([fileId]);
  client.showSettingsDialog();
};

export const pickerAvailable = () => !!import.meta.env.VITE_APP_GOOGLE_BROWSER_KEY && !!google.projectNumber;

/**
 * the picked file ids (empty: cancelled). shared: Drive's "Shared with me",
 * several at once (no email or link needed: picking lets Kurviq open them)
 */
export const pickFiles = async ({ fileId, shared }: { fileId?: string; shared?: boolean } = {}): Promise<string[]> => {
  const value = await getToken();
  if (!value) {
    throw notConnectedError();
  }
  await loadPicker();
  const pickerApi = (window as any).google.picker;
  const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS).setMimeTypes(SCENE_MIME).setIncludeFolders(false);
  if (fileId) {
    view.setFileIds(fileId);
  }
  if (shared) {
    view.setOwnedByMe(false);
  }
  return new Promise<string[]>((resolve) => {
    const pickerTitle = () => {
      if (fileId) {
        return "Allow Kurviq to open this scene";
      }
      if (shared) {
        return "Scenes shared with you";
      }
      return "Open a scene from Google Drive";
    };

    const builder = new pickerApi.PickerBuilder();
    if (shared) {
      builder.enableFeature(pickerApi.Feature.MULTISELECT_ENABLED);
    }
    const picker = builder
      .addView(view)
      .setOAuthToken(value)
      .setDeveloperKey(import.meta.env.VITE_APP_GOOGLE_BROWSER_KEY)
      .setAppId(google.projectNumber)
      .setTitle(pickerTitle())
      .setCallback((data: any) => {
        const action = data[pickerApi.Response.ACTION];
        if (action === pickerApi.Action.PICKED) {
          // Kurviq may open them now: list them right away
          sharedList = null;
          resolve((data[pickerApi.Response.DOCUMENTS] || []).map((doc: any) => String(doc[pickerApi.Document.ID])));
        } else if (action === pickerApi.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
};
