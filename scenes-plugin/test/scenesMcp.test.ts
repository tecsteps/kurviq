import { describe, expect, it } from "vitest";

// @ts-ignore: plain JS module of the MCP tools
import { createScenesMcp } from "../../scenes-mcp/tools.mjs";
import { changesScene, commentsOnly, isEmptyEdit } from "../../scenes-mcp/agentEdits.mjs";

// The MCP tools against a fake scenes server: what they send to the user's
// tab and what they answer agents.

type Handler = (command: any) => any;
type Setup = {
  mode?: "detached" | "live";
  scenes?: Record<string, any>;
  versions?: Record<string, any>;
  agentVersion?: any;
  commands?: Record<string, Handler>;
  flush?: any;
  state?: any;
  versionStatus?: number;
  sceneError?: { status: number; error: string };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const failing = (message: string, status: number) => Object.assign(new Error(message), { status });

const setup = ({ mode = "detached", scenes = {}, versions = {}, agentVersion = null, commands = {}, flush, state, versionStatus, sceneError }: Setup = {}) => {
  const sent: any[] = [];
  const puts: Array<{ name: string; body: any; headers: Record<string, string> }> = [];
  const routeScene = (name: string, url: URL, init: RequestInit) => {
    if (init.method === "PUT") {
      puts.push({ name, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return json({ md5: "m2", changed: true, driveRevision: "r2" });
    }
    const md5 = url.searchParams.get("md5");
    if (md5) {
      if (versionStatus) {
        return json({ error: "Drive is not reachable" }, versionStatus);
      }
      return versions[md5] ? json(versions[md5]) : json({ error: "Version not found" }, 404);
    }
    if (sceneError) {
      return json({ error: sceneError.error }, sceneError.status);
    }
    return scenes[name] ? json(scenes[name], 200, { "x-scene-md5": "m1" }) : json({ error: `Scene not found: ${name}` }, 404);
  };
  const command = async (body: any) => {
    sent.push(body);
    const handler = commands[body.type];
    if (!handler) {
      return json({ error: `Unknown command ${body.type}` }, 500);
    }
    try {
      return json({ ok: true, result: await handler(body) });
    } catch (error: any) {
      return json({ error: error.message }, error.status ?? 500);
    }
  };
  const serverFetch = async (pathname: string, init: RequestInit = {}) => {
    const url = new URL(pathname, "http://server");
    if (url.pathname === "/api/app/flush") {
      return json(flush ?? { tabs: 1, results: [{ status: "synced" }] });
    }
    if (url.pathname === "/api/app/state") {
      return json(state ?? { connected: true, drive: true });
    }
    if (url.pathname === "/api/app/command") {
      return command(JSON.parse(String(init.body)));
    }
    if (url.pathname === "/api/scenes") {
      return json({ scenes: Object.keys(scenes) });
    }
    if (url.pathname.endsWith("/agent-version")) {
      return json({ version: agentVersion });
    }
    const scene = /^\/api\/scenes\/(.+)$/.exec(url.pathname);
    return scene ? routeScene(decodeURIComponent(scene[1]), url, init) : json({ error: "Not found" }, 404);
  };
  const server = createScenesMcp({
    serverFetch,
    unreachable: "unreachable",
    mode,
    appHint: "http://app.test",
    skill: "---\nname: x\n---\nskill",
    reference: "reference",
    registerUpstream: () => undefined,
    savePdf: async () => ({}),
  });
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await server._registeredTools[tool].handler(args, {});
    const [first] = result.content;
    let data: any = first.text;
    try {
      data = JSON.parse(first.text);
    } catch {
      // a plain text answer (errors)
    }
    return { result, data, isError: !!result.isError };
  };
  return { call, sent, puts, tools: () => server._registeredTools as Record<string, { description: string }> };
};

let stamp = 1;
const rect = (id: string, props: Record<string, any> = {}) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 1,
  versionNonce: stamp++,
  strokeColor: "#1e1e1e",
  ...props,
});
const sceneFile = (elements: any[], extra: Record<string, any> = {}) => ({ type: "excalidraw", version: 2, elements, appState: { viewBackgroundColor: "#ffffff" }, files: {}, ...extra });
const edited = (command: any) => ({
  addedIds: (command.add || []).map((el: any) => el.id),
  updated: (command.update || []).map((u: any) => u.id),
  deleted: command.delete || [],
  elements: [],
  md5: "m2",
});

