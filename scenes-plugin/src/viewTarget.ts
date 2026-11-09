import { deckOrder } from "../../scenes-mcp/slideRules.mjs";

type Element = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; customData?: unknown };

/**
 * What the shared-scene viewer fits into view when it opens: a presentation's
 * slides (its frames, without templates), so stray elements beside the deck
 * don't pull the view off center; everything else when it isn't a
 * presentation or has no slides.
 */
export const viewTarget = <T extends Element>(elements: readonly T[], isPresentation: boolean): T[] => {
  const visible = elements.filter((element) => !element.isDeleted);
  const slides = isPresentation ? deckOrder(visible) : [];
  return slides.length ? slides : visible;
};

type Bounds = readonly [number, number, number, number];
type Offsets = { top: number; right: number; bottom: number; left: number };

/** the shared-scene viewer starts zoomed out at most this far (Excalidraw's own floor is 10 %) */
export const MIN_FIT_ZOOM = 0.01;
const MAX_FIT_ZOOM = 30;

/**
 * Zoom and scroll that show the bounds whole, centered in the viewport minus
 * the offsets. Unlike Excalidraw's setViewport it may go below 10 %, so a
 * big deck is entirely in view (wheel zoom brings it back to 10 % and up).
 */
export const fitView = (bounds: Bounds, viewport: { width: number; height: number }, offsets: Offsets) => {
  const [x1, y1, x2, y2] = bounds;
  const width = Math.max(1, viewport.width - offsets.left - offsets.right);
  const height = Math.max(1, viewport.height - offsets.top - offsets.bottom);
  const fit = Math.min(width / Math.max(1, x2 - x1), height / Math.max(1, y2 - y1));
  const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_FIT_ZOOM, fit));
  return {
    zoom: { value: zoom },
    scrollX: (offsets.left + width / 2) / zoom - (x1 + x2) / 2,
    scrollY: (offsets.top + height / 2) / zoom - (y1 + y2) / 2,
  };
};
