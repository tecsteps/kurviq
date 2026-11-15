// The WebMCP bridge's parts (scenes-plugin/src/webmcp): the tab as "the
// scenes server", MCP tools and results as WebMCP tools, the SHA-1 of the
// browser shim, and the whole loop (scenes-mcp/tools.mjs through the
// in-memory client) against a fake tab.
import { createHash as nodeHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { kurviqPageReference } from "../../online/worker/skill";
import { connectInProcess } from "../../scenes-mcp/inProcess.mjs";
import { createScenesMcp } from "../../scenes-mcp/tools.mjs";
import { localServerFetch, modelContextOf, registerReadMeOnly, webResult, webTool } from "../src/webmcp/adapter";
import type { CommandAnswer, WebTool } from "../src/webmcp/adapter";
import { createHash, sha1 } from "../src/webmcp/shims/crypto";

const okRun = (result: unknown) => vi.fn(async (): Promise<CommandAnswer> => ({ ok: true, result }));

describe("localServerFetch: the tab answers the scenes server's API", () => {
  it("app state: connected, with the tab's state", async () => {
    const fetch = localServerFetch(okRun(null), () => ({ activeTab: "t1", current: "Plan", dirty: false }));
    const res = await fetch("/api/app/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, tabs: 1, activeTab: "t1", current: "Plan", dirty: false });
  });

  it("a command runs in the tab; its result as the pairing returns it", async () => {
    const run = okRun({ pong: true });
    const fetch = localServerFetch(run, () => ({}));
    const res = await fetch("/api/app/command", { method: "POST", body: JSON.stringify({ type: "ping" }) });
    expect(run).toHaveBeenCalledWith({ type: "ping" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { pong: true } });
  });

  it("a failed command: 422 with the tab's message", async () => {
    const fetch = localServerFetch(async () => ({ ok: false, error: "read only" }), () => ({}));
    const res = await fetch("/api/app/command", { method: "POST", body: JSON.stringify({ type: "edit" }) });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "read only" });
  });

  it("flush: the open scene's changes, one tab", async () => {
    const run = okRun({ flushed: true });
    const res = await localServerFetch(run, () => ({}))("/api/app/flush", { method: "POST", body: JSON.stringify({ name: "Plan" }) });
    expect(run).toHaveBeenCalledWith({ type: "flush", name: "Plan" });
    expect(await res.json()).toEqual({ tabs: 1, results: [{ flushed: true }] });
  });

  it("scene requests go to the tab's HTTP handler with path, query, x- headers and body", async () => {
    const run = okRun({ status: 201, headers: { "Content-Type": "application/json", "X-Scene-Md5": "abc" }, body: '{"md5":"abc"}' });
    const fetch = localServerFetch(run, () => ({}));
    const res = await fetch("/api/scenes/My%20Plan?md5=1", {
      method: "PUT",
      headers: { "X-Base-Md5": "none", "Content-Type": "application/json", Authorization: "no" },
      body: "{}",
    });
    expect(run).toHaveBeenCalledWith({
      type: "http",
      request: {
        method: "PUT",
        path: "/api/scenes/My%20Plan?md5=1",
        headers: { "x-base-md5": "none", "content-type": "application/json" },
        body: "{}",
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Scene-Md5")).toBe("abc");
    expect(await res.json()).toEqual({ md5: "abc" });
  });

  it("anything else: 404", async () => {
    expect((await localServerFetch(okRun(null), () => ({}))("/api/other")).status).toBe(404);
  });
});

describe("webResult: an MCP result as the text a browser agent gets", () => {
  it("text parts joined; pictures named with their size, not inlined", () => {
    const text = webResult({
      content: [
        { type: "text", text: "Saved." },
        { type: "image", mimeType: "image/png", data: "A".repeat(4096) },
      ],
    });
    expect(text).toBe("Saved.\n\n[picture: image/png, 3 KB, not passed on to page tools; look at the Kurviq page instead]");
  });

  it("a failed call says so", () => {
    expect(webResult({ isError: true, content: [{ type: "text", text: "No such scene" }] })).toBe("Error: No such scene");
    expect(webResult({ isError: true, content: [{ type: "text", text: "Error: No such scene" }] })).toBe("Error: No such scene");
  });

  it("other content as JSON; no content: empty", () => {
    expect(webResult({ content: [{ type: "resource", uri: "x" }] })).toBe('{"type":"resource","uri":"x"}');
    expect(webResult({})).toBe("");
  });
});

describe("webTool: an MCP tool for document.modelContext", () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };

  it("keeps name, description and schema; hints from the MCP annotations", () => {
    const read = webTool({ name: "read_scene", description: "Read", inputSchema: schema, annotations: { readOnlyHint: true } }, vi.fn());
    expect(read).toMatchObject({
      name: "read_scene",
      description: "Read",
      inputSchema: schema,
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
    });
    const del = webTool({ name: "delete_scene", inputSchema: schema, annotations: { destructiveHint: true } }, vi.fn());
    expect(del.annotations).toEqual({ readOnlyHint: false, consequentialHint: true, untrustedContentHint: true });
    expect(del.description).toBe("delete_scene");
    expect(webTool({ name: "read_me", inputSchema: schema }, vi.fn()).annotations.untrustedContentHint).toBe(false);
  });

  it("execute: calls the tool with the input (object or JSON text) and answers text", async () => {
    const call = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = webTool({ name: "list_scenes", inputSchema: schema }, call);
    const signal = new AbortController().signal;
    expect(await tool.execute({ name: "A" }, { signal })).toBe("ok");
    expect(call).toHaveBeenLastCalledWith("list_scenes", { name: "A" }, signal);
    await tool.execute('{"name":"B"}');
    expect(call).toHaveBeenLastCalledWith("list_scenes", { name: "B" }, undefined);
    await tool.execute("not json");
    expect(call).toHaveBeenLastCalledWith("list_scenes", {}, undefined);
    await tool.execute(undefined);
    expect(call).toHaveBeenLastCalledWith("list_scenes", {}, undefined);
  });

  it("execute: a thrown call becomes an error text, not a rejection", async () => {
    const tool = webTool({ name: "x", inputSchema: schema }, async () => {
      throw new Error("timed out");
    });
    expect(await tool.execute({})).toBe("Error: timed out");
  });
});

describe("modelContextOf: the page's WebMCP", () => {
  const context = { registerTool: () => {} };
  it("document first, navigator (before Chrome 150) second, else none", () => {
    expect(modelContextOf({ modelContext: context }, {})).toBe(context);
    expect(modelContextOf({}, { modelContext: context })).toBe(context);
    expect(modelContextOf({ modelContext: {} }, {})).toBeNull();
    expect(modelContextOf(undefined, undefined)).toBeNull();
  });
});

describe("the browser's node:crypto shim: SHA-1 as Node computes it", () => {
  it.each([
    ["", ""],
    ["abc", "abc"],
    ["56 bytes (padding into a second block)", "a".repeat(56)],
    ["64 bytes", "b".repeat(64)],
    ["1000 bytes", "kurviq ".repeat(143)],
  ])("%s", (_label, text) => {
    expect(createHash("sha1").update(text).digest("hex")).toBe(nodeHash("sha1").update(text).digest("hex"));
  });

  it("bytes, in several updates", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    expect(createHash("sha1").update(bytes.subarray(0, 100)).update(bytes.subarray(100)).digest("hex")).toBe(
      nodeHash("sha1").update(bytes).digest("hex"),
    );
    expect(sha1(bytes)).toHaveLength(20);
  });

  it("other hashes or encodings: a clear error", () => {
    expect(() => createHash("sha256")).toThrow(/sha256/);
    expect(() => createHash("sha1").digest("base64" as "hex")).toThrow(/base64/);
  });
});

