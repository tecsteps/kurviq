// Present mode: the slides of the open scene, fullscreen, right in the
// editor (view mode, UI hidden, camera locked on the slide). Steps reveal
// elements per click through render overrides, so nothing in the scene
// changes while presenting. The presenter view is a second window rendered
// from here (same JS context).

import { CaptureUpdateAction, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

import { PRESENTING_KEY, deck } from "./deck";
import { elementStep, getSlides, getTheme, slideData } from "./slides";

import type { Frame } from "./slides";
import type { AppState } from "@excalidraw/excalidraw/types";

type PresentState = {
  active: boolean;
  /** position in the shown (not skipped) slides */
  index: number;
  step: number;
  black: boolean;
  overview: boolean;
  laser: boolean;
  startedAt: number;
  presenterOpen: boolean;
  /** the camera is flying to the slide (masks hidden meanwhile) */
  moving: boolean;
};

const REVEAL_MS = 450;
const GLIDE_MS = 750;

class Presenter {
  state: PresentState = {
    active: false,
    index: 0,
    step: 0,
    black: false,
    overview: false,
    laser: true,
    startedAt: 0,
    presenterOpen: false,
    moving: false,
  };
  private listeners = new Set<() => void>();
  private saved: Partial<AppState> | null = null;
  private wasFullscreen = false;
  private moveTimer = 0;
  private revealFrame = 0;
  presenterWindow: Window | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private set(patch: Partial<PresentState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private api() {
    const api = deck.getApi();
    if (!api) {
      throw new Error("Editor not ready");
    }
    return api;
  }

  /** the slides shown in this presentation (skipped ones left out) */
  shown(): Frame[] {
    return getSlides(this.api().getSceneElements()).filter((frame) => !slideData(frame).skip);
  }

  stepsOf(frame: Frame) {
    let max = 0;
    for (const el of this.api().getSceneElements()) {
      if (el.frameId === frame.id) {
        max = Math.max(max, slideData(el).step ?? 0);
      }
    }
    return max;
  }

  start = (fromSlideId?: string) => {
    const api = this.api();
    const slides = this.shown();
    if (!slides.length) {
      return;
    }
    const appState = api.getAppState();
    this.saved = {
      viewModeEnabled: appState.viewModeEnabled,
      zenModeEnabled: appState.zenModeEnabled,
      gridModeEnabled: appState.gridModeEnabled,
      frameRendering: appState.frameRendering,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      openSidebar: appState.openSidebar,
    };
    deck.paused = true;
    api.updateScene({
      appState: {
        viewModeEnabled: true,
        zenModeEnabled: true,
        gridModeEnabled: false,
        frameRendering: { enabled: true, name: false, outline: false, clip: true },
        selectedElementIds: {},
        openSidebar: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    document.body.classList.add("slides-presenting");
    try {
      localStorage.setItem(PRESENTING_KEY, "1");
    } catch {}
    this.wasFullscreen = false;
    document.documentElement
      .requestFullscreen?.()
      .then(() => {
        this.wasFullscreen = true;
      })
      .catch(() => {});
    const index = Math.max(0, slides.findIndex((s) => s.id === fromSlideId));
    this.set({ active: true, index, step: 0, black: false, overview: false, startedAt: Date.now() });
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("fullscreenchange", this.onFullscreen);
    // the viewport resizes with fullscreen: show the slide once that settled
    setTimeout(() => this.show({ animate: false }), 150);
    setTimeout(() => this.setLaser(this.state.laser), 200);
  };

  stop = () => {
    if (!this.state.active) {
      return;
    }
    const api = this.api();
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("fullscreenchange", this.onFullscreen);
    cancelAnimationFrame(this.revealFrame);
    api.setElementRenderOverrides(null);
    api.setViewport(null);
    api.setActiveTool({ type: "selection" });
    api.updateScene({ appState: (this.saved || {}) as any, captureUpdate: CaptureUpdateAction.NEVER });
    document.body.classList.remove("slides-presenting");
    try {
      localStorage.removeItem(PRESENTING_KEY);
    } catch {}
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    deck.paused = false;
    this.presenterWindow?.close();
    this.presenterWindow = null;
    this.set({ active: false, overview: false, black: false, presenterOpen: false });
  };

  /** fullscreen on / off, window resized: fit the slide again */
  private resizeTimer = 0;
  private onResize = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.state.active && this.show({ animate: false }), 120);
  };

  private onFullscreen = () => {
    if (!document.fullscreenElement && this.wasFullscreen) {
      this.stop(); // Esc in fullscreen ends the presentation
    }
  };

  /** camera on the current slide; hide what is not revealed yet */
  private show({ animate = true }: { animate?: boolean } = {}) {
    const api = this.api();
    const frame = this.shown()[this.state.index];
    if (!frame) {
      return;
    }
    const glide = animate && getTheme(api.getSceneElements()).transition === "glide";
    api.setViewport({
      target: frame,
      fit: "contain",
      lock: { scroll: true, zoom: true, overscroll: false },
      animation: glide ? { duration: GLIDE_MS } : false,
    });
    clearTimeout(this.moveTimer);
    this.set({ moving: glide });
    if (glide) {
      this.moveTimer = window.setTimeout(() => this.set({ moving: false }), GLIDE_MS + 50);
    }
    this.applySteps(null);
  }

  /** render overrides for steps; `reveal`: the step that animates in now */
  private applySteps(reveal: number | null) {
    const api = this.api();
    const frame = this.shown()[this.state.index];
    cancelAnimationFrame(this.revealFrame);
    if (!frame) {
      return;
    }
    const elements = api.getSceneElements();
    const byId = new Map(elements.map((el) => [el.id, el]));
    const stepOf = (el: any) => elementStep(el, byId);
    const items = elements.filter((el) => el.frameId === frame.id && stepOf(el) > 0);
    const build = (progress: number) => {
      const overrides = new Map<string, { opacity?: number; offset?: { x: number; y: number } }>();
      for (const el of items) {
        const step = stepOf(el);
        if (step > this.state.step) {
          overrides.set(el.id, { opacity: 0 });
        } else if (step === reveal && progress < 1) {
          const eased = 1 - (1 - progress) ** 3;
          overrides.set(el.id, {
            opacity: el.opacity * eased,
            ...((el as any).containerId ? {} : { offset: { x: 0, y: 24 * (1 - eased) } }),
          });
        }
      }
      api.setElementRenderOverrides(overrides);
    };
    if (reveal === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      build(1);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / REVEAL_MS);
      build(progress);
      if (progress < 1) {
        this.revealFrame = requestAnimationFrame(tick);
      }
    };
    this.revealFrame = requestAnimationFrame(tick);
  }

  go = (index: number, { built = false } = {}) => {
    const slides = this.shown();
    if (!slides.length) {
      return;
    }
    const next = Math.max(0, Math.min(slides.length - 1, index));
    this.set({ index: next, step: built ? this.stepsOf(slides[next]) : 0, black: false, overview: false });
    this.show({ animate: true });
  };

  next = () => {
    const frame = this.shown()[this.state.index];
    if (frame && this.state.step < this.stepsOf(frame)) {
      this.set({ step: this.state.step + 1, black: false });
      this.applySteps(this.state.step);
    } else if (this.state.index < this.shown().length - 1) {
      this.go(this.state.index + 1);
    }
  };

  prev = () => {
    if (this.state.step > 0) {
      this.set({ step: this.state.step - 1, black: false });
      this.applySteps(null);
    } else if (this.state.index > 0) {
      this.go(this.state.index - 1, { built: true });
    }
  };

  setLaser = (on: boolean) => {
    this.api().setActiveTool({ type: on ? "laser" : "hand" });
    this.set({ laser: on });
  };

  toggleBlack = () => this.set({ black: !this.state.black });
  toggleOverview = () => this.set({ overview: !this.state.overview });

  openPresenterView = () => {
    if (this.presenterWindow && !this.presenterWindow.closed) {
      this.presenterWindow.focus();
      return;
    }
    const win = window.open("", "excalidraw-presenter", "width=1180,height=760");
    if (!win) {
      return;
    }
    win.document.title = "Presenter view";
    win.document.body.innerHTML = "";
    const style = win.document.createElement("style");
    style.textContent = PRESENTER_CSS;
    win.document.head.appendChild(style);
    win.addEventListener("keydown", this.onKey, true);
    win.addEventListener("beforeunload", () => {
      this.presenterWindow = null;
      this.set({ presenterOpen: false });
    });
    this.presenterWindow = win;
    this.set({ presenterOpen: true });
  };

  private digits = "";

  onKey = (event: KeyboardEvent) => {
    if (!this.state.active) {
      return;
    }
    const key = event.key;
    let handled = true;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(key) && !(key === "Enter" && this.digits)) {
      this.next();
    } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(key)) {
      this.prev();
    } else if (key === "Home") {
      this.go(0);
    } else if (key === "End") {
      this.go(this.shown().length - 1);
    } else if (/^[0-9]$/.test(key)) {
      this.digits += key;
    } else if (key === "Enter" && this.digits) {
      this.go(Number(this.digits) - 1);
      this.digits = "";
    } else if (key === "b" || key === "." ) {
      this.toggleBlack();
    } else if (key === "g") {
      this.toggleOverview();
    } else if (key === "l" || key === "k") {
      this.setLaser(!this.state.laser);
    } else if (key === "Escape") {
      if (this.state.overview) {
        this.set({ overview: false });
      } else {
        this.stop();
      }
    } else {
      handled = false;
    }
    if (!/^[0-9]$/.test(key) && key !== "Enter") {
      this.digits = "";
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

export const presenter = new Presenter();

export const usePresenter = () => useSyncExternalStore(presenter.subscribe, presenter.getState);

// -----------------------------------------------------------------------------
// overlay: letterbox masks, controls, black screen, overview
// -----------------------------------------------------------------------------

/** the current slide's rectangle on screen, following the camera */
const useSlideRect = (active: boolean, index: number) => {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    let frameId = 0;
    const loop = () => {
      const api = deck.getApi();
      const frame = presenter.shown()[index];
      if (api && frame) {
        const appState = api.getAppState();
        const a = sceneCoordsToViewportCoords({ sceneX: frame.x, sceneY: frame.y }, appState);
        const b = sceneCoordsToViewportCoords({ sceneX: frame.x + frame.width, sceneY: frame.y + frame.height }, appState);
        setRect((prev) =>
          prev && Math.abs(prev.x - a.x) < 0.5 && Math.abs(prev.y - a.y) < 0.5 && Math.abs(prev.w - (b.x - a.x)) < 0.5
            ? prev
            : { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y },
        );
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [active, index]);
  return rect;
};

const useIdle = (active: boolean, ms = 2200) => {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!active) {
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    window.addEventListener("pointermove", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
    };
  }, [active, ms]);
  return idle;
};

export const PresentationOverlay = () => {
  const state = usePresenter();
  const deckState = useSyncExternalStore(deck.subscribe, deck.getState);
  const rect = useSlideRect(state.active, state.index);
  const idle = useIdle(state.active);
  if (!state.active) {
    return null;
  }
  const shown = deckState.slides.filter((s) => !s.skip);
  const total = shown.length;
  const current = shown[state.index];
  const masks = rect && (
    <div className={clsx("slides-masks", { "slides-masks--moving": state.moving })}>
      <div style={{ left: 0, top: 0, right: 0, height: Math.max(0, rect.y) }} />
      <div style={{ left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }} />
      <div style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }} />
      <div style={{ left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }} />
    </div>
  );
  return createPortal(
    <>
      {masks}
      {state.black && <div className="slides-black" onClick={presenter.toggleBlack} />}
      {state.overview && (
        <div className="slides-overview" role="dialog" aria-label="All slides">
          <div className="slides-overview__grid">
            {shown.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                className={clsx("slides-overview__item", { "slides-overview__item--on": i === state.index })}
                onClick={() => presenter.go(i)}
              >
                {deckState.thumbs[slide.id] ? <img src={deckState.thumbs[slide.id]} alt="" /> : <span className="slides-overview__blank" />}
                <span>
                  {i + 1}. {slide.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={clsx("slides-hud", { "slides-hud--idle": idle && !state.overview })}>
        <button type="button" title="Previous (←)" onClick={presenter.prev}>
          ‹
        </button>
        <span className="slides-hud__count">
          {state.index + 1} / {total}
          {current?.steps ? <small> · {state.step}/{current.steps}</small> : null}
        </span>
        <button type="button" title="Next (→, Space)" onClick={presenter.next}>
          ›
        </button>
        <span className="slides-hud__sep" />
        <button
          type="button"
          className={clsx({ "slides-hud__on": state.laser })}
          title="Laser pointer (L)"
          onClick={() => presenter.setLaser(!state.laser)}
        >
          Laser
        </button>
        <button type="button" title="All slides (G)" onClick={presenter.toggleOverview}>
          Overview
        </button>
        <button type="button" title="Presenter view: notes, next slide, timer" onClick={presenter.openPresenterView}>
          Presenter
        </button>
        <button type="button" title="End (Esc)" onClick={presenter.stop}>
          End
        </button>
      </div>
      {state.presenterOpen && presenter.presenterWindow && <PresenterView win={presenter.presenterWindow} />}
    </>,
    document.body,
  );
};

// -----------------------------------------------------------------------------
// presenter view (second window)
// -----------------------------------------------------------------------------

const useClock = () => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const PresenterView = ({ win }: { win: Window }) => {
  const state = usePresenter();
  const deckState = useSyncExternalStore(deck.subscribe, deck.getState);
  const now = useClock();
  const shown = deckState.slides.filter((s) => !s.skip);
  const current = shown[state.index];
  const next = shown[state.index + 1];
  const elapsed = Math.floor((now - state.startedAt) / 1000);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const notesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    notesRef.current?.scrollTo(0, 0);
  }, [state.index]);
  return createPortal(
    <div className="pv">
      <div className="pv__main">
        <div className="pv__label">
          Now · {state.index + 1} / {shown.length}
          {current?.steps ? ` · step ${state.step} of ${current.steps}` : ""}
        </div>
        {current && deckState.thumbs[current.id] ? <img src={deckState.thumbs[current.id]} alt="" /> : <div className="pv__blank" />}
        <div className="pv__title">{current?.title}</div>
      </div>
      <div className="pv__side">
        <div className="pv__timer">
          <span>{clock}</span>
          <small>{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
        </div>
        <div>
          <div className="pv__label">Next</div>
          {next ? (
            deckState.thumbs[next.id] ? <img className="pv__next" src={deckState.thumbs[next.id]} alt="" /> : <div className="pv__blank" />
          ) : (
            <div className="pv__end">End of the deck</div>
          )}
          {next && <div className="pv__title">{next.title}</div>}
        </div>
        <div className="pv__notes-wrap">
          <div className="pv__label">Notes</div>
          <div className="pv__notes" ref={notesRef}>
            {current?.notes || <em>No notes for this slide.</em>}
          </div>
        </div>
        <div className="pv__buttons">
          <button type="button" onClick={presenter.prev}>‹ Back</button>
          <button type="button" onClick={presenter.next}>Next ›</button>
          <button type="button" onClick={presenter.toggleBlack}>{state.black ? "Unblank" : "Black"}</button>
        </div>
      </div>
    </div>,
    win.document.body,
  );
};

const PRESENTER_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #141418; color: #ececf3; font: 15px/1.5 Assistant, system-ui, sans-serif; }
  .pv { display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; padding: 24px; height: 100vh; box-sizing: border-box; }
  .pv__main, .pv__side { display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
  .pv img { width: 100%; border-radius: 6px; background: #fff; display: block; }
  .pv__blank { aspect-ratio: 16/9; background: #26262e; border-radius: 6px; }
  .pv__label { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #9a9ab0; }
  .pv__title { font-weight: 600; }
  .pv__timer { display: flex; align-items: baseline; justify-content: space-between; }
  .pv__timer span { font: 600 40px/1 ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
  .pv__timer small { color: #9a9ab0; font-size: 16px; }
  .pv__end { padding: 24px; border: 1px dashed #3a3a46; border-radius: 6px; color: #9a9ab0; text-align: center; }
  .pv__notes-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
  .pv__notes { flex: 1; overflow: auto; font-size: 20px; line-height: 1.45; white-space: pre-wrap; }
  .pv__notes em { color: #9a9ab0; font-size: 15px; }
  .pv__buttons { display: flex; gap: 8px; }
  .pv__buttons button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #3a3a46; background: #222229; color: inherit; font: inherit; cursor: pointer; }
  .pv__buttons button:hover { background: #2d2d36; }
`;
(window as any).__presenter = presenter;
