// Tooltips in formatted text: which words with a note (the `n` mark) are
// under a point. Pure geometry (tested in test/richTips.test.ts); tips.ts
// lays the texts out and textTips.tsx shows the note.

import type { Fragment } from "./layout";

export type Point = { x: number; y: number };

export type TipElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  isDeleted?: boolean;
  customData?: Record<string, any>;
};

export type TipHit = {
  tip: string;
  /** the words' corners, in scene coordinates (rotated with the text) */
  corners: Point[];
};

const rotate = (point: Point, center: Point, angle: number): Point => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
};

/** the tooltip of the fragment under a point of a text (scene coordinates), with the fragment's corners */
export const tipInFragments = (element: TipElement, fragments: readonly Fragment[], shift: number, point: Point): TipHit | null => {
  const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
  // the point in the text's own (unrotated) frame, from its top-left
  const local = rotate(point, center, -element.angle);
  const x = local.x - element.x - shift;
  const y = local.y - element.y;
  const fragment = fragments.find((f) => f.marks.n && x >= f.x && x <= f.x + f.width && y >= f.top && y <= f.top + f.height);
  if (!fragment?.marks.n) {
    return null;
  }
  const left = element.x + shift + fragment.x;
  const top = element.y + fragment.top;
  const corners = [
    { x: left, y: top },
    { x: left + fragment.width, y: top },
    { x: left + fragment.width, y: top + fragment.height },
    { x: left, y: top + fragment.height },
  ].map((corner) => rotate(corner, center, element.angle));
  return { tip: fragment.marks.n, corners };
};

/** where the tooltip goes: centered under the words (above them near the bottom of the window), kept on screen */
export const placeTip = (box: { left: number; top: number; right: number; bottom: number }, viewport: { width: number; height: number }) => {
  const above = box.bottom + 80 > viewport.height;
  const x = (box.left + box.right) / 2;
  const left = Math.min(Math.max(x, 170), Math.max(170, viewport.width - 170));
  return { left, top: above ? box.top - 8 : box.bottom + 8, arrow: x - left, above };
};
