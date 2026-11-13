import { describe, expect, it } from "vitest";

import {
  exportBrowserScenes,
  importBrowserScenes,
  moveFileText,
  parseMoveFileText,
  snapshotDbOf,
  type MoveStorage,
} from "../src/browserMove";

const UNTITLED = "\u0000untitled";

/** a browser's storage in memory */
const browser = (local: Record<string, string> = {}, dbs: Record<string, Record<string, unknown>> = {}) => {
  const storage: MoveStorage = {
    localKeys: () => Object.keys(local),
    getLocal: (key) => local[key] ?? null,
    setLocal: (key, value) => {
      local[key] = value;
    },
    entries: (db, store) => Promise.resolve(Object.entries(dbs[`${db}/${store}`] ?? {})),
    put: (db, store, entries) => {
      dbs[`${db}/${store}`] = { ...dbs[`${db}/${store}`], ...Object.fromEntries(entries) };
      return Promise.resolve();
    },
  };
  return { storage, local, dbs };
};

const meta = (scenes: Record<string, object>, current: string | null = null) =>
  JSON.stringify({ current, baseline: 7, autoSync: true, scenes, pendingDeletes: {} });
const snap = (text: string) => ({ json: JSON.stringify({ elements: [{ id: text, type: "text", text }] }), baseline: null, dirty: true });
const sceneText = (db: Record<string, unknown> | undefined, name: string) => JSON.parse((db?.[name] as any).json).elements[0].text;

const SPACE = "excalidraw-scenes@a:anna@example.test";

const oldSite = () =>
  browser(
    {
      "excalidraw-scenes": meta({ Sketch: { baseMd5: null, localOnly: true, dirty: true }, [UNTITLED]: { baseMd5: null, dirty: true } }),
      [SPACE]: meta({ Plan: { baseMd5: "abc", fileId: "f1" }, Open: { baseMd5: null, localOnly: true, dirty: false } }, "Open"),
      "kurviq-scene-groups": '{"folder:x":true}',
      "kurviq-google-session": "refresh-token-never-moves",
      "kurviq-space": "f:shared",
      "kurviq-own-space": "a:anna@example.test",
      excalidraw: "[]",
    },
    {
      [`${snapshotDbOf("excalidraw-scenes")}/snapshots`]: { Sketch: snap("sketch"), [UNTITLED]: snap("untitled") },
      [`${snapshotDbOf(SPACE)}/snapshots`]: { Plan: snap("plan") },
      "kurviq-fonts/fonts": { "font-1": { id: "font-1", family: "Inter", data: new Uint8Array([1, 2, 3]).buffer } },
    },
  );

const moved = async (target = browser()) => {
  const source = oldSite();
  const open = { metaKey: SPACE, name: "Open", snapshot: snap("open scene") };
  const text = await moveFileText(await exportBrowserScenes(source.storage, open, "http://draw.test"));
  const result = await importBrowserScenes(target.storage, parseMoveFileText(text));
  return { target, result, text };
};

describe("moving the browser's scenes to another site", () => {
  it("every space's scenes arrive with their content, the open one included", async () => {
    const { target, result } = await moved();
    const own = target.dbs[`${snapshotDbOf(SPACE)}/snapshots`];
    expect(sceneText(own, "Plan")).toBe("plan");
    expect(sceneText(own, "Open")).toBe("open scene");
    const signedOut = target.dbs[`${snapshotDbOf("excalidraw-scenes")}/snapshots`];
    expect(sceneText(signedOut, "Sketch")).toBe("sketch");
    expect(sceneText(signedOut, "Untitled")).toBe("untitled");
    expect(result.scenes).toBe(4);
  });

  it("Drive scenes keep their link to Drive; the lists name no open scene (the new site's editor decides)", async () => {
    const { target } = await moved();
    const list = JSON.parse(target.local[SPACE]);
    expect(list.scenes.Plan).toMatchObject({ baseMd5: "abc", fileId: "f1" });
    expect(list.current).toBeNull();
    expect(JSON.parse(target.local["excalidraw-scenes"]).scenes[UNTITLED]).toBeUndefined();
  });

  it("fonts arrive as bytes; settings move, sign-ins and the open shared scene don't", async () => {
    const { target, text } = await moved();
    const font = target.dbs["kurviq-fonts/fonts"]["font-1"] as any;
    expect([...new Uint8Array(font.data)]).toEqual([1, 2, 3]);
    expect(target.local["kurviq-scene-groups"]).toBe('{"folder:x":true}');
    expect(target.local["kurviq-own-space"]).toBe("a:anna@example.test");
    expect(target.local["kurviq-google-session"]).toBeUndefined();
    expect(target.local["kurviq-space"]).toBeUndefined();
    expect(text).not.toContain("refresh-token-never-moves");
  });

  it("nothing on the new site is overwritten: a scene of the same name gets a free name, its open scene stays open", async () => {
    const target = browser(
      { [SPACE]: meta({ Plan: { baseMd5: "zzz", fileId: "f9" } }, "Plan"), "kurviq-scene-groups": "{}" },
      { [`${snapshotDbOf(SPACE)}/snapshots`]: { Plan: snap("new site's plan") } },
    );
    const { result } = await moved(target);
    const own = target.dbs[`${snapshotDbOf(SPACE)}/snapshots`];
    expect(sceneText(own, "Plan")).toBe("new site's plan");
    const renamed = result.renamed.find(([from]) => from === "Plan")?.[1] ?? "";
    expect(renamed).not.toBe("Plan");
    expect(sceneText(own, renamed)).toBe("plan");
    const list = JSON.parse(target.local[SPACE]);
    expect(list.current).toBe("Plan");
    expect(list.scenes.Plan.fileId).toBe("f9");
    expect(list.scenes[renamed]).toMatchObject({ localOnly: true });
    expect(target.local["kurviq-scene-groups"]).toBe("{}");
  });

  it("refuses files that aren't move files", () => {
    expect(() => parseMoveFileText("not json")).toThrow(/not a Kurviq browser scenes file/);
    expect(() => parseMoveFileText('{"format":"other"}')).toThrow(/not a Kurviq browser scenes file/);
    expect(() => parseMoveFileText('{"format":"kurviq-browser-scenes","version":1,"spaces":[{"metaKey":"evil","meta":{},"snapshots":[]}],"fonts":[]}')).toThrow(/damaged/);
  });

  it("user data that looks like a tag stays itself", async () => {
    const target = browser();
    const source = browser({ "excalidraw-scenes": meta({ X: { baseMd5: null, localOnly: true } }) }, {
      [`${snapshotDbOf("excalidraw-scenes")}/snapshots`]: { X: { json: "{}", baseline: null, dirty: true, extra: { $kq: "u8", b64: "AA==" } } },
    });
    const text = await moveFileText(await exportBrowserScenes(source.storage, null, "x"));
    await importBrowserScenes(target.storage, parseMoveFileText(text));
    expect((target.dbs[`${snapshotDbOf("excalidraw-scenes")}/snapshots`].X as any).extra).toEqual({ $kq: "u8", b64: "AA==" });
  });
});
