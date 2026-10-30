// Kurviq: the scenes server's job, done in the browser with the Google Drive
// API — list, load, save, rename and delete scenes in the user's Drive, with
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
import { currentSpace, SPACE_KEY } from "../storage";

import google from "../../../online/google.json";

import { md5 } from "./md5";

import type { ApiError, RemoteInfo, RemoteScene, SceneVersion } from "../api";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
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

// -----------------------------------------------------------------------------
// connection: who is signed in (cookie, via the Worker)
// -----------------------------------------------------------------------------

export type GoogleUser = { email: string; name: string | null; avatarUrl: string | null };

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

export const connection = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: () => state,
  /** signed in with Drive access: scenes sync */
  isActive: () => !!state.user && state.drive && !state.lost && !state.needsAccess,
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

/** the local install, back from signing in: #kurviq-google=connected&session=… */
const takeLocalSession = () => {
  if (!IS_LOCAL_INSTALL || !window.location.hash.includes("kurviq-google=")) {
    return;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const session = params.get("session");
  try {
    if (session) {
      localStorage.setItem(LOCAL_SESSION_KEY, session);
    }
  } catch {}
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("google", params.get("kurviq-google") || "failed");
  window.history.replaceState(window.history.state, "", url.toString());
};
takeLocalSession();

let token: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string | null> | null = null;

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
    if (IS_LOCAL_INSTALL) {
      try {
        localStorage.removeItem(LOCAL_SESSION_KEY);
      } catch {}
    }
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
  window.location.href = `${AUTH_BASE}/auth/login?return=${encodeURIComponent(back)}${consent ? "&consent=1" : ""}`;
};

/** the other tabs of this browser hear about a sign-out */
const tabsChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kurviq-google") : null;

const forgetConnection = () => {
  token = null;
  forgetListing();
  setConnection({ user: null, drive: false });
};
tabsChannel?.addEventListener("message", (event) => event.data === "disconnected" && forgetConnection());

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

