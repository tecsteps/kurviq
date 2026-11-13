// A fake Google for local tests (docs/live-sync/PROTOCOL.md §8): Google's
// OAuth and the Drive v3 subset Kurviq uses, with test accounts, so the
// unmodified app and Worker can be QA'd with several users at once. Only
// served by `wrangler dev` with FAKE_GOOGLE=1 (and a local DEV_ORIGIN):
// production never answers /fake-google/*.
//
//   KURVIQ_FAKE_GOOGLE=1 node dev-vars.mjs   (in online/: FAKE_GOOGLE=1, LIVE_SYNC=all, GOOGLE_API_KEY=fake-api-key)
//   npm run build:online:fake               (root: the app calls /fake-google/drive/v3)
//   node build-worker.mjs && npx wrangler dev
//
// All state is in one Durable Object (FAKE_GOOGLE_STORE, idFromName("fake"),
// SQLite), so it survives reloads of `wrangler dev` (keep --persist-to).
//
// It implements what Kurviq (the app, the Worker, the tests) actually sends,
// and answers anything else with a clear 400 "not supported by the fake"
// rather than with behaviour nobody compared with Google.
//
// OAuth (/fake-google/oauth/…)
//   GET  authorize   Google's sign-in page: pick alice/bob/carol@example.test or
//                    type any email; "Allow Drive access" can be unticked (the
//                    token then lacks drive.file). Honours prompt (consent,
//                    select_account), login_hint, access_type=offline,
//                    include_granted_scopes. A refresh token is handed out on
//                    first consent or with prompt=consent (one per user+client).
//   GET  approve     what the page submits; scripts can call it directly:
//                    approve?<authorize params>&email=alice@example.test[&drive=0][&cancel=1]
//   POST token       grant_type=authorization_code | refresh_token (client_secret
//                    "fake-secret" in the form). Access tokens last 1 h. id_token is
//                    an unsigned JWT (alg none) with sub (stable per email),
//                    email, email_verified, name, picture.
//   POST revoke      token=<access or refresh token>: the whole grant of that
//                    user+client ends (later grants: invalid_grant, API: 401)
//
// Drive (/fake-google/drive/v3/…, uploads /fake-google/upload/drive/v3/…)
//   files.list (q: terms joined by "and": '<id>' in parents, trashed = / !=,
//     name = / !=, mimeType = / !=, sharedWithMe, appProperties has { key='k'
//     and value='v' }; orderBy createdTime / name / modifiedTime [desc],
//     pageSize, pageToken), files.get (fields, alt=media), files.create
//     (metadata, uploadType=media|multipart), files.update PATCH (metadata,
//     appProperties merge with null deleting, trashed, uploadType=media|
//     multipart; checked first, then applied as a whole, like Drive),
//     files.delete, files.watch, channels.stop, revisions list/get
//     (alt=media)/update/delete, permissions list/get/create/update/delete
//     (types user, domain and anyone; expirationTime on user permissions,
//     update with removeExpiration=true drops it; an expired permission gives
//     no access and is no longer listed, as Drive removes it).
//     comments list/create/get/delete and replies.create (action "resolve"):
//     Drive's own comments, the commenters' mailbox (fields required, as at
//     Google; the author comes without an address, as at Google).
//     contentHints (thumbnail, indexableText) on files.create / update, with
//     Drive's limits (thumbnail 2 MB, URL-safe base64; text 128 KB; else 400);
//     new content without a thumbnail drops the old one, as at Drive; never in
//     answers, only hasThumbnail and thumbnailLink (GET /fake-google/thumbnail/<id>).
//   drive.file: a user sees a file only if the app may open it for them (they
//     created it through the API, or it was granted: /admin/grant is the
//     Picker / "Open with"; with the setting folderPickGrantsChildren a
//     granted folder grants its files too) AND they have a role on it (own
//     permission, one of a folder it is in, a domain permission of their
//     email's domain, or "anyone with the link").
//     Otherwise 404 notFound.
//   POST /fake-google/picker (the app's Picker in a fake build): the next pick
//     a test queued for that user (/admin/picker), granted; none: cancelled.
//   key=fake-api-key without a token: files.get of files shared with anyone
//     (not trashed), never appProperties.
//   Errors in Google's shape {error:{code,message,errors:[{reason,…}]}}:
//     401 authError (bad/expired/revoked token), 403 insufficientPermissions
//     (token without the drive.file scope, as Google), 403
//     insufficientFilePermissions (a write without canEdit, revisions without
//     edit rights, sharing without canShare, trashing someone else's file),
//     404 notFound, 400 invalid (bad q / fields).
//   Revisions: every content write makes one (headRevisionId); at most 200
//     keepForever per file; beyond 100 not-kept revisions the oldest are
//     purged; the head revision can't be deleted.
//   Watch: expiration capped at 1 day (default 1 h); POSTs to the address with
//     X-Goog-Channel-ID, -Channel-Token, -Channel-Expiration, -Resource-ID,
//     -Resource-URI, -Resource-State (sync, update, trash, untrash, remove),
//     -Changed (content, properties, permissions, parents), -Message-Number.
//   (Revisions, keepForever and watch channels serve live sync's scene object;
//   they go when it goes.)
//
// Not like Google (where a green test says least):
//   - Everything is consistent at once: a new file is in files.list in the same
//     instant, while Drive's listing lags (so "find the Kurviq folder, else
//     create it" never meets its duplicate-folder case here).
//   - modifiedTime moves with content and renames; whether Drive also moves it
//     for appProperties or trash changes is not verified (here it does not).
//   - A new consent hands back the user's existing refresh token; Google issues
//     a new one (the old ones stay valid up to a limit).
//
// Admin (/fake-google/admin/…, JSON; GET with query, POST with a JSON body)
//   GET  /admin                     this list
//   POST /admin/reset               everything forgotten (test users stay)
//   GET  /admin/file?fileId=        one file: metadata, permissions, app access, contentHints, revisions, channels
//   POST /admin/grant {email,fileId}     the Picker: the app may open the file for that user
//   POST /admin/picker {email,ids}       the user's next pick in the app's Picker (files or folders)
//   POST /admin/config {folderPickGrantsChildren?,commentDeleteByAuthorOnly?}
//                                   how Google behaves where it isn't verified yet
//   GET  /admin/comments?fileId=    Drive comments on a file
//   POST /admin/write {email,fileId?,content,name?,mimeType?,appProperties?,parents?}
//                                   a change "from outside Kurviq" (Drive's web UI): new
//                                   revision, watch notifications; without fileId a new
//                                   file of that user (not visible to the app until granted)
//   POST /admin/share {fileId,email|domain|anyone:true,role,expirationTime?}   (reader|commenter|writer;
//                                   expirationTime may lie in the past here: an expired permission)
//   POST /admin/unshare {fileId,email|anyone:true}
//   POST /admin/trash|untrash|delete {fileId}
//   GET  /admin/revisions?fileId=[&content=1]
//   POST /admin/revoke {email}          the user removed Kurviq at myaccount.google.com
//   POST /admin/faults {count?,status?,delayMs?,path?}
//        the next `count` (default 1) matching Drive calls: wait delayMs, then answer
//        `status` (503, 429, 500, 403, …) or, without a status, go on normally.
//        path: a substring of the path after /fake-google plus its query
//        (e.g. "/upload/", a file id, "alt=media").
//   GET  /admin/faults, DELETE /admin/faults (clear; the answer lists faults never used)
//   GET  /admin/log?kind=request|notification|mail&limit=   recent Drive calls,
//        watch deliveries, share mails (for debugging by hand)
//   GET  /admin/channels
//
// Served only by a development build of the Worker (build-worker.mjs without
// --production): the production bundle has a stub instead (see index.ts).

import { DurableObject } from "cloudflare:workers";

import { parseQuery } from "./fakeGoogleQuery";
import type { Predicate } from "./fakeGoogleQuery";
import { isDevOrigin } from "./origins";
import { HintsError, adminHints, parseHints, thumbnailBytes } from "./fakeGoogleHints";
import type { StoredHints } from "./fakeGoogleHints";

type FakeEnv = {
  FAKE_GOOGLE?: string;
  DEV_ORIGIN?: string;
  GOOGLE_API_KEY?: string;
  FAKE_GOOGLE_STORE?: DurableObjectNamespace;
};

const PREFIX = "/fake-google";
const API_KEY = "fake-api-key";
const CLIENT_SECRET = "fake-secret";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const ACCESS_SECONDS = 3600;
const CHANNEL_MAX_MS = 24 * 3600 * 1000;
const CHANNEL_DEFAULT_MS = 3600 * 1000;
const KEEP_FOREVER_MAX = 200;
const UNKEPT_MAX = 100;
const BLOB_CHUNK = 1024 * 1024;
const TEST_USERS: [string, string][] = [
  ["alice@example.test", "Alice Example"],
  ["bob@example.test", "Bob Example"],
  ["carol@example.test", "Carol Example"],
];

/** /fake-google/*: only with FAKE_GOOGLE=1 and a development DEV_ORIGIN (wrangler dev), else null */
export const handleFakeGoogle = (request: Request, env: FakeEnv): Promise<Response> | null => {
  const { pathname } = new URL(request.url);
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
    return null;
  }
  if (env.FAKE_GOOGLE !== "1" || !env.FAKE_GOOGLE_STORE || !isDevOrigin(env.DEV_ORIGIN)) {
    return null;
  }
  const store = env.FAKE_GOOGLE_STORE;
  return store.get(store.idFromName("fake")).fetch(request);
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

type Row = Record<string, any>;

type FileRow = {
  id: string;
  name: string;
  mime: string;
  parents: string;
  app_props: string;
  props: string;
  description: string | null;
  owner: string;
  created: string;
  modified: string;
  modifier: string;
  trashed: number;
  version: number;
  head: string | null;
  md5: string | null;
  size: number;
};

type Caller = { kind: "user"; email: string; scope: string[] } | { kind: "anonymous" };
type User = Extract<Caller, { kind: "user" }>;
/** what a comments call works with */
type CommentCall = { request: Request; caller: User; file: FileRow; role: string; fields: FieldTree; origin: string };
/** what a permissions call works with */
type PermissionCall = { file: FileRow; canShare: boolean; caller: User; origin: string; fields: FieldTree; one: (id: string) => Row | null };

/** the signed-in user of a Drive call; an API key alone (anonymous) gets 401 "Login Required" */
const requireUser = (caller: Caller): User => {
  if (caller.kind === "anonymous") {
    fail(googleError(401, "Login Required.", "required", { location: "Authorization", locationType: "header", status: "UNAUTHENTICATED" }));
  }
  return caller as User;
};

const ROLE_RANK: Record<string, number> = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 3, organizer: 3, owner: 4 };

const now = () => new Date().toISOString();

const randomId = (length: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

/** cyrb53: a small stable hash (ids derived from emails) */
const hash53 = (text: string, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i); // NOSONAR S7758: cyrb53 hashes UTF-16 code units to keep stable ids
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const digits = (text: string, length: number) => {
  let out = "";
  let seed = 1;
  while (out.length < length) {
    out += String(hash53(text, seed));
    seed++;
  }
  return out.slice(0, length);
};

const subOf = (email: string) => {
  const value = digits(`sub:${email}`, 20);
  return `1${value}`;
};
const permIdOf = (email: string) => {
  const value = digits(`perm:${email}`, 19);
  return `0${value}`;
};
/** a domain permission's id (Drive's are numbers, too) */
const domainPermId = (domain: string) => {
  const value = digits(`domain:${domain}`, 19);
  return `1${value}`;
};
const rootOf = (email: string) => {
  const value = digits(`root:${email}`, 17);
  return `0A${value}Uk9PVA`;
};

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const md5Hex = async (bytes: Uint8Array) => toHex(await crypto.subtle.digest("MD5", bytes));

const b64url = (text: string) => {
  const binary = encodeURIComponent(text).replaceAll(/%([0-9A-F]{2})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").split("=")[0];
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", ...headers },
  });

/** an error the way Google's APIs send it */
const googleError = (code: number, message: string, reason: string, extra: Row = {}, headers: Record<string, string> = {}) =>
  json(
    code,
    {
      error: {
        code,
        message,
        errors: [{ message, domain: extra.domain ?? "global", reason, ...(extra.location ? { location: extra.location, locationType: extra.locationType ?? "parameter" } : {}) }],
        ...(extra.status ? { status: extra.status } : {}),
      },
    },
    headers,
  );

const notFound = (id: string) => googleError(404, `File not found: ${id}.`, "notFound", { location: "fileId" });
const noFilePermission = () =>
  googleError(403, "The user does not have sufficient permissions for this file.", "insufficientFilePermissions");
const invalid = (message: string, location?: string) => googleError(400, message, "invalid", { location });

class HttpError extends Error {
  constructor(public response: Response) {
    super("http error");
  }
}

const fail = (response: Response): never => {
  throw new HttpError(response);
};

const parseJson = async (request: Request): Promise<Row> => {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return fail(googleError(400, "Invalid JSON payload received.", "parseError", { status: "INVALID_ARGUMENT" }));
  }
};

const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array, from = 0) => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
};

