// Runtime of the slides feature in the user's tab: keeps template copies in
// sync, sets the template's body text style as the editor's defaults, and offers
// the deck (slides, template, transition, thumbnails) as a store for the UI.

import { CaptureUpdateAction, Fonts } from "@excalidraw/excalidraw";

import { scenesController } from "./controller";
import {
  addBodyText,
  addTitleBlock,
  bodyStyle,
  needsBodyText,
  needsTitleBlock,
  remeasureTitleBlock,
  getSlides,
  getTemplate,
  getTransition,
  renderSlide,
  slideData,
  slideVersion,
  syncTemplate,
  templateKey,
} from "./slides";

import type { Frame, Transition } from "./slides";
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
  transition: Transition;
  /** slide id -> picture (data URL) */
  thumbs: Record<string, string>;
  /** selected element ids (non-frames) and the slide they are on */
  selection: string[];
  /** the slide of the selection, or the selected frame */
  activeId: string | null;
};

/**
 * The scene is a presentation: a template, several slides or speaker notes (a
 * single frame, e.g. an infographic, isn't one). The one test for Present,
 * presentation links and the canvas icons.
 */
export const isDeck = ({ slides, templateId }: Pick<DeckState, "slides" | "templateId">) =>
  !!templateId || slides.length > 1 || slides.some((slide) => slide.notes.trim());

const THUMB_WIDTH = 480;

/** set while a presentation runs (see present.tsx): a page that went away mid-presentation is cleaned up */
export const PRESENTING_KEY = "kurviq-presenting";

class Deck {
  private api: ExcalidrawImperativeAPI | null = null;
  private listeners = new Set<() => void>();
  private lastKey = "";
  private lastTemplateKey = 0;
  /** the body text style last made the editor's default */
  private lastBodyKey = "";
  /** headline and eyebrow being added to an older template */
  private addingTitles = false;
  /** the scene whose template headline / eyebrow were measured again (once per scene) */
  private remeasuredFor: string | null = null;
  private syncTimer = 0;
  private thumbTimer = 0;
  private thumbVersions = new Map<string, number>();
  /** paused while presenting (nothing is edited then) */
  paused = false;

  state: DeckState = { slides: [], templateId: null, transition: "glide", thumbs: {}, selection: [], activeId: null };
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

  private detach: (() => void) | null = null;

  attach(api: ExcalidrawImperativeAPI) {
    if (this.api === api) {
      return;
    }
    this.detach?.();
    this.api = api;
    // the page went away during a presentation (reload, update): Excalidraw
    // keeps zen mode, which would hide the whole editor UI from now on
    try {
      if (localStorage.getItem(PRESENTING_KEY)) {
        localStorage.removeItem(PRESENTING_KEY);
        api.updateScene({ appState: { zenModeEnabled: false } });
      }
    } catch {}
    this.detach = api.onChange((elements, appState) => {
      this.onChange(elements);
      this.onSelection(elements, appState.selectedElementIds);
    });
    this.onChange(api.getSceneElementsIncludingDeleted());
  }

  /**
   * Another canvas is the deck for a while (a shared scene's viewer: the
   * presentation runs on it); the returned function gives the editor back
   */
  borrow(api: ExcalidrawImperativeAPI) {
    const editor = this.api;
    this.attach(api);
    return () => {
      if (this.api === api && editor) {
        this.attach(editor);
      }
    };
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
    // only slide frames selected: Excalidraw's properties panel has nothing useful for them (slides.scss)
    document
      .querySelector(".excalidraw")
      ?.classList.toggle("kq-slide-frame-selected", chosen.length > 0 && chosen.every((el) => el.type === "frame"));
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
      transition: getTransition(elements),
    });
    // the template's body text sample: the style of new text (once per scene and style)
    const body = bodyStyle(elements);
    const bodyKey = body ? `${this.deckName()}:${JSON.stringify(body)}` : "";
    if (bodyKey && bodyKey !== this.lastBodyKey && this.api) {
      this.lastBodyKey = bodyKey;
      const api = this.api;
      setTimeout(() =>
        api.updateScene({
          appState: { currentItemFontFamily: body!.fontFamily as any, currentItemFontSize: body!.fontSize, currentItemStrokeColor: body!.strokeColor },
          captureUpdate: CaptureUpdateAction.NEVER,
        }),
      );
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
    // a template from before headline, eyebrow and body text: they come once, measured with the deck's fonts
    if (needsTitleBlock(elements) || needsBodyText(elements)) {
      if (!this.addingTitles) {
        this.addingTitles = true;
        Fonts.loadElementsFonts(elements.filter((el) => el.type === "text" && !el.isDeleted) as any)
          .catch(() => [])
          .then(() => {
            if (this.api !== api) {
              return;
            }
            const titled = addTitleBlock(api.getSceneElementsIncludingDeleted())?.elements ?? api.getSceneElementsIncludingDeleted();
            const withBody = addBodyText(titled) ?? titled;
            if (withBody !== api.getSceneElementsIncludingDeleted()) {
              api.updateScene({ elements: withBody, captureUpdate: CaptureUpdateAction.NEVER });
            }
          })
          .finally(() => {
            this.addingTitles = false;
            this.scheduleTemplateSync();
          });
      }
      return;
    }
    const key = templateKey(elements, this.deckName());
    if (!reset && key === this.lastTemplateKey) {
      return;
    }
    // a headline / eyebrow measured before its font was loaded (cut off): measured again, once the font is there
    if (this.remeasuredFor !== this.deckName()) {
      this.remeasuredFor = this.deckName();
      Fonts.loadElementsFonts(elements.filter((el) => el.type === "text" && !el.isDeleted) as any)
        .catch(() => [])
        .then(() => {
          const fixed = this.api === api ? remeasureTitleBlock(api.getSceneElementsIncludingDeleted()) : null;
          if (fixed) {
            api.updateScene({ elements: fixed, captureUpdate: CaptureUpdateAction.NEVER });
          }
        });
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
}

export const deck = new Deck();

(window as any).__deck = deck;
