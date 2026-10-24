// The "Slides" sidebar: the deck of the open scene (frames as slides),
// per-slide settings, reveal steps, and the deck's template + style.

import { CaptureUpdateAction, FONT_FAMILY, Sidebar, newElementWith } from "@excalidraw/excalidraw";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

import { scenesController } from "./controller";
import { deck } from "./deck";
import { customFonts } from "./fonts";
import { optimizeImages, pickSlides, printInBrowser, printToPdf, slidesHtml } from "./pdfExport";
import { IS_ONLINE } from "./api";
import { SlidesShare } from "./online/ui";
import { QuickTip } from "./quickTip";
import { presenter } from "./present";
import { setSlideParam } from "./router";
import {
  addSlide,
  applyTheme,
  createTemplate,
  deleteSlides,
  duplicateSlides,
  getSlides,
  getTemplate,
  getTheme,
  moveSlides,
  patchSlideData,
  setSlideOrder,
  slideData,
  withSlideData,
} from "./slides";

import type { DeckTheme } from "./slides";

import "./slides.scss";

export const SLIDES_SIDEBAR_NAME = "slides";

const useDeck = () => useSyncExternalStore(deck.subscribe, deck.getState);

const api = () => {
  const value = deck.getApi();
  if (!value) {
    throw new Error("Editor not ready");
  }
  return value;
};

