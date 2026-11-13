// The share panel: General access with the organization (Drive "domain"
// permissions) and end dates of people's access (expirationTime).
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canHaveEndDate,
  dateFieldValue,
  endDatePatch,
  endDateRange,
  endOfDay,
  generalAccessChanges,
  generalAccessHint,
  generalAccessLabel,
  generalAccessOf,
  generalAccessOptions,
  linkAccessOf,
  organizationDomain,
  otherDomainGrants,
  untilText,
} from "../src/online/shareAccess";

vi.mock("../src/storage", () => ({
  currentSpace: "a:me@tecsteps.com",
  SPACE_KEY: "kurviq-space",
  ownSceneList: () => [],
}));

const owner = { id: "o", type: "user", role: "owner", emailAddress: "me@tecsteps.com" };
const anyone = (role: string) => ({ id: "anyoneWithLink", type: "anyone", role });
const domain = (name: string, role: string) => ({ id: `d-${name}`, type: "domain", role, domain: name });

describe("the organization of the signed-in account", () => {
  it("is the address's domain for Workspace accounts, none for Gmail", () => {
    expect(organizationDomain("Fabian@TecSteps.com")).toBe("tecsteps.com");
    expect(organizationDomain("someone@gmail.com")).toBeNull();
    expect(organizationDomain("someone@googlemail.com")).toBeNull();
    expect(organizationDomain(null)).toBeNull();
    expect(organizationDomain("no-at-sign")).toBeNull();
  });

  it("offers the organization's options only with a domain", () => {
    expect(generalAccessOptions(null)).toEqual(["restricted", "reader", "commenter", "writer"]);
    expect(generalAccessOptions("tecsteps.com")).toContain("domain:writer");
    expect(generalAccessLabel("domain:commenter", "tecsteps.com")).toBe("Anyone at tecsteps.com with the link can comment");
    expect(generalAccessLabel("writer", null)).toBe("Anyone with the link can edit");
    expect(generalAccessLabel("restricted", null)).toBe("Only people added here");
    expect(generalAccessHint("domain:reader", "tecsteps.com")).toMatch(/People at tecsteps.com who have the link can view/);
  });
});

describe("General access read back from Drive's permissions", () => {
  it("reads anyone and domain permissions", () => {
    expect(linkAccessOf([owner])).toEqual({ anyone: "restricted", domains: [] });
    expect(linkAccessOf([owner, anyone("commenter")]).anyone).toBe("commenter");
    expect(linkAccessOf([owner, domain("TecSteps.com", "writer")]).domains).toEqual([{ id: "d-TecSteps.com", domain: "tecsteps.com", role: "writer" }]);
  });

  it("shows the organization's link when there is no link for anyone", () => {
    const grants = linkAccessOf([owner, domain("tecsteps.com", "writer")]);
    expect(generalAccessOf(grants, "tecsteps.com")).toBe("domain:writer");
    expect(otherDomainGrants(grants, "domain:writer", "tecsteps.com")).toEqual([]);
  });

  it("shows both: anyone in the field, the domain under it", () => {
    const grants = linkAccessOf([owner, anyone("reader"), domain("tecsteps.com", "writer")]);
    expect(generalAccessOf(grants, "tecsteps.com")).toBe("reader");
    expect(otherDomainGrants(grants, "reader", "tecsteps.com").map((grant) => grant.domain)).toEqual(["tecsteps.com"]);
  });

  it("lists another domain's link (made in Drive) under the field", () => {
    const grants = linkAccessOf([owner, domain("partner.com", "reader")]);
    expect(generalAccessOf(grants, "tecsteps.com")).toBe("restricted");
    expect(otherDomainGrants(grants, "restricted", "tecsteps.com")).toHaveLength(1);
  });
});

