// The tab's scenes API (online/tabServer.ts): the version names on the wire.
// New names: ?md5=, X-Base-Md5, X-Scene-Md5, md5 / driveRevision / remoteMd5.
// Pre-rename MCP servers still send ?sha= / X-Base-Sha and read X-Scene-Sha,
// sha / commit / remoteSha: both must keep working.
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

const mode = vi.hoisted(() => ({ active: true, live: false }));
const calls: { load: unknown[][]; save: unknown[][]; remove: unknown[][] } = {
  load: [],
  save: [],
  remove: [],
};

vi.mock("../src/leanFiles", () => ({ leanScene: (scene: unknown) => scene }));
vi.mock("../src/controller", () => ({
  scenesController: {
    liveFileId: () => (mode.live ? "live-file" : null),
    liveSessionFor: async () => ({
      flushNow: async () => {},
      snapshot: () => ({ json: '{"elements":[]}', revision: "live-1" }),
    }),
    rememberLiveRevision: async () => {},
    liveWrite: async (...args: unknown[]) => {
      calls.save.push(args);
      return { md5: A };
    },
    remove: async (...args: unknown[]) => {
      calls.remove.push(args);
    },
    syncNow: () => {},
    liveAgentVersion: async () => null,
  },
}));
vi.mock("../src/online/drive", () => ({
  connection: { isActive: () => mode.active },
  driveScenes: {
    liveFileOf: async () => null,
    load: async (...args: unknown[]) => {
      calls.load.push(args);
      return { json: '{"elements":[]}', md5: (args[1] as string) || A };
    },
    save: async (...args: unknown[]) => {
      calls.save.push(args);
      if (args[2] === B) {
        throw Object.assign(new Error("changed in the meantime"), {
          status: 409,
          remoteMd5: A,
        });
      }
      return { md5: A, driveRevision: "rev-1", changed: true };
    },
    remove: async (...args: unknown[]) => {
      calls.remove.push(args);
      return { md5: null };
    },
    rename: async () => ({ md5: A, driveRevision: null }),
    agentVersion: async () => ({
      md5: B,
      driveRevision: "rev-0",
      at: "2026-11-01T00:00:00Z",
    }),
  },
}));

const { serveRequest } = await import("../src/online/tabServer");

const mcp = { "x-scenes-client": "mcp", "x-scenes-source": "agent" };

beforeEach(() => {
  mode.active = true;
  mode.live = false;
  calls.load = [];
  calls.save = [];
  calls.remove = [];
});

describe("tab scenes API: version names", () => {
  it("GET answers with X-Scene-Md5 and the old X-Scene-Sha", async () => {
    const answer = await serveRequest({
      method: "GET",
      path: "/api/scenes/plan",
    });
    expect(answer.status).toBe(200);
    expect(answer.headers?.["X-Scene-Md5"]).toBe(A);
    expect(answer.headers?.["X-Scene-Sha"]).toBe(A);
  });

  it("GET of a version: ?md5= and the old ?sha=", async () => {
    await serveRequest({ method: "GET", path: `/api/scenes/plan?md5=${B}` });
    await serveRequest({
      method: "GET",
      path: `/api/scenes/plan?sha=${B}&lean=1`,
    });
    expect(calls.load.map((args) => args[1])).toEqual([B, B]);
  });

  it("PUT: X-Base-Md5 and the old X-Base-Sha; the answer has md5 / driveRevision and sha / commit", async () => {
    const fresh = await serveRequest({
      method: "PUT",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-md5": "none" },
      body: "{}",
    });
    const old = await serveRequest({
      method: "PUT",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-sha": A },
      body: "{}",
    });
    expect(calls.save.map((args) => args[2])).toEqual(["none", A]);
    for (const answer of [fresh, old]) {
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({
        name: "plan",
        md5: A,
        driveRevision: "rev-1",
        sha: A,
        commit: "rev-1",
        changed: true,
      });
    }
  });

  it("a bad base version is refused, under either header name", async () => {
    for (const header of ["x-base-md5", "x-base-sha"]) {
      const answer = await serveRequest({
        method: "PUT",
        path: "/api/scenes/plan",
        headers: { ...mcp, [header]: "nope" },
        body: "{}",
      });
      expect(answer.status).toBe(400);
    }
    expect(calls.save).toEqual([]);
  });

  it("409: remoteMd5 and the old remoteSha", async () => {
    const answer = await serveRequest({
      method: "PUT",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-md5": B },
      body: "{}",
    });
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({
      remoteMd5: A,
      remoteSha: A,
    });
  });

  it("DELETE takes the base under either name", async () => {
    await serveRequest({
      method: "DELETE",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-md5": A },
    });
    await serveRequest({
      method: "DELETE",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-sha": B },
    });
    expect(calls.remove.map((args) => args[1])).toEqual([A, B]);
  });

  it("agent-version: md5 / driveRevision and sha / commit", async () => {
    const answer = await serveRequest({
      method: "GET",
      path: "/api/scenes/plan/agent-version",
    });
    expect(JSON.parse(answer.body).version).toEqual({
      md5: B,
      driveRevision: "rev-0",
      sha: B,
      commit: "rev-0",
      at: "2026-11-01T00:00:00Z",
    });
  });
});

