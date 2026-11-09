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