const multipartHeaders = (part: Uint8Array) => {
  let split = indexOfBytes(part, new TextEncoder().encode("\r\n\r\n"));
  let skip = 4;
  if (split < 0) {
    split = indexOfBytes(part, new TextEncoder().encode("\n\n"));
    skip = 2;
  }
  const headerText = split < 0 ? "" : new TextDecoder().decode(part.subarray(0, split));
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return { headers, body: split < 0 ? part : part.subarray(split + skip) };
};

const multipartPart = (body: Uint8Array, delimiter: Uint8Array, at: number) => {
  let start = at + delimiter.length;
  if (body[start] === 0x2d && body[start + 1] === 0x2d) {
    return null; // closing delimiter
  }
  if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  else if (body[start] === 0x0a) start += 1;
  const next = indexOfBytes(body, delimiter, start);
  if (next < 0) {
    return null;
  }
  let end = next;
  if (body[end - 1] === 0x0a) end--;
  if (body[end - 1] === 0x0d) end--;
  return { start, end, next };
};

/** multipart/related: the metadata part (JSON) and the content part */
const parseMultipart = (contentType: string, body: Uint8Array) => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) {
    return fail(invalid("Multipart upload without a boundary."));
  }
  const delimiter = new TextEncoder().encode(`--${(boundary[1] || boundary[2]).trim()}`);
  const parts: { headers: Record<string, string>; body: Uint8Array }[] = [];
  let at = indexOfBytes(body, delimiter);
  while (at >= 0) {
    const part = multipartPart(body, delimiter, at);
    if (!part) break;
    const { start, end, next } = part;
    parts.push(multipartHeaders(body.subarray(start, end)));
    at = next;
  }
  if (parts.length < 2) {
    return fail(invalid("Multipart upload needs a metadata part and a media part."));
  }
  let metadata: Row;
  try {
    metadata = JSON.parse(new TextDecoder().decode(parts[0].body) || "{}");
  } catch {
    return fail(googleError(400, "Invalid JSON payload received in the metadata part.", "parseError"));
  }
  return { metadata, content: parts[1].body, contentType: parts[1].headers["content-type"] || "" };
};

// -----------------------------------------------------------------------------
// fields selection (Drive's partial responses)
// -----------------------------------------------------------------------------

type FieldTree = Map<string, FieldTree | true>;

const parseFields = (text: string): FieldTree => {
  let at = 0;
  const readName = () => {
    const start = at;
    while (at < text.length && /[A-Za-z0-9_*]/.test(text[at])) at++;
    const name = text.slice(start, at);
    if (!name) {
      throw new Error(`Invalid field selection ${text}`);
    }
    return name;
  };

  const readSubtree = (): FieldTree | true => {
    let sub: FieldTree | true = true;
    if (text[at] === "(") {
      at++;
      sub = parseList();
      if (text[at] !== ")") {
        throw new Error(`Invalid field selection ${text}`);
      }
      at++;
    }
    return sub;
  };

  const mergeField = (tree: FieldTree, name: string, sub: FieldTree | true) => {
    const old = tree.get(name);
    let merged = sub;
    if (old && old !== true && sub !== true) {
      merged = new Map([...old, ...sub]);
    } else if (old === true) {
      merged = true;
    }
    tree.set(name, merged);
  };

  const parseList = (): FieldTree => {
    const tree: FieldTree = new Map();
    while (at < text.length) {
      while (text[at] === " " || text[at] === ",") at++;
      if (text[at] === ")" || at >= text.length) {
        break;
      }
      const name = readName();
      const sub = readSubtree();
      mergeField(tree, name, sub);
      if (text[at] === ",") {
        at++;
      } else if (at < text.length && text[at] !== ")") {
        throw new Error(`Invalid field selection ${text}`);
      }
    }
    return tree;
  };
  // "a/b/c,d": treat "/" as a one-element nesting
  const normalized = text.replace(/(?<![A-Za-z0-9_*])([A-Za-z0-9_*]+)\/([A-Za-z0-9_*/]+)/g, (_match, head: string, tail: string) => {
    const segments = [head, ...tail.split("/")];
    return segments.slice(0, -1).join("(") + `(${segments.at(-1)}` + ")".repeat(segments.length - 1);
  });
  text = normalized.replace(/\s+/g, "");
  return parseList();
};

const FILE_KEYS = new Set(
  (
    "kind,id,name,mimeType,description,starred,trashed,explicitlyTrashed,trashingUser,trashedTime,parents,properties,appProperties,spaces," +
    "version,webContentLink,webViewLink,iconLink,hasThumbnail,thumbnailLink,thumbnailVersion,viewedByMe,viewedByMeTime,createdTime," +
    "modifiedTime,modifiedByMeTime,modifiedByMe,sharedWithMeTime,sharingUser,owners,driveId,teamDriveId,lastModifyingUser,shared," +
    "ownedByMe,capabilities,viewersCanCopyContent,copyRequiresWriterPermission,writersCanShare,permissions,permissionIds," +
    "hasAugmentedPermissions,folderColorRgb,originalFilename,fullFileExtension,fileExtension,md5Checksum,sha1Checksum,sha256Checksum," +
    "size,quotaBytesUsed,headRevisionId,contentHints,imageMediaMetadata,videoMediaMetadata,isAppAuthorized,exportLinks,shortcutDetails," +
    "contentRestrictions,resourceKey,linkShareMetadata,labelInfo,inheritedPermissionsDisabled,downloadRestrictions"
  ).split(","),
);
const REVISION_KEYS = new Set(
  "kind,id,mimeType,modifiedTime,keepForever,published,publishedLink,publishAuto,publishedOutsideDomain,lastModifyingUser,originalFilename,md5Checksum,size,exportLinks".split(","),
);
const PERMISSION_KEYS = new Set(
  "kind,id,type,emailAddress,domain,role,view,allowFileDiscovery,displayName,photoLink,expirationTime,teamDrivePermissionDetails,permissionDetails,deleted,pendingOwner,inheritedPermissionsDisabled".split(","),
);

const checkKeys = (tree: FieldTree | true | undefined, keys: Set<string>) => {
  if (!tree || tree === true) {
    return;
  }
  for (const key of tree.keys()) {
    if (key !== "*" && !keys.has(key)) {
      fail(invalid(`Invalid field selection ${key}`, "fields"));
    }
  }
};

const select = (value: any, tree: FieldTree | true | undefined): any => {
  if (tree === undefined || tree === true || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => select(item, tree));
  }
  if (tree.has("*")) {
    return value;
  }
  const out: Row = {};
  for (const [key, sub] of tree) {
    if (value[key] !== undefined) {
      out[key] = select(value[key], sub);
    }
  }
  return out;
};

const fieldsOf = (url: URL, fallback: string) => {
  try {
    return parseFields(url.searchParams.get("fields") || fallback);
  } catch (error: any) {
    return fail(invalid(error.message, "fields"));
  }
};

// -----------------------------------------------------------------------------
// the Durable Object
// -----------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS grants (email TEXT, client_id TEXT, scope TEXT, refresh TEXT, PRIMARY KEY (email, client_id));
CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, email TEXT, client_id TEXT, redirect_uri TEXT, scope TEXT, refresh INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, email TEXT, client_id TEXT, scope TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, parents TEXT, app_props TEXT, props TEXT, description TEXT,
  owner TEXT, created TEXT, modified TEXT, modifier TEXT, trashed INTEGER, version INTEGER, head TEXT, md5 TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS revisions (file_id TEXT, id TEXT, seq INTEGER, md5 TEXT, size INTEGER, mime TEXT, modified TEXT, user TEXT, keep INTEGER,
  PRIMARY KEY (file_id, id));
CREATE TABLE IF NOT EXISTS blobs (md5 TEXT, idx INTEGER, data BLOB, PRIMARY KEY (md5, idx));
CREATE TABLE IF NOT EXISTS perms (file_id TEXT, id TEXT, type TEXT, role TEXT, email TEXT, discover INTEGER, domain TEXT, expires INTEGER, PRIMARY KEY (file_id, id));
CREATE TABLE IF NOT EXISTS app_access (email TEXT, file_id TEXT, PRIMARY KEY (email, file_id));
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, resource_id TEXT, file_id TEXT, token TEXT, address TEXT, expiration INTEGER, email TEXT, msg INTEGER);
CREATE TABLE IF NOT EXISTS faults (id INTEGER PRIMARY KEY AUTOINCREMENT, remaining INTEGER, status INTEGER, reason TEXT, delay_ms INTEGER,
  email TEXT, path TEXT, method TEXT, target TEXT, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, file_id TEXT, email TEXT, content TEXT, created TEXT, modified TEXT, resolved INTEGER, seq INTEGER);