describe("edit_scene and edit_open_scene: every operation alone is an edit", () => {
  const scenes = { Plan: sceneFile([rect("a")]) };

  it("sends comments, isPresentation, restyle, reset or addTitleBlock without element changes", async () => {
    for (const args of [
      { comments: [{ action: "add", text: "Looks good", element: "a" }] },
      { isPresentation: false },
      { isPresentation: true },
      { restyle: true },
      { reset: "all" },
      { addTitleBlock: true },
    ]) {
      const { call, sent } = setup({ scenes, commands: { "scene-edit": edited } });
      const { isError, data } = await call("edit_scene", { name: "Plan", view: false, ...args });
      expect(isError, JSON.stringify(data)).toBe(false);
      const command = sent.find((c) => c.type === "scene-edit");
      expect(command).toMatchObject(args);
      expect(command.add).toBeUndefined();
    }
  });

  it("refuses an edit with nothing in it (upsert alone changes nothing)", async () => {
    const { call, sent } = setup({ scenes, commands: { "scene-edit": edited } });
    for (const args of [{}, { upsert: true }, { comments: [] }]) {
      const { isError, data } = await call("edit_scene", { name: "Plan", ...args });
      expect(isError).toBe(true);
      expect(data).toMatch(/Nothing to do/);
    }
    expect(sent.some((c) => c.type === "scene-edit")).toBe(false);
  });

  it("live mode: edit_open_scene takes them alone too", async () => {
    const { call, sent } = setup({
      mode: "live",
      commands: {
        read: () => ({ scene: "Plan", elements: [rect("a")], agentBaseline: null }),
        edit: (command: any) => ({ ...edited(command), scene: "Plan", autoSync: true }),
      },
    });
    const { isError } = await call("edit_open_scene", { comments: [{ action: "reply", thread: "t1", text: "Done" }], view: false });
    expect(isError).toBe(false);
    const command = sent.find((c) => c.type === "edit");
    expect(command).toMatchObject({ comments: [{ action: "reply", thread: "t1", text: "Done" }] });
    // a timed-out edit sent again is never applied twice
    expect(command.requestId).toMatch(/^edit-/);
  });

  it("the tab and the MCP agree on what an edit is", () => {
    expect(commentsOnly({ comments: [{ action: "add" }] })).toBe(true);
    expect(commentsOnly({ comments: [{ action: "add" }], isPresentation: false })).toBe(false);
    expect(changesScene({ isPresentation: false })).toBe(true);
    expect(changesScene({ add: [], upsert: true, comments: [{}] })).toBe(false);
    expect(isEmptyEdit({ upsert: true, add: [] })).toBe(true);
    expect(isEmptyEdit({ reset: "all" })).toBe(false);
  });
});

