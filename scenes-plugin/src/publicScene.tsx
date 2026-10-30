// Scenes to look at, shown read-only above the editor (slide by slide for
// decks, the whole drawing otherwise). They are not added to the visitor's
// scenes; "Make a copy" does that on purpose.
//  - Kurviq's own (kurviq.com/features): online/scenes/<name>.excalidraw,
//    served at /scenes/<name>.excalidraw
//  - shared ones (kurviq.com/s/<fileId>/…): a Google Drive file, "anyone
//    with the link" without sign-in, else with the visitor's own Drive
//    access (see readSharedScene)

import { exportToCanvas, restoreElements } from "@excalidraw/excalidraw";
import clsx from "clsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { IS_ONLINE } from "./api";
import { scenesController } from "./controller";
import { connectGoogle, connection, enterSpace, pickFiles, readSharedScene, sharedFileId } from "./online/drive";
import type { SharedSceneAnswer } from "./online/drive";
import { registerSceneFonts } from "./fonts";
import { getSlides, renderSlide } from "./slides";

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

type Deck = {
  json: string;
  elements: any[];
  files: BinaryFiles;
  slides: ReturnType<typeof getSlides>;
  /** each shown slide's number in the deck (as the editor counts, backup slides included): the URL's ?slide */
  numbers: number[];
  public?: boolean;
  canEdit?: boolean;
};

/** a drawing without slides is shown as one picture of everything */
const WHOLE = "\u0000whole";

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

