import { describe, expect, it } from "vitest";
import { buildSceneFile, plainOf } from "../../online/worker/serverMerge";
import {
  encodeEvent,
  importSceneKey,
  toBase64,
} from "../src/online/liveCrypto";
import type { EventKind } from "../src/online/liveProtocol";

const meta = { op: "save", receipts: {}, authors: {}, onBehalf: [] };
const subjects = (entries: Array<[EventKind, any]>) =>
  new Map(entries.map(([k, value]) => [`${k}:${value.id}`, { k, value }]));

describe("Drive scene integrity", () => {
  it("saves readable references rather than encrypted references", async () => {
    const key = await importSceneKey(
      toBase64(new Uint8Array(32)),
      "key",
      "file"
    );
    const event = await encodeEvent(
      key,
      "el",
      "arrow",
      {
        id: "arrow",
        type: "arrow",
        version: 1,
        versionNonce: 1,
        startBinding: { elementId: "old", gap: 4 },
        groupIds: ["old-group"],
        frameId: "old-frame",
      },
      null
    );
    const value = await plainOf(key, {
      ...event,
      r: {
        ...event.r!,
        startId: "new",
        groupIds: ["new-group"],
        frameId: null,
      },
      v: 2,
      n: 3,
      a: null,
      seq: 1,
    });
    expect(value.startBinding).toEqual({ elementId: "new", gap: 4 });
    expect(value.groupIds).toEqual(["new-group"]);
    expect(value.frameId).toBeNull();
  });
  it("cuts deleted graph references but preserves live references and their types", () => {
    const plain = subjects([
      [
        "el",
        {
          id: "arrow",
          index: "a0",
          type: "arrow",
          frameId: "gone",
          startBinding: { elementId: "gone" },
          endBinding: { elementId: "label", gap: 2 },
          boundElements: [{ id: "gone" }, { id: "label", type: "arrow" }],
        },
      ],
      ["el", { id: "gone", type: "rectangle", isDeleted: true }],
      ["el", { id: "label", index: "a1", type: "text" }],
    ]);
    const saved = JSON.parse(buildSceneFile(plain, meta).json);
    expect(saved.elements.map((el: any) => el.id)).toEqual(["arrow", "label"]);
    expect(saved.elements[0]).toMatchObject({
      frameId: null,
      startBinding: null,
      endBinding: { elementId: "label", gap: 2 },
      boundElements: [{ id: "label", type: "text" }],
    });
  });
  it("retains live and preuploaded assets, drops assets used only by deleted elements", () => {
    const plain = subjects([
      [
        "el",
        {
          id: "live",
          type: "image",
          index: "a0",
          fileId: "used",
          fontFamily: 2001,
        },
      ],
      [
        "el",
        { id: "gone", isDeleted: true, fileId: "deleted", fontFamily: 2002 },
      ],
      ...["used", "deleted", "ahead"].map((id): [EventKind, any] => [
        "file",
        { id, dataURL: `data:${id}` },
      ]),
      ...[2001, 2002, 2003].map((id): [EventKind, any] => [
        "font",
        { id, family: `Font${id}`, faces: [] },
      ]),
    ]);
    const saved = JSON.parse(buildSceneFile(plain, meta).json);
    expect(saved.files).toEqual({
      used: { id: "used", dataURL: "data:used" },
      ahead: { id: "ahead", dataURL: "data:ahead" },
    });
    expect(saved.kurviqFonts.map((f: any) => f.id).sort()).toEqual([
      2001, 2003,
    ]);
  });
});