describe("edit_scene: retries and conflicts", () => {
  const base = rect("a");
  const mine = { ...base, backgroundColor: "#a5d8ff", version: 2, versionNonce: stamp++ };

  it("a retry of an edit that landed is neither a conflict nor a user change", async () => {
    const { call, sent } = setup({
      scenes: { Plan: sceneFile([mine]) },
      versions: { m0: sceneFile([base]) },
      commands: { "scene-edit": (command: any) => ({ ...edited(command), alreadyApplied: true }) },
    });
    const { data } = await call("edit_scene", { name: "Plan", basedOn: "m0", requestId: "r1", update: [{ id: "a", backgroundColor: "#a5d8ff" }], view: false });
    expect(sent.find((c) => c.type === "scene-edit")).toMatchObject({ requestId: "r1", update: [{ id: "a", backgroundColor: "#a5d8ff" }] });
    expect(data.alreadyApplied).toBe(true);
    expect(data.warning).toBeUndefined();
    expect(data.conflicts).toBeUndefined();
    expect(data.userChanges).toBeUndefined();
  });

  it("an upsert that replaces an element the user changed is a conflict", async () => {
    const theirs = { ...base, strokeColor: "#e03131", version: 2, versionNonce: stamp++ };
    const { call, sent } = setup({
      scenes: { Plan: sceneFile([theirs]) },
      versions: { m0: sceneFile([base]) },
      commands: { "scene-edit": edited },
    });
    const { data } = await call("edit_scene", { name: "Plan", basedOn: "m0", upsert: true, add: JSON.stringify([rect("a", { x: 50 }), rect("b")]), view: false });
    expect(data.conflicts).toEqual([expect.objectContaining({ id: "a", properties: ["replaced"], resolution: "rejected" })]);
    expect(sent.find((c) => c.type === "scene-edit").add.map((el: any) => el.id)).toEqual(["b"]);
  });

  it("a version that can't be loaded is an error, not 'revision not found'", async () => {
    const { call } = setup({ scenes: { Plan: sceneFile([base]) }, versionStatus: 503, commands: { "scene-edit": edited } });
    const { data } = await call("read_scene", { name: "Plan", since: "m0" });
    expect(data).toMatch(/Drive is not reachable/);
    expect(data).not.toMatch(/not found/);
    const missing = setup({ scenes: { Plan: sceneFile([base]) } });
    expect((await missing.call("read_scene", { name: "Plan", since: "m9" })).data).toMatch(/Revision "m9" of "Plan" not found/);
  });
});

describe("a flush the user's app did not answer", () => {
  const scenes = { Plan: sceneFile([rect("a")]) };

  it("is refused instead of read from (or written to) Google Drive", async () => {
    for (const flush of [{ tabs: 1, results: [{ error: "Timed out" }] }]) {
      const { call, sent } = setup({ scenes, flush, commands: { "scene-edit": edited } });
      expect((await call("read_scene", { name: "Plan" })).data).toMatch(/did not answer \(Timed out\).*unknown whether "Plan" is a local-only scene/);
      expect((await call("edit_scene", { name: "Plan", delete: ["a"] })).isError).toBe(true);
      expect(sent.some((c) => c.type === "scene-edit")).toBe(false);
    }
  });

  it("one tab that answered is enough", async () => {
    const { call } = setup({ scenes, flush: { tabs: 2, results: [{ error: "Timed out" }, { status: "synced" }] } });
    const { data } = await call("read_scene", { name: "Plan", changesOnly: true });
    expect(data.sync).toMatch(/Up to date/);
  });
});

describe("save_scene", () => {
  const comments = [{ id: "c1", thread: "c1", text: "kept" }];
  const fonts = [{ family: "Inter", id: 1000, faces: [] }];

  it("replace keeps the scene's comments and fonts", async () => {
    const { call, puts } = setup({
      scenes: { Plan: sceneFile([rect("a")], { kurviqComments: comments, kurviqFonts: fonts }) },
      commands: { "checkpoint-save": () => ({}) },
    });
    const { data, isError } = await call("save_scene", { name: "Plan", elements: JSON.stringify([rect("b")]), replace: true });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(puts[0].body.kurviqComments).toEqual(comments);
    expect(puts[0].body.kurviqFonts).toEqual(fonts);
    expect(puts[0].body.elements.map((el: any) => el.id)).toEqual(["b"]);
  });

  it("a follow-up that fails after the save is reported in the result, not as an error", async () => {
    const { call } = setup({
      commands: {
        open: () => {
          throw failing("The tab did not answer", 504);
        },
        "checkpoint-save": () => {
          throw failing("The tab did not answer", 504);
        },
      },
    });
    const { data, isError } = await call("save_scene", { name: "New", elements: JSON.stringify([rect("b")]), open: true });
    expect(isError).toBe(false);
    expect(data.saved).toBe("New");
    expect(data.app).toEqual({ error: "The tab did not answer" });
    expect(data.checkpointNote).toMatch(/no checkpoint/);
  });

  it("without Google Drive in the user's app, a new scene is local-only (also locally)", async () => {
    const { call, sent, puts } = setup({ state: { connected: true, drive: false }, commands: { "local-save": () => ({ saved: "New", localOnly: true }), "checkpoint-save": () => ({}) } });
    const { isError } = await call("save_scene", { name: "New", elements: JSON.stringify([rect("b")]) });
    expect(isError).toBe(false);
    expect(sent.some((c) => c.type === "local-save")).toBe(true);
    expect(puts).toEqual([]);
  });

  it("a slow conversion is an error with retry advice (no estimated sizes)", async () => {
    const { call, puts } = setup({
      commands: {
        convert: () => {
          throw failing("The tab did not answer", 504);
        },
      },
    });
    const { data, isError } = await call("save_scene", { name: "New", elements: JSON.stringify([{ type: "text", id: "t", x: 0, y: 0, text: "Hi" }]) });
    expect(isError).toBe(true);
    expect(data).toMatch(/Nothing was saved. Try again/);
    expect(puts).toEqual([]);
  });

  it("the server's error message is passed on, not its raw JSON", async () => {
    const { call } = setup({ sceneError: { status: 503, error: "Google Drive is not connected" } });
    const { data } = await call("save_scene", { name: "New", elements: JSON.stringify([rect("b")]) });
    expect(data).toBe("Error: Google Drive is not connected");
  });
});

