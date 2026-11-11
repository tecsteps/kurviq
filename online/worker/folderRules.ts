// Shared folders (docs/folders/CONCEPT.md, "Shared folders through the
// owner's sign-in"): the rules, without I/O. Which Drive calls a recipient's
// Kurviq may make in a shared folder (they are made with the owner's access,
// so only calls about that folder and its scenes pass), who has which role
// according to the folder's Drive permissions, and how answers are shown to
// the recipient.

/** a Drive permission as permissions.list gives it */
export type DrivePermission = {
  type?: string;
  role?: string;
  emailAddress?: string;
  domain?: string;
  deleted?: boolean;
};

/** what a recipient may do in a shared folder */
export type FolderRole = "writer" | "reader";

const WRITER_ROLES = new Set(["owner", "organizer", "fileOrganizer", "writer"]);
const READER_ROLES = new Set(["commenter", "reader"]);

const roleOfPermission = (role: string | undefined): FolderRole | null => {
  if (role && WRITER_ROLES.has(role)) {
    return "writer";
  }
  if (role && READER_ROLES.has(role)) {
    return "reader";
  }
  return null;
};

export const normalEmail = (email: string) => email.trim().toLowerCase();

const domainOf = (email: string) => normalEmail(email).split("@")[1] ?? "";

/**
 * The person's role in a folder by its permissions: their own (user)
 * permission or one for their whole domain, the higher one. Groups can't be
 * resolved (Kurviq can't see their members) and "anyone with the link" never
 * counts: folders are shared with people.
 */
export const roleFor = (permissions: DrivePermission[], email: string): FolderRole | null => {
  const me = normalEmail(email);
  let best: FolderRole | null = null;
  for (const permission of permissions) {
    if (permission.deleted) {
      continue;
    }
    const matches =
      (permission.type === "user" && normalEmail(permission.emailAddress ?? "") === me) ||
      (permission.type === "domain" && !!permission.domain && permission.domain.toLowerCase() === domainOf(me));
    const role = matches ? roleOfPermission(permission.role) : null;
    if (role === "writer") {
      return role;
    }
    best = role ?? best;
  }
  return best;
};

/**
 * The people (and domains) a folder is shared with, besides its owner, as
 * keys for the member index: "u:<email>" / "d:<domain>". Empty: not shared.
 */
export const memberKeys = (permissions: DrivePermission[], ownerEmail: string) => {
  const owner = normalEmail(ownerEmail);
  const keys = new Set<string>();
  for (const permission of permissions) {
    if (permission.deleted || !roleOfPermission(permission.role)) {
      continue;
    }
    if (permission.type === "user" && permission.emailAddress && normalEmail(permission.emailAddress) !== owner) {
      keys.add(`u:${normalEmail(permission.emailAddress)}`);
    } else if (permission.type === "domain" && permission.domain) {
      keys.add(`d:${permission.domain.toLowerCase()}`);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
};

/** the keys under which a person finds the folders shared with them */
export const lookupKeys = (email: string) => [`u:${normalEmail(email)}`, `d:${domainOf(email)}`];

// -----------------------------------------------------------------------------
// the proxy: which calls pass
// -----------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const REVISION_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** query parameters a read may carry (anything else is refused) */
const READ_PARAMS = new Set(["q", "fields", "pageSize", "pageToken", "orderBy", "alt", "supportsAllDrives", "includeItemsFromAllDrives"]);

export type ProxyCall =
  | { kind: "list"; search: string }
  | { kind: "file"; fileId: string; search: string; media: boolean }
  | { kind: "revisions"; fileId: string; search: string }
  | { kind: "revision"; fileId: string; revisionId: string; search: string; media: boolean };

export type Refusal = { refused: string };

/** the listing query of a folder's scenes, exactly as Kurviq writes it */
export const listQuery = (folderId: string) => `'${folderId}' in parents and trashed=false`;

const readParams = (search: string): URLSearchParams | Refusal => {
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!READ_PARAMS.has(key)) {
      return { refused: `parameter not allowed: ${key}` };
    }
  }
  const alt = params.get("alt");
  if (alt !== null && alt !== "media") {
    return { refused: "alt must be media" };
  }
  return params;
};

const fileCall = (parts: string[], params: URLSearchParams, media: boolean): ProxyCall | Refusal => {
  const [fileId, sub, revisionId] = parts;
  if (!ID_RE.test(fileId)) {
    return { refused: "not a Drive file id" };
  }
  const search = params.toString();
  if (parts.length === 1) {
    return { kind: "file", fileId, search, media };
  }
  if (sub !== "revisions" || parts.length > 3) {
    return { refused: "call not allowed" };
  }
  if (parts.length === 2) {
    return media ? { refused: "call not allowed" } : { kind: "revisions", fileId, search };
  }
  return REVISION_RE.test(revisionId) ? { kind: "revision", fileId, revisionId, search, media } : { refused: "not a revision id" };
};

/**
 * A recipient's read in a shared folder: the listing of exactly this folder,
 * one of its files (metadata or content) or a file's revisions. Whether the
 * file really is in the folder is checked with Drive afterwards (its parents).
 */
export const classifyRead = (folderId: string, method: string, path: string): ProxyCall | Refusal => {
  if (method !== "GET") {
    return { refused: "shared folders are read-only for now" };
  }
  const [pathname, search = ""] = path.split("?", 2);
  const params = readParams(search);
  if ("refused" in params) {
    return params;
  }
  if (pathname === "/files") {
    if (params.get("q") !== listQuery(folderId) || params.has("alt")) {
      return { refused: "only this folder's listing" };
    }
    return { kind: "list", search: params.toString() };
  }
  const match = /^\/files\/(.+)$/.exec(pathname);
  if (!match || params.has("q")) {
    return { refused: "call not allowed" };
  }
  return fileCall(match[1].split("/").map(decodeURIComponent), params, params.get("alt") === "media");
};

/** the Drive address of an allowed call */
export const callUrl = (api: string, call: ProxyCall) => {
  const query = call.search ? `?${call.search}` : "";
  switch (call.kind) {
    case "list":
      return `${api}/files${query}`;
    case "file":
      return `${api}/files/${call.fileId}${query}`;
    case "revisions":
      return `${api}/files/${call.fileId}/revisions${query}`;
    default:
      return `${api}/files/${call.fileId}/revisions/${call.revisionId}${query}`;
  }
};

/**
 * A file as the recipient sees it: Drive answered as the owner, so what the
 * owner may do is replaced by what the recipient may do.
 */
const asRecipientFile = (file: unknown, role: FolderRole) => {
  if (!file || typeof file !== "object") {
    return file;
  }
  const copy: Record<string, unknown> = { ...(file as Record<string, unknown>) };
  if ("capabilities" in copy) {
    copy.capabilities = { ...(copy.capabilities as object), canEdit: role === "writer", canShare: false };
  }
  if ("ownedByMe" in copy) {
    copy.ownedByMe = false;
  }
  return copy;
};

/** a Drive answer (JSON) as the recipient sees it */
export const asRecipient = (data: unknown, role: FolderRole) => {
  if (data && typeof data === "object" && Array.isArray((data as { files?: unknown }).files)) {
    const list = data as { files: unknown[] };
    return { ...list, files: list.files.map((file) => asRecipientFile(file, role)) };
  }
  return asRecipientFile(data, role);
};