describe("tab request boundaries", () => {
  it("prefers the new version name when both are present", async () => {
    await serveRequest({
      method: "GET",
      path: `/api/scenes/plan?md5=${A}&sha=${B}`,
    });
    await serveRequest({
      method: "PUT",
      path: "/api/scenes/plan",
      headers: { ...mcp, "x-base-md5": A, "x-base-sha": B },
      body: "{}",
    });
    expect(calls.load[0][1]).toBe(A);
    expect(calls.save[0][2]).toBe(A);
  });
  it("rejects disconnected and direct writes", async () => {
    mode.active = false;
    expect(
      (await serveRequest({ method: "GET", path: "/api/scenes/plan" })).status
    ).toBe(503);
    mode.active = true;
    expect(
      (
        await serveRequest({
          method: "PUT",
          path: "/api/scenes/plan",
          body: "{}",
        })
      ).status
    ).toBe(403);
    expect(calls.save).toEqual([]);
  });
  it("returns errors for malformed paths and rename JSON", async () => {
    expect(
      (await serveRequest({ method: "GET", path: "/unknown" })).status
    ).toBe(404);
    expect(
      (await serveRequest({ method: "GET", path: "/api/scenes/%ZZ" })).status
    ).toBe(500);
    const response = await serveRequest({ method: "POST", path: "/api/scenes/plan/rename", headers: mcp, body: "{" });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/valid JSON/);
  });
  it("routes live writes and deletion through the controller", async () => {
    mode.live = true;
    const read = await serveRequest({
      method: "GET",
      path: "/api/scenes/plan",
    });
    expect(read.status).toBe(200);
    expect(read.headers?.["X-Scene-Md5"]).toBe("live-1");
    expect(calls.load).toEqual([]);
    expect(
      (
        await serveRequest({
          method: "PUT",
          path: "/api/scenes/plan",
          headers: mcp,
          body: "{}",
        })
      ).status
    ).toBe(200);
    expect(calls.save[0].slice(0, 3)).toEqual(["live-file", "plan", "{}"]);
    expect(
      (
        await serveRequest({
          method: "DELETE",
          path: "/api/scenes/plan",
          headers: mcp,
        })
      ).status
    ).toBe(200);
    expect(calls.remove).toEqual([["plan"]]);
  });
});

describe("malformed scene write bodies", () => {
  it.each([false, true])("refuses malformed JSON before writing (live=%s)", async (live) => {
    mode.live = live;
    for (const body of ["{", "", '{"elements":]']) {
      const response = await serveRequest({ method: "PUT", path: "/api/scenes/plan", headers: mcp, body });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/valid JSON/);
    }
    expect(calls.save).toEqual([]);
  });
});
