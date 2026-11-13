// The databases this person connected (their own Supabase projects, or a
// team's they were invited to): address, public key and name, in this
// browser (localStorage) and, when signed in with Google, in their Drive's
// hidden app data so they follow them to other browsers. Never on Kurviq's
// servers. Per database: one supabase-js client and its sign-in (email link
// or code), the scene home over it (./home.ts), and the members and access
// calls of the share panel.

import { createStore } from "../../externalStore";

import { createDbClient, dbCall, notSignedIn, sessionKeyOf, supabaseRows } from "./client";
import { databaseHomeOf } from "./home";
import { isPausedAnswer, PAUSED_MESSAGE } from "./rows";
import { schemaState } from "./schemaVersion";

import type { DbConnection } from "./client";
import type { DatabaseHome } from "./home";
import type { Role, SceneRows } from "./rows";
import type { SupabaseClient } from "@supabase/supabase-js";

export type { DbConnection } from "./client";

const STORE_KEY = "kurviq-databases";
/** the name a connection has until its space tells its own */
export const DEFAULT_SPACE_NAME = "Team space";

export type DbSession = {
  /** unknown: not asked yet (supabase-js not loaded) */
  status: "unknown" | "signed-out" | "signed-in";
  email: string | null;
  /** the role in the whole space (null: only scenes shared with them, or none) */
  spaceRole: Role | null;
  /** why the database can't be used now (paused, not reachable) */
  problem: string | null;
  paused?: boolean;
};

type Stored = { connections: DbConnection[]; removed: Record<string, string> };

export type DatabasesState = { connections: DbConnection[]; sessions: Record<string, DbSession> };

const readStored = (): Stored => {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const connections = Array.isArray(value.connections) ? value.connections.filter(isConnection) : [];
    return { connections, removed: value.removed && typeof value.removed === "object" ? value.removed : {} };
  } catch {
    return { connections: [], removed: {} };
  }
};

const isConnection = (value: any): value is DbConnection =>
  !!value && typeof value.ref === "string" && /^[a-z0-9-]{3,64}$/.test(value.ref) && typeof value.url === "string" && /^https?:\/\//.test(value.url) && typeof value.key === "string" && typeof value.name === "string";

const writeStored = (stored: Stored) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {}
};

const NO_SESSION: DbSession = { status: "unknown", email: null, spaceRole: null, problem: null };

const store = createStore<DatabasesState>({ connections: readStored().connections, sessions: {} });

const setSession = (ref: string, patch: Partial<DbSession>) => {
  const state = store.get();
  store.set({ ...state, sessions: { ...state.sessions, [ref]: { ...(state.sessions[ref] ?? NO_SESSION), ...patch } } });
};

/** a project's ref from its address (https://<ref>.supabase.co), else a short id of the host (self-hosted) */
export const refOfUrl = (url: string) => {
  const host = new URL(url).hostname.toLowerCase();
  const hosted = /^([a-z0-9]{20})\.supabase\.(co|in|net)$/.exec(host);
  if (hosted) {
    return hosted[1];
  }
  let hash = 7;
  for (const char of host) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return `h-${hash.toString(36)}`;
};

/** a pasted project address, cleaned (https, no path); null if it isn't one */
export const cleanProjectUrl = (raw: string) => {
  try {
    const url = new URL(raw.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

/** what can be a publishable / anon key: sb_publishable_…, or a legacy anon JWT; never a secret key */
export const keyProblem = (key: string) => {
  const value = key.trim();
  if (value.startsWith("sb_secret_")) {
    return "This is a secret key: Kurviq needs the publishable (anon) key. Never paste a secret key anywhere in a browser.";
  }
  if (/^sb_publishable_[\w-]{10,}$/.test(value)) {
    return null;
  }
  const parts = value.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")));
      if (payload.role === "service_role") {
        return "This is the service role key: Kurviq needs the anon (publishable) key. Never paste the service role key anywhere in a browser.";
      }
      return payload.role === "anon" ? null : "This doesn't look like an anon key";
    } catch {
      return "This doesn't look like a Supabase key";
    }
  }
  return "Paste the project's publishable key (sb_publishable_…) or its legacy anon key";
};

/**
 * A project to connect, checked before it is: Kurviq's tables are there (ok),
 * not yet (missing), older (old); it is paused, or doesn't answer.
 */
export const createProbe = async ({ url, key }: { url: string; key: string }, fetcher: typeof fetch = (...args) => fetch(...args)) => {
  let res: Response;
  try {
    res = await fetcher(`${url}/rest/v1/rpc/kurviq_schema_version`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: "{}" });
  } catch {
    return (await isPaused(url, fetcher)) ? ("paused" as const) : ("unreachable" as const);
  }
  const text = await res.text();
  if (isPausedAnswer(res.status, text)) {
    return "paused" as const;
  }
  if (res.status === 404 || /PGRST202|could not find the function/i.test(text)) {
    return "missing" as const;
  }
  if (!res.ok) {
    return "unreachable" as const;
  }
  return schemaState(JSON.parse(text)) === "ok" ? ("ok" as const) : ("old" as const);
};

