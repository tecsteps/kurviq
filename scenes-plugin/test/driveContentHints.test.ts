import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INDEX_TEXT_MAX_BYTES, cutAtWord, sceneIndexText } from "../src/online/indexText";
import { ContentHintsCache, base64Length, thumbnailScale, thumbnailTarget, toBase64Url } from "../src/online/contentHints";
import { adminHints, parseHints, pngSize } from "../../online/worker/fakeGoogleHints";

vi.mock("../src/storage", () => ({
  currentSpace: "f:sharedfile12345",
  SPACE_KEY: "kurviq-space",
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = (id: string, words: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", text: words, originalText: words, ...extra });
const frame = (id: string, name: string | null, extra: Record<string, unknown> = {}) => ({ id, type: "frame", name, x: 0, y: 0, width: 1920, height: 1080, ...extra });

describe("the words Drive indexes", () => {
  it("has the scene name, texts, labels, formatted text as plain text and slide titles", () => {
    const rich = { v: 1, p: [{ r: [{ t: "Bold", b: true }, { t: " words" }] }] };
    const elements = [
      frame("f1", "Q3 roadmap", { customData: { slides: { notes: "secret remark" } } }),
      { id: "box", type: "rectangle" },
      text("label", "Box label", { containerId: "box" }),
      text("wrapped", "a long\nwrapped line", { originalText: "a long wrapped line" }),
      text("rich", "Bold words", { customData: { rich } }),
      frame("f2", null),
    ];
    const index = sceneIndexText("Plan", { elements, kurviqComments: [{ text: "a comment" }] } as any);
    expect(index.split("\n")).toEqual(["Plan", "Q3 roadmap", "Box label", "a long wrapped line", "Bold words"]);
    expect(index).not.toContain("secret");
    expect(index).not.toContain("comment");
  });

  it("leaves out deleted elements and labels of deleted shapes, and repeats nothing", () => {
    const elements = [
      text("gone", "deleted words", { isDeleted: true }),
      { id: "box", type: "rectangle", isDeleted: true },
      text("orphan", "orphan label", { containerId: "box" }),
      text("a", "Footer"),
      text("b", "Footer"),
    ];
    expect(sceneIndexText("s", { elements })).toBe("s\nFooter");
  });

  it("cuts at a word boundary within the limit (bytes, not characters)", () => {
    expect(cutAtWord("one two three", 9)).toBe("one two");
    expect(cutAtWord("one two three", 7)).toBe("one two");
    expect(cutAtWord("one two", 100)).toBe("one two");
    expect(cutAtWord("abcdefghij", 4)).toBe("abcd"); // one word longer than the limit
    expect(cutAtWord("äää äää", 7)).toBe("äää"); // ä is two bytes
    const big = Array.from({ length: 30_000 }, (_, i) => `word${i}`).join(" ");
    const cut = sceneIndexText("big", { elements: [text("t", big)] });
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(INDEX_TEXT_MAX_BYTES);
    expect(big.startsWith(cut.slice(4))).toBe(true);
    expect(big[cut.length - 4]).toBe(" ");
  });
});

describe("what the preview shows", () => {
  it("shows a presentation's first slide not skipped, a scene whole, an empty scene not at all", () => {
    const slides = [frame("s1", "One", { customData: { slides: { order: 0, skip: true } } }), frame("s2", "Two", { customData: { slides: { order: 1 } } })];
    expect(thumbnailTarget({ elements: slides, appState: { kurviqPresentation: true } })).toEqual({ frameId: "s2" });
    expect(thumbnailTarget({ elements: slides, appState: { kurviqPresentation: false } })).toEqual({ frameId: null });
    expect(thumbnailTarget({ elements: [text("t", "x", { isDeleted: true })] })).toBeNull();
    expect(thumbnailTarget({ elements: [] })).toBeNull();
  });

  it("is about 400 px wide, at most 800 tall, in URL-safe base64", () => {
    expect(thumbnailScale(2000, 1000) * 2000).toBe(400);
    expect(thumbnailScale(100, 4000) * 4000).toBe(800);
    expect(toBase64Url("ab+/cd==")).toBe("ab-_cd==");
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
  });
});

const png = (n: number) => ({ image: `img${n}`, mimeType: "image/png" });
const scene = (words: string) => JSON.stringify({ elements: [text("t", words)] });

describe("content hints of a save", () => {
  it("renders once per content and sends text and preview", async () => {
    const render = vi.fn(async () => png(1));
    const hints = new ContentHintsCache({ render });
    expect(await hints.forSave("s", scene("hello"), "m1")).toEqual({ indexableText: "s\nhello", thumbnail: png(1) });
    expect(await hints.forSave("s", scene("hello"), "m1")).toEqual({ indexableText: "s\nhello", thumbnail: png(1) });
    expect(render).toHaveBeenCalledTimes(1);
    expect(await hints.forSave("s", JSON.stringify({ elements: [] }), "m2")).toEqual({ indexableText: "s" });
    expect(await hints.forSave("s", "not json", "m3")).toBeNull();
  });

  it("saves without a preview when rendering fails", async () => {
    const hints = new ContentHintsCache({ render: async () => Promise.reject(new Error("no canvas")) });
    expect(await hints.forSave("s", scene("hi"), "m1")).toEqual({ indexableText: "s\nhi" });
  });

  it("doesn't hold up the save: a late preview follows as a metadata change, if Drive still has that content", async () => {
    let finish: (value: any) => void = () => {};
    const hints = new ContentHintsCache({ render: () => new Promise((resolve) => (finish = resolve)), timeBox: 5 });
    expect(await hints.forSave("s", scene("slow"), "m1")).toEqual({ indexableText: "s\nslow" });
    const patch = vi.fn(async () => null);
    hints.afterSave("s", "m1", patch);
    finish(png(1));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledWith({ indexableText: "s\nslow", thumbnail: png(1) }));
  });

  it("drops a late preview of content a newer save replaced", async () => {
    const pending: Array<(value: any) => void> = [];
    const hints = new ContentHintsCache({ render: () => new Promise((resolve) => pending.push(resolve)), timeBox: 5 });
    await hints.forSave("s", scene("old"), "m1");
    const patch = vi.fn(async () => null);
    hints.afterSave("s", "m1", patch);
    await hints.forSave("s", scene("new"), "m2");
    pending[0](png(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(patch).not.toHaveBeenCalled();
    hints.afterSave("s", "m2", patch);
    pending[1](png(2));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledWith({ indexableText: "s\nnew", thumbnail: png(2) }));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("draws a slow scene at most every 2 minutes, sending its last preview in between", async () => {
    let clock = 0;
    let count = 0;
    const render = vi.fn(async () => {
      clock += 1000; // a slow render
      count += 1;
      return png(count);
    });
    vi.useFakeTimers();
    const hints = new ContentHintsCache({ render, now: () => clock, timeBox: 60_000 });
    const patch = vi.fn(async () => null);
    expect((await hints.forSave("s", scene("v1"), "m1"))?.thumbnail).toEqual(png(1));
    hints.afterSave("s", "m1", patch);
    clock += 1000;
    expect((await hints.forSave("s", scene("v2"), "m2"))?.thumbnail).toEqual(png(1));
    hints.afterSave("s", "m2", patch);
    expect((await hints.forSave("s", scene("v3"), "m3"))?.thumbnail).toEqual(png(1));
    hints.afterSave("s", "m3", patch);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(render).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith({ indexableText: "s\nv3", thumbnail: png(2) });
  });
});

describe("a save to Drive carries the content hints", () => {
  const driveWith = (existing: boolean) => {
    const uploads: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal("navigator", {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/auth/token") {
        return new Response(JSON.stringify({ token: "t", expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { email: "a@example.test" }, drive: true }));
      }
      if (url.includes("/upload/")) {
        const body = typeof init?.body === "string" ? init.body : await (init?.body as Blob).text();
        uploads.push({ url, method: init?.method ?? "GET", body });
        return new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: "b".repeat(32) }));
      }
      return new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: existing ? "a".repeat(32) : undefined, ownedByMe: true, capabilities: { canEdit: true } }));
    });
    return uploads;
  };

  it("sends the words to index in the same multipart upload as the content", async () => {
    const uploads = driveWith(true);
    const { driveScenes } = await import("../src/online/drive");
    const json = JSON.stringify({ elements: [text("t", "Q3 roadmap")], appState: { name: "plan" } });
    await driveScenes.save("plan", json, "a".repeat(32), "app:tab");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].method).toBe("PATCH");
    expect(uploads[0].url).toContain("uploadType=multipart");
    const metadata = JSON.parse(uploads[0].body.split("\r\n\r\n")[1].split("\r\n")[0]);
    expect(metadata).toEqual({ contentHints: { indexableText: "plan\nQ3 roadmap" } });
    expect(uploads[0].body).toContain(json);
  });
});

