import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pubNameFromPath,
  pubNameProblem,
  toPubName,
} from "../src/online/pubName";
import { handlePubApi } from "../../online/worker/pubLinks";

describe("short names", () => {
  it("accepts and refuses names", () => {
    expect(pubNameProblem("oredev")).toBeNull();
    expect(pubNameProblem("my-talk-2026")).toBeNull();
    expect(pubNameProblem("ab")).toMatch(/At least/);
    expect(pubNameProblem("a".repeat(41))).toMatch(/At most/);
    expect(pubNameProblem("Oredev")).toMatch(/lowercase/);
    expect(pubNameProblem("my talk")).toMatch(/lowercase/);
    expect(pubNameProblem("-talk")).toMatch(/Hyphens/);
    expect(pubNameProblem("my--talk")).toMatch(/Hyphens/);
    expect(pubNameProblem("admin")).toMatch(/reserved/);
    expect(pubNameProblem("kurviq-team")).toMatch(/reserved/);
  });

  it("makes a name from a scene name", () => {
    expect(toPubName("Öredev 2026: The Talk!")).toBe("oredev-2026-the-talk");
    expect(toPubName("  --Hi--  ")).toBe("hi");
  });

  it("reads /pub/<name>", () => {
    expect(pubNameFromPath("/pub/Oredev")).toBe("oredev");
    expect(pubNameFromPath("/pub/oredev/")).toBe("oredev");
    expect(pubNameFromPath("/pub/a/b")).toBeNull();
    expect(pubNameFromPath("/s/oredev")).toBeNull();
  });
});

/** D1 on node:sqlite (prepare / bind / first / run / batch as a transaction) */
const fakeD1 = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE pub_links (name TEXT PRIMARY KEY, file_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
  );
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () =>
      (db.prepare(sql).get(...(values as any[])) as any) ?? null,
    run: async () => db.prepare(sql).run(...(values as any[])),
    exec: () => db.prepare(sql).run(...(values as any[])),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      db.exec("BEGIN");
      try {
        statements.forEach((item) => item.exec());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
};

const ORIGIN = "https://kurviq.com";
const FILE_A = "fileAAAAAAAAAAAA";
const FILE_B = "fileBBBBBBBBBBBB";

/** Drive: token "token-edit-a" may edit file A, "token-edit-b" file B */
const driveAnswers = () =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: any, init: any) => {
      const url = String(input);
      const token = String(init?.headers?.Authorization ?? "").replace(
        "Bearer ",
        ""
      );
      const fileId = url.match(/\/files\/([^?]+)/)?.[1];
      const mayEdit =
        (token === "token-edit-a" && fileId === FILE_A) ||
        (token === "token-edit-b" && fileId === FILE_B);
      return new Response(
        JSON.stringify({
          id: fileId,
          trashed: false,
          capabilities: { canEdit: mayEdit },
        }),
        { status: 200 }
      );
    });

const call = async (
  env: any,
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {}
) => {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await handlePubApi(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env
  );
  return { status: res!.status, body: await res!.json() };
};

describe("short link API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("claims, looks up, keeps names unique, renames and frees", async () => {
    driveAnswers();
    const env = { FEEDBACK: fakeD1() };
    expect((await call(env, "GET", "/api/pub/oredev")).status).toBe(404);

    // no token, no access, invalid
    expect(
      (
        await call(env, "POST", "/api/pub", {
          body: { fileId: FILE_A, name: "oredev" },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await call(env, "POST", "/api/pub", {
          token: "token-edit-b",
          body: { fileId: FILE_A, name: "oredev" },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(env, "POST", "/api/pub", {
          token: "token-edit-a",
          body: { fileId: FILE_A, name: "Ore dev" },
        })
      ).status
    ).toBe(400);

    expect(
      await call(env, "POST", "/api/pub", {
        token: "token-edit-a",
        body: { fileId: FILE_A, name: "oredev" },
      })
    ).toEqual({ status: 200, body: { name: "oredev" } });
    expect((await call(env, "GET", "/api/pub/OREDEV")).body).toEqual({
      fileId: FILE_A,
    });
    expect((await call(env, "GET", `/api/pub?file=${FILE_A}`)).body).toEqual({
      name: "oredev",
    });

    // taken by another scene
    const taken = await call(env, "POST", "/api/pub", {
      token: "token-edit-b",
      body: { fileId: FILE_B, name: "oredev" },
    });
    expect(taken.status).toBe(409);

    // a new name for the same scene frees the old one
    expect(
      (
        await call(env, "POST", "/api/pub", {
          token: "token-edit-a",
          body: { fileId: FILE_A, name: "my-talk" },
        })
      ).status
    ).toBe(200);
    expect((await call(env, "GET", "/api/pub/oredev")).status).toBe(404);
    expect(
      (
        await call(env, "POST", "/api/pub", {
          token: "token-edit-b",
          body: { fileId: FILE_B, name: "oredev" },
        })
      ).status
    ).toBe(200);

    // only an editor of its scene frees a name
    expect(
      (await call(env, "DELETE", "/api/pub/my-talk", { token: "token-edit-b" }))
        .status
    ).toBe(403);
    expect(
      (await call(env, "DELETE", "/api/pub/my-talk", { token: "token-edit-a" }))
        .status
    ).toBe(200);
    expect((await call(env, "GET", `/api/pub?file=${FILE_A}`)).body).toEqual({
      name: null,
    });
  });

  it("refuses changes from other sites", async () => {
    driveAnswers();
    const env = { FEEDBACK: fakeD1() };
    const res = await handlePubApi(
      new Request(`${ORIGIN}/api/pub`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          Authorization: "Bearer token-edit-a",
        },
        body: JSON.stringify({ fileId: FILE_A, name: "oredev" }),
      }),
      env as any
    );
    expect(res!.status).toBe(403);
  });
});

