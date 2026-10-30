// Speaker notes: an icon after each slide's name on the canvas, and a popover
// (before it, a pen: the slide in the slide list; the template's pen opens the deck's style)
// to see and edit a slide's notes with formatting (the same editor and
// toolbar as text on the canvas). Notes are stored as markdown-like text in
// the slide's `customData.slides.notes` (see richText/model.ts), so plain
// notes stay valid and agents read / write them as text.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

import { deck, isDeck } from "./deck";
import { usePresenter } from "./present";
import { QuickTip } from "./quickTip";
import { patchSlideData } from "./slides";
import { showSlideInList, editTemplate } from "./slidesUI";
import { createRichEditable } from "./richText/editor";
import { docFromMarkdown, docFromPlain, isPlainDoc, markdownOf, plainOf, richDocOf } from "./richText/model";
import { docToHtml } from "./richText/layout";
import type { RichDoc } from "./richText/model";

const NOTES_SIZE = 16;

/** notes as a doc (plain notes from before are read the same way) */
export const notesDoc = (notes: string | undefined): RichDoc => docFromMarkdown(notes ?? "");

/** notes as HTML (presenter view) */
export const notesHtml = (notes: string | undefined, dark = false) => docToHtml(notesDoc(notes), dark);

// -----------------------------------------------------------------------------
// which slide's notes are open

let openId: string | null = null;
const listeners = new Set<() => void>();
const setOpen = (id: string | null) => {
  openId = id;
  listeners.forEach((listener) => listener());
};
export const slideNotes = {
  open: (id: string) => setOpen(id),
  close: () => setOpen(null),
  toggle: (id: string) => setOpen(openId === id ? null : id),
};
const useOpenId = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => openId,
  );

// -----------------------------------------------------------------------------
// where the slides' names are on screen (Excalidraw draws them as divs)

/** after the name (x), up to where its frame ends on screen (max) */
type Spot = { left: number; x: number; y: number; h: number; max: number };

const useNameSpots = (enabled: boolean) => {
  const { slides, templateId } = useSyncExternalStore(deck.subscribe, deck.getState);
  const [spots, setSpots] = useState<Record<string, Spot>>({});
  useEffect(() => {
    if (!enabled) {
      setSpots({});
      return;
    }
    let frame = 0;
    let last = "";
    const loop = () => {
      const next: Record<string, Spot> = {};
      const api = deck.getApi();
      const hidden = !api || api.getAppState().viewModeEnabled;
      for (const id of hidden ? [] :  [...slides.map((slide) => slide.id), ...(templateId ? [templateId] : [])]) {
        const name = document.querySelector<HTMLElement>(`.excalidraw [id$="-frame-name-${CSS.escape(id)}"]`);
        if (!name || name.querySelector("input")) {
          continue; // off screen, or being renamed
        }
        const rect = name.getBoundingClientRect();
        // Excalidraw shortens a name to its frame's width (maxWidth)
        const max = rect.left + (parseFloat(name.style.maxWidth) || Infinity);
        if (rect.width) {
          next[id] = { left: Math.round(rect.left), x: Math.round(rect.right), y: Math.round(rect.top), h: Math.round(rect.height), max: Math.round(max) };
        }
      }
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSpots(next);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [enabled, slides, templateId]);
  return spots;
};

/** the slide in the slide list */
const ListIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3.5" width="5" height="4" rx="1" />
    <rect x="3" y="12.5" width="5" height="4" rx="1" />
    <path d="M11 5.5h6M11 14.5h6" />
  </svg>
);

/** an icon's room (touch screens: bigger, see slides.scss) */
const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
const PEN_WIDTH = touch ? 32 : 22;
const ICON_WIDTH = touch ? 32 : 22;

/**
 * where the icons start: after the name, but inside its frame (a shortened
 * name: over its end, on a background); null when the frame is too narrow on screen
 */
const iconsAt = (spot: Spot, width: number) => {
  if (spot.max - spot.left < width + 40) {
    return null;
  }
  const left = Math.min(spot.x + 4, spot.max - width);
  return { left, over: left < spot.x + 4 };
};

const PenIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13z" />
    <path d="M11.5 5.5l3 3" />
  </svg>
);

const NotesIcon = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
    <path d="M4 3.5h12v9.5l-4 3.5H4z" fillOpacity={filled ? 0.18 : undefined} />
    <path d="M7 7.5h6M7 10.5h4" />
  </svg>
);

// -----------------------------------------------------------------------------
// the editor in the popover: the canvas text editor, on a stand-in element