describe("the page reference (read_me for browser agents)", () => {
  it("no upload address, no local files; says how images and big edits work in the page", () => {
    const text = kurviqPageReference();
    expect(text).toContain("the Kurviq page's own tools");
    expect(text).not.toContain("curl ");
    expect(text).not.toContain("<the upload address>");
    expect(text).not.toMatch(/absolute file path/);
  });
});

describe("the whole loop: scenes tools in the page, against a fake tab", () => {
  const registered = async (run: (command: Record<string, any>) => Promise<CommandAnswer>) => {
    const server = createScenesMcp({
      name: "Kurviq",
      mode: "detached",
      appHint: "https://kurviq.test",
      leanReads: true,
      localFiles: false,
      skill: "",
      reference: kurviqPageReference(),
      unreachable: "unreachable",
      serverFetch: localServerFetch(run, () => ({ activeTab: "t1", current: "Plan", dirty: false, drive: true })),
      registerUpstream: registerReadMeOnly,
    });
    const client = await connectInProcess(server);
    const tools: WebTool[] = [];
    const context = { registerTool: (tool: WebTool) => tools.push(tool) };
    const { tools: listed } = await client.listTools();
    for (const tool of listed) {
      context.registerTool(webTool(tool as any, (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal })));
    }
    return { tools, client };
  };

  it("offers the MCP's scene tools (no create_view, no send_feedback) with JSON schemas", async () => {
    const { tools, client } = await registered(async () => ({ ok: true, result: {} }));
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["read_me", "list_scenes", "read_scene", "edit_scene", "view_scene", "app_status"]));
    expect(names).not.toContain("create_view");
    expect(names).not.toContain("send_feedback");
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[\w.-]{1,128}$/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    await client.close();
  });

  it("read_me answers the page reference; list_scenes reads through the tab", async () => {
    const run = vi.fn(async (command: Record<string, any>): Promise<CommandAnswer> => {
      if (command.type === "http" && command.request.path.startsWith("/api/scenes")) {
        return {
          ok: true,
          result: {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenes: [{ name: "Plan", md5: "m1", updatedAt: "2026-11-15T10:00:00Z" }], drive: true }),
          },
        };
      }
      return { ok: true, result: {} };
    });
    const { tools, client } = await registered(run);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    expect(await byName("read_me").execute({})).toContain("the Kurviq page's own tools");
    const listed = await byName("list_scenes").execute({});
    expect(listed).toContain("Plan");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ type: "http", request: expect.objectContaining({ method: "GET" }) }));
    await client.close();
  });
});