/** camera on a frame, without locking anything */
const focusFrame = (id: string, select = true) => {
  const frame = api().getSceneElements().find((el) => el.id === id);
  if (!frame) {
    return;
  }
  api().setViewport({ target: frame, fit: "contain", animation: { duration: 400 }, offsets: { ui: true } });
  if (select) {
    api().updateScene({ appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  deck.setActive(id);
  const number = getSlides(api().getSceneElements()).findIndex((slide) => slide.id === id) + 1;
  setSlideParam(number || null);
};

const FONTS: Array<[string, number]> = [
  ["Excalifont (hand-drawn)", FONT_FAMILY.Excalifont],
  ["Nunito", FONT_FAMILY.Nunito],
  ["Lilita One", FONT_FAMILY["Lilita One"]],
  ["Comic Shanns (code)", FONT_FAMILY["Comic Shanns"]],
  ["Liberation Sans", FONT_FAMILY["Liberation Sans"]],
  ["Assistant", FONT_FAMILY.Assistant],
  ["Virgil (classic)", FONT_FAMILY.Virgil],
];

/** change the deck theme: stored on the template; matching elements follow */
const setTheme = (patch: Partial<DeckTheme>) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const template = getTemplate(elements);
  if (!template) {
    return;
  }
  const from = getTheme(elements);
  const to = { ...from, ...patch };
  const themed = applyTheme(elements, from, to) ?? elements;
  api().updateScene({
    elements: themed.map((el) => (el.id === template.id ? withSlideData(el, { theme: to }) : el)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/** a slide back to the template: template elements restored, deck style applied */
const resetSlides = (ids: string[]) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const theme = getTheme(elements);
  const themed = applyTheme(elements, theme, theme, { force: new Set(ids) });
  if (themed) {
    api().updateScene({ elements: themed, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  deck.runTemplateSync({ reset: new Set(ids) });
};

type PdfChoice = "all" | "current" | "pick";

const exportPdf = async (
  spec: string,
  { includeSkipped, compress }: { includeSkipped: boolean; compress: boolean },
  setBusy: (busy: string | null) => void,
) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const name = scenesController.getState().current ?? "Untitled";
  const frames = pickSlides(elements, spec, { includeSkipped });
  setBusy(`Preparing ${frames.length} slide${frames.length === 1 ? "" : "s"}…`);
  const files = compress ? await optimizeImages(elements, api().getFiles(), frames) : api().getFiles();
  const html = await slidesHtml(elements, files, frames, {
    deck: name,
    background: api().getAppState().viewBackgroundColor,
  });
  const suffix = spec === "all" ? "" : frames.length === 1 ? ` - slide ${deck.getState().slides.findIndex((s) => s.id === frames[0].id) + 1}` : ` - slides ${spec.replace(/\s+/g, "")}`;
  let blob: Blob;
  try {
    setBusy("Printing PDF…");
    blob = await printToPdf(html);
  } catch (error) {
    // scenes server without PDF support (or no Chrome): the browser prints it
    console.warn("PDF via scenes server failed, using the print dialog", error);
    setBusy(null);
    printInBrowser(html, `${name}${suffix}`);
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${name}${suffix}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  setBusy(null);
};

/** PDF of the whole deck, the current slide or picked slides */
const PdfPanel = () => {
  const { slides, activeId } = useDeck();
  const current = slides.find((s) => s.id === activeId);
  const [choice, setChoice] = useState<PdfChoice>(current ? "current" : "all");
  const [pick, setPick] = useState("");
  const [includeSkipped, setIncludeSkipped] = useState(false);
  const [compress, setCompress] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = slides.filter((s) => includeSkipped || !s.skip).length;
  const spec = choice === "all" ? "all" : choice === "current" ? String((current?.index ?? 0) + 1) : pick;
  return (
    <section className="slides-details slides-pdf">
      <label className="slides-check">
        <input type="radio" checked={choice === "all"} onChange={() => setChoice("all")} />
        Whole deck ({shown} slide{shown === 1 ? "" : "s"})
      </label>
      <label className={clsx("slides-check", { "slides-check--off": !current })}>
        <input type="radio" disabled={!current} checked={choice === "current"} onChange={() => setChoice("current")} />
        {current ? `This slide (${current.index + 1}: ${current.title})` : "This slide (select one first)"}
      </label>
      <label className="slides-check">
        <input type="radio" checked={choice === "pick"} onChange={() => setChoice("pick")} />
        Slides
        <input
          className="slides-input slides-pdf__pick"
          placeholder="e.g. 1, 3-5"
          value={pick}
          onFocus={() => setChoice("pick")}
          onChange={(event) => setPick(event.target.value)}
        />
      </label>
      {choice === "all" && slides.some((s) => s.skip) && (
        <label className="slides-check">
          <input type="checkbox" checked={includeSkipped} onChange={(event) => setIncludeSkipped(event.target.checked)} />
          Include skipped slides
        </label>
      )}
      <label className="slides-check">
        <input type="checkbox" checked={compress} onChange={(event) => setCompress(event.target.checked)} />
        Smaller file (no visible loss)
      </label>
      <div className="slides-row">
        <button
          type="button"
          className="slides-btn slides-btn--primary"
          disabled={!!busy || (choice === "pick" && !pick.trim())}
          onClick={() => {
            setError(null);
            exportPdf(spec, { includeSkipped, compress }, setBusy)
              .catch((err) => {
                setBusy(null);
                setError(err.message);
              });
          }}
        >
          {busy ?? "Download PDF"}
        </button>
      </div>
      {error && <p className="slides-hint slides-hint--error">{error}</p>}
    </section>
  );
};

// -----------------------------------------------------------------------------

const SlideList = () => {
  const { slides, thumbs, activeId } = useDeck();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** the slide moved with the keyboard: its card keeps the focus after the list re-orders */
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const id = refocus.current;
    const button = id && document.querySelector<HTMLElement>(`[data-slide-open="${CSS.escape(id)}"]`);
    if (button) {
      refocus.current = null;
      button.focus();
      button.scrollIntoView({ block: "nearest" });
    }
  }, [slides]);

  /** ⌥↑ / ⌥↓ on a slide: one place up or down in the deck */
  const moveBy = (id: string, delta: number) => {
    const to = slides.findIndex((s) => s.id === id) + delta;
    if (to < 0 || to >= slides.length) {
      return;
    }
    refocus.current = id;
    moveSlides(api(), [id], to);
    deck.setActive(id);
    setSlideParam(to + 1);
  };

  /** ↑ / ↓ on a slide: show the previous / next one (its card takes the focus) */
  const goBy = (id: string, delta: number) => {
    const target = slides[slides.findIndex((s) => s.id === id) + delta];
    if (!target) {
      return;
    }
    focusFrame(target.id);
    const button = document.querySelector<HTMLElement>(`[data-slide-open="${CSS.escape(target.id)}"]`);
    button?.focus();
    button?.scrollIntoView({ block: "nearest" });
  };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      return;
    }
    const ids = slides.map((s) => s.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId) + (slides.findIndex((s) => s.id === dragId) < slides.findIndex((s) => s.id === targetId) ? 1 : 0), 0, dragId);
    setSlideOrder(api(), ids);
  };

  return (
    <ol className="slides-list">
      <li>
        <button
          type="button"
          className="slides-add"
          onClick={() => {
            const id = addSlide(api(), activeId ?? undefined);
            setTimeout(() => focusFrame(id), 50);
          }}
        >
          <span className="slides-add__plus" aria-hidden="true">
            +
          </span>
          Add slide
        </button>
      </li>
      {slides.map((slide) => (
        <li
          key={slide.id}
          draggable
          onDragStart={(event) => {
            setDragId(slide.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOverId(slide.id);
          }}
          onDragLeave={() => setOverId(null)}
          onDrop={(event) => {
            event.preventDefault();
            drop(slide.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          className={clsx("slides-card", {
            "slides-card--active": slide.id === activeId,
            "slides-card--skip": slide.skip,
            "slides-card--over": overId === slide.id && dragId !== slide.id,
            "slides-card--drag": dragId === slide.id,
          })}
        >
          <span className="slides-card__actions">
            <QuickTip tip="Duplicate" label={false}>
              <button
                type="button"
                aria-label={`Duplicate slide ${slide.index + 1}`}
                onClick={() => {
                  const [copy] = duplicateSlides(api(), [slide.id]);
                  if (copy) {
                    setTimeout(() => focusFrame(copy), 50);
                  }
                }}
              >
                ⧉
              </button>
            </QuickTip>
            <QuickTip tip="Delete (undo with ⌘Z)" label={false}>
              <button
                type="button"
                aria-label={`Delete slide ${slide.index + 1}`}
                onClick={() => window.confirm(`Delete slide ${slide.index + 1} “${slide.title}” with everything on it?`) && deleteSlides(api(), [slide.id])}
              >
                ×
              </button>
            </QuickTip>
          </span>
          <button
            type="button"
            className="slides-card__open"
            data-slide-open={slide.id}
            onClick={() => focusFrame(slide.id)}
            onKeyDown={(event) => {
              if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.metaKey && !event.ctrlKey) {
                // not the canvas's arrow keys (they would nudge the selected frame)
                event.preventDefault();
                event.stopPropagation();
                const delta = event.key === "ArrowUp" ? -1 : 1;
                if (event.altKey) {
                  moveBy(slide.id, delta); // ⌥↑ / ⌥↓: one place up or down in the deck
                } else {
                  goBy(slide.id, delta); // ↑ / ↓: the previous / next slide
                }
              }
            }}
          >
            <span className="slides-card__num">{slide.index + 1}</span>
            <span className="slides-card__thumb">{thumbs[slide.id] ? <img src={thumbs[slide.id]} alt="" /> : null}</span>
            <span className="slides-card__meta">
              <span className="slides-card__title">{slide.title}</span>
              <span className="slides-card__badges">
                {slide.skip && <span>skipped</span>}
                {!slide.template && <span>no template</span>}
                {slide.steps > 0 && <span>{slide.steps} step{slide.steps === 1 ? "" : "s"}</span>}
                {slide.notes && <span>notes</span>}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
};

const SlideDetails = ({ id }: { id: string }) => {
  const { slides } = useDeck();
  const slide = slides.find((s) => s.id === id);
  const [title, setTitle] = useState(slide?.title ?? "");
  const [notes, setNotes] = useState(slide?.notes ?? "");
  useEffect(() => {
    setTitle(slide?.title ?? "");
    setNotes(slide?.notes ?? "");
  }, [id, slide?.title, slide?.notes]);
  if (!slide) {
    return null;
  }
  const saveTitle = () => {
    if (title.trim() && title.trim() !== slide.title) {
      const elements = api().getSceneElementsIncludingDeleted();
      api().updateScene({
        elements: elements.map((el) => (el.id === id ? newElementWith(el as any, { name: title.trim() } as any) : el)),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  };
  const saveNotes = () => {
    if (notes !== slide.notes) {
      patchSlideData(api(), new Map([[id, { notes: notes || undefined }]]));
    }
  };
  return (
    <section className="slides-details">
      <div className="slides-section__title">Slide {slide.index + 1}</div>
      <input
        className="slides-input"
        value={title}
        aria-label="Slide title"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      <textarea
        className="slides-input slides-notes"
        placeholder="Speaker notes (presenter view)"
        value={notes}
        rows={3}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={saveNotes}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <label className="slides-check">
        <input type="checkbox" checked={slide.skip} onChange={(event) => patchSlideData(api(), new Map([[id, { skip: event.target.checked || undefined }]]))} />
        Skip when presenting (backup slide)
      </label>
      <label className="slides-check">
        <input
          type="checkbox"
          checked={slide.template}
          onChange={(event) => patchSlideData(api(), new Map([[id, { template: event.target.checked ? undefined : false }]]))}
        />
        Show template (header, footer, logo…)
      </label>
      <div className="slides-row">
        <button type="button" className="slides-btn" onClick={() => presenter.start(id)}>
          ▶ From here
        </button>
        <button type="button" className="slides-btn" onClick={() => addSlide(api(), id)}>
          + After
        </button>
        <QuickTip tip="Template elements back as in the template, deck fonts and colors on everything on this slide" label={false}>
          <button type="button" className="slides-btn" onClick={() => resetSlides([id])}>
            Reset to template
          </button>
        </QuickTip>
      </div>
    </section>
  );
};

const StepPicker = () => {
  const { selection } = useDeck();
  if (!selection.length) {
    return null;
  }
  const elements = api().getSceneElements();
  const chosen = elements.filter((el) => selection.includes(el.id));
  if (!chosen.some((el) => el.frameId)) {
    return null;
  }
  const steps = new Set(chosen.map((el) => slideData(el).step ?? 0));
  const value = steps.size === 1 ? [...steps][0] : -1;
  const setStep = (step: number) => {
    // groups and bound labels go along
    const groups = new Set(chosen.flatMap((el) => el.groupIds));
    const ids = new Set(
      elements
        .filter((el) => selection.includes(el.id) || el.groupIds.some((g) => groups.has(g)) || ((el as any).containerId && selection.includes((el as any).containerId)))
        .map((el) => el.id),
    );
    patchSlideData(api(), new Map([...ids].map((id) => [id, { step: step || undefined }])));
  };
  return (
    <section className="slides-details">
      <div className="slides-section__title">Selection appears</div>
      <div className="slides-steps">
        {[0, 1, 2, 3, 4, 5, 6].map((step) => (
          <button key={step} type="button" className={clsx("slides-chip", { "slides-chip--on": value === step })} onClick={() => setStep(step)}>
            {step === 0 ? "Always" : `Click ${step}`}
          </button>
        ))}
      </div>
    </section>
  );
};

const ThemeForm = () => {
  const { theme, templateId } = useDeck();
  // fonts the user added are deck fonts too (a hook: before any early return)
  useSyncExternalStore(customFonts.subscribe, customFonts.version);
  if (!templateId) {
    return (
      <section className="slides-details">
        <div className="slides-section__title">Template &amp; style</div>
        <p className="slides-hint">
          Header, footer and logo for every slide.
        </p>
        <button type="button" className="slides-btn slides-btn--primary" onClick={() => focusFrame(createTemplate(api()), false)}>
          Create template
        </button>
      </section>
    );
  }
  const select = <K extends keyof DeckTheme>(key: K, options: Array<[string, DeckTheme[K]]>) => (
    <select
      className="slides-input"
      value={String(theme[key])}
      onChange={(event) => {
        const option = options.find(([, value]) => String(value) === event.target.value);
        if (option) {
          setTheme({ [key]: option[1] } as Partial<DeckTheme>);
        }
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {options.map(([label, value]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );
  const color = (key: "textColor" | "strokeColor", label: string) => (
    <label className="slides-field">
      <span>{label}</span>
      <input type="color" value={theme[key]} onChange={(event) => setTheme({ [key]: event.target.value })} />
    </label>
  );
  return (
    <section className="slides-details">
      <div className="slides-section__title">Template &amp; style</div>
      <div className="slides-row">
        <button type="button" className="slides-btn" onClick={() => focusFrame(templateId, false)}>
          Edit template
        </button>
        <QuickTip tip="Deck fonts and colors on every slide, template elements restored everywhere" label={false}>
          <button
            type="button"
            className="slides-btn"
            onClick={() => {
              if (window.confirm("Apply the deck style to every slide? Fonts and colors you changed on single slides are reset.")) {
                resetSlides(deck.getState().slides.map((s) => s.id));
              }
            }}
          >
            Reset all slides
          </button>
        </QuickTip>
      </div>
      <p className="slides-hint">
        Placeholders: <code>{"{page}"}</code> <code>{"{total}"}</code> <code>{"{title}"}</code> <code>{"{deck}"}</code>{" "}
        <code>{"{date}"}</code>
      </p>
      <label className="slides-field">
        <span>Font</span>
        {select("fontFamily", [...FONTS, ...customFonts.list().map((font): [string, number] => [font.family, font.id])])}
      </label>
      <div className="slides-grid">
        <label className="slides-field">
          <span>Title size</span>
          {select("titleSize", [["48", 48], ["56", 56], ["64", 64], ["72", 72], ["96", 96], ["120", 120]])}
        </label>
        <label className="slides-field">
          <span>Text size</span>
          {select("bodySize", [["20", 20], ["24", 24], ["28", 28], ["32", 32], ["36", 36], ["44", 44]])}
        </label>
        {color("textColor", "Text color")}
        {color("strokeColor", "Line color")}
        <label className="slides-field">
          <span>Sloppiness</span>
          {select("roughness", [["Architect", 0], ["Artist", 1], ["Cartoonist", 2]])}
        </label>
        <label className="slides-field">
          <span>Stroke</span>
          {select("strokeWidth", [["Thin", 1], ["Bold", 2], ["Extra bold", 4]])}
        </label>
        <label className="slides-field">
          <span>Fill</span>
          {select("fillStyle", [["Solid", "solid"], ["Hachure", "hachure"], ["Cross-hatch", "cross-hatch"], ["Zigzag", "zigzag"]])}
        </label>
        <label className="slides-field">
          <span>Transition</span>
          {select("transition", [["Glide", "glide"], ["Cut", "cut"]])}
        </label>
      </div>
    </section>
  );
};

/** the first slide (and the deck template with its footer, if there is none yet) */
const startPresentation = () => {
  const id = addSlide(api());
  if (!getTemplate(api().getSceneElementsIncludingDeleted())) {
    createTemplate(api());
  }
  setTimeout(() => focusFrame(id), 50);
};

/** no slides yet: what slides are, and one button to start */
const SlidesEmpty = () => (
  <section className="slides-empty">
    <svg className="slides-empty__art" viewBox="0 0 160 104" aria-hidden>
      <rect x="34" y="6" width="96" height="60" rx="6" className="slides-empty__back" />
      <rect x="22" y="18" width="96" height="60" rx="6" className="slides-empty__back" />
      <rect x="10" y="30" width="96" height="60" rx="6" className="slides-empty__front" />
      <rect x="22" y="42" width="44" height="6" rx="3" className="slides-empty__line slides-empty__line--strong" />
      <rect x="22" y="54" width="62" height="4" rx="2" className="slides-empty__line" />
      <rect x="22" y="63" width="52" height="4" rx="2" className="slides-empty__line" />
      <circle cx="128" cy="78" r="20" className="slides-empty__play" />
      <path d="M123 69.5v17l14-8.5z" className="slides-empty__play-icon" />
    </svg>
    <div className="slides-empty__title">No slides in this scene yet</div>
    <p className="slides-empty__text">
      Turn your canvas into a presentation: every slide is a frame you draw in. Present it full screen, share a link, or
      export a PDF.
    </p>
    <button type="button" className="slides-btn slides-btn--primary slides-empty__cta" onClick={startPresentation}>
      Start a presentation
    </button>
  </section>
);

type SlidesTab = "slides" | "style" | "share" | "pdf";

/** the sidebar's tab: kept outside the sidebar, which unmounts when closed; set by the template watcher too */
const slidesTab = (() => {
  let tab: SlidesTab = "slides";
  const listeners = new Set<() => void>();
  return {
    get: () => tab,
    set: (next: SlidesTab) => {
      tab = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

// editing the template (something on it selected): the Style tab opens;
// back on a slide, the slide list returns (if it was opened this way)
{
  let lastActive: string | null = null;
  let openedForTemplate = false;
  deck.subscribe(() => {
    const { activeId, templateId } = deck.getState();
    if (activeId === lastActive || deck.paused) {
      return;
    }
    const was = lastActive;
    lastActive = activeId;
    if (templateId && activeId === templateId) {
      openedForTemplate = slidesTab.get() !== "style";
      slidesTab.set("style");
      const api = deck.getApi();
      if (api && api.getAppState().openSidebar?.name !== SLIDES_SIDEBAR_NAME) {
        api.toggleSidebar({ name: SLIDES_SIDEBAR_NAME, force: true });
      }
    } else if (was && was === templateId && openedForTemplate && slidesTab.get() === "style") {
      openedForTemplate = false;
      slidesTab.set("slides");
    }
  });
}

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const TABS: Array<{ tab: SlidesTab; label: string; icon: ReactNode; online?: boolean }> = [
  {
    tab: "slides",
    label: "Slides",
    icon: icon(
      <>
        <rect x="2.5" y="5.5" width="12" height="9" rx="1.3" />
        <path d="M5.5 3h10.2c1 0 1.8.8 1.8 1.8V12" />
      </>,
    ),
  },
  {
    tab: "style",
    label: "Style",
    icon: icon(
      <>
        <path d="M10 2.8a7.2 7.2 0 0 0 0 14.4c1 0 1.6-.7 1.6-1.5 0-.9-.7-1.2-.7-2 0-.8.6-1.3 1.4-1.3h1.6a3.3 3.3 0 0 0 3.3-3.3c0-3.5-3.2-6.3-7.2-6.3z" />
        <circle cx="6.4" cy="9.6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="8.9" cy="6.3" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="12.7" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
      </>,
    ),
  },
  {
    tab: "share",
    label: "Share",
    online: true,
    icon: icon(
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9m1.3 3.9a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" />,
    ),
  },
  {
    tab: "pdf",
    label: "PDF",
    icon: icon(<path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14.5V16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.5" />),
  },
];

export const SlidesSidebar = () => {
  const { slides, activeId } = useDeck();
  const tab = useSyncExternalStore(slidesTab.subscribe, slidesTab.get);
  const active = slides.find((s) => s.id === activeId) ? activeId : null;
  const tabs = TABS.filter((entry) => !entry.online || IS_ONLINE);
  const shown = tabs.some((entry) => entry.tab === tab) ? tab : "slides";
  return (
    <Sidebar name={SLIDES_SIDEBAR_NAME} className="slides-sidebar">
      <Sidebar.Header>
        <div className="scenes-sidebar__title">Slides</div>
      </Sidebar.Header>
      <div className="slides-body">
        {!slides.length ? (
          <SlidesEmpty />
        ) : (
          <>
            <div className="slides-tabs" role="tablist">
              {tabs.map((entry) => (
                <button
                  key={entry.tab}
                  type="button"
                  role="tab"
                  aria-selected={shown === entry.tab}
                  className="slides-tabs__tab"
                  onClick={() => slidesTab.set(entry.tab)}
                >
                  {entry.icon}
                  {entry.label}
                </button>
              ))}
            </div>
            {shown === "slides" && (
              <>
                <SlideList />
                <p className="slides-hint">Drag or ⌥↑ / ⌥↓ to reorder.</p>
                <StepPicker />
                {active && <SlideDetails id={active} />}
              </>
            )}
            {shown === "style" && <ThemeForm />}
            {shown === "share" && <SlidesShare />}
            {shown === "pdf" && <PdfPanel />}
          </>
        )}
      </div>
    </Sidebar>
  );
};