const Viewer = ({ name: linkName, fileId, moved, present: startPresenting, slide: startSlide }: Shown) => {
  const bundled = !fileId && !moved;
  const [name, setName] = useState(linkName);
  const title = bundled ? PUBLIC_SCENES[name].title : name || "A shared scene";
  const [deck, setDeck] = useState<Deck | null>(null);
  /** why a shared scene can't be shown (yet) */
  const [missing, setMissing] = useState<Exclude<SharedSceneAnswer, { scene: unknown }> | { moved: true } | null>(
    moved ? { moved: true } : null,
  );
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [copying, setCopying] = useState(false);
  /** slides only (in the window, or fullscreen) */
  const [presenting, setPresenting] = useState(!!startPresenting);
  const [fullscreen, setFullscreen] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pictures = useRef(new Map<number, HTMLCanvasElement>());

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
      .then(async ({ json, public: isPublic, canEdit }) => {
        const data = JSON.parse(json);
        await registerSceneFonts(data);
        const elements = restoreElements(data.elements, null).filter((el) => !el.isDeleted);
        // backup slides ("skip when presenting") stay out of a shared deck
        const all = getSlides(elements);
        const slides = all.filter((frame: any) => !frame.customData?.slides?.skip);
        const numbers = slides.map((frame) => all.indexOf(frame) + 1);
        // ?slide=N names the deck's N-th slide (or the next one shown, if that's a backup slide)
        const start = numbers.findIndex((number) => number >= (startSlide ?? 1));
        setIndex(Math.max(0, start));
        setDeck({
          json,
          elements,
          files: data.files || {},
          slides: slides.length || !elements.length ? slides : [{ id: WHOLE } as any],
          numbers: slides.length ? numbers : [1],
          public: isPublic,
          canEdit,
        });
      })
      .catch((err) => (err.missing ? setMissing(err.missing) : setError(err.message)));
    root.current?.focus();
  }, [fileId, attempt]);

  // the current slide as a picture (cached)
  useEffect(() => {
    if (!deck?.slides[index]) {
      return;
    }
    let cancelled = false;
    const cached = pictures.current.get(index);
    const picture = cached
      ? Promise.resolve(cached)
      : deck.slides[index].id === WHOLE
      ? exportToCanvas({
          elements: deck.elements,
          files: deck.files,
          appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
          exportPadding: 40,
          getDimensions: (w, h) => {
            const width = Math.min(1920, Math.max(960, Math.round(w)));
            return { width, height: Math.round((width * h) / w), scale: width / w };
          },
        })
      : renderSlide(deck.elements, deck.files, deck.slides[index], { width: 1920, background: "#ffffff" });
    picture.then((canvas) => {
      pictures.current.set(index, canvas);
      if (!cancelled && stage.current) {
        stage.current.replaceChildren(canvas);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deck, index]);

  // leaving fullscreen (Esc) ends presenting
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement;
      setFullscreen(on);
      if (!on) {
        setPresenting(false);
        root.current?.focus();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /** fullscreen needs a click or key press: a presentation link starts in the window */
  const enterFullscreen = () => root.current?.requestFullscreen?.().catch(() => {});

  const present = () => {
    setPresenting(true);
    enterFullscreen();
    root.current?.focus();
  };

  const stopPresenting = () => {
    setPresenting(false);
    document.fullscreenElement && document.exitFullscreen().catch(() => {});
    root.current?.focus();
  };

  // the URL says where the deck is (a reload or a copied link starts there)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const number = deck?.numbers[index] ?? startSlide ?? 1;
    number > 1 ? params.set("slide", String(number)) : params.delete("slide");
    presenting ? params.set("present", "") : params.delete("present");
    const query = params.toString().replace(/present=(&|$)/, "present$1");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [index, presenting, deck, startSlide]);

  const count = deck?.slides.length ?? 0;
  const go = (to: number) => setIndex(Math.max(0, Math.min(count - 1, to)));

  const onKeyDown = (event: React.KeyboardEvent) => {
    // the editor below must not see these keys
    event.stopPropagation();
    if (event.key === "Escape") {
      if (presenting) {
        stopPresenting();
      } else {
        publicScene.close();
      }
    } else if ((event.key === "p" || event.key === "F5") && !presenting && deck) {
      event.preventDefault();
      present();
    } else if (event.key === "f" && presenting) {
      event.preventDefault();
      fullscreen ? document.exitFullscreen().catch(() => {}) : enterFullscreen();
    } else if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      go(index + 1);
    } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === "Home") {
      go(0);
    } else if (event.key === "End") {
      go(count - 1);
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
        {fileId && deck && (
          <span className="public-scene__meta">
            {deck.public ? "anyone with the link can view it" : "shared with you in Google Drive"}
          </span>
        )}
        <span className="public-scene__spacer" />
        {deck && count > 0 && (
          <button type="button" className="slides-btn slides-btn--primary" onClick={present} title="Fullscreen (P); arrow keys or click for the next slide, Esc ends">
            ▶ Present
          </button>
        )}
        {fileId && deck?.canEdit && (
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
          disabled={!deck || copying}
          title="Add a copy to your scenes, to change or present it"
          onClick={() => {
            setCopying(true);
            makeCopy(bundled ? PUBLIC_SCENES[name].copyName : name || "Shared scene", deck!.json)
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
      {presenting && (
        <div className="public-scene__controls">
          <span className="public-scene__count">{count ? `${index + 1} / ${count}` : "…"}</span>
          {!fullscreen && (
            <button type="button" className="slides-btn" onClick={enterFullscreen} title="Fullscreen (F)">
              ⛶ Fullscreen
            </button>
          )}
          <button type="button" className="slides-btn" onClick={stopPresenting} title="End the presentation (Esc)">
            ✕
          </button>
        </div>
      )}
      {!missing && (
        <>
          <div className="public-scene__stage" onClick={() => go(index + 1)}>
            <div
              ref={stage}
              className={clsx("public-scene__slide", { "public-scene__slide--whole": deck?.slides[0]?.id === WHOLE })}
            />
          </div>
          {count > 1 && (
            <div className="public-scene__nav">
              <button type="button" className="slides-btn" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous slide">
                ‹
              </button>
              <span className="public-scene__count">{`${index + 1} / ${count}`}</span>
              <button type="button" className="slides-btn" disabled={index >= count - 1} onClick={() => go(index + 1)} aria-label="Next slide">
                ›
              </button>
            </div>
          )}
        </>
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
