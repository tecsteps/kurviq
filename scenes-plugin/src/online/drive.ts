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

import { createStore, del, get, keys, set } from "idb-keyval";

import { isSceneName } from "../../../scenes-mcp/sceneName.mjs";
import { createStore as createValueStore } from "../externalStore";
import { accountKey, spaceAccountOf } from "../spaces";
import { currentSpace, ownSceneList, SPACE_KEY } from "../storage";
import { FOLDER_COUNT_PROPERTY, folderCountOf, groupSharedFolders } from "./folderAccess";
import type { FolderGroup } from "./folderAccess";
import { BYLINE_MAX_BYTES, BYLINE_PROPERTY, MOVED_PROPERTY, SCENE_MIME, cleanByline, cutBytes, movedNote, parseMovedNote } from "./driveNames";
import { linkTargetOf } from "./linkTarget";
import { slugify } from "./pubName";
import { endDatePatch, generalAccessChanges, organizationDomain } from "./shareAccess";
import type { GeneralAccess } from "./shareAccess";

import google from "../../../online/google.json";

import { md5 } from "./md5";

import type { ApiError, RemoteInfo, RemoteScene, SceneVersion } from "../api";

/** Google's Drive API; a dev build for the fake Google (online/worker/fakeGoogle.ts) sets VITE_APP_GOOGLE_API_BASE */
const GOOGLE_BASE = (import.meta.env.VITE_APP_GOOGLE_API_BASE || "").replace(/\/$/, "");
export const API = GOOGLE_BASE ? `${GOOGLE_BASE}/drive/v3` : "https://www.googleapis.com/drive/v3";
const UPLOAD = GOOGLE_BASE ? `${GOOGLE_BASE}/upload/drive/v3` : "https://www.googleapis.com/upload/drive/v3";
export { SCENE_MIME } from "./driveNames";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const EXTENSION = ".excalidraw";
export const FOLDER_NAME = "Kurviq";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,headRevisionId,permissionIds,capabilities(canEdit,canShare,canComment),appProperties,owners(displayName,emailAddress)";

/** where sign-in lives: this site (online), or kurviq.com (the local install) */
const AUTH_BASE = (import.meta.env.VITE_APP_KURVIQ_AUTH_URL || "").replace(/\/$/, "");
const IS_LOCAL_INSTALL = AUTH_BASE !== "";

/** the space of a scene someone shared: "f:<fileId>" (see ../storage.ts) */
const fileSpace = (fileId: string) => `f:${fileId}`;
export const sharedFileId = currentSpace.startsWith("f:") ? currentSpace.slice(2) : null;
/**
 * The space of a folder someone shared ("d:<folderId>"): its scenes, with
 * this person's own Drive access, which reaches only the scenes they picked
 * in Google's Picker (drive.file), or all of them if picking the folder
 * grants its files (see sharedFolders). Nothing goes through Kurviq's server.
 */
const folderSpace = (folderId: string) => `d:${folderId}`;
export const sharedFolderId = currentSpace.startsWith("d:") ? currentSpace.slice(2) : null;

/** the shared folder a scene's file is in, as far as this browser knows (the share panel names it) */
const FOLDER_FILES_KEY = "kurviq-folder-files";
const FOLDER_FILES_MAX = 2000;

const folderFiles = (): Record<string, string> => {
  try {
    const known = JSON.parse(localStorage.getItem(FOLDER_FILES_KEY) || "{}");
    return known && typeof known === "object" ? known : {};
  } catch {
    return {};
  }
};

export const folderOfFile = (fileId: string): string | null => folderFiles()[fileId] ?? null;

