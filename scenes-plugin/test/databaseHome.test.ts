// The database home's rules without a database (src/homes/database): which
// changes go where (newer version wins), the scene file in rows and back,
// writes of a scene that isn't open, errors (offline, paused, refused), the
// connections (keys, links, the Drive app data merge), the setup's PKCE and
// Management API calls, and the Worker's stateless code exchange.
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSupabase, allowedCall, publicKeysOnly } from "../../online/worker/supabase";
import { accessOf, changedComments, deletedVersion, isNewer, localChanges, remoteWinners, settingsKey, vanished } from "../src/homes/database/changes";
import { asHomeError, isPausedAnswer, PAUSED_MESSAGE } from "../src/homes/database/rows";
import { assembleScene, elementRows, fileIndex, orderedElements, splitScene } from "../src/homes/database/sceneJson";
import { ownerSql, schemaState } from "../src/homes/database/schemaVersion";
import { elementChanges, writeSceneChanges } from "../src/homes/database/write";

import { fakeSceneRows } from "./fakeSceneRows";

afterEach(() => vi.restoreAllMocks());

const el = (id: string, version: number, versionNonce = 1, extra: Record<string, unknown> = {}) => ({ id, version, versionNonce, ...extra });

describe("the same element in two places: the newer version wins", () => {
  it("higher version, then the lower nonce (Excalidraw's rule)", () => {
    expect(isNewer(el("a", 2), el("a", 1))).toBe(true);
    expect(isNewer(el("a", 1), el("a", 2))).toBe(false);
    expect(isNewer(el("a", 2, 5), el("a", 2, 9))).toBe(true);
    expect(isNewer(el("a", 2, 9), el("a", 2, 5))).toBe(false);
    expect(isNewer(el("a", 1), undefined)).toBe(true);
  });

  it("the canvas's changes: new and newer elements, not the database's own versions, not new deleted ones", () => {
    const known = new Map([["a", "2:1"], ["b", "1:1"]]);
    const changes = localChanges([el("a", 2), el("b", 3), el("c", 1), el("d", 1, 1, { isDeleted: true })], known);
    expect(changes.map((element) => element.id)).toEqual(["b", "c"]);
    // an older version on the canvas (the database moved on) is not written back
    expect(localChanges([el("a", 1)], known)).toEqual([]);
  });

  it("elements gone from the canvas altogether are deleted there, as a newer version", () => {
    const known = new Map([["a", "2:1"], ["b", "1:1"], ["c", "4:1"]]);
    expect(vanished([el("a", 2)], known, new Set(["c"]))).toEqual(["b"]);
    expect(deletedVersion({ id: "b", version: 1, type: "rectangle" })).toMatchObject({ id: "b", version: 2, isDeleted: true, type: "rectangle" });
  });

  it("two people on different elements never conflict; the database's newer ones win over the canvas", () => {
    const canvas = new Map([["a", el("a", 3)], ["b", el("b", 1)]]);
    const remote = [el("a", 2), el("b", 2), el("c", 1)];
    expect(remoteWinners(remote, canvas).map((element) => element.id)).toEqual(["b", "c"]);
  });

  it("comments: changed when their u is newer than the database's", () => {
    const known = new Map([["c1", 5]]);
    expect(changedComments([{ id: "c1", u: 5 }, { id: "c2", u: 1 }, { id: "c1b", u: 0 }], known).map((comment) => comment.id)).toEqual(["c2", "c1b"]);
  });

  it("settings travel as one key (background, grid, presentation, fonts)", () => {
    expect(settingsKey({ viewBackgroundColor: "#fff" }, undefined)).not.toBe(settingsKey({ viewBackgroundColor: "#000" }, undefined));
    expect(settingsKey({ viewBackgroundColor: "#fff", zoom: 2 }, null)).toBe(settingsKey({ viewBackgroundColor: "#fff" }, undefined));
  });

  it("roles: editors edit, commenters comment, viewers and public visitors view", () => {
    expect(accessOf("owner", false)).toBeNull();
    expect(accessOf("editor", false)).toBeNull();
    expect(accessOf("commenter", false)).toMatchObject({ comment: true });
    expect(accessOf("viewer", false)).toMatchObject({ comment: false, readOnly: expect.stringContaining("view") });
    expect(accessOf(null, true)).toMatchObject({ comment: false });
    expect(accessOf(null, false)?.readOnly).toMatch(/no access/);
  });
});

