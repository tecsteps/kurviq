// Scene URLs: http://draw.test/<scene name> opens that scene (creating it
// locally if it doesn't exist yet) and the URL follows the current scene.
// Two more kinds open in a viewer above the editor instead (see
// publicScene.tsx): Kurviq's own (kurviq.com/features) and shared ones,
// kurviq.com/s/<fileId>/<name> (a Google Drive file), also through a short
// link kurviq.com/pub/<name>. A shared scene this tab edits (its space, see
// storage.ts) opens in the editor, at the same URL.

import { scenesController } from "./controller";
import { pubNameHolder, sceneElsewhere, sharedFileId } from "./online/drive";
import { offerSharedLookup } from "./online/linkHint";
import { pubNameFromPath } from "./online/pubName";
import { isPublicScene, publicScene } from "./publicScene";
import { deck } from "./deck";
import { getSlides } from "./slides";

/** short links: name → file id (null: none). The page names its file (meta kurviq-pub, see online/worker/shared.ts) */
const pubFiles = new Map<string, string | null>();
{
  const [name, fileId] = (document.querySelector('meta[name="kurviq-pub"]')?.getAttribute("content") ?? "").split(" ");
  if (name && fileId) {
    pubFiles.set(name, fileId);
  }
}

/** a short link the page didn't name (offline start, history): asked for */
const resolvePub = async () => {
  const name = pubNameFromPath(window.location.pathname);
  if (name && !pubFiles.has(name)) {
    pubFiles.set(name, await pubNameHolder(name).catch(() => null));
  }
};

/** /s/<fileId>/<name> or /pub/<name>: a shared scene (the name only makes the link readable) */
const sharedFromPath = (): { fileId: string; name: string } | null => {
  const pub = pubNameFromPath(window.location.pathname);
  if (pub) {
    const fileId = pubFiles.get(pub);
    return fileId ? { fileId, name: pub.replaceAll("-", " ") } : null;
  }
  const match = /^\/s\/([\w-]{10,200})(?:\/([^/]*))?\/?$/.exec(window.location.pathname);
  if (!match) {
    return null;
  }
  try {
    return { fileId: match[1], name: decodeURIComponent(match[2] ?? "").replaceAll("-", " ") };
  } catch {
    return { fileId: match[1], name: "" };
  }
};

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
  return false;
};

const sceneFromPath = (): string | null => {
  if (sharedFromPath() || pubNameFromPath(window.location.pathname)) {
    return null;
  }
  const path = window.location.pathname;
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start++;
  while (end > start && path[end - 1] === "/") end--;
  const raw = path.slice(start, end);
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
  // a shared scene's space keeps its link (the short one, if it came through that)
  if (sharedFileId) {
    const pub = pubNameFromPath(window.location.pathname);
    if (pub && pubFiles.get(pub) === sharedFileId) {
      return name === null ? "/" : window.location.pathname;
    }
    return name === null ? "/" : `/s/${sharedFileId}/${encodeURIComponent(name)}`;
  }
  return name === null ? "/" : `/${encodeURIComponent(name)}`;
};

/**
 * a scene link: the tab's scene of that name, else one shared with the user or in a shared
 * folder (sceneElsewhere), else a new one (with an offer to look among the scenes shared with
 * the user that Kurviq can't see yet)
 */
const navigateTo = (name: string) =>
  scenesController
    .openOrCreate(name, { elsewhere: sceneElsewhere })
    .then((created) => {
      if (created) {
        offerSharedLookup(name);
      }
    })
    .catch((error) => {
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
    const json = await scenesController.localOnlyJson(name); // NOSONAR S9382: in order on purpose (polling and scene removal must finish before proceeding)
    const elements = (JSON.parse(json).elements ?? [])
      .filter((el: any) => !el.isDeleted)
      .map((el: any) => [el.id, Math.round(el.x), Math.round(el.y), Math.round(el.width), Math.round(el.height), el.text ?? ""]);
    let h = 2166136261;
    const text = JSON.stringify(elements);
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619); // NOSONAR S7758: this stored content hash uses UTF-16 code units
    }
    if ((h >>> 0).toString(36) === content) {
      await scenesController.remove(name); // NOSONAR S9382: in order on purpose (polling and scene removal must finish before proceeding)
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
  const search = query ? `?${query}` : "";
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, "", url);
  }
};

/** a scene opened with ?slide=N shows that slide (once the scene is on the canvas) */
const showSlideFromUrl = async () => {
  const params = new URLSearchParams(window.location.search);
  const number = Number(params.get("slide"));
  if (params.has("present") || number < 1 || Number.isNaN(number)) {
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
    await new Promise((resolve) => setTimeout(resolve, 250)); // NOSONAR S9382: in order on purpose (polling and scene removal must finish before proceeding)
  }
};

const openSharedSpace = async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 250)); // NOSONAR S9382: in order on purpose (polling and scene removal must finish before proceeding)
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

  // the browser tab: the open scene's name; the generic title for Untitled (and Kurviq's own public pages)
  const baseTitle = document.title;
  const syncTitle = () => {
    const viewer = publicScene.shown();
    let name: string | null;
    if (viewer) {
      name = viewer.fileId ? viewer.name : null;
    } else {
      name = scenesController.getState().current;
    }
    const title = name ? `${name} · Kurviq` : baseTitle;
    if (document.title !== title) {
      document.title = title;
    }
  };
  scenesController.subscribe(syncTitle);
  publicScene.subscribe(syncTitle);

  await resolvePub();
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
    await openSharedSpace();
  }
  syncUrl("replace");
  syncTitle();
  showSlideFromUrl().catch((error) => console.error("[scenes] could not show linked slide", error));

  // viewer closed: the URL goes back to the current scene (without the viewer's ?present / ?slide)
  publicScene.subscribe(() => {
    if (!publicScene.shown()) {
      const params = new URLSearchParams(window.location.search);
      params.delete("present");
      params.delete("slide");
      const query = params.toString();
      const search = query ? `?${query}` : "";
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
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

  window.addEventListener("popstate", async () => {
    await resolvePub();
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
      void navigateTo(name);
    }
  });
};
