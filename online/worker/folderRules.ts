import { isSceneName } from "../../scenes-mcp/sceneName.mjs";

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

/** the folder owner's address, from the folder's permissions (shown to the people it is shared with, as Drive shows it) */
export const ownerEmailOf = (permissions: DrivePermission[]): string | null =>
  permissions.find((permission) => permission.role === "owner" && permission.type === "user" && !permission.deleted)?.emailAddress ?? null;

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
    return { refused: "not a read" };
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

// -----------------------------------------------------------------------------
// writes (people with edit rights on the folder): what Kurviq itself writes
// -----------------------------------------------------------------------------

export const SCENE_MIME = "application/vnd.excalidraw+json";
const EXTENSION = ".excalidraw";
/** query parameters a write may carry */
const WRITE_PARAMS = new Set(["uploadType", "fields", "supportsAllDrives"]);
/** the file properties Kurviq sets on a scene when an agent saved it (driveScenes.save) */
const AGENT_PROPERTIES = new Set(["agentRev", "agentAt"]);

export type WriteCall =
  | { kind: "content"; fileId: string; search: string }
  | { kind: "create"; search: string }
  | { kind: "metadata"; fileId: string; search: string; metadata: Record<string, unknown> }
  | { kind: "keep"; fileId: string; revisionId: string; keepForever: boolean };

const writeParams = (search: string, uploadType: string | null): URLSearchParams | Refusal => {
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!WRITE_PARAMS.has(key)) {
      return { refused: `parameter not allowed: ${key}` };
    }
  }
  if (params.get("uploadType") !== uploadType) {
    return { refused: "upload type not allowed" };
  }
  return params;
};

/** a scene's file name: "<valid scene name>.excalidraw" */
export const isSceneFileName = (name: unknown) =>
  typeof name === "string" && name.endsWith(EXTENSION) && isSceneName(name.slice(0, -EXTENSION.length));

/** an agent version's mark: only Kurviq's own properties, short texts */
const agentProperties = (value: unknown) => {
  const properties = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  return properties.length > 0 && properties.every(([name, text]) => AGENT_PROPERTIES.has(name) && typeof text === "string" && text.length <= 200);
};

/** why one metadata field can't be written (null: it can) */
const fieldProblem = (key: string, value: unknown) => {
  switch (key) {
    case "name":
      return isSceneFileName(value) ? null : "not a scene name";
    case "trashed":
      return typeof value === "boolean" ? null : "trashed must be true or false";
    case "appProperties":
      return agentProperties(value) ? null : "properties not allowed";
    default:
      return `field not allowed: ${key}`;
  }
};

/** a metadata change Kurviq makes: rename, (un)trash, an agent version's mark; nothing else */
export const checkMetadata = (metadata: unknown): { metadata: Record<string, unknown> } | Refusal => {
  const entries = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Object.entries(metadata) : [];
  if (!entries.length) {
    return { refused: "metadata missing" };
  }
  for (const [key, value] of entries) {
    const problem = fieldProblem(key, value);
    if (problem) {
      return { refused: problem };
    }
  }
  return { metadata: metadata as Record<string, unknown> };
};

/** a write to Drive's upload address: a scene's new content, or a new scene */
const classifyUpload = (method: string, parts: string[], search: string): WriteCall | Refusal => {
  const params = writeParams(search, method === "POST" ? "multipart" : "media");
  if ("refused" in params) {
    return params;
  }
  if (method === "POST" && parts.length === 1) {
    return { kind: "create", search: params.toString() };
  }
  if (method === "PATCH" && parts.length === 2) {
    return { kind: "content", fileId: parts[1], search: params.toString() };
  }
  return { refused: "call not allowed" };
};

/** a revision kept for good (or let go again): nothing but keepForever */
const classifyKeep = (fileId: string, revisionId: string, json: unknown): WriteCall | Refusal => {
  const body = json as { keepForever?: unknown } | null;
  if (!body || typeof body.keepForever !== "boolean" || Object.keys(body).length !== 1) {
    return { refused: "only keepForever" };
  }
  return { kind: "keep", fileId, revisionId, keepForever: body.keepForever };
};

/** a metadata write (PATCH on Drive's API address): a file's metadata or a revision's */
const classifyMetadata = (parts: string[], search: string, json: unknown): WriteCall | Refusal => {
  const [, fileId, sub, revisionId] = parts;
  const params = writeParams(search, null);
  if ("refused" in params) {
    return params;
  }
  if (parts.length === 2) {
    const checked = checkMetadata(json);
    return "refused" in checked ? checked : { kind: "metadata", fileId, search: params.toString(), metadata: checked.metadata };
  }
  if (sub === "revisions" && parts.length === 4 && REVISION_RE.test(revisionId)) {
    return classifyKeep(fileId, revisionId, json);
  }
  return { refused: "call not allowed" };
};

/**
 * A write in a shared folder: a scene's new content, a new scene, a rename,
 * moving one to the bin (or back), an agent version's mark. target: "api" or
 * "upload" (Drive's upload address). Whether the file is in the folder (and
 * not saved live by its owner) is checked with Drive afterwards.
 */
export const classifyWrite = (method: string, target: string, path: string, json?: unknown): WriteCall | Refusal => {
  const [pathname, search = ""] = path.split("?", 2);
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "files" || (parts[1] !== undefined && !ID_RE.test(parts[1]))) {
    return { refused: "call not allowed" };
  }
  if (target === "upload") {
    return classifyUpload(method, parts, search);
  }
  if (target !== "api" || method !== "PATCH" || parts.length < 2) {
    return { refused: "call not allowed" };
  }
  return classifyMetadata(parts, search, json);
};

/**
 * The parts of a new scene's upload (multipart/related: metadata JSON, then
 * the content), or null when it isn't one.
 */
export const parseCreate = (contentType: string, body: string): { name: string; content: string } | null => {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1];
  if (!/^multipart\/related/i.test(contentType) || !boundary) {
    return null;
  }
  const parts = body.split(`--${boundary}`);
  // "", metadata part, content part, "--"
  if (parts.length !== 4 || parts[0] !== "" || !parts[3].startsWith("--")) {
    return null;
  }
  const split = (part: string) => {
    const at = part.indexOf("\r\n\r\n");
    return at < 0 ? null : part.slice(at + 4).replace(/\r\n$/, "");
  };
  const metadataText = split(parts[1]);
  const content = split(parts[2]);
  if (metadataText === null || content === null) {
    return null;
  }
  try {
    const metadata = JSON.parse(metadataText);
    return isSceneFileName(metadata?.name) ? { name: metadata.name, content } : null;
  } catch {
    return null;
  }
};

/** the upload of a new scene in the folder: Kurviq's own metadata, whatever was asked */
export const createBody = (folderId: string, name: string, content: string, boundary: string) => {
  const metadata = { name, mimeType: SCENE_MIME, parents: [folderId], appProperties: { kurviq: "scene", fmt: "1" } };
  return {
    body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${SCENE_MIME}\r\n\r\n${content}\r\n--${boundary}--`,
    contentType: `multipart/related; boundary=${boundary}`,
  };
};

/** the Drive address of an allowed write */
export const writeUrl = (api: string, upload: string, call: WriteCall) => {
  switch (call.kind) {
    case "content":
      return `${upload}/files/${call.fileId}?${call.search}`;
    case "create":
      return `${upload}/files?${call.search}`;
    case "metadata": {
      const query = call.search ? "?" + call.search : "";
      return `${api}/files/${call.fileId}${query}`;
    }
    default:
      return `${api}/files/${call.fileId}/revisions/${call.revisionId}`;
  }
};
