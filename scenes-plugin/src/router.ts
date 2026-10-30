// Scene URLs: http://draw.test/<scene name> opens that scene (creating it
// locally if it doesn't exist yet) and the URL follows the current scene.
// Two more kinds open in a viewer above the editor instead (see
// publicScene.tsx): Kurviq's own (kurviq.com/features) and shared ones,
// kurviq.com/s/<fileId>/<name> (a Google Drive file). A shared scene this tab
// edits (its space, see storage.ts) opens in the editor, at the same URL.

import { IS_ONLINE } from "./api";
import { scenesController } from "./controller";
import { sharedFileId } from "./online/drive";
import { isPublicScene, publicScene } from "./publicScene";
import { deck } from "./deck";
import { getSlides } from "./slides";

/** /s/<fileId>/<name>: a shared scene (the name only makes the link readable) */
const sharedFromPath = (): { fileId: string; name: string } | null => {
  const match = window.location.pathname.match(/^\/s\/([\w-]{10,200})(?:\/([^/]*))?\/?$/);
  if (!match) {
    return null;
  }
  try {
    return { fileId: match[1], name: decodeURIComponent(match[2] ?? "").replace(/-/g, " ") };
  } catch {
    return { fileId: match[1], name: "" };
  }
};

/** /@owner/scene: a link of the time scenes were on GitHub */
const isOldSharedPath = () => IS_ONLINE && /^\/(?:@|%40)[A-Za-z0-9-]{1,39}\/.+/i.test(window.location.pathname);

/** a presentation link: ?present (and &slide=3) */
const presentFromSearch = () => {
  const params = new URLSearchParams(window.location.search);
  const slide = Number(params.get("slide"));
  return { present: params.has("present"), ...(slide >= 1 ? { slide } : {}) };
};

/**
 * The shared scene this tab edits (its space) opens in the editor, unless
 * the link is a presentation link: that one is presented for everyone.
 */
const isThisSpace = (fileId: string) => !presentFromSearch().present && sharedFileId === fileId;

/** show a shared link's scene in the viewer (true), or leave it to the editor */
const showShared = () => {
  const shared = sharedFromPath();
  if (shared && !isThisSpace(shared.fileId)) {
    publicScene.show(shared.name, { fileId: shared.fileId, ...presentFromSearch() });
    return true;
  }
  if (isOldSharedPath()) {
    publicScene.show("", { moved: true });
    return true;
  }
  return false;
};