const drive = async (
  url: string,
  {
    method = "GET",
    body,
    contentType,
    raw = false,
  }: { method?: string; body?: BodyInit | object; contentType?: string; raw?: boolean } = {},
): Promise<DriveResponse> => {
  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    if (!value) {
      throw notConnectedError();
    }
    const isJson = body !== undefined && !(typeof body === "string" || body instanceof Blob || body instanceof Uint8Array);
    let res: Response;
    try {
      res = await fetch(url.startsWith("https://") ? url : `${API}${url}`, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${value}`,
          ...(isJson ? { "Content-Type": "application/json" } : contentType ? { "Content-Type": contentType } : {}),
        },
        body: body === undefined ? undefined : isJson ? JSON.stringify(body) : (body as BodyInit),
      });
    } catch {
      throw offlineError("Google Drive not reachable");
    }
    if (res.status === 401 && attempt === 0) {
      token = null; // revoked or expired early: get a fresh one once
      continue;
    }
    const text = res.status === 204 ? "" : await res.text();
    let data: any = null;
    if (!raw || !res.ok) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
    }
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
    return { status: res.status, data, text };
  }
};

const fail = (res: DriveResponse, what: string): never => {
  const detail = typeof res.data?.error?.message === "string" ? `: ${res.data.error.message}` : "";
  throw httpError(res.status, `${what} (Google Drive ${res.status}${detail})`);
};

const q = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

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

const keepVersion = async (fileId: string, sha: string, json: string) => {
  try {
    await set(`${fileId}:${sha}`, json, versionStore);
    const kept = [sha, ...((await get<string[]>(fileId, versionIndex)) ?? []).filter((other) => other !== sha)];
    await set(fileId, kept.slice(0, KEEP_VERSIONS), versionIndex);
    await Promise.all(kept.slice(KEEP_VERSIONS).map((other) => del(`${fileId}:${other}`, versionStore)));
  } catch {}
};

const keptVersion = async (fileId: string, sha: string) => {
  try {
    return (await get<string>(`${fileId}:${sha}`, versionStore)) ?? null;
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

/** the scenes of this space (name -> file); a cached copy for a few seconds */
const fetchScenes = async (force = false): Promise<Listing> => {
  if (listing && !force && Date.now() - listing.fetchedAt < 5_000) {
    return listing;
  }
  try {
    const files = new Map<string, DriveFile>();
    if (sharedFileId) {
      const file = await fetchSharedFile(sharedFileId);
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
    } else {
      const folder = await folderId();
      let pageToken = "";
      do {
        const res = await drive(
          `/files?q=${encodeURIComponent(`${q(folder)} in parents and trashed=false`)}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000${
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
          const name = sceneNameOf(file);
          const other = name ? files.get(name) : undefined;
          // two files of the same name (made in Drive): the newer one counts
          if (name && isSceneName(name) && (!other || (other.modifiedTime ?? "") < (file.modifiedTime ?? ""))) {
            files.set(name, file);
          }
        }
        pageToken = res.data.nextPageToken || "";
      } while (pageToken);
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

const checkBase = (name: string, current: string | undefined, baseSha: string | undefined) => {
  if (baseSha !== undefined && (current || "none") !== baseSha) {
    throw httpError(409, `"${name}" was changed in Google Drive in the meantime`, { remoteSha: current || null });
  }
};

const readOnlyError = (reason: string) => httpError(403, `Read only: ${reason}`, { readOnly: true });

const requireWritable = () => {
  if (readOnly) {
    throw readOnlyError(readOnly);
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
const loadVersion = async (file: DriveFile, name: string, sha: string) => {
  const kept = await keptVersion(file.id, sha);
  if (kept !== null) {
    return kept;
  }
  const revisions = await listRevisions(file.id);
  for (const revision of revisions.filter((entry) => entry.md5Checksum === sha).reverse()) {
    const res = await download(file.id, revision.id);
    if (res.status === 200) {
      await keepVersion(file.id, sha, res.text);
      return res.text;
    }
  }
  throw httpError(404, `Version ${sha} of scene "${name}" not found (Google Drive keeps older versions about 30 days)`);
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
    const res = await drive(
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
              sha: file.md5Checksum ?? "",
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
  load: async (name: string, sha?: string): Promise<{ json: string; sha: string }> => {
    checkName(name);
    const file = await locate(name);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    if (sha && sha !== file.md5Checksum) {
      return { json: await loadVersion(file, name, sha), sha };
    }
    const res = await download(file.id);
    if (res.status !== 200) {
      fail(res, `"${name}" could not be read`);
    }
    // the content's own MD5 (the listing may be a moment older than what was read)
    const actual = md5(encodeBytes(res.text));
    await keepVersion(file.id, actual, res.text);
    return { json: res.text, sha: actual };
  },

  /**
   * Save a scene. baseSha: undefined = overwrite, "none" = must be new,
   * <md5> = must be exactly that version in Drive (else 409: merge first).
   */
  save: async (name: string, json: string, baseSha?: string, source?: string) => {
    checkName(name);
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
    requireWritable();
    const sha = md5(encodeBytes(json));
    const file = await locate(name);
    checkBase(name, file?.md5Checksum, baseSha);
    if (file && file.md5Checksum === sha) {
      return { sha, commit: null, changed: false };
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
    await keepVersion(saved.id, sha, json);
    if (isAgent(source) && saved.headRevisionId) {
      await markAgentVersion({ ...saved, appProperties: file?.appProperties ?? saved.appProperties }, saved.headRevisionId);
    }
    return { sha: saved.md5Checksum ?? sha, commit: saved.headRevisionId ?? null, changed: true };
  },

  /** delete a scene (to Drive's bin); baseSha (optional): only if Drive still has that version */
  remove: async (name: string, baseSha?: string | null) => {
    checkName(name);
    requireWritable();
    const file = await locate(name);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    if (sharedFileId) {
      throw httpError(403, `"${name}" belongs to ${ownerName(file)}: only they can delete it`);
    }
    checkBase(name, file.md5Checksum, baseSha ?? undefined);
    const res = await drive(`/files/${file.id}?fields=id`, { method: "PATCH", body: { trashed: true } });
    if (res.status !== 200) {
      fail(res, `Deleting "${name}" failed`);
    }
    forgetListing();
    return { sha: null };
  },

  /** rename (the file keeps its id, so links to it keep working; the content and its MD5 stay) */
  rename: async (from: string, to: string): Promise<{ sha: string; commit: string | null }> => {
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
    forgetListing();
    return { sha: file.md5Checksum ?? "", commit: null };
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
        commit: revision.id,
        at: revision.modifiedTime ?? null,
        author: revision.lastModifyingUser?.displayName ?? revision.lastModifyingUser?.emailAddress ?? null,
        message: revision.id === agentRev ? "Agent edit" : "",
        agent: revision.id === agentRev,
        sha: revision.md5Checksum,
      }));
  },

  /** the scene as it was in a revision */
  loadAt: async (name: string, revision: string): Promise<{ json: string; sha: string }> => {
    checkName(name);
    const file = await locate(name, false);
    if (!file) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    const res = await download(file.id, revision);
    if (res.status !== 200) {
      throw httpError(res.status, `This version of "${name}" can't be read any more (Google Drive keeps older versions about 30 days)`);
    }
    return { json: res.text, sha: md5(encodeBytes(res.text)) };
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
    return { sha: res.data.md5Checksum as string, commit: revision, at: res.data.modifiedTime ?? file.appProperties?.agentAt ?? null };
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
  const anyone = permissions.find((permission) => permission.type === "anyone");
  return anyone ? (anyone.role === "writer" ? "writer" : "reader") : "restricted";
};

/** share with a person (Google mails them; the mail carries Kurviq's link in the message) */
export const addPerson = async (fileId: string, email: string, role: "reader" | "writer", message: string) => {
  const res = await drive(
    `/files/${fileId}/permissions?sendNotificationEmail=true&emailMessage=${encodeURIComponent(message)}&supportsAllDrives=true&fields=id`,
    { method: "POST", body: { type: "user", role, emailAddress: email.trim() } },
  );
  if (res.status !== 200) {
    fail(res, `Could not share with ${email}`);
  }
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

const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** the link to a scene for anyone: kurviq.com/s/<fileId>/<readable name> */
export const shareLink = (fileId: string, name: string) => {
  const base = IS_LOCAL_INSTALL ? AUTH_BASE : window.location.origin;
  const readable = slug(name);
  return `${base}/s/${fileId}${readable ? `/${readable}` : ""}`;
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
    const res = await drive(
      `/files?q=${encodeURIComponent(`sharedWithMe and trashed=false and mimeType=${q(SCENE_MIME)}`)}&fields=files(${FILE_FIELDS})&pageSize=200&includeItemsFromAllDrives=true&supportsAllDrives=true`,
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
  const publicCopy = fetch(`${AUTH_BASE}/api/public/${encodeURIComponent(fileId)}${version ? `?v=${version}` : ""}`)
    .then(async (res) => (res.ok ? { json: await res.text(), name: decodeURIComponent(res.headers.get("X-Kurviq-Name") || "") } : null))
    .catch(() => null);
  const signedIn = getToken().catch(() => null);
  const access = signedIn.then(async (value) => (value ? fetchSharedFile(fileId).catch(() => null) : null));
  const pub = await publicCopy;
  if (pub) {
    // don't wait for the access check longer than a moment
    const file = await Promise.race([access, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
    return { scene: { json: pub.json, name: pub.name || (file ? sceneNameOf(file) ?? "" : ""), public: true, canEdit: !!file?.capabilities?.canEdit } };
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

let pickerScript: Promise<void> | null = null;

const loadPicker = () => {
  pickerScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => (window as any).gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Google Picker could not be loaded")) });
    script.onerror = () => {
      pickerScript = null;
      reject(offlineError("Google Picker could not be loaded"));
    };
    document.head.appendChild(script);
  });
  return pickerScript;
};

export const pickerAvailable = () => !!google.browserApiKey && !!google.projectNumber;

/** the picked file ids (empty: cancelled) */
export const pickFiles = async ({ fileId }: { fileId?: string } = {}): Promise<string[]> => {
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
  return new Promise<string[]>((resolve) => {
    const picker = new pickerApi.PickerBuilder()
      .addView(view)
      .setOAuthToken(value)
      .setDeveloperKey(google.browserApiKey)
      .setAppId(google.projectNumber)
      .setTitle(fileId ? "Allow Kurviq to open this scene" : "Open a scene from Google Drive")
      .setCallback((data: any) => {
        const action = data[pickerApi.Response.ACTION];
        if (action === pickerApi.Action.PICKED) {
          resolve((data[pickerApi.Response.DOCUMENTS] || []).map((doc: any) => String(doc[pickerApi.Document.ID])));
        } else if (action === pickerApi.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
};
