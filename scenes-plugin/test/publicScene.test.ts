// The Worker's side of public scenes (online/worker/shared.ts): it never
// serves a scene's content (the viewer reads it from Drive in the browser),
// only the name and version for link previews, uncached.
import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePublicApi, publicMeta } from "../../online/worker/shared";

const FILE = "file0123456789abcdef";
const env = { GOOGLE_API_KEY: "test-key" } as any;

const driveAnswers = (status: number, body: unknown) => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/public/<fileId>", () => {
  it("answers a public scene's name, author and version, never its content, uncached", async () => {
    const calls = driveAnswers(200, {
      name: "Plan.excalidraw",
      mimeType: "application/vnd.excalidraw+json",
      md5Checksum: "0123456789abcdef0123456789abcdef",
      properties: { kurviqBy: " Anna\u0007 " },
    });
    const res = await handlePublicApi(new Request(`https://kurviq.com/api/public/${FILE}`), env)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ name: "Plan", by: "Anna", version: "0123456789abcdef0123456789abcdef" });
    // only metadata is asked for: no alt=media
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fields=name,mimeType,md5Checksum,properties");
    expect(calls[0]).not.toContain("alt=media");
  });

  it("answers the version alone, and 404 for what isn't a public scene", async () => {
    driveAnswers(200, { name: "Plan.excalidraw", mimeType: "application/vnd.excalidraw+json", md5Checksum: "abc" });
    const version = await handlePublicApi(new Request(`https://kurviq.com/api/public/${FILE}/version`), env)!;
    expect(await version.json()).toEqual({ version: "abc" });

    driveAnswers(200, { name: "Notes.txt", mimeType: "text/plain" });
    expect((await handlePublicApi(new Request(`https://kurviq.com/api/public/${FILE}`), env)!).status).toBe(404);
    driveAnswers(404, { error: { code: 404 } });
    expect((await handlePublicApi(new Request(`https://kurviq.com/api/public/${FILE}`), env)!).status).toBe(404);
  });

  it("is no route for other paths, and refuses bad ids and methods", async () => {
    expect(handlePublicApi(new Request("https://kurviq.com/api/pub/x"), env)).toBeNull();
    expect((await handlePublicApi(new Request("https://kurviq.com/api/public/bad"), env)!).status).toBe(404);
    expect((await handlePublicApi(new Request(`https://kurviq.com/api/public/${FILE}`, { method: "POST" }), env)!).status).toBe(404);
  });

  it("knows nothing without Kurviq's API key", async () => {
    expect(await publicMeta(FILE, {} as any)).toBeNull();
  });
});