/**
 * A database that doesn't answer while the internet works (this site does):
 * a free Supabase project pauses after a week unused. Its answer, if any,
 * says "paused"; a project's address without CORS headers then fails too.
 */
export const isPaused = async (url: string, fetcher: typeof fetch = (...args) => fetch(...args)) => {
  try {
    const res = await fetcher(`${url}/auth/v1/health`);
    return isPausedAnswer(res.status, await res.text());
  } catch {
    try {
      const here = await fetcher(`${globalThis.location?.origin ?? ""}/llms.txt`, { method: "HEAD" });
      return here.ok;
    } catch {
      return false; // this browser is offline
    }
  }
};

// -----------------------------------------------------------------------------
// clients, sessions, homes
// -----------------------------------------------------------------------------

const clients = new Map<string, Promise<SupabaseClient>>();
const homes = new Map<string, DatabaseHome>();

export const connectionOf = (ref: string) => store.get().connections.find((entry) => entry.ref === ref) ?? null;

const requireConnection = (ref: string) => {
  const connection = connectionOf(ref);
  if (!connection) {
    throw Object.assign(new Error("This database is not connected in this browser"), { status: 401, notConnected: true });
  }
  return connection;
};

const emailOf = (ref: string) => store.get().sessions[ref]?.email ?? null;

/** after a sign-in: the space's owner if it has none yet (a new database), its name and this person's role */
const afterSignIn = async (ref: string, client: SupabaseClient, email: string) => {
  setSession(ref, { status: "signed-in", email, problem: null, paused: false });
  try {
    const role = (await dbCall(ref, () => client.rpc("kurviq_claim_space", {}) as any)) as Role | null;
    const space = (await dbCall(ref, () => client.from("kurviq_space").select("name").maybeSingle() as any)) as { name?: string } | null;
    setSession(ref, { spaceRole: role ?? null });
    const connection = connectionOf(ref);
    if (connection && space?.name && space.name !== connection.name && (connection.name === DEFAULT_SPACE_NAME || role !== "owner")) {
      saveConnection({ ...connection, name: space.name });
    }
  } catch (error: any) {
    setSession(ref, { problem: error.paused ? PAUSED_MESSAGE : null, paused: !!error.paused });
  }
};

/** the supabase-js client of a connected database (loaded on first use) */
export const clientFor = (ref: string): Promise<SupabaseClient> => {
  let client = clients.get(ref);
  if (!client) {
    const connection = requireConnection(ref);
    client = createDbClient(connection).then(async (created) => {
      created.auth.onAuthStateChange((event, session) => {
        const email = session?.user?.email?.toLowerCase() ?? null;
        if (!email) {
          setSession(ref, { status: "signed-out", email: null, spaceRole: null });
        } else if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
          // (a callback must not await supabase calls itself: they wait for it)
          globalThis.setTimeout(() => void afterSignIn(ref, created, email), 0);
        }
      });
      const { data } = await created.auth.getSession();
      if (!data.session) {
        setSession(ref, { status: "signed-out", email: null });
      }
      return created;
    });
    clients.set(ref, client);
  }
  return client;
};

/** the scene rows of a database, its client loaded on the first call */
const lazyRows = (ref: string): SceneRows => {
  let rows: SceneRows | null = null;
  const get = async () => {
    rows ??= supabaseRows(await clientFor(ref), () => emailOf(ref));
    return rows;
  };
  return new Proxy({} as SceneRows, {
    get: (_target, method: keyof SceneRows) => async (...args: unknown[]) => ((await get())[method] as (...params: unknown[]) => unknown)(...args),
  });
};