describe("changing General access", () => {
  it("creates the organization's link, never findable in search", () => {
    expect(generalAccessChanges([owner], "domain:commenter", "tecsteps.com")).toEqual([
      { create: { type: "domain", domain: "tecsteps.com", role: "commenter", allowFileDiscovery: false } },
    ]);
  });

  it("replaces the link for anyone with the organization's", () => {
    expect(generalAccessChanges([owner, anyone("reader")], "domain:reader", "tecsteps.com")).toEqual([
      { remove: "anyoneWithLink" },
      { create: { type: "domain", domain: "tecsteps.com", role: "reader", allowFileDiscovery: false } },
    ]);
  });

  it("changes the role of the existing link", () => {
    expect(generalAccessChanges([owner, domain("tecsteps.com", "reader")], "domain:writer", "tecsteps.com")).toEqual([
      { patch: "d-tecsteps.com", role: "writer" },
    ]);
    expect(generalAccessChanges([owner, anyone("writer")], "writer", null)).toEqual([]);
  });

  it("'Only people added here' removes every link permission", () => {
    expect(generalAccessChanges([owner, anyone("reader"), domain("tecsteps.com", "writer")], "restricted", "tecsteps.com")).toEqual([
      { remove: "anyoneWithLink" },
      { remove: "d-tecsteps.com" },
    ]);
  });

  it("refuses the organization's link without an organization", () => {
    expect(() => generalAccessChanges([owner], "domain:reader", null)).toThrow(/Workspace/);
  });
});

describe("end dates of access", () => {
  it("are offered to viewers and commenters, not to editors or links", () => {
    expect(canHaveEndDate({ type: "user", role: "reader" })).toBe(true);
    expect(canHaveEndDate({ type: "group", role: "commenter" })).toBe(true);
    expect(canHaveEndDate({ type: "user", role: "writer" })).toBe(false);
    expect(canHaveEndDate({ type: "user", role: "owner" })).toBe(false);
    expect(canHaveEndDate({ type: "domain", role: "reader" })).toBe(false);
    expect(canHaveEndDate({ type: "anyone", role: "reader" })).toBe(false);
  });

  it("end with the picked day, in the user's time zone", () => {
    const end = new Date(endOfDay("2026-11-30"));
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes()]).toEqual([2026, 10, 30, 23, 59]);
    expect(dateFieldValue(end)).toBe("2026-11-30");
  });

  it("are picked from today to a year ahead", () => {
    expect(endDateRange(new Date(2026, 10, 13, 9))).toEqual({ min: "2026-11-13", max: "2027-11-13" });
  });

  it("read 'until 30 Nov' (with the year when it isn't this year's)", () => {
    const now = new Date(2026, 10, 13);
    expect(untilText(new Date(2026, 10, 30, 23, 59).toISOString(), now)).toBe("until 30 Nov");
    expect(untilText(new Date(2027, 0, 5, 12).toISOString(), now)).toBe("until 5 Jan 2027");
  });

  it("are set and removed with a PATCH of the permission", () => {
    expect(endDatePatch("reader", "2026-11-30")).toEqual({ query: "", body: { role: "reader", expirationTime: endOfDay("2026-11-30") } });
    expect(endDatePatch("commenter", null)).toEqual({ query: "&removeExpiration=true", body: { role: "commenter" } });
  });
});

describe("Drive calls of the share panel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("PATCHes the end date, and makes the organization's link", async () => {
    vi.stubGlobal("navigator", {});
    const calls: { url: string; method: string; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/auth/token") {
        return new Response(
          JSON.stringify({ token: "t", expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { email: "me@tecsteps.com" }, drive: true }),
        );
      }
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "GET") {
        return new Response(JSON.stringify({ permissions: [owner, anyone("reader")] }));
      }
      return new Response(method === "DELETE" ? null : "{}", { status: method === "DELETE" ? 204 : 200 });
    });
    const { checkConnection, setAccessEnd, setLinkAccess, userOrganization } = await import("../src/online/drive");
    await checkConnection();
    expect(userOrganization()).toBe("tecsteps.com");

    await setAccessEnd("file1", { id: "p1", role: "reader" }, "2026-11-30");
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { role: "reader", expirationTime: endOfDay("2026-11-30") } });
    expect(calls[0].url).toContain("/files/file1/permissions/p1?");
    await setAccessEnd("file1", { id: "p1", role: "reader" }, null);
    expect(calls[1].url).toContain("removeExpiration=true");
    expect(calls[1].body).toEqual({ role: "reader" });

    calls.length = 0;
    await setLinkAccess("file1", "domain:writer");
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(calls[2].body).toEqual({ type: "domain", domain: "tecsteps.com", role: "writer", allowFileDiscovery: false });
  });
});
