import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage", () => ({
  currentSpace: "f:sharedfile12345",
  SPACE_KEY: "kurviq-space",
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Drive stale base protection", () => {
  it("refreshes cached metadata and refuses stale saves and create-only writes without a mutation", async () => {
    vi.stubGlobal("navigator", {});
    const old = "a".repeat(32);
    const latest = "b".repeat(32);
    let checksum = old;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/auth/token")
          return new Response(
            JSON.stringify({
              token: "access-token",
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              user: { email: "a@example.test" },
              drive: true,
            })
          );
        expect(init?.method ?? "GET").toBe("GET");
        expect(url).toContain("/files/sharedfile12345?");
        return new Response(
          JSON.stringify({
            id: "sharedfile12345",
            name: "plan.excalidraw",
            md5Checksum: checksum,
            ownedByMe: true,
            capabilities: { canEdit: true },
          })
        );
      });
    const { driveScenes } = await import("../src/online/drive");
    expect((await driveScenes.list()).scenes[0].md5).toBe(old);
    checksum = latest;
    await expect(
      driveScenes.save("plan", '{"elements":[]}', old, "agent")
    ).rejects.toMatchObject({ status: 409, remoteMd5: latest });
    await expect(
      driveScenes.save("plan", '{"elements":[]}', "none", "agent")
    ).rejects.toMatchObject({ status: 409, remoteMd5: latest });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
