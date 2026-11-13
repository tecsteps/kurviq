// Tooltips of formatted text on the canvas (see richText/tips.ts): the note
// of the words under the pointer, in Kurviq's tooltip look. Mouse and pen:
// on hover; touch: a tap shows it, the next touch hides it.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";

import { deck } from "./deck";
import { placeTip } from "./richText/tipHit";
import { tipAt } from "./richText/tips";

type Shown = { tip: string; left: number; top: number; arrow: number; above: boolean };

const sameShown = (a: Shown | null, b: Shown | null) =>
  a === b || (!!a && !!b && a.tip === b.tip && a.left === b.left && a.top === b.top && a.above === b.above);

/** the tooltip at a pointer position, or null (not on the canvas, while drawing or editing text, nothing there) */
const tipAtPointer = (event: PointerEvent): Shown | null => {
  const api = deck.getApi();
  const target = event.target as Element | null;
  if (!api || target?.tagName !== "CANVAS" || !target.closest(".excalidraw")) {
    return null;
  }
  const appState = api.getAppState() as any;
  if (appState.editingTextElement || appState.newElement || appState.selectionElement || appState.isResizing || appState.isRotating) {
    return null;
  }
  const point = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, appState);
  const hit = tipAt(api.getSceneElements() as any, point);
  if (!hit) {
    return null;
  }
  const corners = hit.corners.map((corner) => sceneCoordsToViewportCoords({ sceneX: corner.x, sceneY: corner.y }, appState));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  const placed = placeTip(box, { width: window.innerWidth, height: window.innerHeight });
  return { tip: hit.tip, ...placed, left: Math.round(placed.left), top: Math.round(placed.top), arrow: Math.round(placed.arrow) };
};

export const TextTipsOverlay = () => {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let frame = 0;
    let latest: PointerEvent | null = null;
    const show = (next: Shown | null) => setShown((current) => (sameShown(current, next) ? current : next));
    const check = () => {
      frame = 0;
      // not while a button is down (dragging, drawing, selecting)
      show(latest && !latest.buttons ? tipAtPointer(latest) : null);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }
      latest = event;
      frame ||= requestAnimationFrame(check);
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") {
        show(null);
      }
    };
    const onTap = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        show(tipAtPointer(event));
      }
    };
    const hide = () => show(null);
    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) {
        hide();
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onTap, { passive: true });
    window.addEventListener("pointerout", onOut, { passive: true });
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onTap);
      window.removeEventListener("pointerout", onOut);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!shown) {
    return null;
  }
  return createPortal(
    <div
      className={`kurviq-tip kurviq-tip--note${shown.above ? " kurviq-tip--above" : ""}`}
      role="tooltip"
      style={{ left: shown.left, top: shown.top, ["--tip-arrow" as any]: `calc(50% + ${shown.arrow}px)` }}
    >
      {shown.tip}
    </div>,
    document.body,
  );
};