describe("a scene file in rows and back", () => {
  it("splits elements, pictures and comments off and assembles the same file", () => {
    const file = {
      type: "excalidraw",
      version: 2,
      elements: [el("a", 1), el("b", 1)],
      appState: { viewBackgroundColor: "#eee" },
      files: { f: { id: "f", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 3 } },
      kurviqComments: [{ id: "x" }],
    };
    const parts = splitScene(JSON.stringify(file));
    expect(JSON.parse(parts.envelope)).toEqual({ type: "excalidraw", version: 2, elements: [], appState: { viewBackgroundColor: "#eee" }, files: {}, kurviqComments: [] });
    expect(fileIndex(parts.files)).toEqual({ f: { mimeType: "image/png", created: 3 } });
    expect(JSON.parse(assembleScene(parts.envelope, parts.elements, parts.files, parts.comments))).toEqual(file);
    expect(() => splitScene("[]")).toThrow();
  });

  it("orders elements by position, leaves deleted ones out; a new scene gets a fresh envelope", () => {
    const rows = [
      { id: "b", version: 1, version_nonce: 1, pos: 2, data: el("b", 1) },
      { id: "a", version: 1, version_nonce: 1, pos: 1, data: el("a", 1) },
      { id: "z", version: 2, version_nonce: 1, pos: 3, data: el("z", 2, 1, { isDeleted: true }) },
    ];
    expect(orderedElements(rows).map((element) => element.id)).toEqual(["a", "b"]);
    expect(JSON.parse(assembleScene(null, [], {}, []))).toMatchObject({ type: "excalidraw", elements: [] });
    expect(elementRows([{ id: "q" }])).toEqual([{ id: "q", version: 1, versionNonce: 0, kurviqPos: 1 }]);
  });
});

