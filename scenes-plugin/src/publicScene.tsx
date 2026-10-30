// Scenes to look at, shown read-only above the editor (slide by slide for
// decks, the whole drawing otherwise). They are not added to the visitor's
// scenes; "Make a copy" does that on purpose.
//  - Kurviq's own (kurviq.com/features): online/scenes/<name>.excalidraw,
//    served at /scenes/<name>.excalidraw
//  - shared ones (kurviq.com/s/<fileId>/…): a Google Drive file, "anyone
//    with the link" without sign-in, else with the visitor's own Drive
//    access (see readSharedScene)

import { CaptureUpdateAction, Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import clsx from "clsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { IS_ONLINE } from "./api";
import { scenesController } from "./controller";
import { connectGoogle, connection, enterSpace, pickFiles, readSharedScene, sharedFileId, sharedSceneVersion } from "./online/drive";
import type { SharedSceneAnswer } from "./online/drive";
import { registerSceneFonts } from "./fonts";
import { getSlides } from "./slides";
import { deck } from "./deck";
import { presenter, usePresenter } from "./present";

export const PUBLIC_SCENES: Record<string, { title: string; copyName: string }> = IS_ONLINE
  ? { features: { title: "What Kurviq adds to Excalidraw", copyName: "Kurviq features" } }
  : {};

export const isPublicScene = (name: string | null): name is string => !!name && name in PUBLIC_SCENES;

// -----------------------------------------------------------------------------
// open / close (the router follows: URL /<name> while open)
// -----------------------------------------------------------------------------

/**
 * A bundled scene (name), or a shared one (its Drive file; name: from the
 * link, until it is loaded), or an old kind of link (moved: kurviq.com/@owner/scene).
 * present / slide: a presentation link (?present&slide=3) starts presenting
 * at that slide.
 */
export type Shown = { name: string; fileId?: string; moved?: boolean; present?: boolean; slide?: number };

let shown: Shown | null = null;
const listeners = new Set<() => void>();
const setShown = (next: Shown | null) => {
  shown = next;
  listeners.forEach((listener) => listener());
};

export const publicScene = {
  show: (name: string, start: { fileId?: string; moved?: boolean; present?: boolean; slide?: number } = {}) =>
    setShown({ name, ...start }),
  close: () => setShown(null),
  shown: () => shown,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const fetchScene = (name: string) =>
  fetch(`/scenes/${encodeURIComponent(name)}.excalidraw`).then((res) => {
    if (!res.ok) {
      throw new Error(`Could not load "${name}" (${res.status})`);
    }
    return res.text();
  });

/** a local-only copy in the visitor's scenes, opened */
const makeCopy = async (base: string, json: string) => {
  for (let n = 1; n < 50; n++) {
    const copy = n === 1 ? base : `${base} ${n}`;
    try {
      await scenesController.createLocalOnly(copy, json);
    } catch (error: any) {
      if (error.status === 409) {
        continue;
      }
      throw error;
    }
    // signed in with Google, the copy goes to the visitor's Drive too
    if (connection.isActive() && !sharedFileId) {
      await scenesController.setLocalOnly(copy, false).catch(() => {});
    }
    publicScene.close();
    await scenesController.open(copy);
    return;
  }
};

// -----------------------------------------------------------------------------
// the viewer
// -----------------------------------------------------------------------------

type Scene = {
  json: string;
  elements: any[];
  files: BinaryFiles;
  background: string;
  /** the slides a presentation shows (backup slides left out) */
  slides: ReturnType<typeof getSlides>;
  /** each shown slide's number in the deck (as the editor counts, backup slides included): the URL's ?slide */
  numbers: number[];
  public?: boolean;
  canEdit?: boolean;
};

/**
 * Edit a shared scene: one of the visitor's own scenes opens among them,
 * someone else's in a space of its own (the page reloads into it)
 */
const editShared = async (fileId: string, name: string) => {
  const own = scenesController.getState().remote?.find((scene) => scene.fileId === fileId);
  publicScene.close();
  if (own && !sharedFileId) {
    await scenesController.open(own.name);
    return;
  }
  await scenesController.leaveForReload();
  enterSpace(fileId, window.location.pathname.startsWith("/s/") ? window.location.pathname : `/s/${fileId}/${encodeURIComponent(name)}`);
};

const parseScene = async (json: string, access: { public?: boolean; canEdit?: boolean }): Promise<Scene> => {
  const data = JSON.parse(json);
  await registerSceneFonts(data);
  const elements = restoreElements(data.elements, null).filter((el) => !el.isDeleted);
  // backup slides ("skip when presenting") stay out of a presentation
  const all = getSlides(elements);
  const slides = all.filter((frame: any) => !frame.customData?.slides?.skip);
  return {
    json,
    elements,
    files: data.files || {},
    background: data.appState?.viewBackgroundColor || "#ffffff",
    slides,
    numbers: slides.map((frame) => all.indexOf(frame) + 1),
    ...access,
  };
};

/**
 * How often an open shared scene checks for changes (only while the tab is
 * visible): every 10 s at first and after a change, slower while nothing
 * changes, up to once a minute (each check is a Worker request: the free plan
 * has 100,000 a day)
 */
const REFRESH_MIN_MS = 10_000;
const REFRESH_MAX_MS = 60_000;

const Viewer = ({ name: linkName, fileId, moved, present: startPresenting, slide: startSlide }: Shown) => {
  const bundled = !fileId && !moved;
  const [name, setName] = useState(linkName);
  const title = bundled ? PUBLIC_SCENES[name].title : name || "A shared scene";
  const [scene, setScene] = useState<Scene | null>(null);
  /** why a shared scene can't be shown (yet) */
  const [missing, setMissing] = useState<Exclude<SharedSceneAnswer, { scene: unknown }> | { moved: true } | null>(
    moved ? { moved: true } : null,
  );
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (moved) {
      return;
    }
    setMissing(null);
    const load = fileId
      ? readSharedScene(fileId).then((answer) => {
          if (!("scene" in answer)) {
            return Promise.reject(Object.assign(new Error(""), { missing: answer }));
          }
          if (answer.scene.name) {
            setName(answer.scene.name);
          }
          return answer.scene;
        })
      : fetchScene(name).then((json) => ({ json, public: true, canEdit: false }));
    load
      .then(async ({ json, public: isPublic, canEdit }) => setScene(await parseScene(json, { public: isPublic, canEdit })))
      .catch((err) => (err.missing ? setMissing(err.missing) : setError(err.message)));
    root.current?.focus();
  }, [fileId, attempt]);

  // the scene on a read-only canvas; while it is shown it is the deck, so
  // Present runs the editor's own presentation on it
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Excalidraw's render throttle is one per page: with the editor and this
  // canvas both drawing, frames of one of them were dropped (stale after a zoom)
  useEffect(() => {
    const before = (window as any).EXCALIDRAW_THROTTLE_RENDER;
    (window as any).EXCALIDRAW_THROTTLE_RENDER = false;
    return () => {
      (window as any).EXCALIDRAW_THROTTLE_RENDER = before;
    };
  }, []);
  // read before the viewer borrows the deck: the editor's own setting
  const [editorWheel] = useState(() => {
    const live = deck.getApi()?.getAppState().inputDevice;
    if (live) {
      return live;
    }
    // the editor isn't up yet (the link was opened directly): its saved settings
    try {
      return JSON.parse(localStorage.getItem("excalidraw-state") || "{}").inputDevice as AppState["inputDevice"] | undefined;
    } catch {
      return undefined;
    }
  });
  const presenting = usePresenter().active;
  useEffect(() => {
    if (!api) {
      return;
    }
    const giveBack = deck.borrow(api);
    // the whole scene in view (as big as it fits)
    const fit = setTimeout(
      () => api.setViewport({ target: api.getSceneElements(), fit: "contain", offsets: { top: 48, bottom: 64, left: 48, right: 48 } }),
      100,
    );
    return () => {
      clearTimeout(fit);
      presenter.stop();
      giveBack();
    };
  }, [api]);

  // the owner (or anyone allowed) changes it: this view follows, where the visitor looks stays
  const version = useRef<string | null>(null);
  useEffect(() => {
    if (!fileId || !api || !scene) {
      return;
    }
    let stopped = false;
    let busy = false;
    let delay = REFRESH_MIN_MS;
    let timer = 0;
    sharedSceneVersion(fileId).then((v) => (version.current ??= v));
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(check, delay);
    };
    const check = async () => {
      if (busy || stopped) {
        return;
      }
      if (document.visibilityState !== "visible") {
        return; // a hidden tab doesn't ask; coming back checks right away
      }
      busy = true;
      try {
        const latest = await sharedSceneVersion(fileId);
        if (!latest || latest === version.current) {
          delay = Math.min(REFRESH_MAX_MS, Math.round(delay * 1.5));
          return;
        }
        delay = REFRESH_MIN_MS;
        const answer = await readSharedScene(fileId, { version: latest });
        if (stopped || !("scene" in answer)) {
          return;
        }
        const next = await parseScene(answer.scene.json, { public: answer.scene.public, canEdit: answer.scene.canEdit });
        version.current = latest;
        api.addFiles(Object.values(next.files));
        api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.NEVER });
        setScene(next);
      } catch {
        // offline for a moment: the next check tries again
      } finally {
        busy = false;
        if (!stopped) {
          schedule();
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        delay = REFRESH_MIN_MS;
        check();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fileId, api, !!scene]);

  const slideId = (number: number | undefined) => {
    if (!scene || !number) {
      return undefined;
    }
    return scene.slides[scene.numbers.findIndex((n) => n >= number)]?.id;
  };

  const present = (number?: number) => {
    if (api && scene?.slides.length) {
      presenter.start(slideId(number));
    }
  };

  // a presentation link starts presenting (fullscreen needs a click: F, or the button)
  const started = useRef(false);
  useEffect(() => {
    if (api && scene && startPresenting && !started.current) {
      started.current = true;
      // the canvas has its size and the fonts are in
      setTimeout(() => present(startSlide), 300);
    }
  }, [api, scene]);

  // the URL says whether it is presented (a reload or a copied link does the same)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (presenting === params.has("present")) {
      return;
    }
    presenting ? params.set("present", "") : params.delete("present");
    const query = params.toString().replace(/present=(&|$)/, "present$1");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [presenting]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // the editor below must not see these keys
    event.stopPropagation();
    if (presenter.getState().active) {
      return; // the presentation has its own keys
    }
    if (event.key === "Escape") {
      publicScene.close();
    } else if ((event.key === "p" || event.key === "F5") && scene?.slides.length) {
      event.preventDefault();
      present();
    }
  };

  return (
    <div
      ref={root}
      className={clsx("public-scene", { "public-scene--presenting": presenting })}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="public-scene__bar">
        <strong className="public-scene__title">{title}</strong>
        {fileId && scene && (
          <span className="public-scene__meta">
            {scene.public ? "anyone with the link can view it" : "shared with you in Google Drive"}
          </span>
        )}
        <span className="public-scene__spacer" />
        {scene && scene.slides.length > 0 && (
          <button
            type="button"
            className="slides-btn slides-btn--primary"
            disabled={!api}
            onClick={() => present()}
            title="Present the slides (P); arrow keys or click for the next slide, Esc ends"
          >
            ▶ Present
          </button>
        )}
        {fileId && scene?.canEdit && (
          <button
            type="button"
            className="slides-btn"
            title="Google Drive lets you change this scene: open it in the editor (your changes are saved to it)"
            onClick={() => editShared(fileId, name).catch((err) => setError(err.message))}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="slides-btn"
          disabled={!scene || copying}
          title="Add a copy to your scenes, to change or present it"
          onClick={() => {
            setCopying(true);
            makeCopy(bundled ? PUBLIC_SCENES[name].copyName : name || "Shared scene", scene!.json)
              .catch((err) => setError(err.message))
              .finally(() => setCopying(false));
          }}
        >
          {copying ? "Copying…" : "Make a copy"}
        </button>
        <button type="button" className="slides-btn" onClick={() => publicScene.close()} title="Esc">
          Back to my drawings
        </button>
      </div>
      {error && <p className="scenes-error public-scene__error">{error}</p>}
      {missing && (
        <div className="public-scene__missing">
          <WhyMissing why={missing} fileId={fileId} retry={() => setAttempt((n) => n + 1)} />
        </div>
      )}
      {!missing && scene && (
        <div className="public-scene__canvas">
          <Excalidraw
            onExcalidrawAPI={setApi}
            initialData={{
              elements: scene.elements,
              files: scene.files,
              appState: {
                viewBackgroundColor: scene.background,
                viewModeEnabled: true,
                // the wheel does what it does in the visitor's editor (zoom with a mouse)
                ...(editorWheel ? { inputDevice: editorWheel } : {}),
              },
              scrollToContent: true,
            }}
            viewModeEnabled
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: null } }}
          />
        </div>
      )}
    </div>
  );
};

