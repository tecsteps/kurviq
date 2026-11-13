import { describe, expect, it } from "vitest";

import {
  DRIVE_NEW_PARAM,
  OTHER_SCENES_MAX,
  checkDriveNewAccount,
  driveNewAppPath,
  parseDriveNewState,
  readOtherScenes,
  resourceKeyHeader,
  sceneNameOfFile,
  withOtherScene,
} from "../src/online/driveNewState";
import { handleDriveNew } from "../../online/worker/driveNew";

const STATE = JSON.stringify({ action: "create", folderId: "0AbC-folder_1", userId: "1234567890" });

describe("Drive's New state", () => {
  it("reads a create request", () => {
    expect(parseDriveNewState(STATE)).toEqual({ folderId: "0AbC-folder_1", userId: "1234567890" });
  });

  it("keeps the folder's resource key, if any", () => {
    const request = parseDriveNewState(JSON.stringify({ action: "create", folderId: "f1", userId: "u1", folderResourceKey: "0-key_A" }));
    expect(request).toEqual({ folderId: "f1", userId: "u1", folderResourceKey: "0-key_A" });
    expect(resourceKeyHeader(request!)).toEqual({ "X-Goog-Drive-Resource-Keys": "f1/0-key_A" });
    expect(resourceKeyHeader({ folderId: "f1", userId: "u1" })).toEqual({});
    expect(parseDriveNewState(JSON.stringify({ action: "create", folderId: "f1", userId: "u1", folderResourceKey: "bad key" }))).toEqual({ folderId: "f1", userId: "u1" });
    const path = driveNewAppPath(request!);
    expect(parseDriveNewState(new URL(path, "https://kurviq.com").searchParams.get(DRIVE_NEW_PARAM))).toEqual(request);
  });

  it("refuses anything else", () => {
    expect(parseDriveNewState(null)).toBeNull();
    expect(parseDriveNewState("")).toBeNull();
    expect(parseDriveNewState("{not json")).toBeNull();
    expect(parseDriveNewState("[]")).toBeNull();
    expect(parseDriveNewState(JSON.stringify({ action: "open", ids: ["a"], userId: "1" }))).toBeNull();
    expect(parseDriveNewState(JSON.stringify({ action: "create", folderId: "a/../b", userId: "1" }))).toBeNull();
    expect(parseDriveNewState(JSON.stringify({ action: "create", folderId: "abc", userId: "1 2" }))).toBeNull();
    expect(parseDriveNewState(JSON.stringify({ action: "create", folderId: 5, userId: "1" }))).toBeNull();
    expect(parseDriveNewState("x".repeat(3000))).toBeNull();
  });

  it("hands only Drive's state to the app", () => {
    const path = driveNewAppPath({ folderId: "f1", userId: "u1" });
    const url = new URL(path, "https://kurviq.com");
    expect(url.pathname).toBe("/");
    expect([...url.searchParams.keys()]).toEqual([DRIVE_NEW_PARAM]);
    expect(parseDriveNewState(url.searchParams.get(DRIVE_NEW_PARAM))).toEqual({ folderId: "f1", userId: "u1" });
  });
});

describe("the account check", () => {
  it("creates only as Drive's account with Drive access", () => {
    expect(checkDriveNewAccount({ sub: "42" }, true, "42")).toBe("ok");
    expect(checkDriveNewAccount({ sub: "42" }, false, "42")).toBe("no-drive");
    expect(checkDriveNewAccount({ sub: "7" }, true, "42")).toBe("other-account");
    expect(checkDriveNewAccount({}, true, "42")).toBe("unknown");
    expect(checkDriveNewAccount(null, false, "42")).toBe("signed-out");
    expect(checkDriveNewAccount(undefined, false, "42")).toBe("signed-out");
  });
});

describe("other folders' scenes", () => {
  it("reads only well-formed entries", () => {
    expect(readOtherScenes(null)).toEqual([]);
    expect(readOtherScenes("nope")).toEqual([]);
    expect(readOtherScenes("{}")).toEqual([]);
    expect(
      readOtherScenes(
        JSON.stringify([
          { fileId: "a1", name: "Plan", folderId: "f" },
          { fileId: "a 2", name: "Bad id", folderId: "f" },
          { fileId: "a3", name: "", folderId: "f" },
          { fileId: "a4", name: "No folder" },
          null,
        ]),
      ),
    ).toEqual([{ fileId: "a1", name: "Plan", folderId: "f" }]);
  });

  it("adds, updates and caps", () => {
    const one = withOtherScene([], { fileId: "a", name: "A", folderId: "f" });
    const two = withOtherScene(one, { fileId: "b", name: "B", folderId: "f" });
    expect(withOtherScene(two, { fileId: "a", name: "A2", folderId: "g" })).toEqual([
      { fileId: "b", name: "B", folderId: "f" },
      { fileId: "a", name: "A2", folderId: "g" },
    ]);
    let many = two;
    for (let i = 0; i < OTHER_SCENES_MAX + 5; i++) {
      many = withOtherScene(many, { fileId: `x${i}`, name: `X${i}`, folderId: "f" });
    }
    expect(many).toHaveLength(OTHER_SCENES_MAX);
    expect(many.at(-1)?.fileId).toBe(`x${OTHER_SCENES_MAX + 4}`);
  });

  it("names scene files", () => {
    expect(sceneNameOfFile("Plan.excalidraw")).toBe("Plan");
    expect(sceneNameOfFile("Plan.pdf")).toBeNull();
  });
});

describe("GET /drive/new", () => {
  const url = (state: string | null) => {
    const address = new URL("https://kurviq.com/drive/new");
    if (state !== null) {
      address.searchParams.set("state", state);
    }
    return address;
  };

  it("is off unless DRIVE_NEW is on", async () => {
    for (const value of [undefined, "off", "1", "ON"]) {
      const res = handleDriveNew(url(STATE), { DRIVE_NEW: value });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("isn't enabled");
      expect(text).toContain('href="/"');
    }
  });

  it("passes the state on to the app, keeping nothing", () => {
    const res = handleDriveNew(url(STATE), { DRIVE_NEW: "on" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const target = new URL(res.headers.get("Location") ?? "");
    expect(target.origin).toBe("https://kurviq.com");
    expect(target.pathname).toBe("/");
    expect(parseDriveNewState(target.searchParams.get(DRIVE_NEW_PARAM))).toEqual({ folderId: "0AbC-folder_1", userId: "1234567890" });
  });

  it("explains a broken request", async () => {
    const res = handleDriveNew(url(null), { DRIVE_NEW: "on" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("New → More → Kurviq");
    expect(handleDriveNew(url('{"action":"open","ids":["x"]}'), { DRIVE_NEW: "on" }).status).toBe(400);
  });
});