const NotesEditor = ({ id, notes, dark }: { id: string; notes: string; dark: boolean }) => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = notesDoc(notes);
    const element: any = {
      id: `notes-${id}`,
      type: "text",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fontSize: NOTES_SIZE,
      lineHeight: 1.45,
      containerId: null,
      originalText: plainOf(doc),
      customData: isPlainDoc(doc) ? {} : { rich: doc },
    };
    const app = {
      state: { theme: dark ? "dark" : "light", zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 },
      scene: {
        getElement: (elementId: string) => (elementId === element.id ? element : null),
        mutateElement: (el: any, patch: any) => Object.assign(el, patch),
      },
    };
    let root: HTMLElement & Record<string, any>;
    // the toolbar goes above the popover
    const corner = (x: number, y: number): [number, number] => {
      const rect = (root.closest(".slides-notes-pop") ?? root).getBoundingClientRect();
      return [x ? rect.right : rect.left, y ? rect.bottom : rect.top];
    };
    // (notes are markdown: no font of their own)
    root = createRichEditable(document, element, app, corner, { fonts: false }) as any;
    root.classList.add("slides-notes-pop__editor");
    root.style.fontSize = `${NOTES_SIZE}px`;
    root.style.lineHeight = "1.45";
    root.dataset.placeholder = "Speaker notes for this slide (presenter view)…";
    host.current!.appendChild(root);

    let saved = notes;
    const save = () => {
      const text = root.value as string;
      element.originalText = text;
      const next = text.trim() ? markdownOf(richDocOf(element, text) ?? docFromPlain(text)) : "";
      if (next !== saved) {
        saved = next;
        const api = deck.getApi();
        if (api) {
          patchSlideData(api, new Map([[id, { notes: next || undefined }]]));
        }
      }
    };
    let timer = 0;
    const onInput = () => {
      root.classList.toggle("slides-notes-pop__editor--empty", !(root.value as string));
      clearTimeout(timer);
      timer = window.setTimeout(save, 600);
    };
    onInput();
    clearTimeout(timer);
    root.addEventListener("input", onInput);
    root.focus();
    // the caret at the end
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return () => {
      clearTimeout(timer);
      save();
      root.removeEventListener("input", onInput);
      root.remove();
    };
    // the editor is made once per slide; later changes to the notes come from it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return <div ref={host} className="slides-notes-pop__host" />;
};

// -----------------------------------------------------------------------------

export const SlideNotesOverlay = () => {
  const state = useSyncExternalStore(deck.subscribe, deck.getState);
  const { slides, templateId } = state;
  const presenting = usePresenter().active;
  const id = useOpenId();
  const api = deck.getApi();
  const appState = api?.getAppState();
  // (view mode, e.g. read-only while Drive is checked, is looked at in the loop: it ends without a re-render here)
  const enabled = !presenting && isDeck(state);
  const spots = useNameSpots(enabled);
  const container = document.querySelector<HTMLElement>(".excalidraw");
  const dark = appState?.theme === "dark";
  const [pinned, setPinned] = useState<Spot | null>(null);

  // the popover stays where it opened (the slide's name may scroll away)
  useEffect(() => {
    setPinned(id ? spots[id] ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        slideNotes.close();
      }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest?.(".slides-notes-pop, .rt-toolbar, .slides-notes-btn, .slides-card__actions")) {
        slideNotes.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [id]);

  useEffect(() => {
    if (presenting) {
      slideNotes.close();
    }
  }, [presenting]);

  if (!enabled || !container) {
    return null;
  }
  const slide = id ? slides.find((s) => s.id === id) : undefined;
  const at = pinned ?? (id ? spots[id] : undefined);
  const width = Math.min(440, window.innerWidth - 32);
  const left = at ? Math.max(16, Math.min(at.x - 40, window.innerWidth - width - 16)) : Math.max(16, (window.innerWidth - width) / 2);
  const top = at ? Math.min(at.y + at.h + 8, window.innerHeight - 260) : 120;

  return createPortal(
    <>
      {slides.map((s) => {
        const spot = spots[s.id];
        if (!spot) {
          return null;
        }
        const at = iconsAt(spot, PEN_WIDTH + ICON_WIDTH);
        if (!at) {
          return null;
        }
        const has = !!s.notes.trim();
        return [
          <QuickTip key={`${s.id}-list`} tip="Show in the slide list" label={false}>
            <button
              type="button"
              className={clsx("slides-notes-btn", { "slides-notes-btn--over": at.over })}
              style={{ left: at.left, top: spot.y + spot.h / 2 }}
              aria-label={`Slide ${s.index + 1} in the slide list`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => showSlideInList(s.id)}
            >
              <ListIcon />
            </button>
          </QuickTip>,
          <QuickTip key={s.id} tip="Speaker notes" label={false}>
          <button
            type="button"
            className={clsx("slides-notes-btn", { "slides-notes-btn--has": has, "slides-notes-btn--open": s.id === id, "slides-notes-btn--over": at.over })}
            style={{ left: at.left + PEN_WIDTH, top: spot.y + spot.h / 2 }}
            aria-label={`Speaker notes of slide ${s.index + 1}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => slideNotes.toggle(s.id)}
          >
            <NotesIcon filled={has} />
          </button>
          </QuickTip>,
        ];
      })}
      {templateId && spots[templateId] && iconsAt(spots[templateId], ICON_WIDTH) && (
        <QuickTip tip="Edit the template" label={false}>
        <button
          type="button"
          className={clsx("slides-notes-btn slides-notes-btn--has", { "slides-notes-btn--over": iconsAt(spots[templateId], ICON_WIDTH)!.over })}
          style={{ left: iconsAt(spots[templateId], ICON_WIDTH)!.left, top: spots[templateId].y + spots[templateId].h / 2 }}
          aria-label="Edit the template"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={editTemplate}
        >
          <PenIcon />
        </button>
        </QuickTip>
      )}
      {slide && (
        <div
          className="slides-notes-pop"
          role="dialog"
          aria-label={`Speaker notes of slide ${slide.index + 1}`}
          style={{ left, top, width }}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="slides-notes-pop__head">
            <span className="slides-notes-pop__title">
              Speaker notes · {slide.index + 1}. {slide.title}
            </span>
            <button type="button" className="slides-notes-pop__close" aria-label="Close" onClick={slideNotes.close}>
              ×
            </button>
          </div>
          <NotesEditor key={slide.id} id={slide.id} notes={slide.notes} dark={dark} />
          <div className="slides-notes-pop__hint">Shown in the presenter view. Select text for formatting.</div>
        </div>
      )}
    </>,
    container,
  );
};
