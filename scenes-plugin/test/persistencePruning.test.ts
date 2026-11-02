import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCheckpoint, setCheckpoint } from "../src/storage";
import { getUpload, keepUpload, withUploads } from "../src/uploads";

afterEach(() => vi.unstubAllGlobals());

describe("bounded persistence", () => {
  it("keeps the latest 200 checkpoints under concurrent writes", async () => {
    await Promise.all(
      Array.from({ length: 201 }, (_, i) => setCheckpoint(`prune-${i}`, { i }))
    );
    expect(await getCheckpoint("prune-0")).toBeNull();
    expect(await getCheckpoint("prune-1")).toEqual({ i: 1 });
    expect(await getCheckpoint("prune-200")).toEqual({ i: 200 });
  });
  it("bounds live revisions per file without pruning another file", async () => {
    await setCheckpoint("live-rev:other:1", "other");
    await Promise.all(
      Array.from({ length: 13 }, (_, i) =>
        setCheckpoint(`live-rev:file:${i}`, i)
      )
    );
    expect(await getCheckpoint("live-rev:file:0")).toBeNull();
    expect(await getCheckpoint("live-rev:file:1")).toBe(1);
    expect(await getCheckpoint("live-rev:file:12")).toBe(12);
    expect(await getCheckpoint("live-rev:other:1")).toBe("other");
  });
  it("keeps 100 uploads and resolves retained bytes and aspect ratio", async () => {
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 80;
        naturalHeight = 40;
        onload = () => {};
        set src(_value: string) {
          queueMicrotask(() => this.onload());
        }
      }
    );
    const id = (i: number) => i.toString(16).padStart(40, "0");
    await Promise.all(
      Array.from({ length: 101 }, (_, i) =>
        keepUpload({
          id: id(i),
          mimeType: "image/png",
          dataURL: "data:image/png;base64,YQ==",
        })
      )
    );
    expect(await getUpload(id(0))).toBeUndefined();
    expect(await getUpload(id(1))).toMatchObject({
      id: id(1),
      width: 80,
      height: 40,
    });
    const resolved = await withUploads([
      { id: "image", type: "image", fileId: id(100), width: 160 },
    ]);
    expect(resolved.elements[0]).toMatchObject({
      width: 160,
      height: 80,
      status: "saved",
    });
    expect(resolved.files[id(100)].dataURL).toBe("data:image/png;base64,YQ==");
    expect(await getUpload("upload-index")).toBeUndefined();
  });
});
