// Tooltips in formatted text (the `n` mark, see model.ts): words with a note
// that isn't drawn. On the canvas (editor, shared viewer, presentation) the
// note shows when the pointer is over the words (a tap on touch screens), in
// Kurviq's own tooltip look (.kurviq-tip, scenes.scss).

import { elementLayout } from "./layout";

import { tipInFragments } from "./tipHit";

import type { Point, TipElement, TipHit } from "./tipHit";

/** quick check before laying a text out: is the point anywhere near it? */
const near = (element: TipElement, point: Point) => {
  const reach = Math.hypot(element.width, element.height) / 2;
  return Math.abs(point.x - (element.x + element.width / 2)) <= reach && Math.abs(point.y - (element.y + element.height / 2)) <= reach;
};

/** the tooltip under a point of the scene: the topmost formatted text there that has one */
export const tipAt = (elements: readonly TipElement[], point: Point): TipHit | null => {
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];
    if (element.type !== "text" || element.isDeleted || !element.customData?.rich || !near(element, point)) {
      continue;
    }
    const result = elementLayout(element as any);
    const hit = result && tipInFragments(element, result.layout.fragments, result.shift, point);
    if (hit) {
      return hit;
    }
  }
  return null;
};