describe("short link failure boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([3, 40])("accepts a name of length %i", (length) => {
    expect(pubNameProblem("x".repeat(length))).toBeNull();
  });
  it.each([
    [401, 401],
    [429, 503],
    [500, 503],
    [503, 503],
  ])("maps Google %i to %i without claiming", async (google, status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: google })
    );
    const env = { FEEDBACK: fakeD1() };
    const response = await call(env, "POST", "/api/pub", {
      token: "token-edit-a", body: { fileId: FILE_A, name: "oredev" },
    });
    expect(response.status).toBe(status);
    if (status === 503) expect(response.body.error).toMatch(/try again in a moment/);
    expect((await call(env, "GET", "/api/pub/oredev")).status).toBe(404);
  });
  it("refuses a trashed file even if it is editable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ trashed: true, capabilities: { canEdit: true } })
      )
    );
    expect(
      (
        await call({ FEEDBACK: fakeD1() }, "POST", "/api/pub", {
          token: "token-edit-a",
          body: { fileId: FILE_A, name: "oredev" },
        })
      ).status
    ).toBe(403);
  });
  it.each([
    ["{", 400],
    ["x".repeat(2001), 413],
  ])("refuses malformed or oversized JSON", async (body, status) => {
    const fetch = driveAnswers();
    const response = await handlePubApi(
      new Request(`${ORIGIN}/api/pub`, {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer token-edit-a" },
        body: String(body),
      }),
      { FEEDBACK: fakeD1() } as any
    );
    expect(response!.status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("concurrent claims have one winner and preserve the loser's old name", async () => {
    driveAnswers();
    const env = { FEEDBACK: fakeD1() };
    for (const [fileId, token, name] of [
      [FILE_A, "token-edit-a", "first-name"],
      [FILE_B, "token-edit-b", "second-name"],
    ]) {
      expect(
        (await call(env, "POST", "/api/pub", { token, body: { fileId, name } }))
          .status
      ).toBe(200);
    }
    const results = await Promise.all(
      [
        [FILE_A, "token-edit-a"],
        [FILE_B, "token-edit-b"],
      ].map(([fileId, token]) =>
        call(env, "POST", "/api/pub", {
          token,
          body: { fileId, name: "contested" },
        })
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results[0].status === 409 ? FILE_A : FILE_B;
    expect((await call(env, "GET", `/api/pub?file=${loser}`)).body).toEqual({
      name: loser === FILE_A ? "first-name" : "second-name",
    });
  });
});

describe("repeated claim authorization", () => {
  afterEach(() => vi.restoreAllMocks());
  it("requires edit access even for a name the file already holds", async () => {
    const drive = driveAnswers();
    const env = { FEEDBACK: fakeD1() };
    const body = { fileId: FILE_A, name: "oredev" };
    expect((await call(env, "POST", "/api/pub", { token: "token-edit-a", body })).status).toBe(200);
    expect((await call(env, "POST", "/api/pub", { token: "token-edit-b", body })).status).toBe(403);
    expect((await call(env, "GET", "/api/pub/oredev")).body).toEqual({ fileId: FILE_A });
    expect((await call(env, "POST", "/api/pub", { token: "token-edit-a", body })).status).toBe(200);
    drive.mockResolvedValue(new Response("{}", { status: 401 }));
    expect((await call(env, "POST", "/api/pub", { token: "token-edit-a", body })).status).toBe(401);
    drive.mockResolvedValue(new Response("{}", { status: 429 }));
    expect((await call(env, "POST", "/api/pub", { token: "token-edit-a", body })).status).toBe(503);
    expect((await call(env, "GET", "/api/pub/oredev")).body).toEqual({ fileId: FILE_A });
  });
});
