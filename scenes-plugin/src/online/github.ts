// Kurviq (online): the scenes server's job, done in the browser with the
// GitHub REST API — list, load, commit, rename and delete scenes in the repo
// the user connected, with the same rules (a push must be based on the
// version GitHub has, agent commits carry a trailer).
//
// GitHub is the only source of truth for who may do what: a space is a
// GitHub account or organization with its private <owner>/kurviq-scenes and
// (once a scene is made public) its public <owner>/kurviq-public. Whether
// this user may change them is what GitHub says (permissions, archived,
// protected branch); Kurviq stores no users, teams or permissions.
//
// The browser never sees a long-lived GitHub credential: the Worker keeps
// the refresh token in an encrypted httpOnly cookie and hands out the
// short-lived access token (8 h) on request (see online/worker/auth.ts).

import { isSceneName } from "../../../scenes-mcp/sceneName.mjs";
import { currentSpace, spaceSuffix } from "../storage";

import type { ApiError, RemoteInfo, RemoteScene, SceneVersion } from "../api";

const API = "https://api.github.com";
const SCENES_DIR = "scenes";
const EXTENSION = ".excalidraw";
const AGENT_TRAILER = "Scenes-Source: agent";

// -----------------------------------------------------------------------------
// connection: who is connected (cookie, via the Worker) and which repo syncs
// -----------------------------------------------------------------------------

export type GitHubUser = { login: string; avatarUrl: string | null };
export type RepoChoice = {
  owner: string;
  name: string;
  branch: string;
  private: boolean;
  /** GitHub lets this user read it, not change it: why */
  readOnly?: string | null;
};

export type ConnectionState = {
  /** null = not checked yet */
  user: GitHubUser | null | undefined;
  /** the space's scenes repository */
  repo: RepoChoice | null;
  /** last token / API problem, if any */
  error: string | null;
  /** the repository can't be reached any more (access removed, deleted…): why */
  lost?: string | null;
};

/** the space's scenes repository (per space, see ../storage.ts) */
const repoKeyFor = (space: string) => `kurviq-github-repo${spaceSuffix(space)}`;
const REPO_KEY = repoKeyFor(currentSpace);

const loadRepo = (): RepoChoice | null => {
  try {
    const value = JSON.parse(localStorage.getItem(REPO_KEY) || "null");
    return value?.owner && value?.name && value?.branch ? value : null;
  } catch {
    return null;
  }
};

let state: ConnectionState = { user: undefined, repo: loadRepo(), error: null };
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
  /** connected and a repo is chosen: scenes sync */
  isActive: () => !!state.user && !!state.repo && !state.lost,
};

let token: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string | null> | null = null;

const requestToken = async (): Promise<string | null> => {
  const ask = (retry = false) =>
    fetch("/auth/token", {
      method: "POST",
      credentials: "same-origin",
      headers: retry ? { "X-Kurviq-Retry": "1" } : {},
    });
  let res: Response;
  try {
    res = await ask();
    if (res.status === 409) {
      // another tab refreshed the token at the same moment: its new cookie
      // is ours too, ask again
      await new Promise((resolve) => setTimeout(resolve, 800));
      res = await ask(true);
    }
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
  if (!res.ok) {
    throw offlineError(`Kurviq server error (${res.status})`);
  }
  const body = await res.json();
  if (body.connected === false) {
    token = null;
    setConnection({ user: null });
    return null;
  }
  token = { value: body.token, expiresAt: Date.parse(body.expiresAt) };
  if (state.user?.login !== body.user?.login) {
    setConnection({ user: body.user, error: null });
  }
  return token.value;
};

/** the current access token, refreshed when it is about to expire */
export const getToken = async (): Promise<string | null> => {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) {
    return token.value;
  }
  // one request at a time, also across this browser's tabs (the refresh
  // token rotates: two refreshes at once would invalidate each other)
  tokenRequest ??= (
    navigator.locks
      ? (navigator.locks.request("kurviq-github-token", requestToken) as unknown as Promise<string | null>)
      : requestToken()
  ).finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
};

/** find out whether this browser is connected (on start) */
export const checkConnection = async () => {
  try {
    await getToken();
  } catch (error: any) {
    setConnection({ error: error.message });
  }
  return state;
};

/** this tab went to GitHub to connect (sessionStorage) */
export const CONNECTING_KEY = "kurviq-connecting";

/**
 * Go to GitHub (full page redirect, back to this page afterwards).
 *   "login" (Connect GitHub): just signs in. Once Kurviq is allowed, GitHub
 *     sends the user straight back; the setup dialog then shows what is
 *     still missing.
 *   "install": the Kurviq app's installation page, where GitHub asks which
 *     repositories Kurviq may use (once per account).
 */
export const connectGitHub = (mode: "login" | "install" = "login") => {
  const back = window.location.pathname + window.location.search;
  try {
    // the answer (?github=connected) only counts in the tab that asked
    sessionStorage.setItem(CONNECTING_KEY, String(Date.now()));
  } catch {}
  window.location.href = `/auth/${mode}?return=${encodeURIComponent(back)}`;
};

