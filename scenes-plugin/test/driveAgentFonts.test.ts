import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage", () => ({
  currentSpace: "f:sharedfile12345",
  SPACE_KEY: "kurviq-space",
}));

// the font registry of this tab: Inter (id 1000) is known here
const inter = { family: "Inter", id: 1000, faces: [{ src: "data:font/woff2;base64,AA" }], source: "google" };
vi.mock("../src/fonts", () => ({
  withFonts: (json: string, elements: any[]) =>
    elements.some((el) => el.fontFamily === 1000) ? `${json.slice(0, json.lastIndexOf("}"))},"kurviqFonts":${JSON.stringify([inter])}}` : json,
  mergeFontLists: (...lists: unknown[]) => {
    const merged = new Map<number, any>();
    lists.filter(Array.isArray).flat().forEach((font: any) => merged.set(font.id, font));
    return merged.size ? [...merged.values()] : undefined;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const md5 = "a".repeat(32);

const driveWith = () => {
  const uploads: string[] = [];
  vi.stubGlobal("navigator", {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/auth/token") {
      return new Response(JSON.stringify({ token: "t", expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { email: "a@example.test" }, drive: true }));
    }
    if (init?.method === "PATCH" && url.includes("uploadType=media")) {
      uploads.push(String(init.body));
      return new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: "b".repeat(32) }));
    }
    return new Response(JSON.stringify({ id: "sharedfile12345", name: "plan.excalidraw", md5Checksum: md5, ownedByMe: true, capabilities: { canEdit: true } }));
  });
  return uploads;
};

describe("an agent's scene carries the custom fonts it uses", () => {
  it("adds the fonts of this tab the elements use, keeps the ones sent along", async () => {
    const uploads = driveWith();
    const { driveScenes } = await import("../src/online/drive");
    const scene = { type: "excalidraw", elements: [{ id: "t", type: "text", fontFamily: 1000 }], appState: { name: "plan" }, kurviqFonts: [{ family: "Other", id: 1001, faces: [] }] };
    await driveScenes.save("plan", JSON.stringify(scene, null, 2), md5, "agent");
    expect(JSON.parse(uploads[0]).kurviqFonts.map((font: any) => font.id)).toEqual([1001, 1000]);
  });

  it("leaves the app's own saves and scenes without custom fonts as they are", async () => {
    const uploads = driveWith();
    const { driveScenes } = await import("../src/online/drive");
    const plain = JSON.stringify({ elements: [{ id: "t", type: "text", fontFamily: 5 }], appState: { name: "plan" } }, null, 2);
    await driveScenes.save("plan", plain, md5, "agent");
    const app = JSON.stringify({ elements: [{ id: "t", type: "text", fontFamily: 1000 }], appState: { name: "plan" } }, null, 2);
    await driveScenes.save("plan", app, md5, "app:tab");
    expect(uploads).toEqual([plain, app]);
  });
});
