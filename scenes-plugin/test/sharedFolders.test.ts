import { describe, expect, it } from "vitest";

import {
  ownerEmailOf,
  asRecipient,
  callUrl,
  classifyRead,
  classifyWrite,
  createBody,
  listQuery,
  lookupKeys,
  memberKeys,
  parseCreate,
  roleFor,
  writeUrl,
} from "../../online/worker/folderRules";

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

describe("shared folders: which writes pass", () => {
  it("lets Kurviq's own writes through: content, new scene, rename, bin, agent mark, keep a version", () => {
    expect(classifyWrite("PATCH", "upload", `/files/${FILE}?uploadType=media&fields=id,md5Checksum&supportsAllDrives=true`)).toMatchObject({ kind: "content", fileId: FILE });
    expect(classifyWrite("POST", "upload", "/files?uploadType=multipart&fields=id")).toMatchObject({ kind: "create" });
    expect(classifyWrite("PATCH", "api", `/files/${FILE}?fields=id&supportsAllDrives=true`, { name: "Plan 2.excalidraw" })).toMatchObject({ kind: "metadata", metadata: { name: "Plan 2.excalidraw" } });
    expect(classifyWrite("PATCH", "api", `/files/${FILE}?fields=id`, { trashed: true })).toMatchObject({ kind: "metadata" });
    expect(classifyWrite("PATCH", "api", `/files/${FILE}?fields=id`, { appProperties: { agentRev: "r1", agentAt: "2026-11-11T00:00:00Z" } })).toMatchObject({ kind: "metadata" });
    expect(classifyWrite("PATCH", "api", `/files/${FILE}/revisions/0B12`, { keepForever: true })).toEqual({ kind: "keep", fileId: FILE, revisionId: "0B12", keepForever: true });
  });

  it("refuses everything else", () => {
    // moving out of the folder, sharing, other fields, other properties, odd names
    expect(classifyWrite("PATCH", "api", `/files/${FILE}?addParents=x&removeParents=${FOLDER}`, { name: "a.excalidraw" })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { parents: ["x"] })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { name: "a.excalidraw", mimeType: "text/plain" })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { appProperties: { kurviqSync: "live" } })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { name: "../evil.excalidraw" })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { name: "notes.txt" })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, { trashed: "yes" })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}`, {})).toHaveProperty("refused");
    expect(classifyWrite("POST", "api", `/files/${FILE}/permissions`, { role: "writer" })).toHaveProperty("refused");
    expect(classifyWrite("DELETE", "api", `/files/${FILE}`)).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "api", `/files/${FILE}/revisions/0B12`, { keepForever: true, published: true })).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "upload", `/files/${FILE}?uploadType=multipart`)).toHaveProperty("refused");
    expect(classifyWrite("POST", "upload", "/files?uploadType=media")).toHaveProperty("refused");
    expect(classifyWrite("PATCH", "upload", "/files/short?uploadType=media")).toHaveProperty("refused");
    expect(classifyWrite("POST", "api", "/files?fields=id", { name: "a.excalidraw" })).toHaveProperty("refused");
  });

  it("builds Drive addresses only from the checked parts", () => {
    const content = classifyWrite("PATCH", "upload", `/files/${FILE}?uploadType=media&fields=id`) as any;
    expect(writeUrl("https://api", "https://up", content)).toBe(`https://up/files/${FILE}?uploadType=media&fields=id`);
    const keep = classifyWrite("PATCH", "api", `/files/${FILE}/revisions/0B12`, { keepForever: false }) as any;
    expect(writeUrl("https://api", "https://up", keep)).toBe(`https://api/files/${FILE}/revisions/0B12`);
  });

  it("reads a new scene's upload and rebuilds it with Kurviq's metadata in the folder", () => {
    const boundary = "kurviqabc";
    const upload =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: "Plan.excalidraw", parents: ["elsewhere"], appProperties: { kurviqSync: "live" } })}\r\n` +
      `--${boundary}\r\nContent-Type: application/vnd.excalidraw+json\r\n\r\n{"type":"excalidraw"}\r\n--${boundary}--`;
    const parsed = parseCreate(`multipart/related; boundary=${boundary}`, upload);
    expect(parsed).toEqual({ name: "Plan.excalidraw", content: '{"type":"excalidraw"}' });
    const rebuilt = createBody(FOLDER, parsed!.name, parsed!.content, "b2");
    expect(rebuilt.contentType).toBe("multipart/related; boundary=b2");
    expect(parseCreate(rebuilt.contentType, rebuilt.body)).toEqual(parsed);
    const metadata = JSON.parse(rebuilt.body.split("\r\n\r\n")[1].split("\r\n")[0]);
    expect(metadata).toEqual({ name: "Plan.excalidraw", mimeType: "application/vnd.excalidraw+json", parents: [FOLDER], appProperties: { kurviq: "scene", fmt: "1" } });
  });

  it("refuses uploads that aren't a scene", () => {
    expect(parseCreate("application/json", "{}")).toBeNull();
    expect(parseCreate("multipart/related; boundary=x", "--x\r\n\r\n{}\r\n--x--")).toBeNull();
    expect(parseCreate("multipart/related; boundary=x", `--x\r\nA: b\r\n\r\n${JSON.stringify({ name: "a.txt" })}\r\n--x\r\nA: b\r\n\r\n{}\r\n--x--`)).toBeNull();
  });
});

describe("the folder's owner", () => {
  it("is the user with the owner role", () => {
    expect(
      ownerEmailOf([
        { type: "user", role: "writer", emailAddress: "ed@b.com" },
        { type: "user", role: "owner", emailAddress: "Fabian@enstoke.com" },
      ]),
    ).toBe("Fabian@enstoke.com");
  });

  it("is unknown without one (or only a deleted one)", () => {
    expect(ownerEmailOf([{ type: "user", role: "writer", emailAddress: "ed@b.com" }])).toBeNull();
    expect(ownerEmailOf([{ type: "user", role: "owner", emailAddress: "x@y.com", deleted: true }])).toBeNull();
  });
});
