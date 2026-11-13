import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-ignore: plain JS module of the MCP tools
import { insideRoot, privateAddress, resolveImages } from "../../scenes-mcp/media.mjs";
import { cleanFeedback } from "../../scenes-mcp/feedback.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

const dataUrl = (mimeType: string, bytes: Buffer) => `data:${mimeType};base64,${bytes.toString("base64")}`;

/** a WebP header: RIFF … WEBP plus one chunk */
const webp = (chunk: string, data: number[]) => {
  const body = Buffer.from([...Buffer.from(chunk, "latin1"), 0, 0, 0, 0, ...data]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), body]);
};
const le16 = (n: number) => [n & 255, n >> 8];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 64, 0, 0, 0, 32])]);

const image = async (src: string, props: Record<string, unknown> = {}) => {
  const { elements } = await resolveImages([{ type: "image", id: "i", x: 0, y: 0, src, ...props }]);
  return elements[0];
};

describe("image sizes", () => {
  it("reads lossy (VP8) and lossless (VP8L) WebP", async () => {
    const lossy = webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]);
    expect(await image(dataUrl("image/webp", lossy))).toMatchObject({ width: 400, height: 300 });
    // 14 bits each: width - 1 = 299, height - 1 = 149
    const bits = 299 | (149 << 14);
    const lossless = webp("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]);
    expect(await image(dataUrl("image/webp", lossless), { width: 600 })).toMatchObject({ width: 600, height: 300 });
  });

  it("reads SVG sizes in single quotes", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 20'></svg>");
    expect(await image(dataUrl("image/svg+xml", svg), { height: 10 })).toMatchObject({ width: 20, height: 10 });
  });

  it("an unknown size: a square default, or both sides needed", async () => {
    const unknown = dataUrl("image/webp", Buffer.from("RIFF0000WEBPXXXX"));
    expect(await image(unknown)).toMatchObject({ width: 200, height: 200 });
    expect(await image(unknown, { width: 80, height: 30 })).toMatchObject({ width: 80, height: 30 });
    await expect(image(unknown, { width: 800 })).rejects.toThrow(/give both/);
  });
});

describe("images from the web", () => {
  it("never from this machine or a private network, also not after a redirect", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3101/api/scenes" } }));
    await expect(image("http://localhost:3101/x.png")).rejects.toThrow(/private network/);
    await expect(image("http://[::1]/x.png")).rejects.toThrow(/private network/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(image("https://images.invalid/x.png")).rejects.toThrow(/private network/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the server's type decides (the extension only for a generic type), and the bytes must be an image", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("<html>secret</html>", { headers: { "content-type": "text/html" } }));
    await expect(image("https://images.invalid/x.png")).rejects.toThrow(/not an image \(text\/html\)/);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not a picture", { headers: { "content-type": "application/octet-stream" } }));
    await expect(image("https://images.invalid/x.png")).rejects.toThrow(/not an image/);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { headers: { "content-type": "application/octet-stream" } }));
    expect(await image("https://images.invalid/x.png")).toMatchObject({ width: 64, height: 32 });
  });

  it("knows private addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:7f00:1", "::ffff:192.168.0.1"]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:808:808"]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });
});

describe("local files", () => {
  it("are inside the root, also when the root is /", () => {
    expect(insideRoot("/", "/Users/me/a.png")).toBe(true);
    expect(insideRoot("/work", "/work/a.png")).toBe(true);
    expect(insideRoot("/work", "/work")).toBe(true);
    expect(insideRoot("/work", "/work/..dots.png")).toBe(true);
    expect(insideRoot("/work", "/other/a.png")).toBe(false);
    expect(insideRoot("/work", "/workshop/a.png")).toBe(false);
  });
});

describe("feedback text", () => {
  const report = (text: string) => cleanFeedback({ kind: "bug", title: "Lost my drawing", text });

  it("takes the plain word data: and refuses data and script URLs", () => {
    expect(report("Lost data: the scene was empty after reload").ok).toBe(true);
    expect(report("The language javascript: is not involved here").ok).toBe(true);
    expect(report("Try data:text/html;base64,PHNjcmlwdD4= please").ok).toBe(false);
    expect(report("Click javascript:alert(1) to see it").ok).toBe(false);
  });
});