/** the scene home of a connected database */
export const databaseHome = (ref: string): DatabaseHome => {
  let home = homes.get(ref);
  if (!home) {
    const made = databaseHomeOf(lazyRows(ref), { ref, label: connectionOf(ref)?.name ?? DEFAULT_SPACE_NAME });
    // its label follows the space's name
    Object.defineProperty(made, "label", { get: () => connectionOf(ref)?.name ?? DEFAULT_SPACE_NAME });
    home = made;
    homes.set(ref, home);
  }
  return home;
};

// -----------------------------------------------------------------------------
// the list of connections
// -----------------------------------------------------------------------------

const saveConnection = (connection: DbConnection) => {
  const stored = readStored();
  const connections = [...stored.connections.filter((entry) => entry.ref !== connection.ref), connection];
  delete stored.removed[connection.ref];
  writeStored({ connections, removed: stored.removed });
  store.set({ ...store.get(), connections });
  scheduleDriveSync();
};

export const databases = {
  subscribe: store.subscribe,
  get: store.get,
  use: store.use,
  list: () => store.get().connections,
  session: (ref: string) => store.get().sessions[ref] ?? NO_SESSION,
  /** add (or update) a connection; its client follows */
  add: (connection: Omit<DbConnection, "addedAt"> & { addedAt?: string }) => {
    const entry: DbConnection = { ...connection, addedAt: connection.addedAt ?? new Date().toISOString() };
    const before = connectionOf(entry.ref);
    if (before && (before.url !== entry.url || before.key !== entry.key)) {
      clients.delete(entry.ref);
    }
    saveConnection(entry);
    void clientFor(entry.ref).catch(() => {});
    return entry;
  },
  rename: (ref: string, name: string) => {
    const connection = connectionOf(ref);
    if (connection && name.trim()) {
      saveConnection({ ...connection, name: name.trim().slice(0, 100) });
    }
  },
  /** forget a connection here (and in Drive's app data): its scenes stay in the database */
  remove: async (ref: string) => {
    await signOutDb(ref).catch(() => {});
    const stored = readStored();
    const connections = stored.connections.filter((entry) => entry.ref !== ref);
    writeStored({ connections, removed: { ...stored.removed, [ref]: new Date().toISOString() } });
    clients.delete(ref);
    homes.delete(ref);
    store.set({ ...store.get(), connections });
    scheduleDriveSync();
  },
  /** start the clients of all connections (their sign-in state is known then) */
  start: () => {
    for (const connection of store.get().connections) {
      void clientFor(connection.ref).catch(() => {});
    }
  },
  /** connections stored by another tab */
  reload: () => store.set({ ...store.get(), connections: readStored().connections }),
};

// -----------------------------------------------------------------------------
// signing in to a database: an email with a link back to Kurviq (and a code,
// if the project's email template has one: {{ .Token }}, custom SMTP)
// -----------------------------------------------------------------------------

/** where an email link of this database returns to: /db/<ref>[/<scene id>] */
export const dbPath = (ref: string, sceneId?: string) => (sceneId ? `/db/${ref}/${sceneId}` : `/db/${ref}`);

/** a link to a database scene for others: the public key in the # part (never sent to a server) */
export const sceneLink = (connection: DbConnection, sceneId: string, origin = globalThis.location?.origin ?? "https://kurviq.com") => {
  const hash = new URLSearchParams({ k: connection.key });
  if (refOfUrl(connection.url) !== connection.ref || !connection.url.endsWith(".supabase.co")) {
    hash.set("u", connection.url);
  }
  return `${origin}${dbPath(connection.ref, sceneId)}#${hash.toString()}`;
};

