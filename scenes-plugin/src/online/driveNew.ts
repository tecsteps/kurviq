// Google Drive's "New → More → Kurviq" in the app (specs/2026-11-13-new-scene-from-drive.md):
// the request Drive sent (./driveNewState.ts), the scene's file created in
// that folder with the user's own Drive access (drive.file may create files
// there), and the scenes made outside the Kurviq folder, remembered in this
// browser per account for the scene list's group "Other folders". Nothing
// of it reaches Kurviq's server.

import { accountKey } from "../spaces";
import { API, SCENE_MIME, connection, getToken, notConnectedError } from "./drive";
import {
  DRIVE_NEW_PARAM,
  parseDriveNewState,
  readOtherScenes,
  resourceKeyHeader,
  sceneNameOfFile,
  withOtherScene,
  type DriveNewRequest,
  type OtherScene,
} from "./driveNewState";

const GOOGLE_BASE = (import.meta.env.VITE_APP_GOOGLE_API_BASE || "").replace(/\/$/, "");
const UPLOAD = GOOGLE_BASE ? `${GOOGLE_BASE}/upload/drive/v3` : "https://www.googleapis.com/upload/drive/v3";

// -----------------------------------------------------------------------------
// the request: from the address (/?drive-new=…), kept in this tab until done
// -----------------------------------------------------------------------------

const PENDING_KEY = "kurviq-drive-new";

/** Drive's request this tab is working on (null: none) */
export const pendingDriveNew = (): { raw: string; request: DriveNewRequest } | null => {
  let raw = new URLSearchParams(window.location.search).get(DRIVE_NEW_PARAM);
  try {
    if (raw) {
      // a reload (sign-in, the tab moving to the account's scenes) may drop the address: the tab keeps it
      sessionStorage.setItem(PENDING_KEY, raw);
    } else {
      raw = sessionStorage.getItem(PENDING_KEY);
    }
  } catch {}
  const request = parseDriveNewState(raw);
  return raw && request ? { raw, request } : null;
};