/** a shared folder's files, remembered (the newest win when there are too many) */
const rememberFolderFiles = (folderId: string, fileIds: string[]) => {
  const known = folderFiles();
  if (fileIds.every((fileId) => known[fileId] === folderId)) {
    return;
  }
  for (const fileId of fileIds) {
    delete known[fileId];
    known[fileId] = folderId;
  }
  const entries = Object.entries(known).slice(-FOLDER_FILES_MAX);
  try {
    localStorage.setItem(FOLDER_FILES_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
};

// -----------------------------------------------------------------------------
// connection: who is signed in (cookie, via the Worker)
// -----------------------------------------------------------------------------

/** sub: Google's stable account id (live sync keys its queues by it; older Workers don't send it) */
export type GoogleUser = { email: string; name: string | null; avatarUrl: string | null; sub?: string };

type ConnectionState = {
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

const connectionStore = createValueStore<ConnectionState>({ user: undefined, drive: false, error: null });
let state = connectionStore.get();

const setConnection = (patch: Partial<ConnectionState>) => {
  state = { ...state, ...patch };
  connectionStore.set(state);
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
  subscribe: connectionStore.subscribe,
  getState: connectionStore.get,
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

/**
 * A POST to Kurviq's Worker with this browser's sign-in: the cookie, or the
 * local install's sealed session in the JSON body (never in a URL). null:
 * the local install has no session. Throws (offline) when the Worker can't
 * be reached.
 */
const authFetch = async (path: string, body?: Record<string, unknown>): Promise<Response | null> => {
  const session = IS_LOCAL_INSTALL ? localSession() : null;
  if (IS_LOCAL_INSTALL && !session) {
    return null;
  }
  const payload = session ? { ...body, session } : body;
  try {
    return await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      credentials: IS_LOCAL_INSTALL ? "omit" : "same-origin",
      ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
    });
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
};

/** the local install's sealed session, renewed by the Worker on use */
const keepLocalSession = (session: unknown) => {
  if (IS_LOCAL_INSTALL && typeof session === "string") {
    try {
      localStorage.setItem(LOCAL_SESSION_KEY, session);
    } catch {}
  }
};

const signedOut = () => {
  token = null;
  setConnection({ user: null, drive: false, error: null });
  return null;
};

const requestToken = async (): Promise<string | null> => {
  const res = await authFetch("/auth/token");
  if (!res) {
    return signedOut();
  }
  if (!res.ok) {
    throw offlineError(res.status === 503 ? "Google not reachable" : `Kurviq server error (${res.status})`);
  }
  const body = await res.json();
  if (body.connected === false) {
    clearLocalSession();
    return signedOut();
  }
  keepLocalSession(body.session);
  token = { value: body.token, expiresAt: Date.parse(body.expiresAt) };
  if (state.user?.email !== body.user?.email || state.drive !== !!body.drive) {
    setConnection({ user: body.user, drive: !!body.drive, error: null });
  } else if (state.error) {
    setConnection({ error: null });
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
  folderRequest = null;
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
  const logout = () => authFetch("/auth/logout").catch(() => null);
  await (navigator.locks ? navigator.locks.request("kurviq-google-token", logout) : logout());
  clearLocalSession();
  forgetConnection();
  tabsChannel?.postMessage("disconnected");
};

/**
 * A POST to Kurviq's Worker with this browser's sign-in: the cookie, or the
 * local install's sealed session in the body (never in a URL). Live sync's
 * tickets, access-proof renewals and reconcile tokens use it.
 */
export const authPost = async (path: string, body: Record<string, unknown> = {}) => {
  const res = await authFetch(path, body);
  if (!res) {
    throw notConnectedError();
  }
  const answer = await res.json().catch(() => ({}));
  keepLocalSession(answer.session);
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

/** the WebSocket of a scene's relay (online/pen.ts; on kurviq.com also for the local install) */
export const relaySocketUrl = (fileId: string, ticket: string) => {
  const base = IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin;
  return `${base.replace(/^http/, "ws")}/relay/${encodeURIComponent(fileId)}/live?ticket=${encodeURIComponent(ticket)}`;
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
  // an object goes as JSON; text and bytes as they are, with their content type
  const isJson = body !== undefined && !(typeof body === "string" || body instanceof Blob || body instanceof Uint8Array);
  const type = isJson ? "application/json" : contentType;
  const payload = isJson ? JSON.stringify(body) : (body as BodyInit | undefined);

  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    if (!value || otherAccount()) {
      throw notConnectedError();
    }
    let res: Response;
    try {
      res = await fetch(url.startsWith("https://") || url.startsWith(UPLOAD) ? url : `${API}${url}`, {
        method,
        cache: "no-store",
        headers: { Authorization: `Bearer ${value}`, ...(type ? { "Content-Type": type } : {}) },
        body: payload,
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
  return data;
};

const encodeBytes = (json: string) => new TextEncoder().encode(json);

// -----------------------------------------------------------------------------
// versions kept in this browser: a merge needs the version a scene is based
// on, and Drive only hands out old versions that were kept ("keep forever")
// -----------------------------------------------------------------------------

const versionStore = createStore("kurviq-drive-versions", "versions");
/**
 * per file: the versions kept, newest first, and when the file was last read
 * or written here (a small index, so the scenes themselves are never read to
 * prune); older entries are a plain list
 */
const versionIndex = createStore("kurviq-drive-version-index", "index");
type VersionEntry = { kept: string[]; at: number };
/** versions kept per file (the newest; the base of a merge is among them) */
const KEEP_VERSIONS = 4;
/** a file not read or written here for this long loses its kept versions (deleted, or nobody opens it any more) */
const UNUSED_VERSIONS_MS = 90 * 24 * 3600 * 1000;

const versionEntry = (value: string[] | VersionEntry | undefined): VersionEntry => {
  if (Array.isArray(value)) {
    return { kept: value, at: 0 };
  }
  return value ?? { kept: [], at: 0 };
};

const keepVersion = async (fileId: string, checksum: string, json: string) => {
  try {
    await set(`${fileId}:${checksum}`, json, versionStore);
    const { kept: before } = versionEntry(await get(fileId, versionIndex));
    const kept = [checksum, ...before.filter((other) => other !== checksum)];
    await set(fileId, { kept: kept.slice(0, KEEP_VERSIONS), at: Date.now() } satisfies VersionEntry, versionIndex);
    await Promise.all(kept.slice(KEEP_VERSIONS).map((other) => del(`${fileId}:${other}`, versionStore)));
  } catch {}
};

/** a file's kept versions go (the scene was deleted) */
const forgetVersions = async (fileId: string) => {
  try {
    const { kept } = versionEntry(await get(fileId, versionIndex));
    await Promise.all(kept.map((checksum) => del(`${fileId}:${checksum}`, versionStore)));
    await del(fileId, versionIndex);
  } catch {}
};

let versionsPruned = false;

/**
 * Once per tab: the kept versions of files not read or written in this
 * browser for 90 days go (scenes deleted elsewhere, shared scenes nobody
 * opens any more; any account's, as the stores are the browser's).
 */
const pruneVersions = async (now = Date.now()) => {
  if (versionsPruned) {
    return;
  }
  versionsPruned = true;
  try {
    for (const fileId of await keys<string>(versionIndex)) {
      const raw = await get<string[] | VersionEntry>(fileId, versionIndex); // NOSONAR S9382: one entry at a time, in the background
      if (Array.isArray(raw)) {
        // kept before entries had a time: from now on
        await set(fileId, { kept: raw, at: now } satisfies VersionEntry, versionIndex); // NOSONAR S9382: one entry at a time, in the background
      } else if (now - versionEntry(raw).at > UNUSED_VERSIONS_MS) {
        await forgetVersions(fileId); // NOSONAR S9382: one entry at a time, in the background
      }
    }
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
  capabilities?: { canEdit?: boolean; canShare?: boolean; canComment?: boolean };
  appProperties?: Record<string, string>;
  owners?: { displayName?: string; emailAddress?: string }[];
};

type Listing = { files: Map<string, DriveFile>; fetchedAt: number };

let listing: Listing | null = null;
const remote: RemoteInfo = { online: null, lastFetchAt: null, lastError: null };
/** a shared scene's space: Drive lets this user read it, not change it */
let readOnly: string | null = null;

/** the listing is stale (a scene was saved, renamed, deleted or shared): the next one asks Drive */
const forgetListing = () => {
  listing = null;
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

/**
 * A shared folder's space: may this person edit in it? The folder says so
 * when it was picked; else the scenes picked from it do.
 */
const sharedFolderReadOnly = async (folder: string, files: Map<string, DriveFile>) => {
  const res = await drive(`/files/${folder}?fields=id,capabilities(canEdit,canAddChildren),owners(displayName,emailAddress)&supportsAllDrives=true`);
  const first = [...files.values()][0];
  if (res.status !== 200 && !first) {
    setConnection({ lost: "This folder is not shared with you (any more), or you haven't picked it in Google Drive yet" });
    throw notConnectedError();
  }
  setConnection({ lost: null });
  const owner = res.status === 200 ? ownerName(res.data) : ownerName(first);
  const canEdit = res.status === 200 ? res.data.capabilities?.canEdit !== false : first.capabilities?.canEdit !== false;
  return canEdit ? null : `${owner} shared this folder with you to view`;
};

/** the user's own Kurviq folder, or a shared folder (with the person's own access) */
const fetchFolderSpace = async (files: Map<string, DriveFile>) => {
  await fetchFolderScenes(files);
  if (sharedFolderId) {
    rememberFolderFiles(sharedFolderId, [...files.values()].map((file) => file.id));
    readOnly = await sharedFolderReadOnly(sharedFolderId, files);
  } else {
    noteFolderScenes(files.size).catch(() => {});
    pruneVersions().catch(() => {});
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

/** a scene's file as Drive has it now: a known file is asked for alone, else the folder is listed */
const locate = async (name: string, force = true) => {
  const known = listing?.files.get(name);
  if (force && known && !sharedFileId) {
    const res = await drive(`/files/${known.id}?fields=${FILE_FIELDS},trashed&supportsAllDrives=true`);
    if (res.status === 200 && !res.data.trashed && sceneNameOf(res.data) === name) {
      listing?.files.set(name, res.data);
      return res.data as DriveFile;
    }
  }
  return (await fetchScenes(force)).files.get(name) ?? null;
};

/** Drive refused a write to a shared scene because the user's access changed (not, e.g., because the owner's Drive is full) */
const lostAccess = (res: DriveResponse) => {
  const reason = res.data?.error?.errors?.[0]?.reason;
  return res.status === 404 || (res.status === 403 && (reason === "insufficientFilePermissions" || reason === "forbidden"));
};

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

const isAgent = (source?: string) => typeof source === "string" && source.startsWith("agent");

/**
 * An agent's scene (a whole drawing from save_scene, or an edit) carries the
 * custom fonts its elements use, as the app's own saves do: people opening
 * the file see them before the owner's app saves it again. Fonts this tab
 * doesn't know stay as the agent sent them.
 */
const withAgentFonts = async (json: string, data: any, source?: string) => {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  if (!isAgent(source) || !elements.length) {
    return json;
  }
  const { mergeFontLists, withFonts } = await import("../fonts");
  // withFonts appends the used fonts to a serialized scene: here to a minimal one, to read them
  const used = JSON.parse(withFonts('{"elements":[]}', elements)).kurviqFonts;
  const given = Array.isArray(data.kurviqFonts) ? data.kurviqFonts : [];
  const fonts = mergeFontLists(given, used);
  if (!fonts || fonts.length === given.length) {
    return json;
  }
  return JSON.stringify({ ...data, kurviqFonts: fonts }, null, 2);
};

const download = (fileId: string, revision?: string) =>
  drive(revision ? `/files/${fileId}/revisions/${revision}?alt=media` : `/files/${fileId}?alt=media&supportsAllDrives=true`, { raw: true });

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
// the pen's mark on a scene's file (online/pen.ts): appProperties.kurviqPen,
// metadata only (no new version, the content's checksum stays)
// -----------------------------------------------------------------------------

export const PEN_PROPERTY = "kurviqPen";

/** the file's pen mark as stored (null: none) and its modifiedTime */
export const readPenMark = async (fileId: string): Promise<{ mark: string | null; modifiedTime: string | null }> => {
  const res = await drive(`/files/${fileId}?fields=appProperties,modifiedTime&supportsAllDrives=true`);
  if (res.status !== 200) {
    fail(res, "The scene's file could not be read");
  }
  return { mark: res.data?.appProperties?.[PEN_PROPERTY] ?? null, modifiedTime: res.data?.modifiedTime ?? null };
};

/** sets (or with null removes) the file's pen mark */
export const writePenMark = async (fileId: string, mark: string | null) => {
  const res = await drive(`/files/${fileId}?fields=id&supportsAllDrives=true`, { method: "PATCH", body: { appProperties: { [PEN_PROPERTY]: mark } } });
  if (res.status !== 200) {
    fail(res, "The scene's pen mark could not be written");
  }
};

// -----------------------------------------------------------------------------
// "moved to …": a scene moved to another home leaves this note on its old
// file (appProperties.kurviqMoved = "<home> <link>", metadata only) before
// the file goes to the bin, so a link to it can point to the new place
// -----------------------------------------------------------------------------

export const writeMovedNote = async (fileId: string, home: string, link: string) => {
  const value = movedNote(home, link);
  if (value === null) {
    throw httpError(400, "The new place's link is too long for a note on the old file");
  }
  const res = await drive(`/files/${fileId}?fields=id&supportsAllDrives=true`, { method: "PATCH", body: { appProperties: { [MOVED_PROPERTY]: value } } });
  if (res.status !== 200) {
    fail(res, "The note on the old file could not be written");
  }
};

export const readMovedNote = async (fileId: string) => {
  const res = await drive(`/files/${fileId}?fields=appProperties,modifiedTime&supportsAllDrives=true`);
  if (res.status !== 200) {
    fail(res, "The scene's file could not be read");
  }
  const note = parseMovedNote(res.data?.appProperties?.[MOVED_PROPERTY]);
  return note ? { ...note, at: (res.data?.modifiedTime as string | undefined) ?? null } : null;
};


/** a scene's content to Drive: a new version of `file`, or a new file in the Kurviq folder (with Drive's preview and search words, if any) */
const uploadScene = async (file: DriveFile | null | undefined, name: string, json: string, hints: object | null): Promise<DriveResponse> => {
  if (file) {
    // (Drive has no conditional write: the check before leaves a moment in
    // which someone else's save is overwritten; their app merges it back)
    const upload = hints ? multipart({ contentHints: hints }, json) : { body: json, contentType: SCENE_MIME };
    return drive(`${UPLOAD}/files/${file.id}?uploadType=${hints ? "multipart" : "media"}&fields=${FILE_FIELDS}&supportsAllDrives=true`, {
      method: "PATCH",
      body: upload.body,
      contentType: upload.contentType,
    });
  }
  const upload = multipart(
    { name: `${name}${EXTENSION}`, mimeType: SCENE_MIME, parents: [await folderId()], appProperties: { kurviq: "scene", fmt: "1" }, ...(hints ? { contentHints: hints } : {}) },
    json,
  );
  return drive(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, { method: "POST", body: upload.body, contentType: upload.contentType });
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
  save: async (name: string, given: string, baseMd5?: string, source?: string) => {
    checkName(name);
    const json = await withAgentFonts(given, validateSceneContent(name, given), source);
    requireWritable();
    const checksum = md5(encodeBytes(json));
    const file = await locate(name);
    checkBase(name, file?.md5Checksum, baseMd5);
    if (file?.md5Checksum === checksum) {
      return { md5: checksum, driveRevision: null, changed: false };
    }
    // Drive's preview and search words (contentHints.ts), in the same upload
    const { contentHints } = await import("./contentHints");
    const hints = await contentHints.forSave(name, json, checksum);
    if (!file && sharedFileId) {
      throw httpError(403, "This is someone's shared scene: new scenes are made in your own scenes");
    }
    let res = await uploadScene(file, name, json, hints);
    if (res.status === 400 && hints) {
      // Drive refused the preview or the search words: the scene is saved without them
      console.warn(`[drive] "${name}": Drive refused the preview / search text, saved without them`, res.data);
      res = await uploadScene(file, name, json, null);
    }
    if (sharedFileId && lostAccess(res)) {
      readOnly = "you can't change this scene any more (its owner changed the sharing)";
      throw readOnlyError(readOnly);
    }
    if (res.status !== 200) {
      fail(res, `Saving "${name}" to Google Drive failed`);
    }
    const saved = res.data as DriveFile;
    // the listing knows the saved file (no new listing for the next save)
    listing?.files.set(name, saved);
    await keepVersion(saved.id, checksum, json);
    contentHints.afterSave(name, checksum, (late) => drive(`/files/${saved.id}?fields=id&supportsAllDrives=true`, { method: "PATCH", body: { contentHints: late } }));
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
    checkBase(name, file.md5Checksum, baseMd5 ?? undefined);
    const res = await drive(`/files/${file.id}?fields=id`, { method: "PATCH", body: { trashed: true } });
    if (res.status !== 200) {
      fail(res, `Deleting "${name}" failed`);
    }
    listing?.files.delete(name);
    await forgetVersions(file.id);
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
    const res = await drive(`/files/${file.id}?fields=id&supportsAllDrives=true`, {
      method: "PATCH",
      body: { name: `${to}${EXTENSION}` },
    });
    if (res.status !== 200) {
      fail(res, "Rename failed");
    }
    listing?.files.delete(from);
    listing?.files.set(to, { ...file, name: `${to}${EXTENSION}` });
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
    await forgetVersions(fileId);
  },

  /** the Drive file of a scene of this space, for the share panel: may this user change who has access? */
  fileOf: async (name: string) => {
    const file = await locate(name, false);
    return file ? { id: file.id, canShare: file.capabilities?.canShare !== false, owner: ownerName(file) } : null;
  },
};

// -----------------------------------------------------------------------------
// sharing (Drive permissions)
// -----------------------------------------------------------------------------

type Role = "reader" | "commenter" | "writer" | "owner" | "fileOrganizer" | "organizer";

export type Permission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: Role;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  photoLink?: string;
  /** the access ends then (Drive removes the permission) */
  expirationTime?: string;
};

export const listPermissions = async (fileId: string): Promise<Permission[]> => {
  const res = await drive(
    `/files/${fileId}/permissions?fields=permissions(id,type,role,emailAddress,domain,displayName,photoLink,expirationTime,deleted)&supportsAllDrives=true`,
  );
  if (res.status !== 200) {
    fail(res, "Who has access could not be read");
  }
  return (res.data.permissions as (Permission & { deleted?: boolean })[]).filter((permission) => !permission.deleted);
};

export const changeRole = async (fileId: string, permissionId: string, role: "reader" | "commenter" | "writer") => {
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

/** the organization the signed-in user can share with (Google Workspace), or null (a personal Gmail account) */
export const userOrganization = () => organizationDomain(state.user?.email);

/**
 * General access: only the people added, anyone with the link (can view,
 * comment or edit), or anyone at the user's organization with the link
 * (Drive's "domain" permission, not findable in Drive's search)
 */
export const setLinkAccess = async (fileId: string, access: GeneralAccess) => {
  const changes = generalAccessChanges(await listPermissions(fileId), access, userOrganization());
  for (const change of changes) {
    if ("remove" in change) {
      await removeAccess(fileId, change.remove); // NOSONAR S9382: one permission at a time, in order
    } else if ("patch" in change) {
      await changeRole(fileId, change.patch, change.role); // NOSONAR S9382: one permission at a time, in order
    } else {
      const res = await drive(`/files/${fileId}/permissions?supportsAllDrives=true&fields=id`, { method: "POST", body: change.create }); // NOSONAR S9382: one permission at a time, in order
      if (res.status !== 200) {
        fail(res, "Could not change who can open the link");
      }
    }
  }
  forgetListing();
};

/** the end of a person's access to view or comment (a day, "2026-11-30"; null: no end date) */
export const setAccessEnd = async (fileId: string, permission: Pick<Permission, "id" | "role">, date: string | null) => {
  const { query, body } = endDatePatch(permission.role, date);
  const res = await drive(`/files/${fileId}/permissions/${permission.id}?supportsAllDrives=true&fields=id,expirationTime${query}`, { method: "PATCH", body });
  if (res.status !== 200) {
    fail(res, "Could not change when the access ends");
  }
};

/** the link to a scene for anyone: kurviq.com/s/<fileId>/<readable name> */
export const shareLink = (fileId: string, name: string) => {
  const base = IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin;
  const readable = slugify(name, 60);
  const suffix = readable ? `/${readable}` : "";
  return `${base}/s/${fileId}${suffix}`;
};

// -----------------------------------------------------------------------------
// the author on the public page: only when they choose (Share…), a public property of the file
// -----------------------------------------------------------------------------

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
    body: { properties: { [BYLINE_PROPERTY]: name ? cutBytes(name, BYLINE_MAX_BYTES) : null } },
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
const pubNames = createValueStore(new Map<string, string | null>());
const setPubName = (fileId: string, name: string | null) => pubNames.set(new Map(pubNames.get()).set(fileId, name));

export const pubNameStore = {
  subscribe: pubNames.subscribe,
  /** undefined: not asked yet */
  get: (fileId: string) => pubNames.get().get(fileId),
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
    const files = await listAll(query, FILE_FIELDS, "The scenes shared with you could not be listed").catch((error) => {
      if (error.offline) {
        throw error;
      }
      return [] as DriveFile[];
    });
    return files
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
// Google Drive. Nothing about it is kept on Kurviq's server: the person it is
// shared with picks the folder (or its scenes) once in Google's Picker, and
// their Kurviq lists what that lets it see, with their own access.
// -----------------------------------------------------------------------------

/** the owner's Kurviq notes its scene count on its folder (a private property of Kurviq's) this often at most */
const COUNT_CHECK_MS = 10 * 60_000;
const countKey = () => `kurviq-folder-count:${state.user?.email ?? ""}`;

/**
 * The owner's side: while the Kurviq folder is shared, its number of scenes
 * is noted on it (appProperties.kurviqScenes, Drive metadata: no new version
 * of anything). A guest who sees fewer knows that new scenes wait for a pick
 * ("3 new scenes in this folder: open them").
 */
const noteFolderScenes = async (count: number) => {
  if (sharedFileId || sharedFolderId || !state.user || !state.drive) {
    return;
  }
  let known: { at: number; count: number } | null = null;
  try {
    known = JSON.parse(localStorage.getItem(countKey()) || "null");
  } catch {}
  if (known?.count === count && Date.now() - known.at < COUNT_CHECK_MS) {
    return;
  }
  const folder = await folderId();
  const res = await drive(`/files/${folder}?fields=id,shared,appProperties`);
  if (res.status !== 200) {
    return;
  }
  const noted = res.data.appProperties?.[FOLDER_COUNT_PROPERTY];
  if (res.data.shared === true && noted !== String(count)) {
    await drive(`/files/${folder}?fields=id`, { method: "PATCH", body: { appProperties: { [FOLDER_COUNT_PROPERTY]: String(count) } } });
  }
  try {
    localStorage.setItem(countKey(), JSON.stringify({ at: Date.now(), count }));
  } catch {}
};

export type SharedFolder = FolderGroup;

let folderList: { at: number; value: Promise<SharedFolder[]> } | null = null;

/** every page of a files.list query, with the given fields per file */
const listAll = async (query: string, fields: string, what = "The shared folders could not be listed"): Promise<DriveFile[]> => {
  const all: DriveFile[] = [];
  let pageToken = "";
  do {
    const res = await drive( // NOSONAR S9382: each page needs the preceding page token
      `/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(${fields})&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
    );
    if (res.status !== 200) {
      fail(res, what);
    }
    all.push(...(res.data.files as DriveFile[]));
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);
  return all;
};

/**
 * The folders others shared with this user, as far as Kurviq may see them:
 * folders they picked (with every scene Kurviq may open in them), and scenes
 * they picked out of a folder they didn't pick (grouped by that folder).
 * Asked again after a minute.
 */
export const sharedFolders = (): Promise<SharedFolder[]> => {
  if (folderList && Date.now() - folderList.at < 60_000) {
    return folderList.value;
  }
  const value = (async () => {
    // others' folders and scenes Kurviq may open for this person (drive.file: those they picked, and
    // the files in a picked folder if picking it grants them)
    const [folders, scenes, single] = await Promise.all([
      listAll(`mimeType=${q(FOLDER_MIME)} and not 'me' in owners and trashed=false`, "id,name,owners(displayName,emailAddress),capabilities(canEdit),appProperties"),
      listAll(`mimeType=${q(SCENE_MIME)} and not 'me' in owners and trashed=false`, `${FILE_FIELDS},parents`),
      sharedWithMe(),
    ]);
    return groupSharedFolders(
      folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        owner: ownerName(folder),
        ownerEmail: folder.owners?.[0]?.emailAddress ?? null,
        canEdit: folder.capabilities?.canEdit === true,
        count: folderCountOf(folder.appProperties),
      })),
      scenes
        .map((file) => ({ file, name: sceneNameOf(file) }))
        .filter((entry): entry is { file: DriveFile & { parents?: string[] }; name: string } => !!entry.name && isSceneName(entry.name))
        .map(({ file, name }) => ({
          fileId: file.id,
          name,
          parents: (file as { parents?: string[] }).parents ?? [],
          owner: ownerName(file),
          ownerEmail: file.owners?.[0]?.emailAddress ?? null,
          canEdit: file.capabilities?.canEdit === true,
          modifiedTime: file.modifiedTime ?? null,
        })),
      new Set(single.map((entry) => entry.fileId)),
    );
  })();
  value.catch(() => {
    folderList = null;
  });
  folderList = { at: Date.now(), value };
  return value;
};

/** the folder list is asked again (after a pick) */
export const forgetSharedFolders = () => {
  folderList = null;
  sharedList = null;
};

/**
 * The folder a scene is shared through, for the share panel: "mine" (the
 * user's own Kurviq folder, with who has access to it: they have every scene
 * in it), "theirs" (a folder someone shares with the user), or null (the
 * scene is shared on its own, or the folder isn't shared).
 */
export type FolderSharing =
  | { kind: "mine"; folderId: string; name: string; permissions: Permission[] }
  | { kind: "theirs"; folderId: string; name: string; owner: string; ownerEmail: string | null; role: "writer" | "reader" };

export const folderSharingOf = async (fileId: string): Promise<FolderSharing | null> => {
  const known = sharedFolderId ?? folderOfFile(fileId);
  const theirs = (await sharedFolders().catch((): SharedFolder[] => [])).find(
    (folder) => folder.folderId === known || folder.scenes.some((scene) => scene.fileId === fileId),
  );
  if (theirs) {
    return {
      kind: "theirs",
      folderId: theirs.folderId,
      name: theirs.name,
      owner: theirs.owner,
      ownerEmail: theirs.ownerEmail ?? null,
      role: theirs.role,
    };
  }
  if (sharedFileId || sharedFolderId) {
    return null;
  }
  const own = await folderId();
  const res = await drive(`/files/${fileId}?fields=parents&supportsAllDrives=true`);
  if (res.status !== 200 || !(res.data.parents as string[] | undefined)?.includes(own)) {
    return null;
  }
  return { kind: "mine", folderId: own, name: FOLDER_NAME, permissions: await listPermissions(own) };
};

/** a page of Google Drive as the account signed in to Kurviq */
const asUser = (page: string) => {
  const email = state.user?.email;
  return email ? `${page}?authuser=${encodeURIComponent(email)}` : page;
};

/**
 * The Kurviq folder this tab's scenes are in, in Google Drive: a shared
 * folder's tab links that folder, else the user's own (My Drive while it
 * isn't known yet)
 */
export const ownFolderLink = () => {
  let id: string | null = sharedFolderId;
  if (!id) {
    try {
      id = localStorage.getItem(folderKey());
    } catch {}
  }
  return id ? driveWebLink(id, true) : asUser("https://drive.google.com/drive/my-drive");
};

/** Drive's own page of a file or folder, opened as the account signed in to Kurviq (not the browser's first Google account) */
export const driveWebLink = (id: string, folder = false) =>
  asUser(folder ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view`);

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

/**
 * A scene link whose name the tab's scenes don't have: the scene of that name
 * shared with the user on its own (one they opened in Kurviq once), or in a
 * folder shared with them (or, from a folder's tab, among their own scenes).
 * Answers how to go there (the page reloads into that space), or null: there
 * is none, it is a new scene.
 */
export const sceneElsewhere = async (name: string): Promise<(() => void) | null> => {
  if (sharedFileId || !state.user || !state.drive) {
    return null;
  }
  const [folders, files] = await Promise.all([
    sharedFolders().catch((): SharedFolder[] => []),
    sharedWithMe().catch((): SharedWithMe[] => []),
  ]);
  const own = sharedFolderId ? ownSceneList().map((scene) => scene.name) : [];
  const target = linkTargetOf(name, folders, own, sharedFolderId, files);
  if (!target) {
    return null;
  }
  if (target.kind === "own") {
    return () => enterSpace(null, `/${encodeURIComponent(name)}`);
  }
  if (target.kind === "file") {
    return () => enterSpace(target.fileId, `/s/${target.fileId}/${encodeURIComponent(name)}`);
  }
  return () => enterFolder(target.folderId, name);
};

// -----------------------------------------------------------------------------
// a shared link (kurviq.com/s/<fileId>): public without sign-in (read from
// Drive in the browser with Kurviq's browser API key: the content never
// passes through Kurviq's servers), else with the visitor's own Drive access
// -----------------------------------------------------------------------------

/** Kurviq's browser API key (Picker, and public files without sign-in); set at build time */
const BROWSER_KEY: string = import.meta.env.VITE_APP_GOOGLE_BROWSER_KEY || "";

type SharedScene = {
  json: string;
  name: string;
  /** the version of exactly this content (the MD5 of its bytes, as Drive names it) */
  version: string;
  /** the author, if they chose to be named on the public page */
  by?: string;
  public: boolean;
  /** Drive lets this user change it */
  canEdit: boolean;
  /** Drive lets this user comment on it */
  canComment: boolean;
};

export type SharedSceneAnswer =
  | { scene: SharedScene }
  /** signed in, but Kurviq may not read it yet: the Picker grants it */
  | { needsAccess: true }
  /** not public, not signed in */
  | { signIn: true }
  /** no such file, or no access */
  | { missing: true };

type PublicFile = { name?: string; mimeType?: string; md5Checksum?: string; properties?: Record<string, string> };

const isSceneFile = (file: { name?: string; mimeType?: string }) => file.mimeType === SCENE_MIME || String(file.name).endsWith(EXTENSION);

/** a Drive URL with Kurviq's browser key: works for files shared "anyone with the link" only */
const keyUrl = (fileId: string, query: string) =>
  `${API}/files/${encodeURIComponent(fileId)}?${query}&supportsAllDrives=true&key=${encodeURIComponent(BROWSER_KEY)}`;

/** a public scene's metadata, without sign-in; null: not public (or no key in this build, or offline) */
const publicFile = async (fileId: string): Promise<PublicFile | null> => {
  if (!BROWSER_KEY) {
    return null;
  }
  try {
    const res = await fetch(keyUrl(fileId, "fields=name,mimeType,md5Checksum,properties"), { cache: "no-store" });
    const file: PublicFile | null = res.ok ? await res.json() : null;
    return file && isSceneFile(file) ? file : null;
  } catch {
    return null;
  }
};

/** a public scene's content and the MD5 of its bytes (the version loaded); null: not readable */
const publicContent = async (fileId: string): Promise<{ json: string; version: string } | null> => {
  try {
    const res = await fetch(keyUrl(fileId, "alt=media"), { cache: "no-store" });
    if (!res.ok) {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { json: new TextDecoder().decode(bytes), version: md5(bytes) };
  } catch {
    return null;
  }
};

/** a shared scene's current version (Drive's MD5 of it): public ones without sign-in, else with it; null: unknown */
export const sharedSceneVersion = async (fileId: string): Promise<string | null> => {
  const pub = await publicFile(fileId);
  if (pub?.md5Checksum) {
    return pub.md5Checksum;
  }
  if (!(await getToken().catch(() => null))) {
    return null;
  }
  const file = await fetchSharedFile(fileId).catch(() => null);
  return file?.md5Checksum ?? null;
};

/** the file as the signed-in visitor may open it (null: not signed in, or no access) */
const accessibleFile = async (fileId: string) => {
  if (!(await getToken().catch(() => null))) {
    return { signedIn: false, file: null };
  }
  try {
    return { signedIn: true, file: await fetchSharedFile(fileId) };
  } catch {
    return { signedIn: true, file: null };
  }
};

/** a public scene, with what the signed-in visitor may do with it (asked for a moment at most) */
const readPublicScene = async (fileId: string, pub: PublicFile, access: Promise<{ file: DriveFile | null }>): Promise<SharedSceneAnswer | null> => {
  const content = await publicContent(fileId);
  if (!content) {
    return null;
  }
  const { file } = await Promise.race([access, new Promise<{ file: null }>((resolve) => setTimeout(() => resolve({ file: null }), 1500))]);
  const by = cleanByline(pub.properties?.[BYLINE_PROPERTY]);
  const name = String(pub.name ?? "").replace(/\.excalidraw$/, "");
  return {
    scene: {
      json: content.json,
      version: content.version,
      name: name || (file ? sceneNameOf(file) ?? "" : ""),
      ...(by ? { by } : {}),
      public: true,
      canEdit: !!file?.capabilities?.canEdit,
      canComment: !!file?.capabilities?.canComment,
    },
  };
};

/**
 * A shared scene: a public one straight from Drive (no sign-in), else with the
 * visitor's own access. The answer's version is the one of the content read,
 * so a viewer compares Drive's version with what it actually shows.
 */
export const readSharedScene = async (fileId: string): Promise<SharedSceneAnswer> => {
  const access = accessibleFile(fileId);
  const pub = await publicFile(fileId);
  const shown = pub ? await readPublicScene(fileId, pub, access) : null;
  if (shown) {
    return shown;
  }
  const { signedIn, file } = await access;
  if (!signedIn) {
    return { signIn: true };
  }
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
  return {
    scene: {
      json: res.text,
      version: md5(encodeBytes(res.text)),
      name,
      public: !!file.permissionIds?.includes("anyoneWithLink"),
      canEdit: !!file.capabilities?.canEdit,
      canComment: !!file.capabilities?.canComment,
    },
  };
};

// -----------------------------------------------------------------------------
// Google's Picker: the user picks a file, which lets Kurviq open it
// (drive.file); with a file id it shows just that one file
// -----------------------------------------------------------------------------

let picker: Promise<void> | null = null;

/** Google's api.js and its Picker, loaded once (again after a failure) */
const loadPicker = () => {
  picker ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => (window as any).gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Google Picker could not be loaded")) });
    script.onerror = () => reject(offlineError("Google Picker could not be loaded"));
    document.head.appendChild(script);
  }).catch((error) => {
    picker = null;
    throw error;
  });
  return picker;
};

/** a dev build against the fake Google: its Picker answers with what a test queued (online/worker/fakeGoogle.ts) */
const IS_FAKE_GOOGLE = GOOGLE_BASE !== "";

export const pickerAvailable = () => (!!BROWSER_KEY && !!google.projectNumber) || IS_FAKE_GOOGLE;

const fakePick = async (token: string): Promise<string[]> => {
  const res = await fetch(`${GOOGLE_BASE}/picker`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const answer = res.ok ? await res.json() : { ids: [] };
  return Array.isArray(answer.ids) ? answer.ids.map(String) : [];
};

type PickOptions = {
  /** just this file ("Allow Kurviq to open it") */
  fileId?: string;
  /** Drive's "Shared with me", several at once */
  shared?: boolean;
  /** searched for already (a scene link's name) */
  query?: string;
  /** shared folders can be picked too (a folder someone shared: Kurviq then lists its scenes) */
  folders?: boolean;
  /** one file only (default: several where it makes sense, see pickFiles) */
  single?: boolean;
  /** the scenes in this folder, several at once ("open the new scenes in this folder") */
  parent?: string;
};

const pickerTitle = ({ fileId, shared, folders, parent }: PickOptions) => {
  if (fileId) {
    return "Allow Kurviq to open this scene";
  }
  if (parent) {
    return "Pick the scenes of this folder";
  }
  if (folders) {
    return "Scenes and Kurviq folders shared with you";
  }
  return shared ? "Scenes shared with you" : "Open a scene from Google Drive";
};

/** the Picker's view for these options (Google's picker API) */
const pickerView = (pickerApi: any, { fileId, shared, query, folders, parent }: PickOptions) => {
  const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS);
  if (folders) {
    view.setMimeTypes(`${SCENE_MIME},${FOLDER_MIME}`).setIncludeFolders(true).setSelectFolderEnabled(true);
  } else {
    view.setMimeTypes(SCENE_MIME).setIncludeFolders(false);
  }
  if (fileId) {
    view.setFileIds(fileId);
  }
  if (parent) {
    view.setParent(parent);
  }
  if (shared && !parent) {
    view.setOwnedByMe(false);
  }
  if (query) {
    view.setQuery(query);
  }
  return view;
};

/**
 * the picked file (and folder) ids (empty: cancelled). Picking lets Kurviq
 * open them (drive.file): no email or link needed.
 */
export const pickFiles = async (options: PickOptions = {}): Promise<string[]> => {
  const value = await getToken();
  if (!value) {
    throw notConnectedError();
  }
  const picked = (ids: string[]) => {
    // Kurviq may open them now: list them right away
    if (ids.length) {
      forgetSharedFolders();
    }
    return ids;
  };
  if (IS_FAKE_GOOGLE) {
    return picked(await fakePick(value));
  }
  await loadPicker();
  const pickerApi = (window as any).google.picker;
  return new Promise<string[]>((resolve) => {
    const builder = new pickerApi.PickerBuilder();
    if ((options.shared || options.folders || options.parent) && !options.single) {
      builder.enableFeature(pickerApi.Feature.MULTISELECT_ENABLED);
    }
    const picker = builder
      .addView(pickerView(pickerApi, options))
      .setOAuthToken(value)
      .setDeveloperKey(BROWSER_KEY)
      .setAppId(google.projectNumber)
      .setTitle(pickerTitle(options))
      .setCallback((data: any) => {
        const action = data[pickerApi.Response.ACTION];
        if (action === pickerApi.Action.PICKED) {
          resolve(picked((data[pickerApi.Response.DOCUMENTS] || []).map((doc: any) => String(doc[pickerApi.Document.ID]))));
        } else if (action === pickerApi.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
};

// -----------------------------------------------------------------------------
// Drive's own comments on a file: the mailbox of Drive's commenters while no
// editor is there to take their comments into the scene (../comments/mailbox.ts)
// -----------------------------------------------------------------------------

export type DriveComment = {
  id: string;
  content: string;
  /** Google gives the address only sometimes (not documented): the name always */
  author: { displayName?: string; emailAddress?: string; me?: boolean };
  resolved?: boolean;
  deleted?: boolean;
};

const COMMENT_FIELDS = "id,content,author(displayName,emailAddress,me),resolved,deleted";

/** the file's Drive comments (not the deleted ones), oldest first */
export const listDriveComments = async (fileId: string): Promise<DriveComment[]> => {
  const all: DriveComment[] = [];
  let pageToken = "";
  do {
    const res = await drive( // NOSONAR S9382: each page needs the preceding page token
      `/files/${encodeURIComponent(fileId)}/comments?fields=nextPageToken,comments(${COMMENT_FIELDS})&pageSize=100${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
    );
    if (res.status !== 200) {
      fail(res, "The comments in Google Drive could not be read");
    }
    all.push(...((res.data.comments ?? []) as DriveComment[]).filter((comment) => !comment.deleted));
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);
  return all;
};

/** a new Drive comment on the file (Drive's commenters may) */
export const createDriveComment = async (fileId: string, content: string): Promise<string> => {
  const res = await drive(`/files/${encodeURIComponent(fileId)}/comments?fields=id`, { method: "POST", body: { content } });
  if (res.status !== 200) {
    fail(res, "The comment could not be left in Google Drive");
  }
  return String(res.data.id);
};

/**
 * A Drive comment taken care of: deleted, or (where Drive lets only its
 * author delete it) resolved, so nobody takes it in again
 */
export const removeDriveComment = async (fileId: string, commentId: string): Promise<"deleted" | "resolved"> => {
  const path = `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`;
  const res = await drive(path, { method: "DELETE" });
  if (res.status === 204 || res.status === 200 || res.status === 404) {
    return "deleted";
  }
  const reply = await drive(`${path}/replies?fields=id`, { method: "POST", body: { action: "resolve", content: "Taken into the scene by Kurviq." } });
  if (reply.status !== 200) {
    fail(reply, "The comment in Google Drive could not be closed");
  }
  return "resolved";
};