describe("a database scene changed outside the canvas (an agent's edit)", () => {
  it("only what changed is written: others' elements stay, removed ones are deleted", async () => {
    const { rows, scenes } = fakeSceneRows();
    const scene = await rows.createScene("Plan");
    await rows.putElements(scene.id, [el("mine", 1), el("theirs", 1)]);
    const before = JSON.stringify({ type: "excalidraw", elements: [el("mine", 1), el("gone", 1)], appState: {} });
    await rows.putElements(scene.id, [el("gone", 1)]);
    // someone else changes "theirs" meanwhile; the agent's version doesn't list it
    await rows.putElements(scene.id, [el("theirs", 2)]);
    const after = JSON.stringify({ type: "excalidraw", elements: [el("mine", 1, 1, { x: 5 }), el("new", 1)], appState: { viewBackgroundColor: "#000" } });
    const revision = await writeSceneChanges(rows, scene.id, before, after);
    const stored = scenes.get(scene.id)!;
    expect(revision).toBe(stored.revision);
    expect(stored.elements.get("theirs")!.version).toBe(2); // untouched
    expect(stored.elements.get("mine")!.data).toMatchObject({ x: 5, version: 2 }); // an edit that kept the version gets a newer one
    expect(stored.elements.get("gone")!.data).toMatchObject({ isDeleted: true });
    expect(stored.elements.has("new")).toBe(true);
    expect(JSON.parse(stored.meta!.envelope).appState).toEqual({ viewBackgroundColor: "#000" });
    expect(elementChanges([el("a", 1)], [el("a", 1)])).toEqual([]);
  });

  it("a viewer's write is refused by the database (row-level security)", async () => {
    const owner = fakeSceneRows();
    const scene = await owner.rows.createScene("Plan");
    const viewer = { ...owner.rows, ...fakeSceneRows({ role: "viewer" }).rows, elements: owner.rows.elements, meta: owner.rows.meta, comments: owner.rows.comments };
    await expect(viewer.putElements(scene.id, [el("a", 1)])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("errors", () => {
  it("network failures are offline, a paused project says so, refusals are read only, conflicts carry the revision", () => {
    expect(asHomeError(new TypeError("Failed to fetch"))).toMatchObject({ offline: true });
    expect(asHomeError({ message: "Project paused", status: 540 })).toMatchObject({ offline: true, paused: true, message: PAUSED_MESSAGE });
    expect(asHomeError({ code: "42501", message: 'new row violates row-level security policy for table "x"', status: 403 })).toMatchObject({ status: 403, readOnly: true });
    expect(asHomeError({ code: "P0409", details: "12", message: "changed" })).toMatchObject({ status: 409, remoteVersion: "12" });
    expect(asHomeError({ code: "23505", message: "duplicate" })).toMatchObject({ status: 409, exists: true });
    expect(asHomeError({ code: "P0002", message: "missing" })).toMatchObject({ status: 404 });
    expect(isPausedAnswer(503, "This project is paused")).toBe(true);
    expect(isPausedAnswer(500, "boom")).toBe(false);
  });
});

describe("schema helpers", () => {
  it("the owner's row of a new space, only for an email address", () => {
    expect(ownerSql("Ann@Example.com")).toContain("'ann@example.com', 'owner'");
    expect(() => ownerSql("x'; drop table kurviq_members; --")).toThrow();
    expect(schemaState(1)).toBe("ok");
    expect(schemaState(0)).toBe("old");
    expect(schemaState(null)).toBe("missing");
  });

  it("the SQL file is versioned and only touches Kurviq's own objects", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../src/homes/database/schema.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/kurviq_schema_version\(\) returns integer\s+language sql immutable as \$\$ select 1 \$\$/);
    const tables = [...sql.matchAll(/create table if not exists ([\w.]+)/g)].map((match) => match[1]);
    expect(tables.every((table) => table.startsWith("public.kurviq_"))).toBe(true);
    const policies = [...sql.matchAll(/create policy "([^"]+)"/g)].map((match) => match[1]);
    expect(policies.every((name) => name.startsWith("kurviq: "))).toBe(true);
    // every policy is dropped before it is made (the file runs again safely)
    for (const name of policies) {
      expect(sql).toContain(`drop policy if exists "${name}"`);
    }
  });
});

// connections and setup run in a browser: localStorage, location and crypto are stubbed
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
};
vi.stubGlobal("localStorage", memoryStorage());
vi.stubGlobal("sessionStorage", memoryStorage());

const { cleanProjectUrl, createProbe, isPaused, keyProblem, mailProblem, mergeStored, refOfUrl, sceneLink, takeDatabaseLink, connectionOf } = await import("../src/homes/database/connections");
const { authorizeUrl, managementApi, newDatabasePassword, pkcePair, setUpProject, withKurviqRedirect } = await import("../src/homes/database/oauth");

describe("connections", () => {
  const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload))}.y`;

  it("a project's ref from its address; only publishable / anon keys", () => {
    expect(refOfUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe("abcdefghijklmnopqrst");
    expect(refOfUrl("https://db.example.com")).toMatch(/^h-/);
    expect(cleanProjectUrl(" https://abcdefghijklmnopqrst.supabase.co/rest/v1 ")).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(cleanProjectUrl("http://example.com")).toBeNull();
    expect(cleanProjectUrl("http://localhost:54321")).toBe("http://localhost:54321");
    expect(keyProblem("sb_publishable_abcdefghijklmn")).toBeNull();
    expect(keyProblem("sb_secret_abcdefghijklmn")).toMatch(/secret key/);
    expect(keyProblem(jwt({ role: "anon" }))).toBeNull();
    expect(keyProblem(jwt({ role: "service_role" }))).toMatch(/service role/);
    expect(keyProblem("hello")).toMatch(/publishable/);
  });

  it("a scene's link carries the public key in the # part only", () => {
    const link = sceneLink({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_publishable_k", name: "Team", addedAt: "" }, "00000000-0000-4000-8000-000000000001", "https://kurviq.com");
    expect(link).toBe("https://kurviq.com/db/abcdefghijklmnopqrst/00000000-0000-4000-8000-000000000001#k=sb_publishable_k");
    const selfHosted = sceneLink({ ref: "h-1", url: "https://db.example.com", key: "sb_publishable_k", name: "Team", addedAt: "" }, "id", "https://kurviq.com");
    expect(new URLSearchParams(selfHosted.split("#")[1]).get("u")).toBe("https://db.example.com");
  });

  it("a link opened: its connection is added from the # part (and an email link's tokens are not kept in the URL)", async () => {
    const link = await takeDatabaseLink({ pathname: "/db/abcdefghijklmnopqrst/00000000-0000-4000-8000-000000000001", hash: "#k=sb_publishable_abcdefghijklmn#error_description=Email+link+is+invalid" });
    expect(link).toEqual({ ref: "abcdefghijklmnopqrst", sceneId: "00000000-0000-4000-8000-000000000001", known: true, error: "Email link is invalid" });
    expect(connectionOf("abcdefghijklmnopqrst")).toMatchObject({ url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_publishable_abcdefghijklmn" });
    expect(await takeDatabaseLink({ pathname: "/Plan", hash: "" })).toBeNull();
    // a secret key in a link is never taken
    expect((await takeDatabaseLink({ pathname: "/db/zzzzzzzzzzzzzzzzzzzz", hash: "#k=sb_secret_abcdefghijklmn" }))?.known).toBe(false);
  });

  it("the lists of two browsers merge: newer entries win, a removal wins over older entries", () => {
    const a = { ref: "aaa", url: "https://a", key: "k", name: "A", addedAt: "2026-11-01" };
    const b = { ref: "bbb", url: "https://b", key: "k", name: "B", addedAt: "2026-11-02" };
    const merged = mergeStored({ connections: [a], removed: { bbb: "2026-11-03" } }, { connections: [b, { ...a, name: "A2", addedAt: "2026-11-05" }], removed: {} });
    expect(merged.connections).toEqual([{ ...a, name: "A2", addedAt: "2026-11-05" }]);
    expect(merged.removed).toEqual({ bbb: "2026-11-03" });
    expect(mergeStored({ connections: [], removed: { bbb: "2026-11-01" } }, { connections: [b], removed: {} }).connections).toEqual([b]);
  });

  it("the mail limit in words", () => {
    expect(mailProblem({ status: 429, message: "email rate limit exceeded" })).toMatch(/hourly limit/);
    expect(mailProblem({ message: "boom" })).toBe("boom");
  });

  it("a project to connect is checked first: Kurviq's tables there, missing, paused, unreachable", async () => {
    const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));
    expect(await createProbe({ url: "https://p", key: "k" }, answer(200, "1"))).toBe("ok");
    expect(await createProbe({ url: "https://p", key: "k" }, answer(404, '{"code":"PGRST202"}'))).toBe("missing");
    expect(await createProbe({ url: "https://p", key: "k" }, answer(540, "Project paused"))).toBe("paused");
    vi.stubGlobal("location", { origin: "https://kurviq.com" });
    const down = vi.fn(async (url: string) => {
      if (url.startsWith("https://kurviq.com")) {
        return new Response("", { status: 200 });
      }
      throw new TypeError("Failed to fetch");
    });
    expect(await createProbe({ url: "https://p", key: "k" }, down as any)).toBe("paused");
    expect(await isPaused("https://p", vi.fn(async () => Promise.reject(new TypeError("offline"))) as any)).toBe(false);
  });
});

describe("Connect with Supabase (setup)", () => {
  it("PKCE: a verifier and its S256 challenge; the consent page's address", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const expected = btoa(String.fromCodePoint(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
    const url = new URL(authorizeUrl("state1", challenge, "https://kurviq.com"));
    expect(url.origin + url.pathname).toBe("https://api.supabase.com/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "c1e84319-0be9-44e0-8967-88ac83fc4c20", redirect_uri: "https://kurviq.com/auth/supabase/callback", code_challenge_method: "S256", state: "state1" });
  });

  it("a strong password, Kurviq's address added to the sign-in links once", () => {
    expect(newDatabasePassword()).toMatch(/^[A-Za-z2-9]{24}$/);
    expect(withKurviqRedirect("https://a.test/**", "https://kurviq.com")).toBe("https://a.test/**,https://kurviq.com/**");
    expect(withKurviqRedirect("https://kurviq.com/**", "https://kurviq.com")).toBeNull();
  });

  it("sets up a project through the Worker's Management API pass-through: schema, owner, sign-in addresses, the public key", async () => {
    const calls: { method: string; path: string; body?: any }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/api/supabase/v1", "");
      calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mgmt-token");
      if (path.includes("api-keys")) {
        return Response.json([{ name: "anon", type: "legacy", api_key: "eyJ.legacy" }, { name: "default", type: "publishable", api_key: "sb_publishable_x" }]);
      }
      if (path.endsWith("/config/auth") && init.method === "GET") {
        return Response.json({ site_url: "http://localhost:3000", uri_allow_list: "" });
      }
      return Response.json([]);
    });
    const api = managementApi("mgmt-token", fetcher as any);
    const result = await setUpProject(api, "abcdefghijklmnopqrst", "owner@example.com", "https://kurviq.com");
    expect(result).toEqual({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_publishable_x" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /projects/abcdefghijklmnopqrst/database/query",
      "POST /projects/abcdefghijklmnopqrst/database/query",
      "GET /projects/abcdefghijklmnopqrst/config/auth",
      "PATCH /projects/abcdefghijklmnopqrst/config/auth",
      "GET /projects/abcdefghijklmnopqrst/api-keys?reveal=false",
    ]);
    expect(calls[0].body.query).toContain("create table if not exists public.kurviq_scenes");
    expect(calls[1].body.query).toContain("'owner@example.com', 'owner'");
    expect(calls[3].body).toEqual({ uri_allow_list: "https://kurviq.com/**", site_url: "https://kurviq.com" });
    // nothing of it is stored in the browser
    expect(JSON.stringify([localStorage, sessionStorage])).not.toContain("mgmt-token");
  });
});

describe("the Worker's Supabase routes (stateless)", () => {
  const env = { SUPABASE_CLIENT_SECRET: "the-secret", ASSETS: { fetch: vi.fn(async () => new Response("<html>app</html>")) } as any };
  const post = (path: string, body: unknown, origin = "https://kurviq.com") =>
    handleSupabase(new Request(`https://kurviq.com${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);

  it("exchanges the code with the client secret (Basic auth, PKCE verifier) and passes only the access token on", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "mgmt", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" }));
    const verifier = "v".repeat(43);
    const res = (await post("/api/supabase/token", { code: "the-code", codeVerifier: verifier }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ accessToken: "mgmt", expiresIn: 3600 });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.supabase.com/v1/oauth/token");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("c1e84319-0be9-44e0-8967-88ac83fc4c20:the-secret")}`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: verifier,
      redirect_uri: "https://kurviq.com/auth/supabase/callback",
    });
    // no cookie, nothing else set
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses other sites, bad input, and a missing secret; Supabase's refusal is passed on", async () => {
    expect((await post("/api/supabase/token", { code: "c", codeVerifier: "v".repeat(43) }, "https://evil.test"))!.status).toBe(403);
    expect((await post("/api/supabase/token", { code: "c", codeVerifier: "short" }))!.status).toBe(400);
    const noSecret = await handleSupabase(new Request("https://kurviq.com/api/supabase/token", { method: "POST", headers: { Origin: "https://kurviq.com" }, body: "{}" }), { ASSETS: env.ASSETS });
    expect(noSecret!.status).toBe(503);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "code expired" }, { status: 400 }));
    const refused = (await post("/api/supabase/token", { code: "c", codeVerifier: "v".repeat(43) }))!;
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/code expired/);
  });

  it("passes the setup's Management API calls through (only those), without secret keys", async () => {
    expect(allowedCall("POST", "/v1/projects/abcdefghijklmnopqrst/database/query")).toBe(true);
    expect(allowedCall("DELETE", "/v1/projects/abcdefghijklmnopqrst")).toBe(false);
    expect(allowedCall("GET", "/v1/projects/abcdefghijklmnopqrst/secrets")).toBe(false);
    expect(publicKeysOnly([{ name: "anon", type: "legacy" }, { name: "service_role", type: "legacy" }, { type: "secret", name: "default" }, { type: "publishable", name: "default" }])).toEqual([
      { name: "anon", type: "legacy" },
      { type: "publishable", name: "default" },
    ]);
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([{ type: "secret", api_key: "sb_secret_x" }, { type: "publishable", api_key: "sb_publishable_x" }]));
    const res = (await handleSupabase(
      new Request("https://kurviq.com/api/supabase/v1/projects/abcdefghijklmnopqrst/api-keys?reveal=false", { headers: { Origin: "https://kurviq.com", Authorization: "Bearer mgmt-token-123" } }),
      env,
    ))!;
    expect(await res.json()).toEqual([{ type: "publishable", api_key: "sb_publishable_x" }]);
    expect(upstream.mock.calls[0][0]).toBe("https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/api-keys?reveal=false");
    const other = await handleSupabase(new Request("https://kurviq.com/api/supabase/v1/projects/abcdefghijklmnopqrst/secrets", { headers: { Origin: "https://kurviq.com", Authorization: "Bearer mgmt-token-123" } }), env);
    expect(other!.status).toBe(404);
  });

  it("the OAuth callback is the app's page; other paths are not its routes", async () => {
    const page = await handleSupabase(new Request("https://kurviq.com/auth/supabase/callback?code=x&state=y"), env);
    expect(await page!.text()).toContain("app");
    expect(await handleSupabase(new Request("https://kurviq.com/auth/login"), env)).toBeNull();
  });
});