describe("checkpoints hold the whole scene", () => {
  const picture = { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" };
  const file = sceneFile([rect("img", { type: "image", fileId: "f1" })], { files: { f1: picture }, appState: { viewBackgroundColor: "#123456" }, kurviqFonts: [{ id: 1000 }] });

  it("get_scene(checkpoint) stores pictures, background and fonts; view_scene and save_scene use them", async () => {
    const checkpoints: Record<string, any> = {};
    const { call, sent, puts } = setup({
      scenes: { Plan: file },
      commands: {
        "checkpoint-save": ({ id, data }: any) => {
          checkpoints[id] = data;
          return {};
        },
        "checkpoint-load": ({ id }: any) => ({ data: checkpoints[id] }),
        render: () => ({ png: "png", renderedBounds: [0, 0, 1, 1] }),
      },
    });
    expect((await call("get_scene", { name: "Plan" })).data.checkpointId).toBeUndefined();
    const { data } = await call("get_scene", { name: "Plan", checkpoint: true });
    expect(checkpoints[data.checkpointId]).toMatchObject({ files: { f1: picture }, appState: { viewBackgroundColor: "#123456" }, kurviqFonts: [{ id: 1000 }] });

    await call("view_scene", { checkpointId: data.checkpointId });
    expect(sent.find((c) => c.type === "render").scene).toMatchObject({ files: { f1: picture }, appState: { viewBackgroundColor: "#123456" } });

    const saved = await call("save_scene", { name: "Copy", checkpointId: data.checkpointId });
    expect(saved.isError, JSON.stringify(saved.data)).toBe(false);
    expect(puts[0].body).toMatchObject({ files: { f1: picture }, appState: { viewBackgroundColor: "#123456", name: "Copy" }, kurviqFonts: [{ id: 1000 }] });
  });
});

describe("list_scenes", () => {
  it("finds local-only scenes by their status, not by their name", async () => {
    const { call } = setup({
      commands: { status: () => ({ scenes: ["my local-only notes: synced", "Secret: local-only (only in the user's browser, never synced to Drive)", { name: "Rows", status: "local-only", localOnly: true }] }) },
    });
    const { data } = await call("list_scenes");
    expect(data.localOnlyScenes).toEqual(["Secret", "Rows"]);
  });
});

describe("tool set per mode", () => {
  it("descriptions name only the tools of their mode", async () => {
    const detached = setup().tools();
    expect(Object.keys(detached)).toContain("read_scene");
    for (const [name, { description }] of Object.entries(detached)) {
      expect(description ?? "", name).not.toMatch(/read_open_scene|edit_open_scene|scenes\/<name>/);
    }
    const live = setup({ mode: "live" }).tools();
    expect(live.get_conflict.description).toMatch(/read_open_scene/);
  });
});