/** the other tabs of this browser hear about a disconnect */
const tabsChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kurviq-github") : null;

const forgetConnection = () => {
  token = null;
  forgetListings();
  setConnection({ user: null });
};
tabsChannel?.addEventListener("message", (event) => event.data === "disconnected" && forgetConnection());

export const disconnectGitHub = async () => {
  // under the token lock: a refresh running right now can't bring the session back afterwards
  const logout = () => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  await (navigator.locks ? navigator.locks.request("kurviq-github-token", logout) : logout());
  forgetConnection();
  tabsChannel?.postMessage("disconnected");
};

export const chooseRepo = (repo: RepoChoice | null) => {
  try {
    if (repo) {
      localStorage.setItem(REPO_KEY, JSON.stringify(repo));
    } else {
      localStorage.removeItem(REPO_KEY);
    }
  } catch {}
  forgetListings();
  repoCheckedAt = 0;
  setConnection({ repo, lost: null });
};

/** the scenes repository of another space, for the switch (the page reloads into it) */
export const storeRepoForSpace = (space: string, repo: RepoChoice) => {
  localStorage.setItem(repoKeyFor(space), JSON.stringify(repo));
};

// -----------------------------------------------------------------------------
// REST helper
// -----------------------------------------------------------------------------

const offlineError = (message: string) =>
  Object.assign(new Error(message), { status: 0, offline: true }) as ApiError;

const httpError = (status: number, message: string, extra: Partial<ApiError> = {}) =>
  Object.assign(new Error(message), { status, ...extra }) as ApiError;

export const notConnectedError = () =>
  Object.assign(new Error("GitHub is not connected"), {
    status: 0,
    offline: true,
    notConnected: true,
  }) as ApiError;

type GhResponse = { status: number; data: any; etag: string | null };

const gh = async (
  path: string,
  { method = "GET", body, etag }: { method?: string; body?: unknown; etag?: string | null } = {},
): Promise<GhResponse> => {
  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    if (!value) {
      throw notConnectedError();
    }
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${value}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw offlineError("GitHub not reachable");
    }
    if (res.status === 401 && attempt === 0) {
      token = null; // revoked or expired early: get a fresh one once
      continue;
    }
    const text = res.status === 304 || res.status === 204 ? "" : await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401) {
      setConnection({ user: null });
      throw notConnectedError();
    }
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw Object.assign(offlineError("GitHub rate limit reached, retrying later"), { status: 503 });
    }
    if (res.status >= 500) {
      throw Object.assign(offlineError(`GitHub error ${res.status}`), { status: 503 });
    }
    return { status: res.status, data, etag: res.headers.get("etag") };
  }
};

const fail = (res: GhResponse, what: string): never => {
  const detail = typeof res.data?.message === "string" ? `: ${res.data.message}` : "";
  throw httpError(res.status, `${what} (GitHub ${res.status}${detail})`);
};

