// "Connect with Supabase" (specs/2026-11-13-own-database.md, Setup): Supabase's
// OAuth with PKCE. The browser keeps the verifier (session storage, for the
// round trip only), Kurviq's Worker adds the client secret to the code
// exchange (online/worker/supabase.ts) and keeps nothing. The management
// token lives in this page's memory while the setup runs (pick or create a
// project, run Kurviq's schema, read the public key, allow Kurviq's address
// for sign-in links) and is dropped then; it is never stored.
//
// Supabase's Management API answers browsers only on supabase.com, so its
// calls go through the Worker as they are (/api/supabase/v1/…).

import supabase from "../../../../online/supabase.json";

import { ownerSql } from "./schemaVersion";
import { withoutPadding } from "./text";

const AUTHORIZE = "https://api.supabase.com/v1/oauth/authorize";
const PENDING_KEY = "kurviq-supabase-oauth";
const API = "/api/supabase/v1";

const base64url = (bytes: Uint8Array) => withoutPadding(btoa(String.fromCodePoint(...bytes)).replaceAll("+", "-").replaceAll("/", "_"));

/** a PKCE verifier (43 characters) and its S256 challenge */
export const pkcePair = async () => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
};

export const callbackUrl = (origin = location.origin) => `${origin}${supabase.callbackPath}`;

/** Supabase's consent page for Kurviq's OAuth app */
export const authorizeUrl = (state: string, challenge: string, origin = location.origin) => {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: supabase.clientId,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

/** go to Supabase to allow Kurviq (the page leaves) */
export const startSupabaseConnect = async (email: string) => {
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, email, back: location.pathname }));
  location.assign(authorizeUrl(state, challenge));
};

export const isSupabaseCallback = (pathname = location.pathname) => pathname === supabase.callbackPath;

/**
 * Back from Supabase: the code (checked against the state sent) exchanged
 * for a management token through the Worker. The token is returned, never
 * stored; the URL is cleaned. Throws when the user declined or it failed.
 */
export const finishSupabaseConnect = async (search = location.search) => {
  const params = new URLSearchParams(search);
  let pending: { state?: string; verifier?: string; email?: string; back?: string } | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
  } catch {}
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", pending?.back && pending.back !== supabase.callbackPath ? pending.back : "/");
  if (params.get("error")) {
    throw new Error(params.get("error_description") || "Supabase did not connect Kurviq");
  }
  const code = params.get("code");
  if (!code || !pending?.verifier || params.get("state") !== pending.state) {
    throw new Error("This sign-in with Supabase was not started here (or it took too long): try again");
  }
  const res = await fetch("/api/supabase/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: pending.verifier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.accessToken !== "string") {
    throw new Error(body.error ?? `Supabase sign-in failed (${res.status})`);
  }
  return { token: body.accessToken as string, email: pending.email ?? "" };
};

// -----------------------------------------------------------------------------
// the Management API calls of the setup
// -----------------------------------------------------------------------------

export type Organization = { id: string; name: string; slug?: string };
export type Project = { ref: string; name: string; organization_id: string; region: string; status: string };
export const REGIONS: [string, string][] = [
  ["eu-central-1", "Frankfurt (EU)"],
  ["eu-west-1", "Ireland (EU)"],
  ["eu-west-2", "London"],
  ["us-east-1", "North Virginia (US)"],
  ["us-west-1", "North California (US)"],
  ["ap-southeast-1", "Singapore"],
  ["ap-northeast-1", "Tokyo"],
  ["sa-east-1", "São Paulo"],
];

/** a strong database password (shown once, never stored by Kurviq) */
export const newDatabasePassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};

/** the project's address list for sign-in links with Kurviq's address (once) */
export const withKurviqRedirect = (list: string | null | undefined, origin: string) => {
  const entries = (list ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const wanted = `${origin}/**`;
  return entries.includes(wanted) ? null : [...entries, wanted].join(",");
};

export const managementApi = (token: string, fetcher: typeof fetch = (...args) => fetch(...args)) => {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw Object.assign(new Error(data?.message ?? data?.error ?? `Supabase answered ${res.status}`), { status: res.status });
    }
    return data as T;
  };
  return {
    organizations: () => call<Organization[]>("GET", "/organizations"),
    projects: async () =>
      (await call<any[]>("GET", "/projects")).map((project) => ({ ...project, ref: project.ref ?? project.id }) as Project),
    project: async (ref: string) => {
      const project = await call<any>("GET", `/projects/${ref}`);
      return { ...project, ref: project.ref ?? project.id } as Project;
    },
    createProject: async (input: { name: string; organizationId: string; region: string; password: string }) => {
      const project = await call<any>("POST", "/projects", { name: input.name, organization_id: input.organizationId, region: input.region, db_pass: input.password });
      return { ...project, ref: project.ref ?? project.id } as Project;
    },
    query: (ref: string, sql: string) => call<unknown>("POST", `/projects/${ref}/database/query`, { query: sql }),
    publicKey: async (ref: string) => {
      const keys = await call<any[]>("GET", `/projects/${ref}/api-keys?reveal=false`);
      const key = keys.find((entry) => entry.type === "publishable") ?? keys.find((entry) => entry.name === "anon");
      if (!key?.api_key) {
        throw new Error("The project has no publishable key");
      }
      return key.api_key as string;
    },
    authConfig: () => ({
      get: (ref: string) => call<Record<string, any>>("GET", `/projects/${ref}/config/auth`),
      set: (ref: string, patch: Record<string, unknown>) => call<unknown>("PATCH", `/projects/${ref}/config/auth`, patch),
    }),
  };
};

export type ManagementApi = ReturnType<typeof managementApi>;

/** wait until a new project is up (Supabase takes a minute or two) */
export const waitUntilUp = async (api: ManagementApi, ref: string, onStatus: (status: string) => void, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const { status } = await api.project(ref); // NOSONAR S9382: polling in order on purpose
    onStatus(status);
    if (status === "ACTIVE_HEALTHY") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000)); // NOSONAR S9382: polling in order on purpose
  }
  throw new Error("The new project takes long to start: open it in Supabase, then connect again");
};

/**
 * Kurviq's schema in the project, its owner, sign-in links back to Kurviq,
 * and the connection's values (the public key only). The token is the
 * caller's to drop afterwards.
 */
export const setUpProject = async (api: ManagementApi, ref: string, owner: string, origin = location.origin) => {
  const { SCHEMA_SQL } = await import("./schema");
  await api.query(ref, SCHEMA_SQL);
  if (owner) {
    await api.query(ref, ownerSql(owner));
  }
  try {
    const auth = api.authConfig();
    const config = await auth.get(ref);
    const list = withKurviqRedirect(config.uri_allow_list, origin);
    const siteIsDefault = !config.site_url || /localhost:3000/.test(String(config.site_url));
    if (list || siteIsDefault) {
      await auth.set(ref, { ...(list ? { uri_allow_list: list } : {}), ...(siteIsDefault ? { site_url: origin } : {}) });
    }
  } catch (error) {
    console.warn("[database] the project's sign-in addresses were not changed", error);
  }
  const key = await api.publicKey(ref);
  return { ref, url: `https://${ref}.supabase.co`, key };
};