/** send this address a sign-in email; false + why when the database refused (e.g. its hourly mail limit) */
export const signInByEmail = async (ref: string, email: string, sceneId?: string) => {
  const client = await clientFor(ref);
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${dbPath(ref, sceneId)}` },
  });
  return error ? { sent: false as const, why: mailProblem(error) } : { sent: true as const };
};

/** the database's mail refusal in words (the default mailer sends only a few mails per hour) */
export const mailProblem = (error: { message?: string; status?: number; code?: string }) => {
  if (error.status === 429 || /rate limit|too many/i.test(error.message ?? "")) {
    return "The database's mailer reached its hourly limit. Wait a while, or set up your own email sender (SMTP) in Supabase: Authentication → Emails → SMTP settings.";
  }
  return error.message ?? "The database could not send the email";
};

/** the code from the email (only where the project's email template shows it) */
export const verifyCode = async (ref: string, email: string, code: string) => {
  const client = await clientFor(ref);
  const { error } = await client.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: "email" });
  if (error) {
    throw new Error(/expired|invalid/i.test(error.message) ? "This code is wrong or expired: ask for a new email" : error.message);
  }
};

export const signOutDb = async (ref: string) => {
  if (!clients.has(ref)) {
    try {
      localStorage.removeItem(sessionKeyOf(ref));
    } catch {}
    return;
  }
  const client = await clientFor(ref);
  await client.auth.signOut({ scope: "local" });
  setSession(ref, { status: "signed-out", email: null, spaceRole: null });
};

/**
 * A database link (/db/<ref>/<scene id>) opened: its connection is added
 * from the link's # part if it is new here (k: public key, u: address of a
 * self-hosted one), and an email link's sign-in (access_token in the #
 * part) is taken. The # part is cleared. Null if this isn't one.
 */
export const takeDatabaseLink = async (location: { pathname: string; hash: string }) => {
  const match = /^\/db\/([a-z0-9-]{3,64})(?:\/([0-9a-f-]{36}))?\/?$/.exec(location.pathname);
  if (!match) {
    return null;
  }
  const [, ref, sceneId] = match;
  // the # part: "k=…&u=…", then Supabase's "#access_token=…" after an email link
  const params = new URLSearchParams(location.hash.replace(/^#/, "").replaceAll("#", "&"));
  const key = params.get("k");
  if (!connectionOf(ref) && key && !keyProblem(key)) {
    const url = cleanProjectUrl(params.get("u") ?? `https://${ref}.supabase.co`);
    if (url) {
      databases.add({ ref, url, key, name: DEFAULT_SPACE_NAME });
    }
  }
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (connectionOf(ref) && accessToken && refreshToken) {
    const client = await clientFor(ref);
    await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).catch(() => null);
  }
  const linkError = params.get("error_description");
  return { ref, sceneId: sceneId ?? null, known: !!connectionOf(ref), error: linkError };
};

// -----------------------------------------------------------------------------
// members of the space, and per-scene access (the share panel)
// -----------------------------------------------------------------------------

export type Member = { email: string; role: Role; invited_by: string | null; created_at: string };
export type Access = { email: string; role: Exclude<Role, "owner">; expires_at: string | null; invited_by: string | null };

const signedInClient = async (ref: string) => {
  const client = await clientFor(ref);
  if (!emailOf(ref)) {
    const { data } = await client.auth.getSession();
    if (!data.session) {
      throw notSignedIn(connectionOf(ref)?.name ?? DEFAULT_SPACE_NAME);
    }
  }
  return client;
};

export const members = {
  list: async (ref: string) =>
    (await dbCall(ref, async () => (await signedInClient(ref)).from("kurviq_members").select("email,role,invited_by,created_at").order("email") as any)) as Member[],
  set: async (ref: string, email: string, role: Role) => {
    await dbCall(ref, async () => (await signedInClient(ref)).from("kurviq_members").upsert({ email: email.trim().toLowerCase(), role, invited_by: emailOf(ref) }) as any);
  },
  remove: async (ref: string, email: string) => {
    await dbCall(ref, async () => (await signedInClient(ref)).from("kurviq_members").delete().eq("email", email) as any);
  },
};

export const sceneAccess = {
  list: async (ref: string, sceneId: string) =>
    (await dbCall(ref, async () => (await signedInClient(ref)).from("kurviq_scene_access").select("email,role,expires_at,invited_by").eq("scene_id", sceneId).order("email") as any)) as Access[],
  set: async (ref: string, sceneId: string, email: string, role: Access["role"], expiresAt: string | null) => {
    await dbCall(ref, async () =>
      (await signedInClient(ref)).from("kurviq_scene_access").upsert({ scene_id: sceneId, email: email.trim().toLowerCase(), role, expires_at: expiresAt, invited_by: emailOf(ref) }) as any,
    );
  },
  remove: async (ref: string, sceneId: string, email: string) => {
    await dbCall(ref, async () => (await signedInClient(ref)).from("kurviq_scene_access").delete().eq("scene_id", sceneId).eq("email", email) as any);
  },
};

