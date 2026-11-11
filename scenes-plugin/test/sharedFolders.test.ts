import { describe, expect, it } from "vitest";

import { asRecipient, callUrl, classifyRead, listQuery, lookupKeys, memberKeys, roleFor } from "../../online/worker/folderRules";

const FOLDER = "folder0123456789";
const FILE = "file0123456789ab";

describe("shared folders: who may do what", () => {
  const permissions = [
    { type: "user", role: "owner", emailAddress: "Owner@Enstoke.com" },
    { type: "user", role: "writer", emailAddress: "Fabian@Tecsteps.com" },
    { type: "user", role: "reader", emailAddress: "viewer@example.com" },
    { type: "user", role: "commenter", emailAddress: "gone@example.com", deleted: true },
    { type: "domain", role: "reader", domain: "Customer.org" },
    { type: "group", role: "writer", emailAddress: "team@example.com" },
    { type: "anyone", role: "writer" },
  ];

  it("reads a person's role from their own or their domain's permission", () => {
    expect(roleFor(permissions, "fabian@tecsteps.com")).toBe("writer");
    expect(roleFor(permissions, " Viewer@Example.com ")).toBe("reader");
    expect(roleFor(permissions, "someone@customer.org")).toBe("reader");
    expect(roleFor(permissions, "owner@enstoke.com")).toBe("writer");
  });

  it("never counts deleted permissions, groups or anyone with the link", () => {
    expect(roleFor(permissions, "gone@example.com")).toBeNull();
    expect(roleFor(permissions, "team@example.com")).toBeNull();
    expect(roleFor(permissions, "stranger@elsewhere.com")).toBeNull();
  });

  it("takes the higher role when someone has two", () => {
    expect(roleFor([{ type: "domain", role: "reader", domain: "x.com" }, { type: "user", role: "writer", emailAddress: "a@x.com" }], "a@x.com")).toBe("writer");
    expect(roleFor([{ type: "user", role: "writer", emailAddress: "a@x.com" }, { type: "domain", role: "reader", domain: "x.com" }], "a@x.com")).toBe("writer");
  });

  it("indexes the members besides the owner (people and domains)", () => {
    expect(memberKeys(permissions, "owner@enstoke.com")).toEqual(["d:customer.org", "u:fabian@tecsteps.com", "u:viewer@example.com"]);
    expect(memberKeys([{ type: "user", role: "owner", emailAddress: "owner@enstoke.com" }], "owner@enstoke.com")).toEqual([]);
    expect(lookupKeys("Fabian@Tecsteps.com")).toEqual(["u:fabian@tecsteps.com", "d:tecsteps.com"]);
  });
});

describe("shared folders: which Drive calls pass", () => {
  const list = `/files?q=${encodeURIComponent(listQuery(FOLDER))}&fields=nextPageToken,files(id,name)&pageSize=1000`;

  it("lets exactly this folder's listing through", () => {
    const call = classifyRead(FOLDER, "GET", list);
    expect(call).toMatchObject({ kind: "list" });
    expect(callUrl("https://api", call as any)).toBe(`https://api/files?${new URLSearchParams(list.split("?")[1]).toString()}`);
  });

  it("refuses other listings and searches", () => {
    expect(classifyRead(FOLDER, "GET", `/files?q=${encodeURIComponent(listQuery("otherfolder123456"))}`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files?q=${encodeURIComponent("trashed=false")}`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files?q=${encodeURIComponent(`${listQuery(FOLDER)} or trashed=true`)}`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", "/files")).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `${list}&corpora=allDrives`)).toHaveProperty("refused");
  });

  it("lets a file's metadata, content and revisions through (the folder check follows with Drive)", () => {
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}?fields=id,name`)).toMatchObject({ kind: "file", fileId: FILE, media: false });
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}?alt=media&supportsAllDrives=true`)).toMatchObject({ kind: "file", media: true });
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}/revisions?fields=revisions(id)`)).toMatchObject({ kind: "revisions" });
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}/revisions/0B123?alt=media`)).toMatchObject({ kind: "revision", revisionId: "0B123", media: true });
  });

  it("refuses writes, permissions, odd ids and parameters", () => {
    for (const method of ["PATCH", "POST", "DELETE", "PUT"]) {
      expect(classifyRead(FOLDER, method, `/files/${FILE}`)).toHaveProperty("refused");
    }
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}/permissions`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}/revisions/1/extra`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}/revisions?alt=media`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", "/files/short")).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", "/files/..%2Fabout0123456")).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}?alt=json`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}?uploadType=media`)).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", "/about?fields=user")).toHaveProperty("refused");
    expect(classifyRead(FOLDER, "GET", `/files/${FILE}?q=${encodeURIComponent(listQuery(FOLDER))}`)).toHaveProperty("refused");
  });

  it("shows Drive's answers with the recipient's rights, not the owner's", () => {
    const file = { id: FILE, ownedByMe: true, capabilities: { canEdit: true, canShare: true } };
    expect(asRecipient(file, "reader")).toEqual({ id: FILE, ownedByMe: false, capabilities: { canEdit: false, canShare: false } });
    expect(asRecipient({ files: [file], nextPageToken: "x" }, "writer")).toEqual({
      files: [{ id: FILE, ownedByMe: false, capabilities: { canEdit: true, canShare: false } }],
      nextPageToken: "x",
    });
    expect(asRecipient({ id: FILE, name: "a" }, "reader")).toEqual({ id: FILE, name: "a" });
  });
});
