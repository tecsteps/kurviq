// Sign out everywhere (online/worker/sceneRoutes.ts, account.ts, auth.ts):
// Kurviq is revoked at Google within the request (a few tries), and the
// refresh token is never kept for a later try, not even sealed. If Google
// can't be reached, the person is told how to remove Kurviq's access.
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { AccountGuard } from "../../online/worker/account";
import { revokeAtGoogleNow, sealLocalSession } from "../../online/worker/auth";
import { GOOGLE_PERMISSIONS_URL, handleSceneRoutes, logoutAllAnswer } from "../../online/worker/sceneRoutes";

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const authEnv = () => ({ GOOGLE_CLIENT_SECRET: "secret", COOKIE_KEY: key() });

/** Google's revoke endpoint: answers in turn (a status, or "down" for a network error) */
const google = (...answers: (number | "down")[]) => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
    calls.push(String(init?.body ?? ""));
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === "down") {
      throw new TypeError("fetch failed");
    }
    return new Response("", { status: next });
  });
  return calls;
};

/** the account guard's SQLite (ctx.storage) on node:sqlite */
const fakeAccountCtx = (db = new DatabaseSync(":memory:")) => {
  let alarm: number | null = null;
  return {
    db,
    ctx: {
      storage: {
        sql: {
          exec: (query: string, ...bindings: unknown[]) => {
            if (/;\s*\S/.test(query)) {
              db.exec(query); // several statements (the schema)
              return { toArray: () => [] };
            }
            const rows = db.prepare(query).all(...(bindings as any[]));
            return { toArray: () => rows };
          },
        },
        transactionSync: (run: () => void) => run(),
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
      },
    },
  };
};

const metaKeys = (db: DatabaseSync) => (db.prepare("SELECT k FROM meta ORDER BY k").all() as any[]).map((row) => String(row.k));

afterEach(() => vi.restoreAllMocks());

describe("the revocation at Google", () => {
  it("is tried again within the request when Google doesn't answer", async () => {
    const calls = google("down", 503, 200);
    expect(await revokeAtGoogleNow(authEnv(), "refresh-1", [0, 0])).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("token=refresh-1");
  });

  it("an already revoked token counts as revoked", async () => {
    const calls = google(400);
    expect(await revokeAtGoogleNow(authEnv(), "refresh-1", [0, 0])).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the last try (nothing is kept for later)", async () => {
    const calls = google("down");
    expect(await revokeAtGoogleNow(authEnv(), "refresh-1", [0, 0])).toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe("the answer of sign out everywhere", () => {
  it("says plainly what to do when Google couldn't be reached", () => {
    const failed = logoutAllAnswer(false, 2);
    expect(failed).toMatchObject({ ok: false, revokedAtGoogle: false, scenes: 2, removeAccess: GOOGLE_PERMISSIONS_URL });
    expect(failed.message).toContain("Google couldn't be reached");
    expect(failed.message).toContain("https://myaccount.google.com/permissions");
    expect(logoutAllAnswer(true, 0)).toEqual({ ok: true, revokedAtGoogle: true, scenes: 0 });
  });
});

describe("the account guard", () => {
  it("never stores a token, even if one is sent", async () => {
    const fake = fakeAccountCtx();
    const guard = new AccountGuard(fake.ctx as any, {} as any);
    const res = await guard.fetch(
      new Request("https://account/logout-all", { method: "POST", body: JSON.stringify({ sub: "sub-1", retryRevoke: "kid.1.iv.sealed" }) }),
    );
    expect(res.status).toBe(200);
    expect(metaKeys(fake.db)).toEqual(["epoch", "sub"]);
    expect(JSON.stringify(fake.db.prepare("SELECT * FROM meta").all())).not.toContain("sealed");
  });

  it("drops a sealed token an older version kept for a later revocation (migration)", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID");
    db.prepare("INSERT INTO meta (k, v) VALUES ('revoke', 'kid.1.iv.sealed'), ('epoch', '5'), ('sub', 'sub-1')").run();
    const fake = fakeAccountCtx(db);
    const guard = new AccountGuard(fake.ctx as any, {} as any);
    expect(metaKeys(db)).toEqual(["epoch", "sub"]);
    expect(await (await guard.fetch(new Request("https://account/epoch"))).json()).toEqual({ epoch: 5 });
  });
});

describe("POST /auth/logout-all", () => {
  const route = async (googleAnswers: (number | "down")[]) => {
    const env: any = authEnv();
    const toAccount: any[] = [];
    env.ACCOUNT = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: any) => {
          toAccount.push(JSON.parse(init.body));
          return Response.json({ epoch: 7, scenes: [] });
        },
      }),
    };
    env.SCENE = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) };
    env.RELAY = {};
    const session = await sealLocalSession(env, {
      a: "access",
      ae: Date.now() + 3_600_000,
      r: "refresh-secret",
      user: { email: "a@example.test", name: "A" } as any,
      drive: true,
      sub: "sub-1",
      iat: 1,
    });
    const calls = google(...googleAnswers);
    const res = (await handleSceneRoutes(
      new Request("https://kurviq.com/auth/logout-all", {
        method: "POST",
        headers: { Origin: "http://draw.test", "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
      }),
      env,
    ))!;
    return { res, body: await res.json(), toAccount, calls };
  };

  it("Google unreachable: signed out everywhere anyway, told how to remove the access, the token not passed on", async () => {
    const { res, body, toAccount, calls } = await route(["down"]);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(body).toMatchObject({ ok: false, revokedAtGoogle: false, removeAccess: GOOGLE_PERMISSIONS_URL });
    expect(toAccount).toEqual([{ sub: "sub-1" }]);
    expect(JSON.stringify(toAccount)).not.toContain("refresh-secret");
  });

  it("Google answers: revoked, no further note", async () => {
    const { body, toAccount, calls } = await route([200]);
    expect(calls).toHaveLength(1);
    expect(body).toEqual({ ok: true, revokedAtGoogle: true, scenes: 0 });
    expect(toAccount).toEqual([{ sub: "sub-1" }]);
  });
});
