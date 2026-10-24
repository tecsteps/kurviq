// Runtime of the slides feature in the user's tab: keeps template copies in
// sync, sets the deck theme as the editor's defaults, and offers the deck
// (slides, template, theme, thumbnails) as a store for the UI.

import { CaptureUpdateAction, hashString } from "@excalidraw/excalidraw";

import { scenesController } from "./controller";
import {
  DEFAULT_THEME,
  getSlides,
  getTemplate,
  getTheme,
  renderSlide,
  slideData,
  slideVersion,
  syncTemplate,
  templateKey,
  themeDefaults,
} from "./slides";

import type { DeckTheme, Frame } from "./slides";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type SlideInfo = {
  id: string;
  title: string;
  index: number;
  skip: boolean;
  template: boolean;
  notes: string;
  steps: number;
  frame: Frame;
  version: number;
};

export type DeckState = {
  slides: SlideInfo[];
  templateId: string | null;
  theme: DeckTheme;
  /** slide id -> picture (data URL) */
  thumbs: Record<string, string>;
  /** selected element ids (non-frames) and the slide they are on */
  selection: string[];
  /** the slide of the selection, or the selected frame */
  activeId: string | null;
};

const THUMB_WIDTH = 480;

/** set while a presentation runs (see present.tsx): a page that went away mid-presentation is cleaned up */
export const PRESENTING_KEY = "kurviq-presenting";

class Deck {
  private api: ExcalidrawImperativeAPI | null = null;
  private listeners = new Set<() => void>();
  private lastKey = "";
  private lastTemplateKey = 0;
  private lastThemeKey = "";
  private syncTimer = 0;
  private thumbTimer = 0;
  private thumbVersions = new Map<string, number>();
  /** paused while presenting (nothing is edited then) */
  paused = false;

  state: DeckState = { slides: [], templateId: null, theme: DEFAULT_THEME, thumbs: {}, selection: [], activeId: null };
  private lastSelection = "";

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<DeckState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  attach(api: ExcalidrawImperativeAPI) {
    if (this.api === api) {
      return;
    }
    this.api = api;
    // the page went away during a presentation (reload, update): Excalidraw
    // keeps zen mode, which would hide the whole editor UI from now on
    try {
      if (localStorage.getItem(PRESENTING_KEY)) {
        localStorage.removeItem(PRESENTING_KEY);
        api.updateScene({ appState: { zenModeEnabled: false } });
      }
    } catch {}
    api.onChange((elements, appState) => {
      this.onChange(elements);
      this.onSelection(elements, appState.selectedElementIds);
    });
    this.onChange(api.getSceneElementsIncludingDeleted());
  }

  getApi() {
    return this.api;
  }

  private onSelection(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, true>>) {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    const key = ids.join(",");
    if (key === this.lastSelection) {
      return;
    }
    this.lastSelection = key;
    const byId = new Map(elements.map((el) => [el.id, el]));
    const chosen = ids.map((id) => byId.get(id)).filter((el): el is ExcalidrawElement => !!el && !el.isDeleted);
    const frame = chosen.find((el) => el.type === "frame");
    const activeId = frame?.id ?? chosen.find((el) => el.frameId)?.frameId ?? this.state.activeId;
    this.set({ selection: chosen.filter((el) => el.type !== "frame").map((el) => el.id), activeId });
  }

  setActive(id: string | null) {
    this.set({ activeId: id });
  }

  private deckName() {
    return scenesController.getState().current ?? "Untitled";
  }

