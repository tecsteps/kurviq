// Text padding of shapes: how far a shape's text keeps from its border.
// Stored per shape in `customData.textPadding` (default: Excalidraw's 5px);
// ../vite.config.mts patches Excalidraw's text layout to read it. The slider
// is injected into the properties panel, below Opacity.

import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { Range } from "@excalidraw/excalidraw/components/Range";
import { BOUND_TEXT_PADDING } from "@excalidraw/common";
import {
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextElement,
  getBoundTextMaxHeight,
  refreshTextDimensions,
} from "@excalidraw/element";

import { deck } from "./deck";

import type { ExcalidrawElement } from "@excalidraw/element/types";

const CONTAINERS = new Set(["rectangle", "ellipse", "diamond"]);

export const textPaddingOf = (el: ExcalidrawElement | null | undefined) => {
  const value = (el?.customData as any)?.textPadding;
  return typeof value === "number" ? value : BOUND_TEXT_PADDING;
};

const setTextPadding = (ids: Set<string>, padding: number) => {
  const api = deck.getApi();
  if (!api) {
    return;
  }
  const elements = api.getSceneElementsIncludingDeleted();
  const next = new Map(
    elements.map((el) => [
      el.id,
      ids.has(el.id) ? newElementWith(el, { customData: { ...el.customData, textPadding: padding } }) : el,
    ]),
  );
  // lay the text out again: wrap at the new width, grow the shape if needed
  for (const id of ids) {
    let container: any = next.get(id);
    const text: any = container && getBoundTextElement(container, next as any);
    if (!text) {
      continue;
    }
    const dims: any = refreshTextDimensions(text, container, next as any) || {};
    let updated = { ...text, ...dims };
    if (updated.height > getBoundTextMaxHeight(container, updated)) {
      container = newElementWith(container, {
        height: (computeContainerDimensionForBoundText as any)(updated.height, container.type, container),
      });
      next.set(id, container);
    }
    updated = newElementWith(text, { ...dims, ...computeBoundTextPosition(container, updated, next as any) });
    next.set(text.id, updated);
  }
  api.updateScene({ elements: [...next.values()], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
};

export const TextPaddingControl = ({
  appState,
  elementsMap,
}: {
  appState: { selectedElementIds: Readonly<Record<string, true>> };
  elementsMap: ReadonlyMap<string, ExcalidrawElement>;
}) => {
  const targets: ExcalidrawElement[] = [];
  for (const id of Object.keys(appState.selectedElementIds)) {
    const el = elementsMap.get(id);
    // a selected label counts for its shape
    const container = el?.type === "text" && (el as any).containerId ? elementsMap.get((el as any).containerId) : el;
    if (container && CONTAINERS.has(container.type) && !targets.includes(container)) {
      targets.push(container);
    }
  }
  if (!targets.length) {
    return null;
  }
  const values = new Set(targets.map(textPaddingOf));
  const value = textPaddingOf(targets[0]);
  return (
    <Range
      label="Text padding"
      value={value}
      min={0}
      max={80}
      step={2}
      hasCommonValue={values.size === 1}
      onChange={(padding) => setTextPadding(new Set(targets.map((el) => el.id)), padding)}
      testId="text-padding"
    />
  );
};