describe("the fake Google's content hints", () => {
  it("checks Drive's limits and URL-safe base64", () => {
    expect(parseHints(undefined)).toBeNull();
    expect(parseHints({ indexableText: "x", thumbnail: { image: "ab-_", mimeType: "image/png" } })).toEqual({ indexableText: "x", thumbnail: { image: "ab-_", mimeType: "image/png" } });
    expect(() => parseHints({ thumbnail: { image: "ab+/", mimeType: "image/png" } })).toThrow(/URL-safe/);
    expect(() => parseHints({ indexableText: "x".repeat(128 * 1024 + 1) })).toThrow(/128 KB/);
    expect(() => parseHints({ thumbnail: { image: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" } })).toThrow(/2 MB/);
  });

  it("reads a PNG's size for the admin view", () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(header.buffer).setUint32(16, 400);
    new DataView(header.buffer).setUint32(20, 225);
    expect(pngSize(header)).toEqual({ width: 400, height: 225 });
    expect(pngSize(new Uint8Array(4))).toBeNull();
    const image = toBase64Url(btoa(String.fromCodePoint(...header)));
    expect(adminHints({ thumb: image, thumb_mime: "image/png", text: "t" })).toMatchObject({ thumbnail: { width: 400, height: 225, bytes: 24 }, indexableText: "t" });
  });
});