/** a shared scene that isn't shown: why, and what the visitor can do */
const WhyMissing = ({
  why,
  fileId,
  retry,
}: {
  why: Exclude<SharedSceneAnswer, { scene: unknown }> | { moved: true };
  fileId?: string;
  retry: () => void;
}) => {
  const [error, setError] = useState<string | null>(null);
  if ("moved" in why) {
    return (
      <p>
        This link is from an older version of Kurviq and doesn't work any more. Kurviq now keeps scenes in Google Drive:
        ask whoever sent it for a new link.
      </p>
    );
  }
  if ("signIn" in why) {
    return (
      <>
        <p>This scene isn't public. Sign in with Google: you see it if it was shared with you.</p>
        <button type="button" className="slides-btn slides-btn--primary" onClick={() => connectGoogle()}>
          Sign in with Google
        </button>
      </>
    );
  }
  if ("needsAccess" in why) {
    return (
      <>
        <p>
          Google Drive asks you to allow Kurviq to open this scene, once. Click below, then <strong>Select</strong> in
          Google's window.
        </p>
        <button
          type="button"
          className="slides-btn slides-btn--primary"
          onClick={() =>
            pickFiles({ fileId })
              .then((ids) => ids.length && retry())
              .catch((err) => setError(err.message))
          }
        >
          Allow Kurviq to open it
        </button>
        <p className="kq-muted">If Google doesn't show the scene there, it wasn't shared with this Google account.</p>
        {error && <p className="scenes-error">{error}</p>}
      </>
    );
  }
  return <p>This scene doesn't exist (any more), or it isn't shared with you.</p>;
};

/** rendered next to the editor (see index.tsx) */
export const PublicSceneOverlay = () => {
  const current = useSyncExternalStore(publicScene.subscribe, publicScene.shown);
  if (!current || (!current.fileId && !current.moved && !isPublicScene(current.name))) {
    return null;
  }
  return <Viewer key={current.fileId ?? current.name} {...current} />;
};