// -----------------------------------------------------------------------------
// encoding
// -----------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (base64: string) => {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** the git blob sha of some content (to know without a request whether it changed) */
const blobSha = async (bytes: Uint8Array) => {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// -----------------------------------------------------------------------------
// scenes in the space's repositories
// -----------------------------------------------------------------------------


/** the private scenes repository of every space */
export const SCENES_REPO = "kurviq-scenes";
/** public scenes of a space (created when the first scene is made public) */
export const PUBLIC_REPO = "kurviq-public";

const requireRepo = () => {
  if (!state.repo || state.lost) {
    throw notConnectedError();
  }
  return state.repo;
};

const repoPath = (repo: { owner: string; name: string }) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

const scenePath = (name: string) => {
  if (!isSceneName(name)) {
    throw httpError(400, `Invalid scene name: ${name}`);
  }
  return `${SCENES_DIR}/${name}${EXTENSION}`;
};

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

type Listing = {
  head: string | null;
  etag: string | null;
  blobs: Map<string, string>;
  dates: Map<string, string>;
  fetchedAt: number;
};

const listings = new Map<string, Listing>();
/** the space's public repository: undefined = not looked up yet, null = none (or not writable) */
let publicRepo: RepoChoice | null | undefined;
const remote: RemoteInfo = { online: null, lastFetchAt: null, lastError: null };

const repoKey = (repo: RepoChoice) => `${repo.owner}/${repo.name}#${repo.branch}`;

const forgetListings = () => {
  listings.clear();
  publicRepo = undefined;
};

const readOnlyError = (reason: string) => httpError(403, `Read only: ${reason}`, { readOnly: true });

const requireWritable = () => {
  const repo = requireRepo();
  if (repo.readOnly) {
    throw readOnlyError(repo.readOnly);
  }
  return repo;
};

/** what GitHub says about this user and a repository */
const accessOf = (data: any): string | null =>
  data.archived
    ? `${data.full_name} is archived on GitHub`
    : data.permissions?.push === false
    ? `you can read ${data.full_name} on GitHub, but not change it`
    : null;

const toRepo = (data: any): RepoChoice => ({
  owner: data.owner.login,
  name: data.name,
  branch: data.default_branch || "main",
  private: !!data.private,
  readOnly: accessOf(data),
});

/** GitHub's answer for a repository: the repository, or null (missing / no access) */
const lookUpRepo = async (owner: string, name: string): Promise<RepoChoice | null> => {
  const res = await gh(repoPath({ owner, name }));
  if (res.status === 404 || res.status === 403) {
    return null;
  }
  if (res.status !== 200) {
    fail(res, `Could not look up ${owner}/${name}`);
  }
  return toRepo(res.data);
};

/** why a public kurviq-scenes is refused */
export const notPrivate = (owner: string) =>
  `${owner}/${SCENES_REPO} is public on GitHub, so Kurviq doesn't sync private scenes there. Make it private on GitHub (Settings → General → Danger Zone → Change visibility), then set up sync again`;

/** the repository can't be used any more: stop syncing, say why (scenes stay in the browser) */
const loseAccess = (reason: string): never => {
  forgetListings();
  setConnection({ lost: reason });
  throw notConnectedError();
};

let repoCheckedAt = 0;
const REPO_CHECK_MS = 5 * 60_000;

/** mirror GitHub's permissions for the space's repository (at most every few minutes, or now) */
const checkAccess = async (now = false) => {
  const repo = requireRepo();
  if (!now && Date.now() - repoCheckedAt < REPO_CHECK_MS) {
    return repo;
  }
  const res = await gh(repoPath(repo));
  if (res.status === 404 || res.status === 403) {
    const message = typeof res.data?.message === "string" ? res.data.message : "";
    loseAccess(
      /SAML|SSO/i.test(message)
        ? `${repo.owner} requires single sign-on: authorize your GitHub sign-in for ${repo.owner} on GitHub`
        : `Kurviq can't reach ${repo.owner}/${repo.name} any more (deleted, renamed, or access removed on GitHub)`,
    );
  }
  if (res.status !== 200) {
    fail(res, `Could not check ${repo.owner}/${repo.name}`);
  }
  if (!res.data.private) {
    // everything synced there would be public: stop before the next push
    loseAccess(notPrivate(repo.owner));
  }
  repoCheckedAt = Date.now();
  // (a protected branch shows only when a push is refused: found again then)
  const readOnly = accessOf(res.data);
  if ((readOnly ?? null) !== (repo.readOnly ?? null)) {
    const next = { ...repo, readOnly };
    try {
      localStorage.setItem(REPO_KEY, JSON.stringify(next));
    } catch {}
    setConnection({ repo: next });
    return next;
  }
  return repo;
};

/** a push was refused for good: find out why and mirror it */
const refused = async (res: GhResponse, what: string): Promise<never> => {
  const repo = await checkAccess(true);
  if (repo.readOnly) {
    throw readOnlyError(repo.readOnly);
  }
  const message = typeof res.data?.message === "string" ? res.data.message : "";
  if (/protected|rule/i.test(message)) {
    const reason = `the branch ${repo.branch} of ${repo.owner}/${repo.name} is protected on GitHub`;
    const next = { ...repo, readOnly: reason };
    try {
      localStorage.setItem(REPO_KEY, JSON.stringify(next));
    } catch {}
    setConnection({ repo: next });
    throw readOnlyError(reason);
  }
  return fail(res, what);
};

/** last commit date of each scene, in one GraphQL request */
const commitDates = async (repo: RepoChoice, head: string, names: string[]) => {
  const dates = new Map<string, string>();
  for (let i = 0; i < names.length; i += 80) {
    const chunk = names.slice(i, i + 80);
    const fields = chunk
      .map((name, j) => `f${j}: history(first: 1, path: ${JSON.stringify(scenePath(name))}) { nodes { committedDate } }`)
      .join("\n");
    const query = `query { repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { object(oid: ${JSON.stringify(head)}) { ... on Commit { ${fields} } } } }`;
    const res = await gh("/graphql", { method: "POST", body: { query } });
    const commit = res.data?.data?.repository?.object;
    if (res.status !== 200 || !commit) {
      return dates;
    }
    chunk.forEach((name, j) => {
      const date = commit[`f${j}`]?.nodes?.[0]?.committedDate;
      if (date) {
        dates.set(name, date);
      }
    });
  }
  return dates;
};

/**
 * The scenes of one repository (name -> blob sha). Cheap when nothing
 * changed: the branch head is asked with its ETag (a 304 doesn't count
 * against the rate limit) and the listing is only fetched again when the
 * head moved.
 */
const fetchListing = async (repo: RepoChoice, force = false): Promise<Listing> => {
  const key = repoKey(repo);
  const previous = listings.get(key) ?? null;
  if (previous && !force && Date.now() - previous.fetchedAt < 5_000) {
    return previous;
  }
  const ref = await gh(`${repoPath(repo)}/git/ref/heads/${encodePath(repo.branch)}`, { etag: previous?.etag });
  let head: string | null = null;
  if (ref.status === 304 && previous) {
    const same = { ...previous, fetchedAt: Date.now() };
    listings.set(key, same);
    return same;
  } else if (ref.status === 200) {
    head = ref.data.object.sha;
  } else if (ref.status === 404 || ref.status === 409) {
    // empty repo, or the branch doesn't exist yet: the first push creates it
    const repoInfo = await gh(repoPath(repo));
    if (repoInfo.status !== 200) {
      fail(repoInfo, `Repository ${repo.owner}/${repo.name} not accessible`);
    }
  } else {
    fail(ref, `Branch ${repo.branch} of ${repo.owner}/${repo.name} not readable`);
  }
  const blobs = new Map<string, string>();
  if (head) {
    const dir = await gh(`${repoPath(repo)}/contents/${SCENES_DIR}?ref=${head}`);
    if (dir.status === 200 && Array.isArray(dir.data)) {
      for (const entry of dir.data) {
        if (entry.type === "file" && entry.name.endsWith(EXTENSION)) {
          const name = entry.name.slice(0, -EXTENSION.length);
          if (isSceneName(name)) {
            blobs.set(name, entry.sha);
          }
        }
      }
    } else if (dir.status !== 404) {
      fail(dir, "Scenes folder not readable");
    }
  }
  let dates = previous?.dates ?? new Map<string, string>();
  if (head && head !== previous?.head && blobs.size) {
    dates = await commitDates(repo, head, [...blobs.keys()]).catch(() => dates);
  }
  const next = { head, etag: ref.status === 200 ? ref.etag : null, blobs, dates, fetchedAt: Date.now() };
  listings.set(key, next);
  return next;
};

/** the space's scenes: its private repository, plus its public one if there is one this user may change */
const fetchScenes = async (force = false) => {
  try {
    const repo = await checkAccess();
    const main = await fetchListing(repo, force);
    if (publicRepo === undefined) {
      const found = await lookUpRepo(repo.owner, PUBLIC_REPO).catch(() => null);
      // only a repository that really is public and writable counts as the public one
      publicRepo = found && !found.readOnly && !found.private ? found : null;
    }
    const pub = publicRepo ? await fetchListing(publicRepo, force).catch(() => null) : null;
    remote.online = true;
    remote.lastFetchAt = new Date().toISOString();
    remote.lastError = null;
    return { repo, main, pub };
  } catch (error: any) {
    if (error.offline && !error.notConnected) {
      remote.online = false;
      remote.lastError = error.message;
    }
    throw error;
  }
};

/** where a scene lives (new scenes: the private repository) */
/**
 * What this tab committed itself in the last moments. Right after a commit
 * GitHub may still list the previous version for a few seconds: reads then
 * get the version just written, not the one before it.
 */
const ownWrites = new Map<string, { sha: string; at: number }>();
const OWN_WRITE_MS = 30_000;

const locate = async (name: string, force = true) => {
  const { repo, main, pub } = await fetchScenes(force);
  const own = ownWrites.get(name);
  const fresh = own && Date.now() - own.at < OWN_WRITE_MS ? own.sha : undefined;
  if (!main.blobs.has(name) && pub?.blobs.has(name) && publicRepo) {
    return { repo: publicRepo, listing: pub, sha: fresh ?? pub.blobs.get(name), isPublic: true };
  }
  return { repo, listing: main, sha: (main.blobs.has(name) ? fresh : undefined) ?? main.blobs.get(name), isPublic: false };
};

const checkBase = (name: string, current: string | undefined, baseSha: string | undefined) => {
  if (baseSha !== undefined && (current || "none") !== baseSha) {
    throw httpError(409, `"${name}" was changed on GitHub in the meantime`, { remoteSha: current || null });
  }
};

const isAgent = (source?: string) => typeof source === "string" && source.startsWith("agent");

const commitMessage = (text: string, source?: string) =>
  isAgent(source) ? `Agent: ${text[0].toLowerCase()}${text.slice(1)}\n\n${AGENT_TRAILER}` : text;

const readBlob = async (repo: { owner: string; name: string }, name: string, sha: string) => {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw httpError(400, "Invalid sha");
  }
  const res = await gh(`${repoPath(repo)}/git/blobs/${sha}`);
  if (res.status !== 200) {
    throw httpError(404, `Version ${sha} of scene "${name}" not found`);
  }
  return new TextDecoder().decode(fromBase64(res.data.content));
};

