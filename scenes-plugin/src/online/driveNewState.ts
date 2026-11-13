// Google Drive's "New → More → Kurviq" (specs/2026-11-13-new-scene-from-drive.md):
// Drive opens kurviq.com/drive/new?state={"action":"create","folderId":…,"userId":…}.
// The Worker only hands the state on to the app (/?drive-new=…); the app
// checks the account, asks for a name and creates the scene in that folder.
// The pure parts, shared by the Worker (online/worker/driveNew.ts) and the app
// (./driveNew.ts, ./driveNewUI.tsx).

/** the app's query parameter that carries Drive's state */
export const DRIVE_NEW_PARAM = "drive-new";

/** what Drive's "New" asks for: a new file in this folder, for this Google account */
export type DriveNewRequest = {
  folderId: string;
  userId: string;
  /** the folder's resource key (folders shared by link before 2021), sent to Drive as X-Goog-Drive-Resource-Keys */
  folderResourceKey?: string;
};

/** a Drive file or folder id (also My Drive's own id) */
const DRIVE_ID_RE = /^[\w-]{1,200}$/;
/** Google's account id (the OpenID `sub`; digits at Google) */
const USER_ID_RE = /^[\w.-]{1,128}$/;

/** Drive's state (JSON) as a request, or null: not a valid "create" */
export const parseDriveNewState = (raw: string | null | undefined): DriveNewRequest | null => {
  if (!raw || raw.length > 2000) {
    return null;
  }
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!state || typeof state !== "object") {
    return null;
  }
  const { action, folderId, userId, folderResourceKey } = state as Record<string, unknown>;
  if (action !== "create" || typeof folderId !== "string" || typeof userId !== "string") {
    return null;
  }
  if (!DRIVE_ID_RE.test(folderId) || !USER_ID_RE.test(userId)) {
    return null;
  }
  const key = typeof folderResourceKey === "string" && DRIVE_ID_RE.test(folderResourceKey) ? folderResourceKey : null;
  return key ? { folderId, userId, folderResourceKey: key } : { folderId, userId };
};

/** the app's address for a request: just Drive's state again, nothing added */
export const driveNewAppPath = (request: DriveNewRequest) =>
  `/?${DRIVE_NEW_PARAM}=${encodeURIComponent(JSON.stringify({ action: "create", ...request }))}`;

/** Drive's header for a folder with a resource key (none: no header) */
export const resourceKeyHeader = (request: DriveNewRequest): Record<string, string> =>
  request.folderResourceKey ? { "X-Goog-Drive-Resource-Keys": `${request.folderId}/${request.folderResourceKey}` } : {};

/**
 * May this tab create the scene? "ok": signed in as Drive's account, with
 * Drive access. "unknown": signed in, but the sign-in is older than Kurviq
 * knowing account ids (a new sign-in tells). Anything but "ok" creates nothing.
 */
export type AccountCheck = "signed-out" | "no-drive" | "unknown" | "other-account" | "ok";

export const checkDriveNewAccount = (
  user: { sub?: string } | null | undefined,
  drive: boolean,
  userId: string,
): AccountCheck => {
  if (!user) {
    return "signed-out";
  }
  if (!user.sub) {
    return "unknown";
  }
  if (user.sub !== userId) {
    return "other-account";
  }
  return drive ? "ok" : "no-drive";
};

// -----------------------------------------------------------------------------
// scenes made in other folders than the Kurviq folder: the browser remembers
// their ids (per account), the scene list shows them as "Other folders"
// -----------------------------------------------------------------------------

export type OtherScene = { fileId: string; name: string; folderId: string };

/** at most this many are remembered (the oldest go first) */
export const OTHER_SCENES_MAX = 500;

/** the remembered list (localStorage's raw value); anything malformed is left out */
export const readOtherScenes = (raw: string | null): OtherScene[] => {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is OtherScene =>
      !!entry &&
      typeof entry.fileId === "string" &&
      DRIVE_ID_RE.test(entry.fileId) &&
      typeof entry.name === "string" &&
      entry.name !== "" &&
      typeof entry.folderId === "string",
  );
};

/** the list with this scene added (or updated), newest last, capped */
export const withOtherScene = (list: OtherScene[], scene: OtherScene): OtherScene[] =>
  [...list.filter((entry) => entry.fileId !== scene.fileId), scene].slice(-OTHER_SCENES_MAX);

/** the scene name of a Drive file name ("Plan.excalidraw" -> "Plan"), or null: not a scene file */
export const sceneNameOfFile = (fileName: string) => (fileName.endsWith(".excalidraw") ? fileName.slice(0, -".excalidraw".length) : null);
