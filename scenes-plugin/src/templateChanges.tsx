// "Back to template" next to the selection: selected template copies that
// were changed on their slide list those changes (text, color …); each goes
// back to the template's value on its own, or all at once. With several
// elements selected, a change applies to every selected copy that has it.

import { CaptureUpdateAction, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import { getCommonBounds } from "@excalidraw/element";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { scenesController } from "./controller";
import { deck } from "./deck";
import { usePresenter } from "./present";
import { resetTemplateChanges, templateChanges } from "./slides";

type Bar = { x: number; y: number; changes: Array<[string, string[]]> };

const ResetIcon = () => (
  <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 10a6 6 0 1 0 1.8-4.3" />
    <path d="M4 3.5v3.2h3.2" />
  </svg>
);

/** the selection's changed copies and where to show the bar (below the selection), following the camera */
const useBar = (enabled: boolean, selection: readonly string[]) => {
  const [bar, setBar] = useState<Bar | null>(null);
  useEffect(() => {
    if (!enabled || !selection.length) {
      setBar(null);
      return;
    }
    let frame = 0;
    let last = "";
    const loop = () => {
      const api = deck.getApi();
      let next: Bar | null = null;
      if (api) {
        const elements = api.getSceneElements();
        const changes = templateChanges(elements, selection);
        if (changes.size) {
          const appState = api.getAppState();
          const chosen = elements.filter((el) => selection.includes(el.id));
          const [x1, , x2, y2] = getCommonBounds(chosen);
          const at = sceneCoordsToViewportCoords({ sceneX: (x1 + x2) / 2, sceneY: y2 }, appState);
          next = { x: Math.round(at.x + appState.offsetLeft), y: Math.round(at.y + appState.offsetTop), changes: [...changes] };
        }
      }
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setBar(next);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [enabled, selection]);
  return bar;
};

const barHalf = () => Math.min(416, window.innerWidth - 24) / 2 + 12;

const reset = (ids: readonly string[], names: readonly string[] | null) => {
  const api = deck.getApi();
  if (!api) {
    return;
  }
  const next = resetTemplateChanges(api.getSceneElementsIncludingDeleted(), ids, names, scenesController.getState().current ?? "Untitled");
  if (next) {
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
};

export const TemplateChangesBar = () => {
  const { selection } = useSyncExternalStore(deck.subscribe, deck.getState);
  const presenting = usePresenter().active;
  const container = document.querySelector<HTMLElement>(".excalidraw");
  const bar = useBar(!presenting && !!container, selection);
  if (!bar || !container) {
    return null;
  }
  const all = [...new Set(bar.changes.flatMap(([, ids]) => ids))];
  return createPortal(
    <div
      className="kq-template-changes"
      // centered under the selection, kept on screen (the bar is at most 26rem / the screen wide)
      style={{ left: Math.min(Math.max(bar.x, barHalf()), window.innerWidth - barHalf()), top: Math.min(bar.y + 12, window.innerHeight - 120) }}
      onPointerDown={(event) => event.stopPropagation()}
      role="toolbar"
      aria-label="Changed on this slide"
    >
      <span className="kq-template-changes__label">Changed here:</span>
      {bar.changes.map(([name, ids]) => (
        <button
          key={name}
          type="button"
          className="kq-template-changes__item"
          title={`${name[0].toUpperCase()}${name.slice(1)} back to the template${ids.length > 1 ? ` (${ids.length} elements)` : ""}`}
          onClick={() => reset(ids, [name])}
        >
          {name}
          <ResetIcon />
        </button>
      ))}
      {bar.changes.length > 1 && (
        <button type="button" className="kq-template-changes__all" title="Everything back to the template" onClick={() => reset(all, null)}>
          All
          <ResetIcon />
        </button>
      )}
    </div>,
    container,
  );
};
