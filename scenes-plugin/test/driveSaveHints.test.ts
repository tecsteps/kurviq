import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage", () => ({
  currentSpace: "f:sharedfile12345",
  SPACE_KEY: "kurviq-space",
}));

// Drive's preview and search words for every save (the real ones need a DOM to render)
vi.mock("../src/online/contentHints", () => ({
  contentHints: {
    forSave: () => Promise.resolve({ indexableText: { text: "plan words" } }),
    afterSave: () => undefined,
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const md5 = "a".repeat(32);

/** Drive that refuses uploads carrying content hints (400) and takes plain ones */
const driveRefusingHints = () => {
  const uploads: string[] = [];
  vi.stubGlobal("navigator", {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/auth/token") {
      return new Response(JSON.stringify({ token: "t", expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { email: "a@example.test" }, drive: true }));
    }
    if (init?.method === "PATCH" && url.includes("/upload/")) {
      const multipart = url.includes("uploadType=multipart");
      uploads.push(multipart ? "multipart" : "media");
      return multipart
        ? new Response(JSON.stringify({ error: { message: "Invalid contentHints" } }), { status: 400 })
        : new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: "b".repeat(32) }));
    }
    return new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: md5, ownedByMe: true, capabilities: { canEdit: true } }));
  });
  return uploads;
};

describe("a save never fails because of Drive's preview or search words", () => {
  it("Drive refuses the hints: the scene is saved again without them", async () => {
    const uploads = driveRefusingHints();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { driveScenes } = await import("../src/online/drive");
    const scene = JSON.stringify({ type: "excalidraw", elements: [{ id: "r", type: "rectangle" }], appState: { name: "plan" } }, null, 2);
    const saved = await driveScenes.save("plan", scene, md5, "app:tab");
    expect(uploads).toEqual(["multipart", "media"]);
    expect(saved).toMatchObject({ md5: "b".repeat(32), changed: true });
  });
});