const putFile = (repo: RepoChoice, path: string, bytes: Uint8Array, message: string, sha?: string) =>
  gh(`${repoPath(repo)}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: { message, content: toBase64(bytes), branch: repo.branch, ...(sha ? { sha } : {}) },
  });

const deleteFile = (repo: RepoChoice, path: string, message: string, sha: string) =>
  gh(`${repoPath(repo)}/contents/${encodePath(path)}`, {
    method: "DELETE",
    body: { message, sha, branch: repo.branch },
  });

/** the space's public repository, created if needed */
const ensurePublicRepo = async (): Promise<RepoChoice> => {
  const repo = requireWritable();
  if (publicRepo) {
    return publicRepo;
  }
  const found = await lookUpRepo(repo.owner, PUBLIC_REPO);
  const createUrl = newRepoUrl(repo.owner, PUBLIC_REPO, false);
  if (found?.readOnly) {
    throw httpError(403, `${repo.owner}/${PUBLIC_REPO}: ${found.readOnly}`);
  }
  if (found?.private) {
    throw httpError(409, `${repo.owner}/${PUBLIC_REPO} exists but is private: make it public on GitHub to use it for public scenes`);
  }
  if (!found) {
    const created = await createRepo(repo.owner, PUBLIC_REPO, { private: false });
    if (created === "exists") {
      throw httpError(
        403,
        `${repo.owner}/${PUBLIC_REPO} exists, but Kurviq has no access to it: add it to the Kurviq app's repositories on GitHub`,
      );
    }
    if (created === "forbidden") {
      throw httpError(403, `Kurviq can't create ${repo.owner}/${PUBLIC_REPO}. Create it (public) on GitHub: ${createUrl}`);
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const ready = found ?? (await lookUpRepo(repo.owner, PUBLIC_REPO));
    if (ready && !ready.readOnly && !ready.private) {
      publicRepo = ready;
      return ready;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw httpError(503, `${repo.owner}/${PUBLIC_REPO} is not ready yet, try again in a moment`);
};

export const githubScenes = {
  remoteInfo: (): RemoteInfo => ({ ...remote, readOnly: state.repo?.readOnly ?? null }),

  list: async (refresh = false): Promise<{ scenes: RemoteScene[]; remote: RemoteInfo }> => {
    if (state.user === undefined) {
      await checkConnection(); // first call: find out whether this browser is connected
    }
    if (!connection.isActive()) {
      throw notConnectedError();
    }
    const entries = (main: Listing | null, pub: Listing | null) => {
      const scenes: RemoteScene[] = main
        ? [...main.blobs].map(([name, sha]) => ({ name, sha, updatedAt: main.dates.get(name) ?? null }))
        : [];
      for (const [name, sha] of pub?.blobs ?? []) {
        if (!main?.blobs.has(name)) {
          scenes.push({ name, sha, updatedAt: pub!.dates.get(name) ?? null, public: true });
        }
      }
      return scenes.sort((a, b) => a.name.localeCompare(b.name));
    };
    try {
      const { main, pub } = await fetchScenes(refresh);
      return { scenes: entries(main, pub), remote: githubScenes.remoteInfo() };
    } catch (error: any) {
      if (error.offline && !error.notConnected && state.repo) {
        const main = listings.get(repoKey(state.repo)) ?? null;
        const pub = publicRepo ? listings.get(repoKey(publicRepo)) ?? null : null;
        return { scenes: entries(main, pub), remote: githubScenes.remoteInfo() };
      }
      throw error;
    }
  },

  /** latest version, or a specific one (blob sha) */
  load: async (name: string, sha?: string): Promise<{ json: string; sha: string }> => {
    scenePath(name);
    const where = await locate(name);
    sha ??= where.sha;
    if (!sha) {
      throw httpError(404, `Scene not found: ${name}`);
    }
    return { json: await readBlob(where.repo, name, sha), sha };
  },

  /**
   * Commit a scene. baseSha: undefined = overwrite, "none" = must be new,
   * <sha> = must be exactly that version on GitHub (else 409: merge first).
   */
  save: async (name: string, json: string, baseSha?: string, source?: string) => {
    const path = scenePath(name);
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
    const bytes = new TextEncoder().encode(json);
    const sha = await blobSha(bytes);
    for (let attempt = 0; ; attempt++) {
      const { repo, sha: current } = await locate(name);
      checkBase(name, current, baseSha);
      if (current === sha) {
        return { sha, commit: null, changed: false };
      }
      const res = await putFile(repo, path, bytes, commitMessage(`${current ? "Update" : "Add"} scene: ${name}`, source), current);
      if (res.status === 200 || res.status === 201) {
        listings.delete(repoKey(repo));
        ownWrites.set(name, { sha: res.data.content.sha as string, at: Date.now() });
        return { sha: res.data.content.sha as string, commit: res.data.commit.sha as string, changed: true };
      }
      // someone pushed between our listing and the commit: look again
      ownWrites.delete(name);
      if ((res.status === 409 || res.status === 422) && attempt < 2) {
        continue;
      }
      if (res.status === 403 || res.status === 404 || res.status === 409 || res.status === 422) {
        await refused(res, `Push of "${name}" failed`);
      }
      fail(res, `Push of "${name}" failed`);
    }
  },

  /** delete a scene; baseSha (optional): only if GitHub still has that version */
  remove: async (name: string, baseSha?: string | null) => {
    const path = scenePath(name);
    requireWritable();
    for (let attempt = 0; ; attempt++) {
      const { repo, sha: current } = await locate(name);
      if (!current) {
        throw httpError(404, `Scene not found: ${name}`);
      }
      checkBase(name, current, baseSha ?? undefined);
      const res = await deleteFile(repo, path, `Delete scene: ${name}`, current);
      if (res.status === 200) {
        listings.delete(repoKey(repo));
        ownWrites.delete(name);
        return { sha: null };
      }
      if ((res.status === 409 || res.status === 422) && attempt < 2) {
        continue;
      }
      if (res.status === 403 || res.status === 404 || res.status === 409 || res.status === 422) {
        await refused(res, `Delete of "${name}" failed`);
      }
      fail(res, `Delete of "${name}" failed`);
    }
  },

  /** rename in one commit (git sees a rename; the blob sha stays) */
  rename: async (from: string, to: string): Promise<{ sha: string; commit: string | null }> => {
    const [fromPath, toPath] = [scenePath(from), scenePath(to)];
    if (from === to) {
      throw httpError(400, "New name is the same as the old one");
    }
    requireWritable();
    for (let attempt = 0; ; attempt++) {
      const { repo, listing, sha } = await locate(from);
      const { main, pub } = await fetchScenes();
      const head = listing.head;
      if (!sha || !head) {
        throw httpError(404, `Scene not found: ${from}`);
      }
      if (main.blobs.has(to) || pub?.blobs.has(to)) {
        throw httpError(409, `A scene named "${to}" already exists on GitHub`, { exists: true });
      }
      const commit = await gh(`${repoPath(repo)}/git/commits/${head}`);
      if (commit.status !== 200) {
        fail(commit, "Rename failed");
      }
      const tree = await gh(`${repoPath(repo)}/git/trees`, {
        method: "POST",
        body: {
          base_tree: commit.data.tree.sha,
          tree: [
            { path: toPath, mode: "100644", type: "blob", sha },
            { path: fromPath, mode: "100644", type: "blob", sha: null },
          ],
        },
      });
      if (tree.status !== 201) {
        if (tree.status === 403 || tree.status === 404) {
          await refused(tree, "Rename failed");
        }
        fail(tree, "Rename failed");
      }
      const next = await gh(`${repoPath(repo)}/git/commits`, {
        method: "POST",
        body: { message: `Rename scene: ${from} → ${to}`, tree: tree.data.sha, parents: [head] },
      });
      if (next.status !== 201) {
        fail(next, "Rename failed");
      }
      const ref = await gh(`${repoPath(repo)}/git/refs/heads/${encodePath(repo.branch)}`, {
        method: "PATCH",
        body: { sha: next.data.sha, force: false },
      });
      if (ref.status === 200) {
        listings.delete(repoKey(repo));
        ownWrites.delete(from);
        ownWrites.delete(to);
        return { sha, commit: next.data.sha };
      }
      // the branch moved meanwhile (not a fast-forward): try again on top
      if (ref.status === 422 && attempt < 2) {
        continue;
      }
      if (ref.status === 403 || ref.status === 404 || ref.status === 422) {
        await refused(ref, "Rename failed");
      }
      fail(ref, "Rename failed");
    }
  },

  /**
   * Make a scene public (move it to <owner>/kurviq-public) or private again
   * (back to <owner>/kurviq-scenes). It lives in one place only, so later
   * edits reach the public version; the content (and its blob sha) stays.
   */
  setPublic: async (name: string, makePublic: boolean) => {
    const path = scenePath(name);
    requireWritable();
    const from = await locate(name);
    if (!from.sha) {
      throw httpError(404, `"${name}" is not on GitHub yet: sync it first`);
    }
    if (from.isPublic === makePublic) {
      return { sha: from.sha };
    }
    const target = makePublic ? await ensurePublicRepo() : await checkAccess(true);
    if ((await fetchListing(target, true)).blobs.has(name)) {
      throw httpError(409, `${target.owner}/${target.name} already has a scene named "${name}"`);
    }
    const bytes = new TextEncoder().encode(await readBlob(from.repo, name, from.sha));
    const put = await putFile(
      target,
      path,
      bytes,
      makePublic ? `Make scene public: ${name}` : `Move scene back from ${PUBLIC_REPO}: ${name}`,
    );
    if (put.status !== 201 && put.status !== 200) {
      await refused(put, `Could not move "${name}"`);
    }
    const removed = await deleteFile(
      from.repo,
      path,
      makePublic ? `Scene made public (moved to ${PUBLIC_REPO}): ${name}` : `Scene made private (moved to ${SCENES_REPO}): ${name}`,
      from.sha,
    );
    listings.clear();
    if (removed.status !== 200) {
      // both have it now; the private copy wins in the listing
      fail(removed, `"${name}" was copied, but the old copy could not be removed`);
    }
    return { sha: from.sha };
  },

  /** the versions of a scene, newest first (load one with loadAt) */
  history: async (name: string): Promise<SceneVersion[]> => {
    const path = scenePath(name);
    const { repo } = await locate(name, false);
    const res = await gh(
      `${repoPath(repo)}/commits?sha=${encodeURIComponent(repo.branch)}&path=${encodeURIComponent(path)}&per_page=40`,
    );
    if (res.status !== 200 || !Array.isArray(res.data)) {
      fail(res, `The history of "${name}" could not be read`);
    }
    return res.data.map((entry: any) => {
      const message = String(entry.commit?.message || "");
      return {
        commit: entry.sha as string,
        at: entry.commit?.committer?.date ?? entry.commit?.author?.date ?? null,
        author: entry.author?.login ?? entry.commit?.author?.name ?? null,
        message: message.split("\n")[0],
        agent: message.split("\n").some((line) => line.trim() === AGENT_TRAILER),
      };
    });
  },

  /** the scene as it was in a commit */
  loadAt: async (name: string, commit: string): Promise<{ json: string; sha: string }> => {
    const path = scenePath(name);
    const { repo } = await locate(name, false);
    const file = await gh(`${repoPath(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(commit)}`);
    if (file.status !== 200 || !file.data?.sha) {
      fail(file, `This version of "${name}" could not be read`);
    }
    return { json: await readBlob(repo, name, file.data.sha), sha: file.data.sha as string };
  },

  /** the version of a scene an agent committed last, from the git history */
  agentVersion: async (name: string) => {
    const path = scenePath(name);
    const { repo } = await locate(name, false);
    const res = await gh(
      `${repoPath(repo)}/commits?sha=${encodeURIComponent(repo.branch)}&path=${encodeURIComponent(path)}&per_page=100`,
    );
    if (res.status !== 200 || !Array.isArray(res.data)) {
      return null;
    }
    const hit = res.data.find((entry: any) =>
      String(entry.commit?.message || "")
        .split("\n")
        .some((line: string) => line.trim() === AGENT_TRAILER),
    );
    if (!hit) {
      return null;
    }
    const file = await gh(`${repoPath(repo)}/contents/${encodePath(path)}?ref=${hit.sha}`);
    if (file.status !== 200 || !file.data?.sha) {
      return null;
    }
    return { sha: file.data.sha as string, commit: hit.sha as string, at: hit.commit.committer?.date ?? null };
  },
};

// -----------------------------------------------------------------------------
// spaces: the accounts and organizations where the Kurviq app is installed
// -----------------------------------------------------------------------------

export type Space = { owner: string; organization: boolean };

/** the personal account first, then the organizations (as GitHub lists the app's installations) */
export const listSpaces = async (): Promise<Space[]> => {
  const login = state.user?.login;
  const res = await gh("/user/installations?per_page=100");
  if (res.status !== 200) {
    fail(res, "Could not list where the Kurviq app is installed");
  }
  const spaces: Space[] = login ? [{ owner: login, organization: false }] : [];
  for (const installation of res.data.installations || []) {
    const owner = installation.account?.login;
    if (owner && !spaces.some((space) => space.owner.toLowerCase() === owner.toLowerCase())) {
      spaces.push({ owner, organization: installation.account?.type === "Organization" });
    }
  }
  return spaces;
};

export type SpaceScenes = Space & { scenes: string[] };

let otherSpaces: { at: number; value: Promise<SpaceScenes[]> } | null = null;

/**
 * The scenes of the user's other spaces (each one's <owner>/kurviq-scenes),
 * for a scene list that shows them all; asked again after a minute
 */
export const otherSpacesScenes = (): Promise<SpaceScenes[]> => {
  if (otherSpaces && Date.now() - otherSpaces.at < 60_000) {
    return otherSpaces.value;
  }
  const here = (state.repo?.owner ?? "").toLowerCase();
  const value = (async () => {
    const spaces = (await listSpaces()).filter((space) => space.owner.toLowerCase() !== here);
    const found = await Promise.all(
      spaces.map(async (space): Promise<SpaceScenes | null> => {
        try {
          const repo = await findScenesRepo(space.owner);
          if (!repo?.private) {
            return null;
          }
          const dir = await gh(`${repoPath(repo)}/contents/${SCENES_DIR}?ref=${encodePath(repo.branch)}`);
          const scenes = dir.status === 200 && Array.isArray(dir.data)
            ? dir.data
                .filter((entry: any) => entry.type === "file" && entry.name.endsWith(EXTENSION))
                .map((entry: any) => entry.name.slice(0, -EXTENSION.length) as string)
                .filter((name: string) => isSceneName(name))
            : [];
          return { ...space, scenes };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((entry): entry is SpaceScenes => !!entry);
  })();
  value.catch(() => {
    otherSpaces = null;
  });
  otherSpaces = { at: Date.now(), value };
  return value;
};

/** <owner>/kurviq-scenes as GitHub shows it to this user (readOnly set when it can't be changed), or null */
export const findScenesRepo = (owner: string) => lookUpRepo(owner, SCENES_REPO);

/** is the Kurviq app installed on this account or organization? (needed for any repository access) */
export const isInstalledFor = async (owner: string) => {
  const res = await gh("/user/installations?per_page=100");
  if (res.status !== 200) {
    fail(res, "Could not check the Kurviq app on GitHub");
  }
  return (res.data.installations || []).some(
    (installation: any) => installation.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
};

/** GitHub's "new repository" form, filled in */
export const newRepoUrl = (owner: string, name = SCENES_REPO, isPrivate = true) =>
  `https://github.com/new?owner=${encodeURIComponent(owner)}&name=${name}&visibility=${
    isPrivate ? "private" : "public"
  }&description=${encodeURIComponent(isPrivate ? "Drawings from Kurviq" : "Public drawings from Kurviq")}`;

/**
 * Create a repository for an account or organization. "exists": it is
 * there, but Kurviq can't see it; "forbidden": not allowed (the app's
 * permission, or the user's role in the organization).
 */
const createRepo = async (
  owner: string,
  name: string,
  { private: isPrivate }: { private: boolean },
): Promise<"created" | "exists" | "forbidden"> => {
  const personal = owner.toLowerCase() === state.user?.login.toLowerCase();
  const res = await gh(personal ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`, {
    method: "POST",
    body: {
      name,
      private: isPrivate,
      auto_init: true,
      description: isPrivate ? "Drawings from Kurviq (https://kurviq.com)" : "Public drawings from Kurviq (https://kurviq.com)",
    },
  });
  if (res.status === 201) {
    return "created";
  }
  if (res.status === 422) {
    return "exists";
  }
  if (res.status === 403 || res.status === 404) {
    return "forbidden";
  }
  return fail(res, `Could not create ${owner}/${name}`);
};

/** create <owner>/kurviq-scenes (private) */
export const createScenesRepo = (owner: string) => createRepo(owner, SCENES_REPO, { private: true });

/**
 * Copy the scenes of an old scenes repository into the new one (the ones
 * it doesn't have yet); returns how many were copied. The old repository
 * stays as it is.
 */
export const copyScenes = async (from: RepoChoice, to: RepoChoice) => {
  const [source, target] = await Promise.all([fetchListing(from, true), fetchListing(to, true)]);
  let copied = 0;
  for (const [name, sha] of source.blobs) {
    if (target.blobs.has(name)) {
      continue;
    }
    const bytes = new TextEncoder().encode(await readBlob(from, name, sha));
    const res = await putFile(to, scenePath(name), bytes, `Add scene: ${name} (from ${from.owner}/${from.name})`);
    if (res.status !== 201 && res.status !== 200) {
      fail(res, `Could not copy "${name}"`);
    }
    copied++;
  }
  listings.clear();
  return copied;
};

// -----------------------------------------------------------------------------
// someone's shared scene (kurviq.com/@owner/scene): public without sign-in,
// private with the reader's own GitHub access
// -----------------------------------------------------------------------------

export type SharedScene = {
  json: string;
  public: boolean;
  /** this user may change the owner's scenes (a member of that space) */
  canEdit: boolean;
};

/** null: no such scene, or this user may not read it (GitHub doesn't tell which) */
export const readSharedScene = async (owner: string, name: string): Promise<SharedScene | null> => {
  const path = scenePath(name);
  // public scenes: through Kurviq's edge cache (the page preloads this very URL), no sign-in needed
  const publicCopy = fetch(`/api/public/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  // at the same time: is the visitor signed in, and a member of that space?
  const membership = getToken()
    .catch(() => null)
    .then(async (token) =>
      token
        ? {
            signedIn: true,
            canEdit: await lookUpRepo(owner, SCENES_REPO)
              .then((repo) => !!repo && !repo.readOnly)
              .catch(() => false),
          }
        : { signedIn: false, canEdit: false },
    );
  const json = await publicCopy;
  if (json !== null) {
    // don't wait for the membership check longer than a moment
    const { canEdit } = await Promise.race([membership, new Promise<{ canEdit: false }>((resolve) => setTimeout(() => resolve({ canEdit: false }), 1500))]);
    return { json, public: true, canEdit };
  }
  const { signedIn, canEdit } = await membership;
  if (!signedIn) {
    return null;
  }
  const file = await gh(`/repos/${encodeURIComponent(owner)}/${SCENES_REPO}/contents/${encodePath(path)}`);
  if (file.status !== 200 || !file.data?.sha) {
    return null;
  }
  return { json: await readBlob({ owner, name: SCENES_REPO }, name, file.data.sha), public: false, canEdit };
};