/** the request is done (or cancelled): out of the tab and its address */
export const clearDriveNew = () => {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {}
  const url = new URL(window.location.href);
  if (url.searchParams.has(DRIVE_NEW_PARAM)) {
    url.searchParams.delete(DRIVE_NEW_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
};

/**
 * Sign in as Drive's account: Google preselects it (login_hint takes the
 * account id), and the sign-in comes back to this request
 */
export const signInForDriveNew = (raw: string, consent: boolean) => {
  const back = `/?${DRIVE_NEW_PARAM}=${encodeURIComponent(raw)}`;
  const request = parseDriveNewState(raw);
  try {
    sessionStorage.setItem("kurviq-connecting", String(Date.now()));
  } catch {}
  const hint = request ? `&hint=${encodeURIComponent(request.userId)}` : "";
  window.location.href = `/auth/login?return=${encodeURIComponent(back)}${hint}${consent ? "&consent=1" : ""}`;
};

// -----------------------------------------------------------------------------
// Drive calls (the user's own token)
// -----------------------------------------------------------------------------

const call = async (url: string, init: RequestInit = {}) => {
  const token = await getToken();
  if (!token) {
    throw notConnectedError();
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    throw new Error("Google Drive not reachable: are you online?");
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const BACKSLASH = "\\";
const quoted = (value: string) => "'" + value.replaceAll(BACKSLASH, BACKSLASH + BACKSLASH).replaceAll("'", BACKSLASH + "'") + "'";

export type DriveFolder = { name: string; kurviqFolder: boolean };

/** the folder's name, if Kurviq may read it (null: it may not, or Drive didn't answer) */
export const driveFolder = async (request: DriveNewRequest): Promise<DriveFolder | null> => {
  const res = await call(`${API}/files/${encodeURIComponent(request.folderId)}?fields=id,name,appProperties&supportsAllDrives=true`, {
    headers: resourceKeyHeader(request),
  }).catch(() => null);
  if (res?.status !== 200 || typeof res.data?.name !== "string") {
    return null;
  }
  return { name: res.data.name, kurviqFolder: res.data.appProperties?.kurviqRoot === "1" };
};

/** a scene of this name in the folder already (as far as Kurviq sees it) */
const nameTaken = async (request: DriveNewRequest, name: string) => {
  const fileName = `${name}.excalidraw`;
  const query = `${quoted(request.folderId)} in parents and name = ${quoted(fileName)} and trashed = false`;
  const res = await call(
    `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: resourceKeyHeader(request) },
  );
  return res.status === 200 && Array.isArray(res.data?.files) && res.data.files.length > 0;
};

/** what a new, empty scene's file holds */
export const emptySceneJson = (origin: string) =>
  JSON.stringify({ type: "excalidraw", version: 2, source: origin, elements: [], appState: {}, files: {} });

const multipart = (metadata: object, json: string) => {
  const boundary = `kurviq${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${SCENE_MIME}\r\n\r\n`,
    json,
    `\r\n--${boundary}--`,
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
};

/** the new scene's file in the folder, marked as a Kurviq scene like the ones Kurviq makes itself: its id */
const createSceneFile = async (request: DriveNewRequest, name: string) => {
  const upload = multipart(
    { name: `${name}.excalidraw`, mimeType: SCENE_MIME, parents: [request.folderId], appProperties: { kurviq: "scene", fmt: "1" } },
    emptySceneJson(window.location.origin),
  );
  const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id&supportsAllDrives=true`, {
    method: "POST",
    body: upload.body,
    headers: { "Content-Type": upload.contentType, ...resourceKeyHeader(request) },
  });
  if (res.status === 403 || res.status === 404) {
    throw new Error("Google Drive doesn't let Kurviq create a file in this folder (you may only view it)");
  }
  if (res.status !== 200 || typeof res.data?.id !== "string") {
    throw new Error(`The scene could not be created in Google Drive (${res.status})`);
  }
  return res.data.id as string;
};

/**
 * Create the scene in Drive's folder. Answers its file id and whether that
 * folder is the user's Kurviq folder (then it is one of their own scenes;
 * else the browser remembers it for "Other folders").
 */
export const createDriveNewScene = async (request: DriveNewRequest, name: string, folder: DriveFolder | null) => {
  if (await nameTaken(request, name)) {
    throw new Error(`This folder has a scene "${name}" already: choose another name`);
  }
  const fileId = await createSceneFile(request, name);
  const kurviqFolder = !!folder?.kurviqFolder;
  if (!kurviqFolder) {
    rememberOtherScene({ fileId, name, folderId: request.folderId });
  }
  return { fileId, kurviqFolder };
};

// -----------------------------------------------------------------------------
// "Other folders": scenes made outside the Kurviq folder, per account
// -----------------------------------------------------------------------------

const otherKey = () => {
  const email = connection.getState().user?.email;
  return email ? `kurviq-other-folder-scenes:${accountKey(email)}` : null;
};

const storedOtherScenes = (key: string) => {
  try {
    return readOtherScenes(localStorage.getItem(key));
  } catch {
    return [];
  }
};

const storeOtherScenes = (key: string, list: OtherScene[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
};

const rememberOtherScene = (scene: OtherScene) => {
  const key = otherKey();
  if (key) {
    storeOtherScenes(key, withOtherScene(storedOtherScenes(key), scene));
  }
};

/** the Kurviq folder's id as the tab found it (./drive.ts keeps it per account) */
const kurviqFolderId = () => {
  try {
    return localStorage.getItem(`kurviq-drive-folder:${connection.getState().user?.email ?? ""}`);
  } catch {
    return null;
  }
};

type Checked = { keep: true; scene: OtherScene } | { keep: false } | null;

/** one remembered scene as Drive has it now: renamed, gone (deleted, no access, moved into the Kurviq folder), or unknown (null) */
const checkOtherScene = async (scene: OtherScene, kurviq: string | null): Promise<Checked> => {
  const res = await call(`${API}/files/${encodeURIComponent(scene.fileId)}?fields=id,name,trashed,parents&supportsAllDrives=true`).catch(() => null);
  if (!res || (res.status !== 200 && res.status !== 404)) {
    return null;
  }
  const name = res.status === 200 ? sceneNameOfFile(String(res.data?.name ?? "")) : null;
  const parents: string[] = Array.isArray(res.data?.parents) ? res.data.parents : [];
  if (!name || res.data?.trashed || (kurviq && parents.includes(kurviq))) {
    return { keep: false };
  }
  return { keep: true, scene: { ...scene, name, folderId: parents[0] ?? scene.folderId } };
};

let otherList: { at: number; key: string; value: Promise<OtherScene[]> } | null = null;

/**
 * The remembered scenes of other folders, checked with Drive (renamed ones
 * under their new name, deleted ones forgotten); asked again after a minute
 */
export const otherFolderScenes = (): Promise<OtherScene[]> => {
  const key = otherKey();
  if (!key) {
    return Promise.resolve([]);
  }
  if (otherList?.key === key && Date.now() - otherList.at < 60_000) {
    return otherList.value;
  }
  const value = (async () => {
    const stored = storedOtherScenes(key);
    const kurviq = kurviqFolderId();
    const checked = await Promise.all(stored.map((scene) => checkOtherScene(scene, kurviq)));
    const next = stored.flatMap((scene, index): OtherScene[] => {
      const result = checked[index];
      if (!result) {
        return [scene];
      }
      return result.keep ? [result.scene] : [];
    });
    storeOtherScenes(key, next);
    return [...next].sort((a, b) => a.name.localeCompare(b.name));
  })();
  value.catch(() => {
    otherList = null;
  });
  otherList = { at: Date.now(), key, value };
  return value;
};