CREATE TABLE IF NOT EXISTS picks (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, ids TEXT);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS hints (file_id TEXT PRIMARY KEY, thumb TEXT, thumb_mime TEXT, text TEXT);
`;
const TABLES = ["users", "grants", "codes", "tokens", "files", "revisions", "blobs", "perms", "app_access", "channels", "faults", "log", "comments", "picks", "config", "hints"];

const titleCase = (email: string) =>
  email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ") || email;

const scopeUrl = (scope: string) => {
  if (scope === "email") return "https://www.googleapis.com/auth/userinfo.email";
  if (scope === "profile") return "https://www.googleapis.com/auth/userinfo.profile";
  return scope;
};

export class FakeGoogle extends DurableObject<FakeEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: FakeEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
      this.sql.exec(statement);
    }
    this.migrate();
    this.seed();
  }

  private all<T = Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  private one<T = Row>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] as T | undefined) ?? null;
  }

  private run(query: string, ...bindings: unknown[]) {
    this.sql.exec(query, ...bindings);
  }

  /** columns added later to a store kept by `wrangler dev --persist-to` */
  private migrate() {
    const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(perms)").map((row) => row.name));
    for (const [column, type] of [["domain", "TEXT"], ["expires", "INTEGER"]]) {
      if (!columns.has(column)) {
        this.run(`ALTER TABLE perms ADD COLUMN ${column} ${type}`);
      }
    }
  }

  private seed() {
    for (const [email, name] of TEST_USERS) {
      this.run("INSERT OR IGNORE INTO users (email, name) VALUES (?, ?)", email, name);
    }
  }

  private origin(request: Request) {
    return (this.env.DEV_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  }

  private log(kind: string, data: unknown) {
    this.run("INSERT INTO log (at, kind, data) VALUES (?, ?, ?)", now(), kind, JSON.stringify(data));
    this.run("DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - 3000");
  }

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------

  private user(email: string, name?: string) {
    const clean = email.trim().toLowerCase();
    this.run("INSERT OR IGNORE INTO users (email, name) VALUES (?, ?)", clean, name || titleCase(clean));
    if (name) {
      this.run("UPDATE users SET name = ? WHERE email = ?", name, clean);
    }
    return clean;
  }

  private userInfo(email: string, origin: string) {
    const row = this.one<{ name: string }>("SELECT name FROM users WHERE email = ?", email);
    return {
      email,
      name: row?.name || titleCase(email),
      sub: subOf(email),
      permissionId: permIdOf(email),
      picture: `${origin}${PREFIX}/avatar/${encodeURIComponent(email)}.svg`,
    };
  }

  private driveUser(email: string, me: string | null, origin: string) {
    const info = this.userInfo(email, origin);
    return {
      kind: "drive#user",
      displayName: info.name,
      emailAddress: email,
      permissionId: info.permissionId,
      me: email === me,
      photoLink: info.picture,
    };
  }

  // ---------------------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // the app calls the fake from its own origin and the tests are Node scripts: no
    // other website open in the developer's browser may use it (CORS for DEV_ORIGIN only)
    const devOrigin = (this.env.DEV_ORIGIN ?? "").replace(/\/$/, "");
    const cors: Record<string, string> =
      devOrigin && request.headers.get("Origin") === devOrigin
        ? {
            "Access-Control-Allow-Origin": devOrigin,
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Expose-Headers": "Content-Type, Content-Length, Location",
            "Access-Control-Max-Age": "3600",
            Vary: "Origin",
          }
        : { Vary: "Origin" };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    let response: Response;
    try {
      response = await this.route(request, url);
    } catch (error) {
      if (error instanceof HttpError) {
        response = error.response;
      } else {
        console.error("[fake-google]", error);
        response = googleError(500, `Internal Error (fake Google: ${(error as Error)?.message ?? error})`, "backendError");
      }
    }
    const out = new Response(response.body, response);
    Object.entries(cors).forEach(([key, value]) => out.headers.set(key, value));
    return out;
  }

  private async route(request: Request, url: URL): Promise<Response> {
    let path = url.pathname.slice(PREFIX.length) || "/";
    // a relative upload URL appended to the API base (drive.ts with VITE_APP_GOOGLE_API_BASE)
    path = path.replace(/^\/drive\/v3\/fake-google\/upload\/drive\/v3(?=\/)/, "/upload/drive/v3");
    if (path === "/" || path === "/admin" || path === "/admin/") {
      return this.help();
    }
    const avatar = /^\/avatar\/([^/]+)\.svg$/.exec(path);
    if (avatar) {
      return this.avatar(decodeURIComponent(avatar[1]));
    }
    if (path.startsWith("/oauth/")) {
      return this.oauth(request, url, path.slice("/oauth".length));
    }
    if (path.startsWith("/admin/")) {
      return this.admin(request, url, path.slice("/admin".length));
    }
    const thumbnail = /^\/thumbnail\/([^/]+)$/.exec(path);
    if (thumbnail) {
      return this.thumbnail(decodeURIComponent(thumbnail[1]));
    }
    if (path === "/picker" && request.method === "POST") {
      return this.picker(request, url);
    }
    const drive = /^\/(upload\/)?drive\/v3(\/.*)$/.exec(path);
    if (drive) {
      return this.drive(request, url, drive[2], !!drive[1], path);
    }
    return json(404, { error: { code: 404, message: `Not found: ${url.pathname}` } });
  }

  private help() {
    const text = [
      "Fake Google for Kurviq (online/worker/fakeGoogle.ts; the header comment documents it all)",
      "",
      "OAuth:  GET /fake-google/oauth/authorize, GET approve, POST token, POST revoke",
      "Drive:  /fake-google/drive/v3/…, /fake-google/upload/drive/v3/…",
      "Admin:  POST reset | GET file?fileId | POST grant {email,fileId}",
      "        POST write {email,fileId?,content,name?} | POST share, unshare {fileId,email|anyone,role}",
      "        POST trash, untrash, delete {fileId} | GET revisions?fileId",
      "        POST revoke {email} | POST/GET/DELETE faults | GET log?kind | GET channels",
      "",
      `Users: ${this.all<{ email: string }>("SELECT email FROM users ORDER BY email").map((row) => row.email).join(", ")}`,
      `API key: ${API_KEY}   client secret: ${CLIENT_SECRET}`,
    ].join("\n");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  private avatar(email: string) {
    const colors = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599"];
    const color = colors[hash53(email) % colors.length];
    const letter = escapeHtml((email[0] || "?").toUpperCase());
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${color}"/><text x="48" y="62" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
      { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } },
    );
  }

  // ---------------------------------------------------------------------------
  // faults
  // ---------------------------------------------------------------------------

  /** an injected fault for this Drive call (matched against the path after /fake-google plus the query), or null */
  private async fault(request: Request, path: string, email: string | null): Promise<Response | null> {
    const target = `${path}${new URL(request.url).search}`;
    const match = this.all<Row>("SELECT * FROM faults ORDER BY id").find((fault) => !fault.path || target.includes(fault.path));
    if (!match) {
      return null;
    }
    if (match.remaining <= 1) {
      this.run("DELETE FROM faults WHERE id = ?", match.id);
    } else {
      this.run("UPDATE faults SET remaining = remaining - 1, used = 1 WHERE id = ?", match.id);
    }
    this.log("fault", { id: match.id, method: request.method, path: target, email, status: match.status, delayMs: match.delay_ms });
    if (match.delay_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, match.delay_ms));
    }
    if (!match.status) {
      return null;
    }
    const status = Number(match.status);
    if (status === 429) {
      return googleError(429, "Rate Limit Exceeded", "rateLimitExceeded", { domain: "usageLimits" }, { "Retry-After": "1" });
    }
    if (status === 401) {
      return googleError(401, "Request had invalid authentication credentials.", "authError", { location: "Authorization", locationType: "header", status: "UNAUTHENTICATED" });
    }
    if (status >= 500) {
      return googleError(status, status === 500 ? "Internal Error" : "The service is currently unavailable.", "backendError");
    }
    return googleError(status, `Fault injected by the fake Google (${status})`, status === 403 ? "userRateLimitExceeded" : "invalid", { domain: status === 403 ? "usageLimits" : "global" });
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  private grantedScopes(requested: string, drive: boolean, previous: string | null, includeGranted: boolean) {
    const scopes = new Set(
      requested
        .split(/\s+/)
        .filter(Boolean)
        .map(scopeUrl)
        .filter((scope) => drive || !scope.startsWith("https://www.googleapis.com/auth/drive")),
    );
    if (includeGranted && previous) {
      previous.split(" ").filter(Boolean).forEach((scope) => scopes.add(scope));
    }
    return [...scopes].join(" ");
  }

  private redirectWith(redirectUri: string, params: Record<string, string>) {
    const target = new URL(redirectUri);
    Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value));
    return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
  }

  /** a code for the user (the page approved) */
  private issueCode(params: URLSearchParams, email: string, drive: boolean) {
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const grant = this.one<Row>("SELECT * FROM grants WHERE email = ? AND client_id = ?", email, clientId);
    const scope = this.grantedScopes(params.get("scope") || "", drive, grant?.scope ?? null, params.get("include_granted_scopes") === "true");
    const offline = params.get("access_type") === "offline";
    const consent = (params.get("prompt") || "").split(" ").includes("consent");
    // Google: a refresh token on the first consent, and again when consent is asked for
    const refresh = offline && (consent || !grant?.refresh) ? 1 : 0;
    const code = `4/0fake${randomId(40)}`;
    this.run(
      "INSERT INTO codes (code, email, client_id, redirect_uri, scope, refresh, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
      code,
      email,
      clientId,
      redirectUri,
      scope,
      refresh,
      Date.now() + 10 * 60_000,
    );
    const back: Record<string, string> = { code, scope, authuser: "0", prompt: consent ? "consent" : "none" };
    if (params.has("state")) {
      back.state = params.get("state")!;
    }
    return this.redirectWith(redirectUri, back);
  }

  private oauthAuthorize(url: URL) {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") || "";
    try {
      new URL(redirectUri);
    } catch {
      return new Response("Error 400: redirect_uri_mismatch (missing or not absolute)", { status: 400 });
    }
    if (!params.get("client_id")) {
      return new Response("Error 400: invalid_request (Missing required parameter: client_id)", { status: 400 });
    }
    if (params.get("response_type") !== "code") {
      return this.redirectWith(redirectUri, { error: "unsupported_response_type", ...(params.has("state") ? { state: params.get("state")! } : {}) });
    }
    const prompt = (params.get("prompt") || "").split(" ").filter(Boolean);
    if (prompt.includes("none")) {
      return new Response("prompt=none is not supported by the fake Google", { status: 400 });
    }
    return this.authorizePage(params, (params.get("login_hint") || "").trim().toLowerCase(), prompt);
  }

  private oauthApprove(url: URL) {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") || "";
    try {
      new URL(redirectUri);
    } catch {
      return new Response("Error 400: redirect_uri_mismatch", { status: 400 });
    }
    if (params.get("cancel") === "1") {
      return this.redirectWith(redirectUri, { error: "access_denied", ...(params.has("state") ? { state: params.get("state")! } : {}) });
    }
    const email = (params.get("email") || params.get("custom_email") || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      return new Response("Type an email address (or pick a test user).", { status: 400 });
    }
    // the page sends drive=1 when ticked (a form leaves unticked boxes out); scripts may leave it out
    const drive = params.has("form") ? params.get("drive") === "1" : params.get("drive") !== "0";
    return this.issueCode(params, this.user(email, params.get("name") || undefined), drive);
  }

  private async oauthRevoke(request: Request, url: URL) {
    const form = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
    const value = form.get("token") || url.searchParams.get("token") || "";
    const access = this.one<Row>("SELECT * FROM tokens WHERE token = ?", value);
    const grant = access
      ? this.one<Row>("SELECT * FROM grants WHERE email = ? AND client_id = ?", access.email, access.client_id)
      : this.one<Row>("SELECT * FROM grants WHERE refresh = ?", value);
    if (!grant) {
      return json(400, { error: "invalid_token", error_description: "Token expired or revoked" });
    }
    this.revokeGrant(grant.email, grant.client_id);
    return json(200, {});
  }

  private async oauth(request: Request, url: URL, path: string): Promise<Response> {
    if (path === "/authorize" && request.method === "GET") {
      return this.oauthAuthorize(url);
    }
    if (path === "/approve" && request.method === "GET") {
      return this.oauthApprove(url);
    }
    if (path === "/token" && request.method === "POST") {
      return this.token(request);
    }
    if (path === "/revoke" && (request.method === "POST" || request.method === "GET")) {
      return this.oauthRevoke(request, url);
    }
    return json(404, { error: "not_found" });
  }

  private revokeGrant(email: string, clientId?: string) {
    if (clientId === undefined) {
      this.run("DELETE FROM grants WHERE email = ?", email);
      this.run("DELETE FROM tokens WHERE email = ?", email);
    } else {
      this.run("DELETE FROM grants WHERE email = ? AND client_id = ?", email, clientId);
      this.run("DELETE FROM tokens WHERE email = ? AND client_id = ?", email, clientId);
    }
    this.log("revoke", { email, clientId: clientId ?? "*" });
  }

  private authorizePage(params: URLSearchParams, hint: string, prompt: string[]) {
    const hidden = [...params]
      .filter(([key]) => !["email", "custom_email", "drive", "cancel", "form"].includes(key))
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join("");
    const users = this.all<{ email: string; name: string }>("SELECT email, name FROM users ORDER BY email");
    const scopes = (params.get("scope") || "").split(/\s+/).filter(Boolean);
    const wantsDrive = scopes.some((scope) => scope.startsWith("https://www.googleapis.com/auth/drive"));
    const buttons = users
      .map(
        (user) =>
          `<button class="user${user.email === hint ? " hinted" : ""}" name="email" value="${escapeHtml(user.email)}"><b>${escapeHtml(user.name)}</b><span>${escapeHtml(user.email)}</span></button>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Fake Google</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#1a73e8}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1b1e23;--fg:#e6e8eb;--muted:#9aa3ad;--line:#30363d;--accent:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;display:flex;justify-content:center;padding:40px 16px}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px}