/**
 * Invite someone to a scene: access with this role (until an end date), then
 * an email from the database's own mailer with a sign-in link that opens the
 * scene. The email may not go out (the default mailer's hourly limit): the
 * access stays, and the link can be sent by hand.
 */
export const invite = async (ref: string, sceneId: string, email: string, role: Access["role"], expiresAt: string | null) => {
  await sceneAccess.set(ref, sceneId, email, role, expiresAt);
  const connection = requireConnection(ref);
  const client = await clientFor(ref);
  const link = sceneLink(connection, sceneId);
  const { error } = await client.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true, emailRedirectTo: link } });
  return { link, sent: !error, why: error ? mailProblem(error) : null };
};

// -----------------------------------------------------------------------------
// the connections in Drive's app data (when signed in with Google): another
// browser of the same Google account gets them at its next start
// -----------------------------------------------------------------------------

export const DRIVE_FILE = "kurviq-databases.json";

type DriveAppData = { read: (name: string) => Promise<string | null | undefined>; write: (name: string, text: string) => Promise<boolean> };

/** both lists in one: every connection either has, the newer entry of one in both; removals win over older entries */
export const mergeStored = (local: Stored, remote: Stored): Stored => {
  const removed: Record<string, string> = { ...remote.removed };
  for (const [ref, at] of Object.entries(local.removed)) {
    if (!removed[ref] || removed[ref] < at) {
      removed[ref] = at;
    }
  }
  const byRef = new Map<string, DbConnection>();
  for (const connection of [...remote.connections, ...local.connections]) {
    const known = byRef.get(connection.ref);
    if (!known || (known.addedAt ?? "") <= (connection.addedAt ?? "")) {
      byRef.set(connection.ref, connection);
    }
  }
  const connections = [...byRef.values()].filter((connection) => !removed[connection.ref] || removed[connection.ref] < connection.addedAt);
  for (const connection of connections) {
    delete removed[connection.ref];
  }
  return { connections: connections.sort((a, b) => a.ref.localeCompare(b.ref)), removed };
};

let driveAppData: DriveAppData | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

const parseStored = (text: string | null | undefined): Stored => {
  try {
    const value = JSON.parse(text || "{}");
    return { connections: Array.isArray(value.connections) ? value.connections.filter(isConnection) : [], removed: value.removed ?? {} };
  } catch {
    return { connections: [], removed: {} };
  }
};

/** take the connections in Drive's app data, and write the merged list back if it changed there */
export const syncWithDrive = async () => {
  if (!driveAppData) {
    return false;
  }
  const remoteText = await driveAppData.read(DRIVE_FILE);
  if (remoteText === undefined) {
    return false; // no app data access (signed in before Kurviq asked for it)
  }
  const local = readStored();
  const merged = mergeStored(local, parseStored(remoteText));
  const text = JSON.stringify(merged);
  if (JSON.stringify({ connections: [...local.connections].sort((a, b) => a.ref.localeCompare(b.ref)), removed: local.removed }) !== text) {
    writeStored(merged);
    store.set({ ...store.get(), connections: merged.connections });
    databases.start();
  }
  if (JSON.stringify(parseStored(remoteText)) !== text) {
    await driveAppData.write(DRIVE_FILE, text);
  }
  return true;
};

function scheduleDriveSync() {
  if (!driveAppData) {
    return;
  }
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncWithDrive().catch((error) => console.warn("[databases] Drive app data not synced", error));
  }, 500);
}

/** signed in with Google: the connections follow through Drive's app data (null: signed out) */
export const setDriveAppData = (appData: DriveAppData | null) => {
  driveAppData = appData;
  if (appData) {
    syncWithDrive().catch((error) => console.warn("[databases] Drive app data not read", error));
  }
};

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // end-to-end tests (dev, and builds for the fake Google): the connections and their clients
  (globalThis as any).__kurviqDb = { databases, clientFor, databaseHome, invite, members, sceneAccess, createProbe };
}
