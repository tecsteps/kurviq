// The Worker's routes that are plain request → response (online/worker):
// the local install's sign-in, agent sign-in codes, feedback quotas, short
// links of binned scenes, and the shared helpers they use.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuth, seal, unseal } from "../../online/worker/auth";
import { readBytes } from "../../online/worker/bytes";
import { resetSchemaForTests } from "../../online/worker/database";
import { saveFeedback, senderKey } from "../../online/worker/feedback";
import { handleOAuth, redirectMatches } from "../../online/worker/oauth";
import { isDevOrigin, isLocalInstall } from "../../online/worker/origins";
import { handlePubApi } from "../../online/worker/pubLinks";

import { fakeD1 } from "./fakeD1";

const ORIGIN = "https://kurviq.com";
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const authEnv = () => ({ GOOGLE_CLIENT_SECRET: "secret", COOKIE_KEY: key() });

beforeEach(() => resetSchemaForTests());
afterEach(() => vi.restoreAllMocks());

describe("origins", () => {
  it("tells a dev server from the local install", () => {
    expect(isDevOrigin("http://localhost:8787")).toBe(true);
    expect(isDevOrigin("http://127.0.0.1:3001")).toBe(true);
    expect(isDevOrigin("http://draw.test")).toBe(false);
    expect(isDevOrigin("https://kurviq.com")).toBe(false);
    expect(isLocalInstall("http://draw.test")).toBe(true);
    expect(isLocalInstall("http://localhost:3001")).toBe(true);
    expect(isLocalInstall("https://kurviq.com")).toBe(false);
    expect(isLocalInstall("javascript://localhost")).toBe(false);
  });
});

describe("bounded body reader", () => {
  it("reads up to the limit and stops beyond it", async () => {
    const body = (text: string) => new Response(text).body;
    expect(new TextDecoder().decode((await readBytes(body("hello"), 5))!)).toBe("hello");
    expect(await readBytes(body("hello!"), 5)).toBeNull();
    expect((await readBytes(null, 5))!).toHaveLength(0);
  });
});