.user{display:flex;flex-direction:column;align-items:flex-start;width:100%;padding:10px 14px;margin:0 0 8px;border:1px solid var(--line);border-radius:8px;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left}
.user span{color:var(--muted);font-size:13px}.user:hover,.hinted{border-color:var(--accent)}
.row{display:flex;gap:8px;margin:14px 0}input[type=email]{flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:none;color:inherit;font:inherit}
.go,.cancel{padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;cursor:pointer}
.cancel{background:none;color:var(--accent)}label{display:flex;gap:8px;align-items:flex-start;margin:14px 0;font-size:14px}
</style></head><body>
<form method="get" action="${PREFIX}/oauth/approve">${hidden}<input type="hidden" name="form" value="1">
<h1>Fake Google: choose an account</h1>
<p>to continue to Kurviq (test accounts, nothing leaves this machine)${prompt.length ? ` · prompt=${escapeHtml(prompt.join(" "))}` : ""}</p>
${buttons}
<div class="row"><input type="email" name="custom_email" placeholder="any@email.test" value="${escapeHtml(hint && !users.some((user) => user.email === hint) ? hint : "")}"><button class="go" name="email" value="">Continue</button></div>
${wantsDrive ? `<label><input type="checkbox" name="drive" value="1" checked> See, edit, create and delete only the specific Google Drive files you use with this app (drive.file)</label>` : ""}
<button class="cancel" name="cancel" value="1">Cancel</button>
</form></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  private idToken(email: string, clientId: string, origin: string) {
    const info = this.userInfo(email, origin);
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      azp: clientId,
      aud: clientId,
      sub: info.sub,
      email,
      email_verified: true,
      name: info.name,
      given_name: info.name.split(" ")[0],
      family_name: info.name.split(" ").slice(1).join(" ") || undefined,
      picture: info.picture,
      iat,
      exp: iat + ACCESS_SECONDS,
    };
    return `${b64url(JSON.stringify({ alg: "none", kid: "fake", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.ZmFrZQ`;
  }

  private newAccessToken(email: string, clientId: string, scope: string) {
    const token = `ya29.fake-${randomId(60)}`;
    this.run(
      "INSERT INTO tokens (token, email, client_id, scope, expires) VALUES (?, ?, ?, ?, ?)",
      token,
      email,
      clientId,
      scope,
      Date.now() + ACCESS_SECONDS * 1000,
    );
    this.run("DELETE FROM tokens WHERE expires < ?", Date.now() - 24 * 3600 * 1000);
    return token;
  }

  private exchangeCode(form: URLSearchParams, clientId: string, origin: string) {
    const code = this.one<Row>("SELECT * FROM codes WHERE code = ?", form.get("code") || "");
    if (code) {
      this.run("DELETE FROM codes WHERE code = ?", code.code);
    }
    if (!code || code.expires < Date.now() || code.client_id !== clientId) {
      return json(400, { error: "invalid_grant", error_description: "Malformed auth code." });
    }
    if (code.redirect_uri !== (form.get("redirect_uri") || "")) {
      return json(400, { error: "redirect_uri_mismatch", error_description: "Bad Request" });
    }
    const grant = this.one<Row>("SELECT * FROM grants WHERE email = ? AND client_id = ?", code.email, clientId);
    let refresh: string | null = grant?.refresh ?? null;
    if (code.refresh && !refresh) {
      refresh = `1//0fake${randomId(60)}`;
    }
    this.run(
      "INSERT OR REPLACE INTO grants (email, client_id, scope, refresh) VALUES (?, ?, ?, ?)",
      code.email,
      clientId,
      code.scope,
      refresh,
    );
    return json(200, {
      access_token: this.newAccessToken(code.email, clientId, code.scope),
      expires_in: ACCESS_SECONDS - 1,
      ...(code.refresh && refresh ? { refresh_token: refresh } : {}),
      scope: code.scope,
      token_type: "Bearer",
      ...(code.scope.split(" ").includes("openid") ? { id_token: this.idToken(code.email, clientId, origin) } : {}),
    });
  }

  private exchangeRefresh(form: URLSearchParams, clientId: string, origin: string) {
    const grant = this.one<Row>("SELECT * FROM grants WHERE refresh = ? AND client_id = ?", form.get("refresh_token") || "", clientId);
    if (!grant) {
      return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    return json(200, {
      access_token: this.newAccessToken(grant.email, clientId, grant.scope),
      expires_in: ACCESS_SECONDS - 1,
      scope: grant.scope,
      token_type: "Bearer",
      ...(grant.scope.split(" ").includes("openid") ? { id_token: this.idToken(grant.email, clientId, origin) } : {}),
    });
  }

  private async token(request: Request) {
    const form = new URLSearchParams(await request.text());
    const clientId = form.get("client_id") || "";
    const clientSecret = form.get("client_secret") || "";
    if (!clientId) {
      return json(400, { error: "invalid_request", error_description: "Missing required parameter: client_id" });
    }
    if (clientSecret !== CLIENT_SECRET) {
      return json(401, { error: "invalid_client", error_description: "Unauthorized" });
    }
    const origin = this.origin(request);
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return this.exchangeCode(form, clientId, origin);
    }
    if (grantType === "refresh_token") {
      return this.exchangeRefresh(form, clientId, origin);
    }
    return json(400, { error: "unsupported_grant_type", error_description: `Invalid grant_type: ${grantType ?? ""}` });
  }

  /** who calls: a user's access token, the API key (anonymous), or null (bad/expired token) */
  private caller(request: Request, url: URL): Caller | null | "none" | "badkey" {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1] || url.searchParams.get("access_token"); // NOSONAR S8786: HTTP headers forbid line breaks, so the suffix cannot trigger repeated whitespace backtracking
    if (bearer) {
      const row = this.one<Row>("SELECT * FROM tokens WHERE token = ?", bearer.trim());
      if (!row || row.expires < Date.now()) {
        return null;
      }
      return { kind: "user", email: row.email, scope: String(row.scope).split(" ") };
    }
    const key = url.searchParams.get("key");
    if (key) {
      return key === API_KEY || key === this.env.GOOGLE_API_KEY ? { kind: "anonymous" } : "badkey";
    }
    return "none";
  }

  // ---------------------------------------------------------------------------
  // Drive: access
  // ---------------------------------------------------------------------------

  private file(id: string) {
    return this.one<FileRow>("SELECT * FROM files WHERE id = ?", id);
  }

  /** a file's permissions; expired ones are gone, as Drive removes them */
  private perms(fileId: string) {
    return this.all<Row>(
      "SELECT * FROM perms WHERE file_id = ? AND (expires IS NULL OR expires > ?) ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, rowid",
      fileId,
      Date.now(),
    );
  }

  /** the folders a file is in, its parents first (a few levels: Kurviq's folders are flat) */
  private ancestors(file: FileRow): FileRow[] {
    const out: FileRow[] = [];
    let level = (JSON.parse(file.parents || "[]") as string[]).map((id) => this.file(id)).filter((row): row is FileRow => !!row);
    for (let depth = 0; depth < 5 && level.length; depth++) {
      out.push(...level);
      level = level.flatMap((row) => (JSON.parse(row.parents || "[]") as string[]).map((id) => this.file(id))).filter((row): row is FileRow => !!row);
    }
    return out;
  }

  private setting(key: string) {
    return this.one<{ value: string }>("SELECT value FROM config WHERE key = ?", key)?.value ?? null;
  }

  /**
   * drive.file: the app may open the file for this user (created through the
   * API, or granted: the Picker, "Open with"). With the setting
   * folderPickGrantsChildren, a granted folder grants the files in it too
   * (whether Google does is to verify; the tests run both ways).
   */
  private appCanOpen(email: string, file: FileRow) {
    if (this.one("SELECT 1 AS x FROM app_access WHERE email = ? AND file_id = ?", email, file.id)) {
      return true;
    }
    return (
      this.setting("folderPickGrantsChildren") === "1" &&
      this.ancestors(file).some((folder) => !!this.one("SELECT 1 AS x FROM app_access WHERE email = ? AND file_id = ?", email, folder.id))
    );
  }

  /** the caller's role on a file (null: can't see it); the folders it is in pass theirs on, as in Drive */
  private roleOf(file: FileRow, caller: Caller, appOnly = true): string | null {
    const perms = [...this.perms(file.id), ...this.ancestors(file).flatMap((folder) => this.perms(folder.id))];
    const anyone = perms.find((perm) => perm.type === "anyone");
    if (caller.kind === "anonymous") {
      return anyone && !file.trashed ? "reader" : null;
    }
    if (appOnly && !this.appCanOpen(caller.email, file)) {
      return null;
    }
    const domain = caller.email.split("@")[1];
    const own = perms
      .filter((perm) => (perm.type === "user" && perm.email === caller.email) || (perm.type === "domain" && perm.domain === domain))
      // a folder's owner may edit what others put in it
      .map((perm) => (perm.role === "owner" && perm.file_id !== file.id ? "writer" : perm.role));
    const roles = [...own, anyone?.role].filter(Boolean) as string[];
    if (!roles.length) {
      return null;
    }
    roles.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
    return roles[0];
  }

  private access(id: string, caller: Caller) {
    const file = this.file(id);
    const role = file ? this.roleOf(file, caller) : null;
    if (!file || !role) {
      return fail(notFound(id));
    }
    return { file, role };
  }

  private capabilities(file: FileRow, role: string, caller: Caller) {
    const rank = caller.kind === "anonymous" ? 1 : ROLE_RANK[role];
    const trashed = !!file.trashed;
    const folder = file.mime === FOLDER_MIME;
    const edit = !trashed && rank >= 3;
    return {
      canEdit: edit,
      canShare: !trashed && rank >= 3 && caller.kind === "user",
      canComment: rank >= 2,
      canCopy: !folder,
      canDownload: true,
      canRename: edit,
      canModifyContent: edit && !folder,
      canAddChildren: edit && folder,
      canListChildren: folder,
      canReadRevisions: rank >= 3,
      canTrash: !trashed && rank === 4,
      canUntrash: trashed && rank === 4,
      canDelete: rank === 4,
      canRemoveChildren: edit && folder,
      canChangeCopyRequiresWriterPermission: rank === 4,
      canChangeViewersCanCopyContent: rank === 4,
      canMoveItemWithinDrive: rank >= 3,
      canAcceptOwnership: false,
      canReadLabels: false,
      canModifyLabels: false,
    };
  }

  private contentResource(file: FileRow, folder: boolean, extension: string | undefined) {
    return {
      originalFilename: folder ? undefined : file.name,
      fullFileExtension: folder ? undefined : extension,
      fileExtension: folder ? undefined : extension,
      md5Checksum: folder ? undefined : file.md5 ?? undefined,
      size: folder ? undefined : String(file.size),
      quotaBytesUsed: folder ? "0" : String(file.size),
      headRevisionId: folder ? undefined : file.head ?? undefined,
    };
  }

  private resource(file: FileRow, role: string, caller: Caller, origin: string) {
    const me = caller.kind === "user" ? caller.email : null;
    const perms = this.perms(file.id);
    const folder = file.mime === FOLDER_MIME;
    const extension = file.name.includes(".") ? file.name.split(".").pop()! : undefined;
    const out: Row = {
      kind: "drive#file",
      id: file.id,
      name: file.name,
      mimeType: file.mime,
      description: file.description ?? undefined,
      starred: false,
      trashed: !!file.trashed,
      explicitlyTrashed: !!file.trashed,
      parents: JSON.parse(file.parents),
      properties: JSON.parse(file.props || "{}"),
      appProperties: JSON.parse(file.app_props || "{}"),
      spaces: ["drive"],
      version: String(file.version),
      webViewLink: folder ? `https://drive.google.com/drive/folders/${file.id}` : `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`,
      webContentLink: folder ? undefined : `https://drive.google.com/uc?id=${file.id}&export=download`,
      iconLink: `https://drive-thirdparty.googleusercontent.com/16/type/${file.mime}`,
      ...this.thumbnailResource(file.id, origin),
      viewedByMe: !!me,
      createdTime: file.created,
      modifiedTime: file.modified,
      modifiedByMe: file.modifier === me,
      modifiedByMeTime: file.modifier === me ? file.modified : undefined,
      owners: [this.driveUser(file.owner, me, origin)],
      lastModifyingUser: this.driveUser(file.modifier, me, origin),
      shared: perms.some((perm) => perm.role !== "owner"),
      ownedByMe: file.owner === me,
      capabilities: this.capabilities(file, role, caller),
      viewersCanCopyContent: true,
      copyRequiresWriterPermission: false,
      writersCanShare: true,
      permissionIds: perms.map((perm) => perm.id),
      permissions: ROLE_RANK[role] >= 3 && caller.kind === "user" ? perms.map((perm) => this.permission(perm, origin)) : undefined,
      hasAugmentedPermissions: false,
      isAppAuthorized: caller.kind === "user",
      ...this.contentResource(file, folder, extension),
    };
    if (me && file.owner !== me) {
      const share = perms.some((perm) => perm.email === me);
      out.sharingUser = share ? this.driveUser(file.owner, me, origin) : undefined;
    }
    if (file.trashed) {
      out.trashedTime = file.modified;
    }
    if (caller.kind === "anonymous") {
      // Google never hands private (app) properties to an API key
      delete out.appProperties;
      delete out.permissions;
    }
    return out;
  }

  private permission(perm: Row, origin: string) {
    if (perm.type === "anyone") {
      return { kind: "drive#permission", id: perm.id, type: "anyone", role: perm.role, allowFileDiscovery: !!perm.discover, deleted: false };
    }
    if (perm.type === "domain") {
      return { kind: "drive#permission", id: perm.id, type: "domain", role: perm.role, domain: perm.domain, displayName: perm.domain, allowFileDiscovery: !!perm.discover, deleted: false };
    }
    const info = this.userInfo(perm.email, origin);
    return {
      kind: "drive#permission",
      id: perm.id,
      type: "user",
      role: perm.role,
      emailAddress: perm.email,
      displayName: info.name,
      photoLink: info.picture,
      ...(perm.expires ? { expirationTime: new Date(perm.expires).toISOString() } : {}),
      deleted: false,
      pendingOwner: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Drive: content, revisions, notifications
  // ---------------------------------------------------------------------------

  private async storeBlob(bytes: Uint8Array) {
    const md5 = await md5Hex(bytes);
    if (!this.one("SELECT 1 AS x FROM blobs WHERE md5 = ? LIMIT 1", md5)) {
      for (let i = 0, index = 0; i < Math.max(bytes.length, 1); i += BLOB_CHUNK, index++) {
        this.run("INSERT OR REPLACE INTO blobs (md5, idx, data) VALUES (?, ?, ?)", md5, index, bytes.slice(i, i + BLOB_CHUNK).buffer);
      }
    }
    return md5;
  }

  private blob(md5: string) {
    const chunks = this.all<{ data: ArrayBuffer }>("SELECT data FROM blobs WHERE md5 = ? ORDER BY idx", md5).map((row) => new Uint8Array(row.data));
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private gcBlobs() {
    this.run("DELETE FROM blobs WHERE md5 NOT IN (SELECT md5 FROM revisions)");
  }

  /** new content: a new head revision; old not-kept revisions beyond 100 are purged */
  private async writeContent(file: FileRow, bytes: Uint8Array, mime: string, email: string) {
    const md5 = await this.storeBlob(bytes);
    const revision = `0B${randomId(38, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
    const seq = (this.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM revisions WHERE file_id = ?", file.id)?.seq ?? 0) + 1;
    const at = now();
    this.run(
      "INSERT INTO revisions (file_id, id, seq, md5, size, mime, modified, user, keep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      file.id,
      revision,
      seq,
      md5,
      bytes.length,
      mime,
      at,
      email,
    );
    this.run(
      "UPDATE files SET head = ?, md5 = ?, size = ?, modified = ?, modifier = ?, version = version + 1 WHERE id = ?",
      revision,
      md5,
      bytes.length,
      at,
      email,
      file.id,
    );
    const unkept = this.all<{ id: string }>("SELECT id FROM revisions WHERE file_id = ? AND keep = 0 AND id != ? ORDER BY seq", file.id, revision);
    for (const old of unkept.slice(0, Math.max(0, unkept.length - UNKEPT_MAX))) {
      this.run("DELETE FROM revisions WHERE file_id = ? AND id = ?", file.id, old.id);
    }
    if (unkept.length > UNKEPT_MAX) {
      this.gcBlobs();
    }
  }

  /**
   * After an unshare: like Google, a channel whose creator can't see the file
   * any more gets "remove" (Drive's "deleted or unshared") and ends.
   */
  private dropChannelsWithoutAccess(fileId: string) {
    const file = this.file(fileId);
    for (const channel of this.all<Row>("SELECT * FROM channels WHERE file_id = ?", fileId)) {
      const caller: Caller = { kind: "user", email: channel.email, scope: [] };
      if (!file || !this.roleOf(file, caller, false)) {
        this.run("UPDATE channels SET msg = msg + 1 WHERE id = ?", channel.id);
        this.deliver({ ...channel, msg: channel.msg + 1 }, "remove", []);
        this.run("DELETE FROM channels WHERE id = ?", channel.id);
      }
    }
  }

  /** watch notifications for a file (delivered in the background) */
  private notify(fileId: string, state: "update" | "trash" | "untrash" | "remove", changed: string[] = []) {
    this.run("DELETE FROM channels WHERE expiration < ?", Date.now());
    for (const channel of this.all<Row>("SELECT * FROM channels WHERE file_id = ?", fileId)) {
      this.run("UPDATE channels SET msg = msg + 1 WHERE id = ?", channel.id);
      this.deliver({ ...channel, msg: channel.msg + 1 }, state, changed);
    }
  }

  private deliver(channel: Row, state: string, changed: string[]) {
    const headers: Record<string, string> = {
      "X-Goog-Channel-ID": channel.id,
      "X-Goog-Channel-Expiration": new Date(channel.expiration).toUTCString(),
      "X-Goog-Resource-ID": channel.resource_id,
      "X-Goog-Resource-URI": `https://www.googleapis.com/drive/v3/files/${channel.file_id}?alt=json&null`,
      "X-Goog-Resource-State": state,
      "X-Goog-Message-Number": String(channel.msg),
      "Content-Length": "0",
    };
    if (channel.token) {
      headers["X-Goog-Channel-Token"] = channel.token;
    }
    if (changed.length) {
      headers["X-Goog-Changed"] = changed.join(",");
    }
    const send = async () => {
      let status: number | string;
      try {
        const res = await fetch(channel.address, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
        status = res.status;
        await res.body?.cancel();
      } catch (error: any) {
        status = `error: ${error?.message ?? error}`;
      }
      this.log("notification", { channel: channel.id, fileId: channel.file_id, address: channel.address, state, changed, message: channel.msg, status });
    };
    this.ctx.waitUntil(send());
  }

  // ---------------------------------------------------------------------------
  // Drive: routes
  // ---------------------------------------------------------------------------

  private async drive(request: Request, url: URL, path: string, upload: boolean, fullPath: string): Promise<Response> {
    const who = this.caller(request, url);
    const email = who && typeof who === "object" && who.kind === "user" ? who.email : null;
    const fault = await this.fault(request, fullPath, email);
    let response: Response;
    if (fault) {
      response = fault;
    } else {
      try {
        response = await this.driveCall(request, url, path, upload, who);
      } catch (error) {
        if (!(error instanceof HttpError)) {
          throw error;
        }
        response = error.response;
      }
    }
    const query = url.search ? `?${decodeURIComponent(url.search.slice(1)).slice(0, 300)}` : "";
    this.log("request", { method: request.method, path: `${fullPath}${query}`, email: email ?? (who === null ? "(bad token)" : "(api key)"), status: response.status });
    return response;
  }

  private async watchFile(request: Request, fileId: string, user: User) {
    const { file } = this.access(fileId, user);
    const body = await parseJson(request);
    if (!body.id || typeof body.id !== "string") {
      return invalid("Required channel id", "id");
    }
    if (body.type !== "web_hook" && body.type !== "webhook") {
      return invalid("Invalid value for type: only web_hook is supported", "type");
    }
    try {
      new URL(String(body.address));
    } catch {
      return invalid(`Invalid push notification address '${body.address ?? ""}'`, "address");
    }
    if (this.one("SELECT 1 AS x FROM channels WHERE id = ?", body.id)) {
      return googleError(400, `Channel id ${body.id} not unique`, "channelIdNotUnique");
    }
    const requested = body.expiration ? Number(body.expiration) : Date.now() + CHANNEL_DEFAULT_MS;
    const expiration = Math.min(Number.isFinite(requested) ? requested : Date.now() + CHANNEL_DEFAULT_MS, Date.now() + CHANNEL_MAX_MS);
    const resourceDigits = digits(`res:${file.id}`, 12);
    const resourceId = `fakeRes${resourceDigits}`;
    this.run(
      "INSERT INTO channels (id, resource_id, file_id, token, address, expiration, email, msg) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      body.id,
      resourceId,
      file.id,
      body.token ?? null,
      String(body.address),
      expiration,
      user.email,
    );
    const channel = this.one<Row>("SELECT * FROM channels WHERE id = ?", body.id)!;
    this.deliver(channel, "sync", []);
    return json(200, {
      kind: "api#channel",
      id: body.id,
      resourceId,
      resourceUri: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=json&null`,
      ...(body.token ? { token: body.token } : {}),
      expiration: String(expiration),
    });
  }

  private getFile(url: URL, fileId: string, caller: Caller, origin: string) {
    if (fileId === "root" && caller.kind === "user") {
      const root = { kind: "drive#file", id: rootOf(caller.email), name: "My Drive", mimeType: FOLDER_MIME, parents: undefined, trashed: false };
      return json(200, select(root, fieldsOf(url, "kind,id,name,mimeType")));
    }
    const { file, role } = this.access(fileId, caller);
    if (url.searchParams.get("alt") === "media") {
      if (file.mime === FOLDER_MIME) {
        return googleError(403, "Only files with binary content can be downloaded. Use Export with Docs Editors files.", "fileNotDownloadable", { location: "alt" });
      }
      return new Response(this.blob(file.md5!), { headers: { "Content-Type": file.mime, "Cache-Control": "no-store" } });
    }
    const fields = fieldsOf(url, "kind,id,name,mimeType");
    checkKeys(fields, FILE_KEYS);
    return json(200, select(this.resource(file, role, caller, origin), fields));
  }

  private fileCall(request: Request, url: URL, { method, upload, fileId, caller, origin }: { method: string; upload: boolean; fileId: string; caller: Caller; origin: string }) {
    if (method === "GET" && !upload) {
      return this.getFile(url, fileId, caller, origin);
    }
    if (method === "PATCH") {
      return this.updateFile(request, url, requireUser(caller), fileId, upload, origin);
    }
    if (method === "DELETE" && !upload) {
      const user = requireUser(caller);
      const { file, role } = this.access(fileId, user);
      if (ROLE_RANK[role] < 4) {
        return noFilePermission();
      }
      this.notify(file.id, "remove");
      this.deleteFile(file.id);
      return new Response(null, { status: 204 });
    }
  }

  private async stopChannel(request: Request) {
    const body = await parseJson(request);
    const channel = this.one<Row>("SELECT * FROM channels WHERE id = ? AND resource_id = ?", String(body.id ?? ""), String(body.resourceId ?? ""));
    if (!channel) {
      return googleError(404, `Channel '${body.id}' not found for project 'fake'`, "notFound");
    }
    this.run("DELETE FROM channels WHERE id = ?", channel.id);
    return new Response(null, { status: 204 });
  }

  private driveFileCall(request: Request, url: URL, path: string, upload: boolean, caller: Caller, origin: string) {
    const method = request.method;
    const fileMatch = /^\/files\/([^/]+)(\/.*)?$/.exec(path);
    if (!fileMatch) {
      return googleError(404, `Not Found: ${path}`, "notFound");
    }
    const fileId = decodeURIComponent(fileMatch[1]);
    const rest = fileMatch[2] || "";

    if (!rest) {
      const response = this.fileCall(request, url, { method, upload, fileId, caller, origin });
      if (response) return response;
    }
    if (rest === "/watch" && method === "POST") {
      return this.watchFile(request, fileId, requireUser(caller));
    }
    const revisionMatch = /^\/revisions(?:\/([^/]+))?$/.exec(rest);
    if (revisionMatch) {
      return this.revisions(request, url, requireUser(caller), fileId, revisionMatch[1] ? decodeURIComponent(revisionMatch[1]) : null, origin);
    }
    const permissionMatch = /^\/permissions(?:\/([^/]+))?$/.exec(rest);
    if (permissionMatch) {
      return this.permissions(request, url, requireUser(caller), fileId, permissionMatch[1] ? decodeURIComponent(permissionMatch[1]) : null, origin);
    }
    const commentMatch = /^\/comments(?:\/([^/]+)(\/replies)?)?$/.exec(rest);
    if (commentMatch) {
      const commentId = commentMatch[1] ? decodeURIComponent(commentMatch[1]) : null;
      return this.comments(request, url, requireUser(caller), { fileId, commentId, replies: !!commentMatch[2], origin });
    }
    return googleError(404, `Not Found: ${method} ${path}`, "notFound");
  }

  private driveResourceCall(request: Request, url: URL, path: string, upload: boolean, caller: Caller, origin: string) {
    const method = request.method;
    if (path === "/channels/stop" && method === "POST") {
      requireUser(caller);
      return this.stopChannel(request);
    }
    if (path === "/files" && method === "GET" && !upload) {
      return this.listFiles(url, requireUser(caller), origin);
    }
    if (path === "/files" && method === "POST") {
      return this.createFile(request, url, requireUser(caller), upload, origin);
    }
    return this.driveFileCall(request, url, path, upload, caller, origin);
  }

  private async driveCall(request: Request, url: URL, path: string, upload: boolean, who: ReturnType<FakeGoogle["caller"]>): Promise<Response> {
    if (who === null) {
      return googleError(
        401,
        "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
        "authError",
        { location: "Authorization", locationType: "header", status: "UNAUTHENTICATED" },
        { "WWW-Authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"' },
      );
    }
    if (who === "badkey") {
      return googleError(400, "API key not valid. Please pass a valid API key.", "badRequest", { status: "INVALID_ARGUMENT" });
    }
    if (who === "none") {
      return googleError(
        403,
        "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
        "forbidden",
        { status: "PERMISSION_DENIED" },
      );
    }
    const caller = who;
    const origin = this.origin(request);
    if (caller.kind === "user" && !caller.scope.includes(DRIVE_FILE)) {
      return googleError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", { status: "PERMISSION_DENIED" });
    }
    return this.driveResourceCall(request, url, path, upload, caller, origin);
  }

  private listFiles(url: URL, caller: User, origin: string) {
    let predicate: Predicate = () => true;
    const q = url.searchParams.get("q");
    if (q) {
      try {
        predicate = parseQuery(q);
      } catch (error: any) {
        return invalid(`Invalid Value (${error.message})`, "q");
      }
    }
    if ((url.searchParams.get("spaces") || "drive").split(",").every((space) => space !== "drive")) {
      return json(200, select({ kind: "drive#fileList", incompleteSearch: false, files: [] }, fieldsOf(url, "kind,incompleteSearch,files(kind,id,name,mimeType)")));
    }
    const fields = fieldsOf(url, "kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)");
    const filesTree = fields.get("files");
    checkKeys(filesTree, FILE_KEYS);

    const visible = this.all<FileRow>("SELECT * FROM files ORDER BY created, id")
      .filter((file) => this.appCanOpen(caller.email, file))
      .map((file) => ({ file, role: this.roleOf(file, caller, false) }))
      .filter((entry): entry is { file: FileRow; role: string } => !!entry.role && predicate(entry.file, { email: caller.email, root: rootOf(caller.email) }));
    const orderBy = (url.searchParams.get("orderBy") || "").split(",").map((part) => part.trim()).filter(Boolean);
    const ORDER_KEYS: Record<string, (file: FileRow) => string> = {
      name: (file) => file.name.toLowerCase(),
      createdTime: (file) => file.created,
      modifiedTime: (file) => file.modified,
    };
    const unknown = orderBy.find((part) => !ORDER_KEYS[part.split(/\s+/)[0]]);
    if (unknown) {
      return invalid(`orderBy ${unknown} is not supported by the fake Google (createdTime, modifiedTime, name)`, "orderBy");
    }
    if (orderBy.length) {
      const keyOf = (file: FileRow, key: string) => ORDER_KEYS[key](file);
      visible.sort((a, b) => {
        for (const part of orderBy) {
          const [key, direction] = part.split(/\s+/);
          const left = keyOf(a.file, key);
          const right = keyOf(b.file, key);
          if (left !== right) {
            return (left < right ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
        }
        return 0;
      });
    }
    const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") || 100) || 100, 1), 1000);
    let offset = 0;
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken) {
      offset = Number(atob(pageToken).replace(/^o:/, ""));
      if (!Number.isInteger(offset) || offset < 0) {
        return invalid("Invalid Value", "pageToken");
      }
    }
    const page = visible.slice(offset, offset + pageSize);
    const body: Row = {
      kind: "drive#fileList",
      incompleteSearch: false,
      files: page.map(({ file, role }) => this.resource(file, role, caller, origin)),
    };
    if (offset + pageSize < visible.length) {
      body.nextPageToken = btoa(`o:${offset + pageSize}`);
    }
    return json(200, select(body, fields));
  }

  /** upload bodies: { metadata, content?, contentType } */

  private async uploadBody(request: Request, url: URL, upload: boolean) {
    if (!upload) {
      return { metadata: await parseJson(request), content: null as Uint8Array | null, contentType: "" };
    }
    const type = url.searchParams.get("uploadType") || "media";
    const contentType = request.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (type === "media") {
      return { metadata: {} as Row, content: bytes, contentType: contentType.split(";")[0].trim() };
    }
    if (type === "multipart") {
      if (!/^multipart\/related/i.test(contentType)) {
        return fail(invalid("Multipart uploads need Content-Type multipart/related.", "uploadType"));
      }
      const parsed = parseMultipart(contentType, bytes);
      return { metadata: parsed.metadata, content: parsed.content, contentType: parsed.contentType.split(";")[0].trim() };
    }
    return fail(invalid(`uploadType=${type} is not supported by the fake Google (media, multipart)`, "uploadType"));
  }

  private checkParents(parents: string[], caller: User) {
    return parents.map((parent) => {
      if (parent === "root" || parent === rootOf(caller.email)) {
        return rootOf(caller.email);
      }
      const folder = this.file(parent);
      const role = folder ? this.roleOf(folder, caller) : null;
      if (!folder || !role) {
        return fail(notFound(parent));
      }
      if (folder.mime !== FOLDER_MIME) {
        return fail(googleError(400, "The specified parent is not a folder.", "notAFolder", { location: "parents" }));
      }
      if (ROLE_RANK[role] < 3) {
        return fail(noFilePermission());
      }
      return parent;
    });
  }

  private stringMap(value: unknown, what: string): Record<string, string | null> {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return fail(invalid(`Invalid value for ${what}`, what));
    }
    const out: Record<string, string | null> = {};
    for (const [key, entry] of Object.entries(value as Row)) {
      if (new TextEncoder().encode(key + (entry ?? "")).length > 124) {
        return fail(googleError(400, `The ${what} key/value pair '${key}' is too long (limit 124 bytes).`, "invalid", { location: what }));
      }
      out[key] = entry === null ? null : String(entry);
    }
    return out;
  }

  private async createFile(request: Request, url: URL, caller: User, upload: boolean, origin: string) {
    const fields = fieldsOf(url, "kind,id,name,mimeType");
    checkKeys(fields, FILE_KEYS);
    const { metadata, content, contentType } = await this.uploadBody(request, url, upload);
    const mime = String(metadata.mimeType || contentType || "application/octet-stream");
    if (mime === FOLDER_MIME && content?.length) {
      return invalid("A folder can't have content.", "mimeType");
    }
    const parents = this.checkParents(Array.isArray(metadata.parents) && metadata.parents.length ? metadata.parents.map(String) : ["root"], caller);
    const appProps = Object.fromEntries(Object.entries(this.stringMap(metadata.appProperties, "appProperties")).filter(([, value]) => value !== null));
    const props = Object.fromEntries(Object.entries(this.stringMap(metadata.properties, "properties")).filter(([, value]) => value !== null));
    const hints = this.checkedHints(metadata.contentHints);
    const file = this.insertFile({
      email: caller.email,
      name: String(metadata.name ?? "Untitled"),
      mime,
      parents,
      appProps,
      props,
      description: metadata.description ?? null,
    });
    this.run("INSERT OR IGNORE INTO app_access (email, file_id) VALUES (?, ?)", caller.email, file.id);
    if (mime !== FOLDER_MIME) {
      await this.writeContent(file, content ?? new Uint8Array(), mime, caller.email);
    }
    this.storeHints(file.id, hints, true);
    const saved = this.file(file.id)!;
    return json(200, select(this.resource(saved, "owner", caller, origin), fields));
  }

  private insertFile(spec: { email: string; name: string; mime: string; parents: string[]; appProps?: Row; props?: Row; description?: string | null }) {
    const id = `1${randomId(32)}`;
    const at = now();
    this.run(
      "INSERT INTO files (id, name, mime, parents, app_props, props, description, owner, created, modified, modifier, trashed, version, head, md5, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, NULL, 0)",
      id,
      spec.name,
      spec.mime,
      JSON.stringify(spec.parents),
      JSON.stringify(spec.appProps ?? {}),
      JSON.stringify(spec.props ?? {}),
      spec.description ?? null,
      spec.email,
      at,
      at,
      spec.email,
    );
    this.run("INSERT INTO perms (file_id, id, type, role, email, discover) VALUES (?, ?, 'user', 'owner', ?, 0)", id, permIdOf(spec.email), spec.email);
    return this.file(id)!;
  }

  // contentHints (fakeGoogleHints.ts): never in Drive's answers (as at Google),
  // only hasThumbnail / thumbnailLink and GET /admin/file

  private hints(fileId: string) {
    return this.one<StoredHints>("SELECT thumb, thumb_mime, text FROM hints WHERE file_id = ?", fileId);
  }

  private checkedHints(value: unknown) {
    try {
      return parseHints(value);
    } catch (error) {
      if (error instanceof HintsError) {
        return fail(invalid(error.message, "contentHints"));
      }
      throw error;
    }
  }

  /** given hints are kept; new content without a thumbnail drops the old one, as at Drive */
  private storeHints(fileId: string, hints: ReturnType<typeof parseHints>, newContent: boolean) {
    const row = this.hints(fileId);
    const keepThumb = !newContent && row?.thumb;
    const thumb = hints?.thumbnail ?? (keepThumb ? { image: row.thumb!, mimeType: row.thumb_mime! } : null);
    const text = hints?.indexableText ?? row?.text ?? null;
    this.run("INSERT OR REPLACE INTO hints (file_id, thumb, thumb_mime, text) VALUES (?, ?, ?, ?)", fileId, thumb?.image ?? null, thumb?.mimeType ?? null, text);
  }

  private thumbnailResource(fileId: string, origin: string) {
    const row = this.hints(fileId);
    if (!row?.thumb) {
      return { hasThumbnail: false };
    }
    return { hasThumbnail: true, thumbnailLink: `${origin}${PREFIX}/thumbnail/${fileId}?v=${row.thumb.length}` };
  }

  /** a file's thumbnail (thumbnailLink; Google's are short-lived links without sign-in) */
  private thumbnail(fileId: string) {
    const row = this.hints(fileId);
    if (!row?.thumb) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(thumbnailBytes(row.thumb), { headers: { "Content-Type": row.thumb_mime ?? "image/png", "Cache-Control": "no-store" } });
  }

  private deleteFile(id: string) {
    this.run("DELETE FROM files WHERE id = ?", id);
    this.run("DELETE FROM hints WHERE file_id = ?", id);
    for (const table of ["revisions", "perms", "app_access", "channels"]) {
      this.run(`DELETE FROM ${table} WHERE file_id = ?`, id);
    }
    this.gcBlobs();
  }

  private fileUpdatePermission(file: FileRow, role: string, metadata: Row, content: Uint8Array | null, url: URL) {
    const rank = ROLE_RANK[role];
    if (url.searchParams.has("addParents") || url.searchParams.has("removeParents")) {
      return invalid("addParents / removeParents are not supported by the fake Google", "addParents");
    }
    let trashState: "trash" | "untrash" | null = null;
    if (metadata.trashed !== undefined && !!metadata.trashed !== !!file.trashed) {
      // in My Drive only the owner moves a file to (or out of) the bin
      if (rank < 4) {
        return noFilePermission();
      }
      trashState = metadata.trashed ? "trash" : "untrash";
    }
    const editsOther = content !== null || ["name", "mimeType", "description", "appProperties", "properties", "contentHints"].some((key) => metadata[key] !== undefined);
    if (editsOther && (rank < 3 || (file.trashed && !trashState))) {
      return noFilePermission();
    }
    return trashState;
  }

  /**
   * A file's appProperties / properties with `changes` merged in (null
   * deletes a key), checked like Drive: at most 124 bytes per key and value,
   * at most 30 keys. Fails (HttpError) before anything is written.
   */
  private mergedMap(file: FileRow, key: "appProperties" | "properties", changes: unknown) {
    const column = key === "appProperties" ? "app_props" : "props";
    const merged: Record<string, string> = { ...JSON.parse(file[column] || "{}") };
    for (const [name, value] of Object.entries(this.stringMap(changes, key))) {
      if (value === null) delete merged[name];
      else merged[name] = value;
    }
    if (Object.keys(merged).length > 30) {
      fail(googleError(403, `A file can have at most 30 ${key}.`, "propertyLimitExceeded"));
    }
    return { column, value: JSON.stringify(merged) };
  }

  /** a file in or out of the bin: new version, watch notification (the API and the admin calls) */
  private setTrashed(file: FileRow, trash: boolean) {
    this.run("UPDATE files SET trashed = ?, version = version + 1 WHERE id = ?", trash ? 1 : 0, file.id);
    this.notify(file.id, trash ? "trash" : "untrash");
  }

  /** a changed permission: new version, watch notification, channels that lost access end (the API and the admin calls) */
  private permissionsChanged(fileId: string) {
    this.run("UPDATE files SET version = version + 1 WHERE id = ?", fileId);
    this.notify(fileId, "update", ["permissions"]);
    this.dropChannelsWithoutAccess(fileId);
  }

  /**
   * What a files.update changes, checked as a whole before anything is
   * written (Drive applies an update atomically: a refused one changes nothing).
   */
  private updatePlan(file: FileRow, metadata: Row, content: Uint8Array | null) {
    if (content !== null && file.mime === FOLDER_MIME) {
      fail(invalid("A folder can't have content."));
    }
    const sets: Array<[string, unknown]> = [];
    const changed = new Set<string>();
    if (metadata.name !== undefined && String(metadata.name) !== file.name) {
      // Drive moves modifiedTime on a rename
      sets.push(["name", String(metadata.name)], ["modified", now()]);
      changed.add("properties");
    }
    if (metadata.description !== undefined) {
      sets.push(["description", metadata.description === null ? null : String(metadata.description)]);
      changed.add("properties");
    }
    for (const key of ["appProperties", "properties"] as const) {
      if (metadata[key] !== undefined) {
        const { column, value } = this.mergedMap(file, key, metadata[key]);
        sets.push([column, value]);
        changed.add("properties");
      }
    }
    let mime = file.mime;
    if (metadata.mimeType !== undefined && String(metadata.mimeType) !== file.mime) {
      mime = String(metadata.mimeType);
      sets.push(["mime", mime]);
      changed.add("properties");
    }
    return { sets, changed, mime };
  }

  private async updateFile(request: Request, url: URL, caller: User, fileId: string, upload: boolean, origin: string) {
    const fields = fieldsOf(url, "kind,id,name,mimeType");
    checkKeys(fields, FILE_KEYS);
    const { file, role } = this.access(fileId, caller);
    const { metadata, content, contentType } = await this.uploadBody(request, url, upload);
    const permission = this.fileUpdatePermission(file, role, metadata, content, url);
    if (permission instanceof Response) return permission;
    const trashState = permission;
    const { sets, changed, mime } = this.updatePlan(file, metadata, content);
    const hints = this.checkedHints(metadata.contentHints);
    // everything checked: now it is written
    if (trashState) {
      this.setTrashed(file, trashState === "trash");
    }
    for (const [column, value] of sets) {
      this.run(`UPDATE files SET ${column} = ? WHERE id = ?`, value, file.id);
    }
    if (content !== null) {
      await this.writeContent(this.file(file.id)!, content, metadata.mimeType ? mime : contentType || mime, caller.email);
      changed.add("content");
    } else if (changed.size) {
      this.run("UPDATE files SET version = version + 1 WHERE id = ?", file.id);
    }
    this.storeHints(file.id, hints, content !== null);
    if (changed.size) {
      this.notify(file.id, "update", [...changed]);
    }
    const saved = this.file(file.id)!;
    return json(200, select(this.resource(saved, role, caller, origin), fields));
  }

  private revisionResource(revision: Row, file: FileRow, me: string, origin: string) {
    return {
      kind: "drive#revision",
      id: revision.id,
      mimeType: revision.mime,
      modifiedTime: revision.modified,
      keepForever: !!revision.keep,
      published: false,
      lastModifyingUser: this.driveUser(revision.user, me, origin),
      originalFilename: file.name,
      md5Checksum: revision.md5,
      size: String(revision.size),
    };
  }

  private listRevisions(url: URL, method: string, file: FileRow, caller: User, origin: string) {
    if (method !== "GET") {
      return googleError(404, "Not Found", "notFound");
    }
    const fields = fieldsOf(url, "kind,nextPageToken,revisions(kind,id,mimeType,modifiedTime)");
    checkKeys(fields.get("revisions"), REVISION_KEYS);
    const all = this.all<Row>("SELECT * FROM revisions WHERE file_id = ? ORDER BY seq", file.id);
    const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") || 200) || 200, 1), 1000);
    const offset = url.searchParams.get("pageToken") ? Number(atob(url.searchParams.get("pageToken")!).replace(/^o:/, "")) || 0 : 0;
    const body: Row = {
      kind: "drive#revisionList",
      revisions: all.slice(offset, offset + pageSize).map((revision) => this.revisionResource(revision, file, caller.email, origin)),
    };
    if (offset + pageSize < all.length) {
      body.nextPageToken = btoa(`o:${offset + pageSize}`);
    }
    return json(200, select(body, fields));
  }

  private async patchRevision(request: Request, url: URL, revision: Row, file: FileRow, caller: User, origin: string) {
    const body = await parseJson(request);
    const fields = fieldsOf(url, "kind,id,mimeType,modifiedTime");
    if (body.keepForever !== undefined) {
      const keep = !!body.keepForever;
      if (keep && !revision.keep) {
        const kept = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM revisions WHERE file_id = ? AND keep = 1", file.id)!.n;
        if (kept >= KEEP_FOREVER_MAX) {
          return googleError(403, `A file can have at most ${KEEP_FOREVER_MAX} revisions kept forever.`, "keepForeverLimitExceeded");
        }
      }
      this.run("UPDATE revisions SET keep = ? WHERE file_id = ? AND id = ?", keep ? 1 : 0, file.id, revision.id);
    }
    const saved = this.one<Row>("SELECT * FROM revisions WHERE file_id = ? AND id = ?", file.id, revision.id)!;
    return json(200, select(this.revisionResource(saved, file, caller.email, origin), fields));
  }

  private async revisions(request: Request, url: URL, caller: User, fileId: string, revisionId: string | null, origin: string) {
    const { file, role } = this.access(fileId, caller);
    if (file.mime === FOLDER_MIME) {
      return googleError(403, "The file does not support revisions.", "revisionsNotSupported");
    }
    // viewers and commenters can't see a file's version history
    if (ROLE_RANK[role] < 3) {
      return noFilePermission();
    }
    const method = request.method;
    if (!revisionId) {
      return this.listRevisions(url, method, file, caller, origin);
    }
    const revision = this.one<Row>("SELECT * FROM revisions WHERE file_id = ? AND id = ?", file.id, revisionId);
    if (!revision) {
      return googleError(404, `Revision not found: ${revisionId}.`, "notFound", { location: "revisionId" });
    }
    if (method === "GET") {
      if (url.searchParams.get("alt") === "media") {
        return new Response(this.blob(revision.md5), { headers: { "Content-Type": revision.mime, "Cache-Control": "no-store" } });
      }
      const fields = fieldsOf(url, "kind,id,mimeType,modifiedTime");
      checkKeys(fields, REVISION_KEYS);
      return json(200, select(this.revisionResource(revision, file, caller.email, origin), fields));
    }
    if (method === "PATCH") {
      return this.patchRevision(request, url, revision, file, caller, origin);
    }
    if (method === "DELETE") {
      if (revision.id === file.head) {
        return googleError(400, "The head revision of a file can't be deleted.", "cannotDeleteHeadRevision");
      }
      this.run("DELETE FROM revisions WHERE file_id = ? AND id = ?", file.id, revision.id);
      this.gcBlobs();
      return new Response(null, { status: 204 });
    }
    return googleError(404, "Not Found", "notFound");
  }

  private permissionRequestError(newRole: string) {
    if (newRole === "owner") {
      return invalid("Ownership transfer is not supported by the fake Google", "role");
    }
    if (!["reader", "commenter", "writer"].includes(newRole)) {
      return googleError(400, `Invalid permission role: ${newRole}`, "invalidSharingRequest", { location: "role" });
    }
    return null;
  }

  /**
   * An expirationTime as Drive takes it: user permissions only, in the future,
   * at most a year ahead (the number, null: none given, or the error)
   */
  private expiration(value: unknown, type: string): number | null | Response {
    if (value === undefined || value === null) {
      return null;
    }
    const at = Date.parse(String(value));
    if (type !== "user") {
      return googleError(400, "Expiration dates can only be set on user and group permissions.", "invalidSharingRequest", { location: "expirationTime" });
    }
    if (!Number.isFinite(at) || at <= Date.now()) {
      return googleError(400, "Expiration dates must be in the future.", "expirationDatesMustBeInTheFuture", { location: "expirationTime" });
    }
    if (at > Date.now() + 366 * 24 * 3600 * 1000) {
      return googleError(400, "Expiration dates cannot be more than a year in the future.", "expirationDateTooFarInTheFuture", { location: "expirationTime" });
    }
    return at;
  }

  private insertUserPermission(body: Row, newRole: string, file: FileRow, url: URL, caller: User) {
    const email = String(body.emailAddress || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      return googleError(400, "A valid email address is required for user permissions.", "invalidSharingRequest", { location: "permission.emailAddress" });
    }
    const expires = this.expiration(body.expirationTime, "user");
    if (expires instanceof Response) return expires;
    this.user(email);
    const id = permIdOf(email);
    this.run("INSERT OR REPLACE INTO perms (file_id, id, type, role, email, discover, expires) VALUES (?, ?, 'user', ?, ?, 0, ?)", file.id, id, newRole, email, expires);
    if (url.searchParams.get("sendNotificationEmail") !== "false") {
      this.log("mail", { to: email, from: caller.email, fileId: file.id, name: file.name, role: newRole, message: url.searchParams.get("emailMessage") || "" });
    }
    return id;
  }

  /** "anyone at <domain> with the link" (one per domain) */
  private insertDomainPermission(body: Row, newRole: string, file: FileRow) {
    const domain = String(body.domain || "").trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return googleError(400, "A valid domain is required for domain permissions.", "invalidSharingRequest", { location: "permission.domain" });
    }
    const expires = this.expiration(body.expirationTime, "domain");
    if (expires instanceof Response) return expires;
    const id = domainPermId(domain);
    this.run(
      "INSERT OR REPLACE INTO perms (file_id, id, type, role, email, discover, domain) VALUES (?, ?, 'domain', ?, NULL, ?, ?)",
      file.id,
      id,
      newRole,
      body.allowFileDiscovery ? 1 : 0,
      domain,
    );
    return id;
  }

  private async createPermission(request: Request, url: URL, { file, canShare, caller, origin, fields, one }: PermissionCall) {
    if (!canShare) {
      return noFilePermission();
    }
    const body = await parseJson(request);
    const type = String(body.type || "");
    const newRole = String(body.role || "");
    const error = this.permissionRequestError(newRole);
    if (error) return error;
    let id: string;
    if (type === "anyone") {
      id = body.allowFileDiscovery ? "anyone" : "anyoneWithLink";
      this.run("DELETE FROM perms WHERE file_id = ? AND type = 'anyone'", file.id);
      this.run("INSERT INTO perms (file_id, id, type, role, email, discover) VALUES (?, ?, 'anyone', ?, NULL, ?)", file.id, id, newRole, body.allowFileDiscovery ? 1 : 0);
    } else if (type === "user") {
      const result = this.insertUserPermission(body, newRole, file, url, caller);
      if (result instanceof Response) return result;
      id = result;
    } else if (type === "domain") {
      const result = this.insertDomainPermission(body, newRole, file);
      if (result instanceof Response) return result;
      id = result;
    } else {
      return googleError(400, `The fake Google supports permission types user, domain and anyone, not '${type}'.`, "invalidSharingRequest", { location: "type" });
    }
    this.permissionsChanged(file.id);
    return json(200, select(this.permission(one(id)!, origin), fields));
  }

  private async patchPermission(request: Request, url: URL, { file, canShare, origin, fields, one }: PermissionCall, perm: Row) {
    if (!canShare) {
      return noFilePermission();
    }
    const body = await parseJson(request);
    const newRole = String(body.role || perm.role);
    if (perm.role === "owner") {
      return googleError(403, "The owner of a file can't be changed (ownership transfer is not supported by the fake Google).", "cannotModifyOwner");
    }
    const error = this.permissionRequestError(newRole);
    if (error) return error;
    const expires = this.expiration(body.expirationTime, String(perm.type));
    if (expires instanceof Response) return expires;
    // removeExpiration=true drops the end date; without either the end date stays
    const keep = url.searchParams.get("removeExpiration") === "true" ? null : perm.expires ?? null;
    this.run("UPDATE perms SET role = ?, expires = ? WHERE file_id = ? AND id = ?", newRole, expires ?? keep, file.id, perm.id);
    this.permissionsChanged(file.id);
    return json(200, select(this.permission(one(perm.id)!, origin), fields));
  }

  private async permissions(request: Request, url: URL, caller: User, fileId: string, permissionId: string | null, origin: string) {
    const { file, role } = this.access(fileId, caller);
    const method = request.method;
    const canShare = this.capabilities(file, role, caller).canShare;
    const one = (id: string) => this.perms(file.id).find((perm) => perm.id === id) ?? null;
    if (!permissionId && method === "GET") {
      const fields = fieldsOf(url, "kind,nextPageToken,permissions(kind,id,type,role)");
      checkKeys(fields.get("permissions"), PERMISSION_KEYS);
      return json(200, select({ kind: "drive#permissionList", permissions: this.perms(file.id).map((perm) => this.permission(perm, origin)) }, fields));
    }
    const fields = fieldsOf(url, "kind,id,type,role");
    checkKeys(fields, PERMISSION_KEYS);
    if (!permissionId && method === "POST") {
      return this.createPermission(request, url, { file, canShare, caller, origin, fields, one });
    }
    const perm = permissionId ? one(permissionId) : null;
    if (!perm) {
      return googleError(404, `Permission not found: ${permissionId}.`, "notFound", { location: "permissionId" });
    }
    if (method === "GET") {
      return json(200, select(this.permission(perm, origin), fields));
    }
    const self = perm.type === "user" && perm.email === caller.email;
    if (method === "PATCH") {
      return this.patchPermission(request, url, { file, canShare, caller, origin, fields, one }, perm);
    }
    if (method === "DELETE") {
      if (!canShare && !self) {
        return noFilePermission();
      }
      if (perm.role === "owner") {
        return googleError(403, "The owner's permission can't be removed.", "cannotRemoveOwner");
      }
      this.run("DELETE FROM perms WHERE file_id = ? AND id = ?", file.id, perm.id);
      this.permissionsChanged(file.id);
      return new Response(null, { status: 204 });
    }
    return googleError(404, "Not Found", "notFound");
  }

  // ---------------------------------------------------------------------------
  // comments (Drive's own, on the file: the commenters' mailbox)
  // ---------------------------------------------------------------------------

  private commentResource(row: Row, caller: User, origin: string) {
    const author = this.driveUser(row.email, caller.email, origin);
    return {
      kind: "drive#comment",
      id: row.id,
      createdTime: row.created,
      modifiedTime: row.modified,
      // Google leaves out the author's address and permission id
      author: { kind: "drive#user", displayName: author.displayName, photoLink: author.photoLink, me: author.me },
      htmlContent: escapeHtml(row.content),
      content: row.content,
      deleted: false,
      resolved: !!row.resolved,
      replies: [],
    };
  }

  /** comments.list / create / get / delete and replies.create (a "resolve" action resolves the comment) */
  private async comments(request: Request, url: URL, caller: User, { fileId, commentId, replies, origin }: { fileId: string; commentId: string | null; replies: boolean; origin: string }) {
    const { file, role } = this.access(fileId, caller);
    // like Google: comments and replies need a fields parameter
    if (!url.searchParams.get("fields") && request.method !== "DELETE") {
      return invalid("The 'fields' parameter is required for this method.", "fields");
    }
    const call: CommentCall = { request, caller, file, role, fields: fieldsOf(url, "*"), origin };
    if (!commentId) {
      return this.fileComments(call);
    }
    const row = this.one<Row>("SELECT * FROM comments WHERE id = ? AND file_id = ?", commentId, file.id);
    if (!row) {
      return googleError(404, `Comment not found: ${commentId}.`, "notFound", { location: "commentId" });
    }
    return replies ? this.commentReply(call, row) : this.oneComment(call, row);
  }

  /** comments.list, comments.create (commenters and up) */
  private async fileComments({ request, caller, file, role, fields, origin }: CommentCall) {
    if (request.method === "GET") {
      const rows = this.all<Row>("SELECT * FROM comments WHERE file_id = ? ORDER BY seq", file.id);
      return json(200, select({ kind: "drive#commentList", comments: rows.map((row) => this.commentResource(row, caller, origin)) }, fields));
    }
    if (request.method !== "POST") {
      return googleError(405, "Method not allowed", "methodNotAllowed");
    }
    if (ROLE_RANK[role] < 2) {
      return noFilePermission();
    }
    const body = await parseJson(request);
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      return invalid("Comment content is required.", "content");
    }
    const id = `AAAA${randomId(12)}`;
    const at = now();
    const seq = (this.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM comments")?.seq ?? 0) + 1;
    this.run("INSERT INTO comments (id, file_id, email, content, created, modified, resolved, seq) VALUES (?, ?, ?, ?, ?, ?, 0, ?)", id, file.id, caller.email, content, at, at, seq);
    return json(200, select(this.commentResource(this.one<Row>("SELECT * FROM comments WHERE id = ?", id)!, caller, origin), fields));
  }

  /** comments.get, comments.delete (the author; editors too unless the setting commentDeleteByAuthorOnly says Google doesn't let them) */
  private oneComment({ request, caller, role, fields, origin }: CommentCall, row: Row) {
    if (request.method === "GET") {
      return json(200, select(this.commentResource(row, caller, origin), fields));
    }
    if (request.method !== "DELETE") {
      return googleError(405, "Method not allowed", "methodNotAllowed");
    }
    const editor = ROLE_RANK[role] >= 3 && this.setting("commentDeleteByAuthorOnly") !== "1";
    if (row.email !== caller.email && !editor) {
      return noFilePermission();
    }
    this.run("DELETE FROM comments WHERE id = ?", row.id);
    return new Response(null, { status: 204 });
  }

  /** replies.create: an action "resolve" / "reopen" changes the comment */
  private async commentReply({ request, role, fields }: CommentCall, row: Row) {
    if (request.method !== "POST") {
      return googleError(405, "Method not allowed", "methodNotAllowed");
    }
    if (ROLE_RANK[role] < 2) {
      return noFilePermission();
    }
    const body = await parseJson(request);
    if (body.action === "resolve" || body.action === "reopen") {
      this.run("UPDATE comments SET resolved = ?, modified = ? WHERE id = ?", body.action === "resolve" ? 1 : 0, now(), row.id);
    }
    return json(200, select({ kind: "drive#reply", id: `AAAB${randomId(12)}`, action: body.action, content: String(body.content ?? "") }, fields));
  }

  // ---------------------------------------------------------------------------
  // the Picker: what the user picks next is queued by a test (POST /admin/picker)
  // ---------------------------------------------------------------------------

  /** the app's picker in a fake build: the next queued pick of this user (none: cancelled); the picked files are granted */
  private picker(request: Request, url: URL) {
    const who = this.caller(request, url);
    if (!who || typeof who !== "object" || who.kind !== "user") {
      return googleError(401, "Login Required.", "required");
    }
    const next = this.one<Row>("SELECT * FROM picks WHERE email = ? ORDER BY id LIMIT 1", who.email);
    if (!next) {
      return json(200, { ids: [] });
    }
    this.run("DELETE FROM picks WHERE id = ?", next.id);
    const ids = (JSON.parse(next.ids) as string[]).filter((id) => {
      const file = this.file(id);
      return !!file && !!this.roleOf(file, who, false);
    });
    for (const id of ids) {
      this.run("INSERT OR IGNORE INTO app_access (email, file_id) VALUES (?, ?)", who.email, id);
    }
    this.log("request", { method: "PICK", path: "/picker", email: who.email, status: 200, ids });
    return json(200, { ids });
  }

  private adminConfig(body: Row) {
    for (const key of ["folderPickGrantsChildren", "commentDeleteByAuthorOnly"]) {
      if (body[key] !== undefined) {
        this.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, body[key] ? "1" : "0");
      }
    }
    return json(200, { config: Object.fromEntries(this.all<Row>("SELECT key, value FROM config").map((row) => [row.key, row.value === "1"])) });
  }

  // ---------------------------------------------------------------------------
  // admin
  // ---------------------------------------------------------------------------

  private adminFile(file: FileRow, origin: string) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mime,
      owner: file.owner,
      parents: JSON.parse(file.parents),
      trashed: !!file.trashed,
      md5Checksum: file.md5,
      size: file.size,
      headRevisionId: file.head,
      version: file.version,
      createdTime: file.created,
      modifiedTime: file.modified,
      lastModifyingUser: file.modifier,
      appProperties: JSON.parse(file.app_props || "{}"),
      properties: JSON.parse(file.props || "{}"),
      permissions: this.perms(file.id).map((perm) => this.permission(perm, origin)),
      appAccess: this.all<{ email: string }>("SELECT email FROM app_access WHERE file_id = ? ORDER BY email", file.id).map((row) => row.email),
      contentHints: adminHints(this.hints(file.id)),
    };
  }

  private async adminWrite(body: Row, origin: string, need: (key: string) => string, fileOf: () => FileRow) {
    const email = this.user(need("email"));
    const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? "");
    const bytes = new TextEncoder().encode(content);
    let file: FileRow;
    if (body.fileId) {
      file = fileOf();
      const own = this.perms(file.id).find((perm) => perm.email === email);
      const anyone = this.perms(file.id).find((perm) => perm.type === "anyone");
      if (Math.max(ROLE_RANK[own?.role] ?? 0, ROLE_RANK[anyone?.role] ?? 0) < 3) {
        return json(403, { error: `${email} can't edit this file` });
      }
      // the same checks and writes as a files.update through the API, without the app-access rule
      const { sets, changed } = this.updatePlan(file, { name: body.name, appProperties: body.appProperties ?? undefined }, bytes);
      for (const [column, value] of sets) {
        this.run(`UPDATE files SET ${column} = ? WHERE id = ?`, value, file.id);
      }
      await this.writeContent(this.file(file.id)!, bytes, String(body.mimeType || file.mime), email);
      changed.add("content");
      this.notify(file.id, "update", [...changed]);
    } else {
      const parents = Array.isArray(body.parents) && body.parents.length ? body.parents.map(String) : [rootOf(email)];
      file = this.insertFile({
        email,
        name: String(body.name || "Untitled.excalidraw"),
        mime: String(body.mimeType || "application/vnd.excalidraw+json"),
        parents,
        appProps: JSON.parse(this.mergedMap({ app_props: "{}" } as FileRow, "appProperties", body.appProperties).value),
      });
      await this.writeContent(file, bytes, file.mime, email);
    }
    return json(200, this.adminFile(this.file(file.id)!, origin));
  }

  private adminShare(body: Row, origin: string, need: (key: string) => string, fileOf: () => FileRow) {
    const file = fileOf();
    const role = String(body.role || "reader");
    if (!["reader", "commenter", "writer"].includes(role)) {
      return json(400, { error: "role: reader, commenter or writer" });
    }
    const expires = body.expirationTime ? Date.parse(String(body.expirationTime)) : null;
    if (expires !== null && !Number.isFinite(expires)) {
      return json(400, { error: "expirationTime: an ISO date" });
    }
    if (body.anyone) {
      this.run("DELETE FROM perms WHERE file_id = ? AND type = 'anyone'", file.id);
      this.run("INSERT INTO perms (file_id, id, type, role, email, discover) VALUES (?, 'anyoneWithLink', 'anyone', ?, NULL, 0)", file.id, role);
    } else if (body.domain) {
      const domain = String(body.domain).toLowerCase();
      this.run("INSERT OR REPLACE INTO perms (file_id, id, type, role, email, discover, domain) VALUES (?, ?, 'domain', ?, NULL, 0, ?)", file.id, domainPermId(domain), role, domain);
    } else {
      const email = this.user(need("email"));
      if (email === file.owner) {
        return json(400, { error: "that's the owner" });
      }
      this.run("INSERT OR REPLACE INTO perms (file_id, id, type, role, email, discover, expires) VALUES (?, ?, 'user', ?, ?, 0, ?)", file.id, permIdOf(email), role, email, expires);
    }
    this.permissionsChanged(file.id);
    return json(200, this.adminFile(file, origin));
  }

  private adminUnshare(body: Row, origin: string, need: (key: string) => string, fileOf: () => FileRow) {
    const file = fileOf();
    if (body.anyone) {
      this.run("DELETE FROM perms WHERE file_id = ? AND type = 'anyone'", file.id);
    } else if (body.domain) {
      this.run("DELETE FROM perms WHERE file_id = ? AND type = 'domain' AND domain = ?", file.id, String(body.domain).toLowerCase());
    } else {
      this.run("DELETE FROM perms WHERE file_id = ? AND email = ? AND role != 'owner'", file.id, need("email").toLowerCase());
    }
    this.permissionsChanged(file.id);
    return json(200, this.adminFile(file, origin));
  }

  private adminGrant(origin: string, need: (key: string) => string, fileOf: () => FileRow) {
    const file = fileOf();
    const email = this.user(need("email"));
    this.run("INSERT OR IGNORE INTO app_access (email, file_id) VALUES (?, ?)", email, file.id);
    return json(200, { ok: true, appAccess: this.adminFile(file, origin).appAccess });
  }

  private adminTrash(origin: string, path: string, fileOf: () => FileRow) {
    const file = fileOf();
    const trash = path === "/trash";
    if (!!file.trashed !== trash) {
      this.setTrashed(file, trash);
    }
    return json(200, this.adminFile(this.file(file.id)!, origin));
  }

  private adminFaults(body: Row) {
    const count = Math.max(1, Number(body.count ?? 1));
    let status: number | null = 503;
    if (body.status) status = Number(body.status);
    else if (body.delayMs) status = null;
    this.run("INSERT INTO faults (remaining, status, delay_ms, path) VALUES (?, ?, ?, ?)", count, status, Number(body.delayMs ?? 0), body.path ?? null);
    return json(200, { faults: this.all<Row>("SELECT * FROM faults ORDER BY id") });
  }

  private adminLog(body: Row) {
    const limit = Math.min(Number(body.limit ?? 100) || 100, 3000);
    const rows = body.kind
      ? this.all<Row>("SELECT * FROM log WHERE kind = ? ORDER BY id DESC LIMIT ?", String(body.kind), limit)
      : this.all<Row>("SELECT * FROM log WHERE kind NOT LIKE 'inbox:%' ORDER BY id DESC LIMIT ?", limit);
    rows.reverse();
    return json(200, { log: rows.map((row) => ({ at: row.at, kind: row.kind, ...JSON.parse(row.data) })) });
  }

  private async admin(request: Request, url: URL, path: string): Promise<Response> {
    const origin = this.origin(request);
    const method = request.method;
    const body: Row = method === "POST" ? await parseJson(request) : Object.fromEntries(url.searchParams);

    const need = (key: string) => {
      if (body[key] === undefined || body[key] === "") {
        fail(json(400, { error: `missing ${key}` }));
      }
      return String(body[key]);
    };
    const fileOf = () => {
      const file = this.file(need("fileId"));
      return file ?? fail(json(404, { error: `no file ${body.fileId}` }));
    };
    switch (`${method} ${path}`) {
      case "POST /reset": {
        for (const table of TABLES) {
          this.run(`DELETE FROM ${table}`);
        }
        this.seed();
        return json(200, { ok: true });
      }
      case "GET /file": {
        const file = fileOf();
        return json(200, {
          ...this.adminFile(file, origin),
          revisions: this.all<Row>("SELECT id, md5, size, modified, user, keep FROM revisions WHERE file_id = ? ORDER BY seq", file.id),
          channels: this.all<Row>("SELECT * FROM channels WHERE file_id = ?", file.id),
        });
      }
      case "POST /grant": return this.adminGrant(origin, need, fileOf);
      case "POST /picker": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        this.run("INSERT INTO picks (email, ids) VALUES (?, ?)", this.user(need("email")), JSON.stringify(ids));
        return json(200, { ok: true, queued: this.all<Row>("SELECT email, ids FROM picks ORDER BY id") });
      }
      case "POST /config": return this.adminConfig(body);
      case "GET /comments": {
        const file = fileOf();
        return json(200, { comments: this.all<Row>("SELECT * FROM comments WHERE file_id = ? ORDER BY seq", file.id) });
      }
      case "POST /write": return this.adminWrite(body, origin, need, fileOf);
      case "POST /share": return this.adminShare(body, origin, need, fileOf);
      case "POST /unshare": return this.adminUnshare(body, origin, need, fileOf);
      case "POST /trash":
      case "POST /untrash": return this.adminTrash(origin, path, fileOf);
      case "POST /delete": {
        const file = fileOf();
        this.notify(file.id, "remove");
        this.deleteFile(file.id);
        return json(200, { ok: true });
      }
      case "GET /revisions": {
        const file = fileOf();
        return json(200, {
          headRevisionId: file.head,
          revisions: this.all<Row>("SELECT id, md5, size, mime, modified, user, keep FROM revisions WHERE file_id = ? ORDER BY seq", file.id).map((row) => ({
            ...row,
            keep: !!row.keep,
            ...(body.content ? { content: new TextDecoder().decode(this.blob(row.md5)) } : {}),
          })),
        });
      }
      case "POST /revoke": {
        this.revokeGrant(need("email").toLowerCase());
        return json(200, { ok: true });
      }
      case "POST /faults": return this.adminFaults(body);
      case "GET /faults":
        return json(200, { faults: this.all<Row>("SELECT * FROM faults ORDER BY id") });
      case "DELETE /faults": {
        // faults a test set up that never fired usually mean it didn't test what it meant to
        const unused = this.all<Row>("SELECT id, path, remaining FROM faults WHERE used = 0 ORDER BY id");
        this.run("DELETE FROM faults");
        return json(200, { ok: true, ...(unused.length ? { unused, hint: "these faults never matched a call" } : {}) });
      }
      case "GET /log": return this.adminLog(body);
      case "GET /channels":
        return json(200, { channels: this.all<Row>("SELECT * FROM channels ORDER BY expiration") });
    }
    return json(404, { error: `unknown admin call ${method} ${path} (GET /fake-google/admin lists them)` });
  }
}
