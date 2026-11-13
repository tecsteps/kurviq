import { describe, expect, it } from "vitest";

import { scopesOf } from "../../online/worker/auth";

describe("Google sign-in scopes", () => {
  it("drive.appdata only when switched on (it must be on the consent screen first)", () => {
    expect(scopesOf({}).some((scope) => scope.endsWith("drive.appdata"))).toBe(false);
    expect(scopesOf({ GOOGLE_APPDATA: "off" }).some((scope) => scope.endsWith("drive.appdata"))).toBe(false);
    expect(scopesOf({ GOOGLE_APPDATA: "on" })).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(scopesOf({ GOOGLE_APPDATA: "on" })).toContain("https://www.googleapis.com/auth/drive.file");
  });
});