describe("local install sign-in", () => {
  const login = (env: any, query: string, init: RequestInit = {}) =>
    handleAuth(new Request(`${ORIGIN}/auth/login?${query}`, init), env);

  it("goes to Google at once for a loopback address", async () => {
    const res = (await login(authEnv(), `return=${encodeURIComponent("http://localhost:3001/plan")}`))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it("asks first for a *.test address, and only Kurviq's own page can confirm", async () => {
    const env = authEnv();
    const query = `return=${encodeURIComponent("http://draw.test/plan")}&state=${"s".repeat(20)}`;
    const ask = (await login(env, query))!;
    expect(ask.status).toBe(200);
    const html = await ask.text();
    expect(html).toContain("http://draw.test");
    expect(html).toContain('action="/auth/login"');
    expect(html).toContain('name="return" value="http://draw.test/plan"');

    const form = { method: "POST", body: new URLSearchParams({ return: "http://draw.test/plan", state: "s".repeat(20) }) };
    const fromElsewhere = (await handleAuth(new Request(`${ORIGIN}/auth/login`, { ...form, headers: { Origin: "https://evil.example" } }), env))!;
    expect(fromElsewhere.status).toBe(403);
    const confirmed = (await handleAuth(new Request(`${ORIGIN}/auth/login`, { ...form, headers: { Origin: ORIGIN } }), env))!;
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get("Location")).toMatch(/^https:\/\/accounts\.google\.com\//);
  });
});

describe("COOKIE_KEY rotation", () => {
  it("still opens what the previous key sealed", async () => {
    const old = { ...authEnv() };
    const sealed = await seal(old, { a: 1 }, "test");
    const rotated = { ...old, COOKIE_KEY: key(), COOKIE_KEY_PREVIOUS: old.COOKIE_KEY };
    expect(await unseal(rotated, sealed, "test")).toEqual({ a: 1 });
    expect(await unseal({ ...rotated, COOKIE_KEY_PREVIOUS: undefined }, sealed, "test")).toBeNull();
    expect(await unseal(rotated, sealed, "other purpose")).toBeNull();
  });
});

describe("agent sign-in (OAuth)", () => {
  const REDIRECT = "http://localhost:1234/callback";

  it("matches loopback redirects on any port, only over http", () => {
    expect(redirectMatches([REDIRECT], "http://localhost:5678/callback")).toBe(true);
    expect(redirectMatches([REDIRECT], "javascript://localhost:5678/callback")).toBe(false);
    expect(redirectMatches([REDIRECT], "https://localhost:5678/callback")).toBe(false);
    expect(redirectMatches([REDIRECT], "ftp://localhost:1234/callback")).toBe(false);
    expect(redirectMatches([REDIRECT], "http://user:pw@localhost:1234/callback")).toBe(false);
    expect(redirectMatches([REDIRECT], "http://localhost:1234/callback#x")).toBe(false);
  });

  /** the pairing's Durable Object, as far as code redemption goes */
  const pairings = () => {
    const used = new Set<string>();
    return {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const { id } = JSON.parse(String(init.body));
          const first = !used.has(id);
          used.add(id);
          return new Response(null, { status: first ? 200 : 409 });
        },
      }),
    };
  };

  it("redeems a code once", async () => {
    const env: any = { ...authEnv(), PAIRING: pairings() };
    const call = (path: string, init: RequestInit) => handleOAuth(new Request(`${ORIGIN}${path}`, init), env).then((res) => res!);
    const registered = await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test" }) })).json();
    const verifier = "v".repeat(50);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const approved = await (
      await call("/oauth/approve", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: registered.client_id, redirect_uri: REDIRECT, key: "k".repeat(32), code_challenge: challenge }),
      })
    ).json();
    const code = new URL(approved.redirect).searchParams.get("code")!;
    const exchange = () =>
      call("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
      });
    const first = await exchange();
    expect(first.status).toBe(200);
    expect((await first.json()).access_token).toBeTruthy();
    const second = await exchange();
    expect(second.status).toBe(400);
    expect((await second.json()).error_description).toMatch(/used already/);
  });

  it("refuses to approve a presented address of another scheme", async () => {
    const env: any = { ...authEnv(), PAIRING: pairings() };
    const call = (path: string, init: RequestInit) => handleOAuth(new Request(`${ORIGIN}${path}`, init), env).then((res) => res!);
    const registered = await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
    const res = await call("/oauth/approve", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: registered.client_id, redirect_uri: "javascript://localhost/%0Aalert(1)//", key: "k".repeat(32), code_challenge: "c" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("feedback", () => {
  it("keys IPv6 senders by their /64, also when compressed", () => {
    expect(senderKey("2001:db8::1:2")).toBe("2001:db8:0:0::/64");
    expect(senderKey("2001:db8:0:0:1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(senderKey("2001:db8:a:b::1")).toBe("2001:db8:a:b::/64");
    expect(senderKey("::1")).toBe("0:0:0:0::/64");
    expect(senderKey("203.0.113.9")).toBe("203.0.113.9");
    expect(senderKey("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
  });

  it("stores at most 10 reports per sender and hour, also when sent in parallel", async () => {
    const env = { FEEDBACK: fakeD1(), COOKIE_KEY: key() };
    const report = { kind: "bug", title: "The export button breaks", text: "Open a deck, press PDF, nothing happens at all in the app." };
    const results = await Promise.all(Array.from({ length: 14 }, () => saveFeedback(env, report, { source: "app", sender: "s1" })));
    expect(results.filter((result) => "id" in result)).toHaveLength(10);
    expect(results.filter((result) => "status" in result && result.status === 429)).toHaveLength(4);
    expect("id" in (await saveFeedback(env, report, { source: "app", sender: "s2" }))).toBe(true);
  });
});

describe("short links of binned scenes", () => {
  const FILE = "fileAAAAAAAAAAAA";
  const drive = (answer: Record<string, unknown>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ id: FILE, ...answer }), { status: 200 }));
  const call = (env: any, method: string, path: string) =>
    handlePubApi(new Request(`${ORIGIN}${path}`, { method, headers: { Origin: ORIGIN, Authorization: "Bearer token-of-owner" } }), env).then((res) => res!);

  it("lets the owner free the name of a scene in the bin", async () => {
    const env = { FEEDBACK: fakeD1() };
    env.FEEDBACK.sqlite.exec("CREATE TABLE IF NOT EXISTS pub_links (name TEXT PRIMARY KEY, file_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
    env.FEEDBACK.sqlite.prepare("INSERT INTO pub_links VALUES (?, ?, ?)").run("talk", FILE, new Date().toISOString());
    drive({ trashed: true, ownedByMe: false, capabilities: { canEdit: false } });
    expect((await call(env, "DELETE", "/api/pub/talk")).status).toBe(403);
    drive({ trashed: true, ownedByMe: true, capabilities: { canEdit: false } });
    expect((await call(env, "DELETE", "/api/pub/talk")).status).toBe(200);
    expect((await call(env, "GET", "/api/pub/talk")).status).toBe(404);
  });

  it("answers 400 for malformed percent-encoding", async () => {
    const env = { FEEDBACK: fakeD1() };
    expect((await call(env, "GET", "/api/pub/%E0%A4%A")).status).toBe(400);
  });
});