const sceneFromPath = (): string | null => {
  if (sharedFromPath() || isOldSharedPath()) {
    return null;
  }
  const raw = window.location.pathname.replace(/^\/+|\/+$/g, "");
  if (!raw) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

const pathFor = (name: string | null) => {
  // a shared scene's space keeps its link
  if (sharedFileId) {
    return name === null ? "/" : `/s/${sharedFileId}/${encodeURIComponent(name)}`;
  }
  return name === null ? "/" : `/${encodeURIComponent(name)}`;
};

const navigateTo = (name: string) =>
  scenesController.openOrCreate(name).catch((error) => {
    console.error(`[scenes] could not open "${name}" from URL`, error);
  });

/** open a public scene from a link in the app (e.g. the welcome screen) */
export const openPublicScene = (name: string) => {
  if (window.location.pathname !== pathFor(name)) {
    window.history.pushState(null, "", pathFor(name));
  }
  publicScene.show(name);
};

/**
 * Until 22 Oct 2026 a visit to /features put a local-only copy "features"
 * into the visitor's scenes. It goes again if the visitor didn't change it.
 */
const removeOldPublicCopies = async () => {
  const KEY = "kurviq-public-scenes";
  let seeded: Record<string, { content: string }> = {};
  try {
    seeded = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {}
  for (const [name, { content }] of Object.entries(seeded)) {
    if (!scenesController.isLocalOnly(name)) {
      continue;
    }
    const json = await scenesController.localOnlyJson(name);
    const elements = (JSON.parse(json).elements ?? [])
      .filter((el: any) => !el.isDeleted)
      .map((el: any) => [el.id, Math.round(el.x), Math.round(el.y), Math.round(el.width), Math.round(el.height), el.text ?? ""]);
    let h = 2166136261;
    const text = JSON.stringify(elements);
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    if ((h >>> 0).toString(36) === content) {
      await scenesController.remove(name);
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {}
};

/** ?slide=N: the slide picked last in the slide list, so the link can be bookmarked */
export const setSlideParam = (number: number | null) => {
  const params = new URLSearchParams(window.location.search);
  if (params.has("present") || publicScene.shown()) {
    return;
  }
  if (number) {
    params.set("slide", String(number));
  } else {
    params.delete("slide");
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, "", url);
  }
};

/** a scene opened with ?slide=N shows that slide (once the scene is on the canvas) */
const showSlideFromUrl = async () => {
  const params = new URLSearchParams(window.location.search);
  const number = Number(params.get("slide"));
  if (params.has("present") || !(number >= 1)) {
    return;
  }
  for (let tries = 0; tries < 40; tries++) {
    const api = deck.getApi();
    const slide = api && getSlides(api.getSceneElements())[number - 1];
    if (api && slide) {
      api.setViewport({ target: slide, fit: "contain", offsets: { ui: true } });
      deck.setActive(slide.id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

let connected = false;

export const connectRouter = async () => {
  if (connected) {
    return;
  }
  connected = true;

  const syncUrl = (mode: "push" | "replace") => {
    const { current, busy } = scenesController.getState();
    if (busy === "loading" || publicScene.shown()) {
      return;
    }
    const path = pathFor(current);
    if (window.location.pathname !== path) {
      const url = `${path}${window.location.search}${window.location.hash}`;
      if (mode === "push") {
        window.history.pushState(null, "", url);
      } else {
        window.history.replaceState(null, "", url);
      }
    }
  };

  const target = sceneFromPath();
  // right away, the editor loads underneath
  if (!showShared() && isPublicScene(target)) {
    publicScene.show(target, presentFromSearch());
  }

  await scenesController.ready;
  await removeOldPublicCopies().catch((error) => console.error("[scenes] removing old public copies", error));

  if (target !== null && !isPublicScene(target)) {
    await navigateTo(target);
  } else if (sharedFileId && sharedFromPath()?.fileId === sharedFileId) {
    // this space's one scene (its name comes from Drive, with the first sync)
    for (let tries = 0; tries < 120; tries++) {
      const { list, remote, current } = scenesController.getState();
      const name = list.find((item) => item.name !== null)?.name ?? remote?.[0]?.name;
      if (name) {
        if (name !== current) {
          await navigateTo(name);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  syncUrl("replace");
  showSlideFromUrl();

  // viewer closed: the URL goes back to the current scene (without the viewer's ?present / ?slide)
  publicScene.subscribe(() => {
    if (!publicScene.shown()) {
      const params = new URLSearchParams(window.location.search);
      params.delete("present");
      params.delete("slide");
      const query = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
    syncUrl("replace");
  });

  let lastCurrent = scenesController.getState().current;
  scenesController.subscribe(() => {
    const { current, busy } = scenesController.getState();
    if (busy === "loading" || current === lastCurrent) {
      return;
    }
    lastCurrent = current;
    // another scene: the slide number was the last one's
    setSlideParam(null);
    syncUrl("push");
  });

  window.addEventListener("popstate", () => {
    if (showShared()) {
      return;
    }
    const name = sceneFromPath();
    if (isPublicScene(name)) {
      publicScene.show(name, presentFromSearch());
      return;
    }
    if (publicScene.shown()) {
      publicScene.close();
    }
    if (name !== null && name !== scenesController.getState().current) {
      navigateTo(name);
    }
  });
};