  private onChange(elements: readonly ExcalidrawElement[]) {
    // slide list (cheap key over frames and stepped elements)
    let key = "";
    let stepped = "";
    for (const el of elements) {
      if (el.type === "frame") {
        key += `${el.id}:${el.version}:${el.isDeleted ? 1 : 0},`;
      } else if (!el.isDeleted && slideData(el).step) {
        stepped += `${el.id}:${slideData(el).step}:${el.frameId},`;
      }
    }
    key += `|${stepped}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.rebuild(elements);
    }
    if (this.state.slides.length || this.state.templateId) {
      this.scheduleThumbs();
      this.scheduleTemplateSync();
    }
  }

  private rebuild(elements: readonly ExcalidrawElement[]) {
    const slides = getSlides(elements);
    const template = getTemplate(elements);
    const steps = new Map<string, number>();
    for (const el of elements) {
      const step = slideData(el).step;
      if (!el.isDeleted && step && el.frameId) {
        steps.set(el.frameId, Math.max(steps.get(el.frameId) ?? 0, step));
      }
    }
    const theme = getTheme(elements);
    this.set({
      slides: slides.map((frame, index) => {
        const data = slideData(frame);
        return {
          id: frame.id,
          title: frame.name?.trim() || `Slide ${index + 1}`,
          index,
          skip: !!data.skip,
          template: data.template !== false,
          notes: data.notes ?? "",
          steps: steps.get(frame.id) ?? 0,
          frame,
          version: frame.version,
        };
      }),
      templateId: template?.id ?? null,
      theme,
    });
    // the deck's style is the default for new elements (once per scene + theme)
    const themeKey = template ? `${this.deckName()}:${hashString(JSON.stringify(theme))}` : "";
    if (themeKey && themeKey !== this.lastThemeKey && this.api) {
      this.lastThemeKey = themeKey;
      const api = this.api;
      setTimeout(() => api.updateScene({ appState: themeDefaults(theme) as any, captureUpdate: CaptureUpdateAction.NEVER }));
    }
    if (!template) {
      this.lastThemeKey = "";
    }
  }

  // ---------------------------------------------------------------------------
  // template sync: copies follow the template (debounced, not while editing)
  // ---------------------------------------------------------------------------

  private scheduleTemplateSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.runTemplateSync(), 300);
  }

  runTemplateSync({ reset }: { reset?: Set<string> } = {}) {
    const api = this.api;
    if (!api || this.paused) {
      return;
    }
    const appState = api.getAppState();
    if (
      !reset &&
      (appState.viewModeEnabled ||
        appState.newElement ||
        appState.editingTextElement ||
        appState.resizingElement ||
        appState.selectedElementsAreBeingDragged)
    ) {
      this.scheduleTemplateSync(); // try again when the user is done
      return;
    }
    const elements = api.getSceneElementsIncludingDeleted();
    const key = templateKey(elements, this.deckName());
    if (!reset && key === this.lastTemplateKey) {
      return;
    }
    const result = syncTemplate(elements, this.deckName(), { reset });
    if (result) {
      api.updateScene({
        elements: result.elements,
        // a reset is a user action (undoable); following the template is not
        captureUpdate: reset ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
      });
    }
    this.lastTemplateKey = templateKey(api.getSceneElementsIncludingDeleted(), this.deckName());
  }

  // ---------------------------------------------------------------------------
  // thumbnails
  // ---------------------------------------------------------------------------

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.renderThumbs(), 600);
  }

  private async renderThumbs() {
    const api = this.api;
    if (!api) {
      return;
    }
    const elements = api.getSceneElementsIncludingDeleted();
    const files = api.getFiles();
    const background = api.getAppState().viewBackgroundColor;
    const frames: Frame[] = [...this.state.slides.map((s) => s.frame)];
    const template = getTemplate(elements);
    if (template) {
      frames.push(template);
    }
    let thumbs = this.state.thumbs;
    for (const frame of frames) {
      const version = slideVersion(elements, frame);
      if (this.thumbVersions.get(frame.id) === version && thumbs[frame.id]) {
        continue;
      }
      try {
        const canvas = await renderSlide(elements, files, frame, { width: THUMB_WIDTH, background });
        thumbs = { ...thumbs, [frame.id]: canvas.toDataURL("image/png") };
        this.thumbVersions.set(frame.id, version);
      } catch (error) {
        console.warn("[slides] thumbnail failed", error);
      }
    }
    if (thumbs !== this.state.thumbs) {
      this.set({ thumbs });
    }
  }

  /** the slide picture right now (presenter view: current / next slide) */
  thumb(id: string) {
    return this.state.thumbs[id] ?? null;
  }
}

export const deck = new Deck();

(window as any).__deck = deck;
