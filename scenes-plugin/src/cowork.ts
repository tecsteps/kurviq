// Co-working on the scene open in the editor: the agent reads the live canvas
// (incl. the user's unsaved edits) and applies edits that merge with whatever
// the user is doing — one undoable step per agent edit.

import {
  CaptureUpdateAction,
  newElementWith,
  Fonts,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import {
  Scene,
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  hashString,
  measureText,
  refreshTextDimensions,
  syncInvalidIndices,
  updateBoundElements,
} from "@excalidraw/element";

import { getFontString } from "@excalidraw/common";

import { registerSceneFonts, withFonts } from "./fonts";
import { scenesApi } from "./api";
import { applyMarkdownUpdate } from "./richText/agent";
import { addTitleBlock, applyTheme, getSlides, getTemplate, getTheme, placeOnSlides, resetToTemplate, slideTitle, syncTemplate } from "./slides";
import { scenesController, withSceneName } from "./controller";
import { getAgentBaseline, getCheckpoint, setAgentBaseline, setCheckpoint } from "./storage";

import type { ApiError } from "./api";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * Agent baselines (what the canvas looked like when an agent last read /
 * edited a scene) are kept here in the browser (IndexedDB), per scene — the
 * MCP server and the scenes server keep nothing.
 */
type BaselineOptions = {
  /** return the stored baseline of this scene (`agentBaseline`) */
  withBaseline?: boolean;
  /** afterwards store the current canvas as the new baseline (e.g. "read") */
  storeBaseline?: string;
  /** also keep the current canvas as a checkpoint with this id */
  revision?: string;
  /** the scene the agent means (routing) — nothing is stored for another scene */
  targetScene?: string | null;
};

export type ReadCommand = { type: "read" } & BaselineOptions;

/** detached mode: the agent edits its own copy of a scene and commits it */
export type SceneEditCommand = {
  type: "scene-edit";
  name: string;
  /** image files of added image elements */
  files?: BinaryFiles;
  add?: any[];
  update?: Array<{ id: string; [key: string]: unknown }>;
  delete?: string[];
} & EditOptions;

/** how an agent's edit treats existing elements */
export type EditOptions = {
  /** add with the id of an existing element replaces it */
  upsert?: boolean;
  /** every slide back to the template ("Reset all slides" in the app) */
  restyle?: boolean;
  /** these slides back to the template (frame ids or slide numbers; "all"): the slide card's icon in the app */
  reset?: Array<string | number> | "all";
  /** headline and eyebrow on the template ("Add headline & eyebrow" in the app) */
  addTitleBlock?: boolean;
  /** the agent's id for this edit: sent again (e.g. after a timeout), it is not applied twice */
  requestId?: string;
};

export type EditCommand = {
  type: "edit";
  /** refuse to edit if the user switched to another scene meanwhile */
  expectScene?: string | null;
  /** new elements, create_view format (labels, startBinding, …) */
  add?: any[];
  /** partial updates: { id, ...props } */
  update?: Array<{ id: string; [key: string]: unknown }>;
  /** ids to delete (labels of deleted containers go too) */
  delete?: string[];
  /** image files of added image elements */
  files?: BinaryFiles;
} & BaselineOptions &
  EditOptions;

const requireApi = () => {
  const api = scenesController.getApi();
  if (!api) {
    throw new Error("Editor not ready");
  }
  return api;
};

const sceneInfo = () => {
  const { current, dirty } = scenesController.getState();
  return {
    scene: current,
    dirty,
    autoSync: scenesController.autoSyncFor(current),
    syncStatus: scenesController.statusOf(current),
  };
};

const handleBaseline = async (
  scene: string | null,
  elements: readonly ExcalidrawElement[],
  { withBaseline, storeBaseline, revision, targetScene }: BaselineOptions,
) => {
  if (targetScene !== undefined && targetScene !== scene) {
    return {}; // the agent meant another scene — it gets an error, store nothing
  }
  const previous = withBaseline ? (await getAgentBaseline(scene)) ?? null : undefined;
  if (revision) {
    await setCheckpoint(revision, { elements: [...elements] });
  }
  if (storeBaseline) {
    await setAgentBaseline(scene, {
      at: new Date().toISOString(),
      action: storeBaseline,
      elements: [...elements],
    });
  }
  return previous === undefined ? {} : { agentBaseline: previous };
};

export const readOpenScene = async (command: ReadCommand = { type: "read" }) => {
  const api = requireApi();
  const info = sceneInfo();
  const elements = api.getSceneElements();
  return {
    ...info,
    elements,
    viewBackgroundColor: api.getAppState().viewBackgroundColor,
    ...(await handleBaseline(info.scene, elements, command)),
  };
};

/**
 * After an edit: labels are wrapped to their shape (which grows if the text
 * needs it) and centered in it again; arrows bound to moved or resized
 * shapes follow them — what the editor does when a user does the same.
 */
const layoutAfterEdit = (
  input: ExcalidrawElement[],
  textChanged: Set<string>,
  reshaped: Set<string>,
) => {
  if (!textChanged.size && !reshaped.size) {
    return input;
  }
  // own copies: the arrow update below mutates elements in place
  const scene = new Scene(input.map((el) => ({ ...el }) as ExcalidrawElement), { skipValidation: true });
  const map = scene.getNonDeletedElementsMap();
  const changedShapes = new Set(reshaped);
  for (const el of scene.getNonDeletedElements()) {
    const containerId = (el as any).containerId;
    const container = containerId && (map.get(containerId) as any);
    if (el.type !== "text" || !container || container.type === "arrow") {
      continue;
    }
    if (!textChanged.has(el.id) && !reshaped.has(container.id) && !reshaped.has(el.id)) {
      continue;
    }
    let text: any = { ...el, ...(refreshTextDimensions(el as any, container, map, (el as any).originalText ?? (el as any).text) || {}) };
    if (text.height > getBoundTextMaxHeight(container, text)) {
      scene.mutateElement(container, {
        height: (computeContainerDimensionForBoundText as any)(text.height, container.type, container),
      });
      changedShapes.add(container.id);
    }
    text = { ...text, ...computeBoundTextPosition(container, text, map), frameId: container.frameId ?? null };
    scene.mutateElement(el as any, {
      x: text.x,
      y: text.y,
      width: text.width,
      height: text.height,
      text: text.text,
      frameId: text.frameId,
    });
  }
  const moved = [...changedShapes].map((id) => map.get(id)).filter(Boolean) as any[];
  for (const el of moved) {
    if (el.type !== "text" && el.type !== "arrow" && el.type !== "line") {
      updateBoundElements(el, scene, { simultaneouslyUpdated: moved });
    }
  }
  return [...scene.getElementsIncludingDeleted()] as ExcalidrawElement[];
};

/** how big the scene file is now (images make it big) */
export const sceneSize = (json: string, elements: readonly ExcalidrawElement[]) => ({
  sceneFile: `${Math.round(json.length / 1024)} KB, ${elements.filter((el) => el.type === "image" && !el.isDeleted).length} image elements`,
});

/** a deck's slides get their template copies (header, footer, page numbers) */
export const withTemplate = (elements: ExcalidrawElement[], deck: string) =>
  syncTemplate(elements, deck)?.elements ?? elements;

/** fields an agent must not set directly */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * customData of an update merges into what the element has (two levels:
 * `customData.slides` too), so setting one key keeps the others (speaker
 * notes, slide order …); a key set to null is removed. Like the app does.
 */
const mergeCustomData = (current: Record<string, unknown> | null | undefined, patch: unknown) => {
  if (!isPlainObject(patch)) {
    return patch;
  }
  const merged: Record<string, unknown> = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (isPlainObject(value) && isPlainObject(merged[key])) {
      const inner: Record<string, unknown> = { ...(merged[key] as Record<string, unknown>) };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue === null) {
          delete inner[innerKey];
        } else {
          inner[innerKey] = innerValue;
        }
      }
      merged[key] = inner;
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const PROTECTED = new Set(["id", "type", "version", "versionNonce", "isDeleted", "index"]);

/**
 * A text box of a fixed width (`autoResize: false`) narrower than one of its
 * words would break that word ("01" → "0", "1"): it gets wide enough for
 * its longest word instead, like a shape grows for its label.
 */
const withRoomForWords = (el: any) => {
  if (el.autoResize !== false) {
    return el;
  }
  const font = getFontString(el);
  const words = String(el.originalText ?? el.text).split(/\s+/).filter(Boolean);
  const widest = Math.max(0, ...words.map((word) => measureText(word, font, el.lineHeight).width));
  return widest > el.width ? { ...el, width: Math.ceil(widest) + 1 } : el;
};

/**
 * Apply an agent's add / update / delete to a list of elements (incl. deleted
 * ones) — used for the user's open canvas (live mode) and for the agent's own
 * headless copy (detached mode).
 */
const applyEdits = async (
  input: readonly ExcalidrawElement[],
  command: Pick<EditCommand, "add" | "update" | "delete" | "upsert" | "restyle" | "reset" | "addTitleBlock">,
  convert: (elements: any[]) => Promise<any[]>,
  /** the scene's name ({deck} in the template) */
  deck: string,
) => {
  let elements: ExcalidrawElement[] = [...input];
  const byId = () => new Map(elements.map((el) => [el.id, el]));
  const missing: string[] = [];
  const slideTargets = resolvedSlides(elements, [...(command.add || []), ...(command.update || [])]);

  /** delete these (containers take their labels along, slides everything on them) */
  const remove = (wanted: Iterable<string>) => {
    const ids = new Set(wanted);
    const frames = new Set(
      elements.filter((el) => ids.has(el.id) && (el.type === "frame" || el.type === "magicframe")).map((el) => el.id),
    );
    for (const el of elements) {
      if (el.frameId && frames.has(el.frameId)) {
        ids.add(el.id);
      }
    }
    for (const el of elements) {
      if ((el as any).containerId && ids.has((el as any).containerId)) {
        ids.add(el.id);
      }
    }
    let count = 0;
    elements = elements.map((el) => {
      if (!ids.has(el.id) || el.isDeleted) {
        return el;
      }
      count++;
      return newElementWith(el, { isDeleted: true });
    });
    return count;
  };

  let alsoDeleted = 0;
  if (command.delete?.length) {
    const present = byId();
    command.delete.forEach((id) => !present.get(id) || present.get(id)!.isDeleted ? missing.push(id) : null);
    alsoDeleted = remove(command.delete.filter((id) => !missing.includes(id))) - (command.delete.length - missing.length);
  }

  /** layer moves asked for ({ zIndex: "front" | "back" } or { above / below: id }), applied at the end */
  const moves: Array<{ id: string; zIndex?: unknown; above?: unknown; below?: unknown }> = [];
  const takeMove = (item: Record<string, any>) => {
    const { zIndex, above, below, ...rest } = item;
    if (zIndex !== undefined || above !== undefined || below !== undefined) {
      moves.push({ id: item.id, zIndex, above, below });
    }
    return rest;
  };
  const themeBefore = getTheme(elements);

  // partial updates
  const textUpdated = new Set<string>();
  /** elements whose geometry changed: their labels and arrows follow */
  const reshaped = new Set<string>();
  /** labels for shapes that have none yet (update with `label`) */
  const newLabels: any[] = [];
  if (command.update?.length) {
    const present = byId();
    const patches = new Map<string, Record<string, unknown>>();
    // { id, slide: 3, x, y }: coordinates on slide 3
    const updates = placeOnSlides(command.update, elements);
    const labelOf = (id: string) =>
      elements.find((el) => !el.isDeleted && el.type === "text" && (el as any).containerId === id);
    for (const { id, ...props } of updates.map(takeMove)) {
      const el = present.get(id);
      if (!el || el.isDeleted) {
        missing.push(id);
        continue;
      }
      const { label: rawLabel, ...rest } = applyMarkdownUpdate(el, props as Record<string, any>);
      const label = rawLabel && typeof rawLabel === "object" ? applyMarkdownUpdate(labelOf(id) ?? {}, rawLabel) : rawLabel;
      const patch: Record<string, unknown> = { ...(patches.get(id) || {}) };
      for (const [key, value] of Object.entries(rest)) {
        if (!PROTECTED.has(key)) {
          patch[key] = key === "customData" ? mergeCustomData((patch.customData ?? el.customData) as any, value) : value;
        }
      }
      if (label !== undefined && el.type !== "text") {
        // { label: { text, fontSize, … } } on a shape edits (or creates) its label
        const existing = labelOf(id);
        // a plain label drops the old one's formatting, like a text update
        const spec: Record<string, any> = typeof label === "string" ? applyMarkdownUpdate(existing ?? {}, { text: label }) : { ...label };
        delete spec.id;
        if (existing) {
          const before = patches.get(existing.id) || {};
          patches.set(existing.id, {
            ...before,
            ...spec,
            ...(spec.customData ? { customData: mergeCustomData((before.customData ?? existing.customData) as any, spec.customData) } : {}),
          });
          if (typeof spec.text === "string") {
            patches.get(existing.id)!.originalText = spec.text;
          }
          // re-wrapped and measured with its (new) font
          textUpdated.add(existing.id);
          reshaped.add(id);
        } else if (typeof spec.text === "string") {
          const { rich, ...customData } = spec.customData || {};
          newLabels.push({ type: "text", id: `${id}-label`, containerId: id, ...spec, customData: rich ? { ...customData, rich } : customData });
        }
      }
      if (el.type === "text" && typeof patch.text === "string") {
        patch.originalText = patch.text;
        textUpdated.add(el.id);
      }
      // another font or size: measured again (else the box keeps the old font's size and cuts the text)
      if (el.type === "text" && ["fontFamily", "fontSize", "lineHeight", "width", "autoResize"].some((key) => key in patch)) {
        textUpdated.add(el.id);
      }
      // a free text given a width wraps at it (a box from x to x + width; textAlign aligns inside)
      if (el.type === "text" && !(el as any).containerId && typeof patch.width === "number" && !("autoResize" in patch)) {
        patch.autoResize = false;
      }
      if (["x", "y", "width", "height", "angle", "points"].some((key) => key in patch)) {
        reshaped.add(id);
      }
      patches.set(id, patch);
    }
    // a moved frame takes its content along (like dragging it in the editor)
    for (const [id, patch] of [...patches]) {
      const frame = present.get(id)!;
      if ((frame.type !== "frame" && frame.type !== "magicframe") || !("x" in patch || "y" in patch)) {
        continue;
      }
      const dx = Number(patch.x ?? frame.x) - frame.x;
      const dy = Number(patch.y ?? frame.y) - frame.y;
      for (const child of elements) {
        const own = patches.get(child.id) || {};
        const moves = child.frameId === id && !child.isDeleted && !("x" in own) && !("y" in own);
        if (moves && (dx || dy)) {
          patches.set(child.id, { ...(patches.get(child.id) || {}), x: child.x + dx, y: child.y + dy });
          reshaped.add(child.id);
        }
      }
    }
    elements = elements.map((el) => {
      const patch = patches.get(el.id);
      return patch ? newElementWith(el, patch as any) : el;
    });
  }

  // the deck theme changed: slide elements that still had its values follow,
  // like when the user changes the deck style
  let restyled = 0;
  const themeAfter = getTheme(elements);
  if (getTemplate(elements) && JSON.stringify(themeBefore) !== JSON.stringify(themeAfter)) {
    const frames = new Set(getSlides(elements).map((slide) => slide.id));
    const template = getTemplate(elements);
    if (template) {
      frames.add(template.id);
    }
    await Fonts.loadElementsFonts([{ type: "text", fontFamily: themeAfter.fontFamily, text: "", originalText: "" } as any]).catch(() => []);
    const themed = applyTheme(elements, themeBefore, themeAfter);
    if (themed) {
      themed.forEach((el, i) => {
        if (el !== elements[i]) {
          restyled++;
          if (el.type === "text") {
            textUpdated.add(el.id);
          }
          if ((el as any).containerId) {
            reshaped.add((el as any).containerId);
          }
        }
      });
      elements = themed;
    }
  }

  // re-measure edited text, with its font loaded (else a fallback font is
  // measured and the text is cut off in the user's browser); a free text
  // keeps its alignment (centered text stays centered where it was)
  if (textUpdated.size) {
    await Fonts.loadElementsFonts(elements.filter((el) => textUpdated.has(el.id))).catch(() => []);
    const map = new Map(elements.map((el) => [el.id, el])) as any;
    const refreshed = new Map(
      elements
        .filter((el) => textUpdated.has(el.id) && el.type === "text" && !(el as any).containerId)
        .map((el: any) => [el.id, { ...el, ...(refreshTextDimensions(withRoomForWords(el), null, map, el.originalText ?? el.text) || {}) }]),
    );
    elements = elements.map((el) => {
      const next = refreshed.get(el.id) as any;
      if (!next) {
        return el;
      }
      const shift = el.width - next.width;
      if (next.autoResize !== false && shift && (next.textAlign === "center" || next.textAlign === "right")) {
        return { ...next, x: el.x + (next.textAlign === "center" ? shift / 2 : shift) };
      }
      return next;
    });
  }

  // headline and eyebrow on the template, slides back to the template: what
  // the app's buttons do ("Add headline & eyebrow", the card's icon, "Reset all slides")
  let titleBlock: number | null = null;
  if (command.addTitleBlock) {
    const result = addTitleBlock(elements);
    if (result) {
      elements = result.elements as ExcalidrawElement[];
      titleBlock = result.adopted;
    }
  }
  const slidesNow = getSlides(elements);
  const resetIds =
    command.restyle || command.reset === "all"
      ? slidesNow.map((slide) => slide.id)
      : (Array.isArray(command.reset) ? command.reset : []).map((ref) =>
          typeof ref === "number" ? slidesNow[ref - 1]?.id ?? String(ref) : ref,
        );
  let reset = 0;
  if (resetIds.length) {
    const unknown = resetIds.filter((id) => !slidesNow.some((slide) => slide.id === id));
    if (unknown.length) {
      throw new Error(`reset: no such slide: ${unknown.join(", ")} (frame ids or slide numbers; nothing was changed)`);
    }
    await Fonts.loadElementsFonts([{ type: "text", fontFamily: themeAfter.fontFamily, text: "", originalText: "" } as any]).catch(() => []);
    const next = resetToTemplate(elements, new Set(resetIds), deck);
    if (next) {
      elements = next as ExcalidrawElement[];
      reset = resetIds.length;
    }
  }

  // additions: converted together with the existing elements, so arrows can
  // bind to shapes that are already on the canvas
  let addedIds: string[] = [];
  let replacedIds: string[] = [];
  const toAdd = [...(command.add || []), ...newLabels].map((el) => (el && typeof el === "object" ? takeMove(el) : el));
  if (toAdd.length) {
    const current = byId();
    const clash = toAdd.filter((el) => current.get(el?.id) && !current.get(el.id)!.isDeleted);
    if (clash.length && !command.upsert) {
      // deleting a frame takes what is in it (frameId), not what only lies on it
      const deletedFrames = new Set((command.delete || []).filter((id) => ["frame", "magicframe"].includes(input.find((el) => el.id === id)?.type as string)));
      const leftOver = clash.filter((el) => deletedFrames.size && !current.get(el.id)!.frameId);
      throw new Error(
        `Element ids already exist: ${clash.map((el) => el.id).join(", ")} — use update for existing elements, pick new ids, or pass upsert: true to replace them (nothing was changed)` +
          (leftOver.length
            ? `. ${leftOver.map((el) => el.id).join(", ")} survived the frame you deleted: they had no frameId (not part of the frame, only on top of it); delete them too`
            : ""),
      );
    }
    if (clash.length) {
      // upsert: the old elements (with their labels) make way for the new ones
      replacedIds = clash.map((el) => el.id);
      remove(replacedIds.filter((id) => !(current.get(id)!.type === "frame" || current.get(id)!.type === "magicframe")));
      // a replaced slide keeps what is on it: only the frame itself is new
      elements = elements.map((el) =>
        replacedIds.includes(el.id) && !el.isDeleted ? newElementWith(el, { isDeleted: true }) : el,
      );
    }
    // ids of deleted elements can be used again: the new element outranks the
    // deleted one wherever the two meet (the user's app merges by version)
    const deletedById = new Map(elements.filter((el) => el.isDeleted).map((el) => [el.id, el]));
    const live = elements.filter((el) => !el.isDeleted);
    const liveIds = new Set(live.map((el) => el.id));
    const merged = (await convert([...live, ...toAdd])).map((el: any) => {
      const tombstone = deletedById.get(el.id);
      return tombstone && !liveIds.has(el.id)
        ? { ...el, version: tombstone.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }
        : el;
    });
    const existingIds = liveIds;
    addedIds = merged.filter((el) => !existingIds.has(el.id)).map((el) => el.id);
    const reused = new Set(addedIds.filter((id) => deletedById.has(id)));
    elements = elements.filter((el) => !reused.has(el.id));
    const mergedById = new Map(merged.map((el) => [el.id, el]));

    // labels added as text with containerId (not via a shape's `label`): center
    // them in the shape and register them on it (convert only does this for `label`)
    for (const id of addedIds) {
      const label = mergedById.get(id);
      const container = label?.containerId && mergedById.get(label.containerId);
      const raw = toAdd.find((el) => el?.id === id);
      if (!label || label.type !== "text" || !container || raw?.type !== "text") {
        continue;
      }
      mergedById.set(id, {
        ...label,
        // the converter defaults to left / top; labels are centered unless asked otherwise
        textAlign: raw.textAlign ?? "center",
        verticalAlign: raw.verticalAlign ?? "middle",
        // a label lives on its shape's slide
        frameId: container.frameId ?? null,
      });
      textUpdated.add(id);
      if (!container.boundElements?.some((b: any) => b.id === id)) {
        mergedById.set(container.id, {
          ...container,
          boundElements: [...(container.boundElements || []), { type: "text", id }],
        });
      }
    }
    elements = [
      ...elements.filter((el) => el.isDeleted),
      ...merged,
    ].map((el) => mergedById.get(el.id) ?? el);
  }

  elements = layoutAfterEdit(elements, textUpdated, reshaped);
  const moved = moveLayers(elements, moves.filter((move) => !missing.includes(move.id)));
  elements = moved.elements;

  return {
    elements,
    addedIds,
    updated: (command.update || []).map((u) => u.id).filter((id) => !missing.includes(id)),
    deleted: (command.delete || []).filter((id) => !missing.includes(id)),
    ...(alsoDeleted > 0 ? { alsoDeleted: `${alsoDeleted} more elements went with them (labels, and everything on deleted slides)` } : {}),
    ...(replacedIds.length ? { replaced: replacedIds } : {}),
    ...(restyled ? { restyled: `${restyled} elements took the deck theme` } : {}),
    ...(reset ? { reset: `${reset} slide${reset === 1 ? "" : "s"} back to the template` } : {}),
    ...(titleBlock !== null ? { titleBlock: `headline and eyebrow on the template; ${titleBlock} slide texts became their copies` } : {}),
    ...(moved.problems.length ? { layerProblems: moved.problems } : {}),
    ...(slideTargets ? { slideNumbers: slideTargets } : {}),
    ...(missing.length ? { missingIds: missing } : {}),
  };
};

/**
 * Slide numbers count in deck order as it is now (they shift when slides are
 * deleted or moved): which slide each number used in an edit meant.
 */
const resolvedSlides = (elements: readonly ExcalidrawElement[], items: any[]) => {
  const numbers = [...new Set(items.map((item) => item?.slide).filter((slide) => typeof slide === "number" || /^\d+$/.test(String(slide ?? ""))))];
  if (!numbers.length) {
    return null;
  }
  const slides = getSlides(elements);
  return Object.fromEntries(
    numbers.map((n) => {
      const slide = slides[Number(n) - 1];
      return [String(n), slide ? `frame ${slide.id} "${slideTitle(slide, Number(n) - 1)}"` : "no such slide"];
    }),
  );
};

/** images whose file is in the scene but which were marked broken (e.g. a failed load in some browser) work again */
const repairImages = (elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
  let repaired = 0;
  let missingFiles = 0;
  const next = elements.map((el) => {
    if (el.type !== "image" || el.isDeleted) {
      return el;
    }
    const fileId = (el as any).fileId;
    if (!fileId || !files[fileId]) {
      missingFiles++;
      return el;
    }
    if ((el as any).status === "error" || (el as any).status === "pending") {
      repaired++;
      return newElementWith(el as any, { status: "saved" } as any);
    }
    return el;
  });
  return {
    elements: next,
    info: {
      ...(repaired ? { imagesRepaired: repaired } : {}),
      ...(missingFiles ? { imagesWithoutFile: `${missingFiles} image elements have no image data in the scene (they show as placeholders): add them again (e.g. upload the file)` } : {}),
    },
  };
};

/**
 * Layer order: `zIndex: "front" | "back"` (within its slide: above / below
 * everything else on it) or `above` / `below` another element. A shape's
 * label moves with it.
 */
const moveLayers = (
  input: ExcalidrawElement[],
  moves: Array<{ id: string; zIndex?: unknown; above?: unknown; below?: unknown }>,
) => {
  const problems: string[] = [];
  if (!moves.length) {
    return { elements: input, problems };
  }
  let list = [...input];
  for (const move of moves) {
    const el = list.find((item) => item.id === move.id && !item.isDeleted);
    if (!el) {
      continue;
    }
    const group = new Set([el.id, ...list.filter((item) => (item as any).containerId === el.id).map((item) => item.id)]);
    const rest = list.filter((item) => !group.has(item.id));
    const moving = list.filter((item) => group.has(item.id)).map((item) => newElementWith(item, { index: null } as any));
    const sameLayer = (item: ExcalidrawElement) => !item.isDeleted && (item.frameId ?? null) === (el.frameId ?? null) && item.type !== "frame";
    let at: number;
    if (typeof move.above === "string" || typeof move.below === "string") {
      const ref = (move.above ?? move.below) as string;
      const index = rest.findIndex((item) => item.id === ref && !item.isDeleted);
      if (index < 0) {
        problems.push(`${move.id}: ${move.above !== undefined ? "above" : "below"} "${ref}": no such element`);
        continue;
      }
      if (move.above !== undefined) {
        // above the element and its label
        let end = index;
        while (end + 1 < rest.length && (rest[end + 1] as any).containerId === ref) {
          end++;
        }
        at = end + 1;
      } else {
        at = index;
      }
    } else if (move.zIndex === "front") {
      const last = rest.reduce((found, item, i) => (sameLayer(item) ? i : found), -1);
      at = last < 0 ? rest.length : last + 1;
    } else if (move.zIndex === "back") {
      const first = rest.findIndex((item) => sameLayer(item));
      at = first < 0 ? 0 : first;
    } else {
      problems.push(`${move.id}: zIndex must be "front" or "back" (or use above / below with an element id)`);
      continue;
    }
    list = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  }
  syncInvalidIndices(list as any);
  return { elements: list, problems };
};

export const editOpenScene = async (
  command: EditCommand,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  const api = requireApi();
  const { scene } = sceneInfo();
  if (command.expectScene !== undefined && command.expectScene !== scene) {
    throw new Error(
      `The user switched scenes: the app now shows ${
        scene === null ? "Untitled" : `"${scene}"`
      }, not "${command.expectScene}". Read the open scene again.`,
    );
  }

  if (command.files && Object.keys(command.files).length) {
    api.addFiles(Object.values(command.files));
  }
  const { elements, ...edit } = await applyEdits(
    api.getSceneElementsIncludingDeleted(),
    command,
    convert,
    scene ?? "Untitled",
  );

  const images = repairImages(elements, api.getFiles());
  api.updateScene({
    elements: images.elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY, // user can undo agent edits
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = requireApi().getSceneElements();
  return {
    ...sceneInfo(),
    ...(await handleBaseline(scene, after, command)),
    ...edit,
    ...images.info,
    elements: after,
  };
};

/**
 * Detached mode, in the agent's headless tab: apply the edit to the newest
 * version on GitHub and commit it (the user's app merges it within seconds).
 * If GitHub moved on meanwhile, the edit is simply applied again on top.
 */
export const editSceneOnGitHub = async (
  command: SceneEditCommand,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  for (let attempt = 1; ; attempt++) {
    const latest = await scenesApi.load(command.name);
    const data = JSON.parse(latest.json);
    await registerSceneFonts(data);
    const edit = await applyEdits(
      restoreElements(data.elements || [], null, { repairBindings: true }),
      command,
      convert,
      command.name,
    );
    const files = { ...(data.files || {}), ...(command.files || {}) };
    const images = repairImages(withTemplate(edit.elements, command.name).filter((el) => !el.isDeleted), files);
    const elements = images.elements;
    const json = withSceneName(
      withFonts(serializeAsJSON(elements, data.appState || {}, files, "local"), elements),
      command.name, // ties the content to this scene
    );
    try {
      const saved = await scenesApi.save(command.name, json, latest.sha, "agent");
      return { ...edit, ...images.info, ...sceneSize(json, elements), elements, sha: saved.sha, commit: saved.commit, changed: saved.changed };
    } catch (error) {
      if ((error as ApiError).status !== 409 || attempt >= 3) {
        throw error;
      }
    }
  }
};

// -----------------------------------------------------------------------------
// local-only scenes: they exist only in the user's browser (never on GitHub),
// so the agent reads and edits them through the user's tab. Revisions and the
// agent's last version are kept here too.
// -----------------------------------------------------------------------------

export type LocalSceneCommand =
  | { type: "local-read"; name: string; since?: string }
  | ({ type: "local-edit"; name: string } & Pick<EditCommand, "add" | "update" | "delete" | "files"> & EditOptions)
  | { type: "local-save"; name: string; json: string; replace?: boolean; open?: boolean };

const revisionKey = (name: string, revision: string) => `local:${name}:${revision}`;

/** a revision id for this content, remembered so `since` can refer to it */
const rememberRevision = async (name: string, elements: readonly unknown[], json: string) => {
  const revision = `local-${(hashString(json) >>> 0).toString(36)}`;
  await setCheckpoint(revisionKey(name, revision), { elements: [...elements] });
  return revision;
};

const parseScene = (json: string) => {
  const data = JSON.parse(json);
  return {
    elements: (data.elements || []).filter((el: any) => !el.isDeleted),
    files: data.files || {},
    appState: data.appState || {},
  };
};

export const readLocalScene = async ({ name, since }: { name: string; since?: string }) => {
  const json = await scenesController.localOnlyJson(name);
  const file = parseScene(json);
  const revision = await rememberRevision(name, file.elements, json);
  let base: { elements: unknown[]; label: string } | null = null;
  if (since) {
    const stored = (await getCheckpoint(revisionKey(name, since))) as { elements: unknown[] } | null;
    if (!stored) {
      throw new Error(`Revision "${since}" of "${name}" not found — call without since/basedOn`);
    }
    base = { elements: stored.elements, label: `since revision ${since}` };
  } else {
    const last = await getAgentBaseline(name);
    if (last) {
      base = { elements: last.elements, label: `since an agent last edited this scene (${last.at})` };
    }
  }
  return { file, revision, base };
};

export const editLocalScene = async (
  command: Extract<LocalSceneCommand, { type: "local-edit" }>,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  const data = JSON.parse(await scenesController.localOnlyJson(command.name));
  await registerSceneFonts(data);
  const edit = await applyEdits(
    restoreElements(data.elements || [], null, { repairBindings: true }),
    command,
    convert,
    command.name,
  );
  const files = { ...(data.files || {}), ...(command.files || {}) };
  const images = repairImages(withTemplate(edit.elements, command.name).filter((el) => !el.isDeleted), files);
  const elements = images.elements;
  const json = withSceneName(withFonts(serializeAsJSON(elements, data.appState || {}, files, "local"), elements), command.name);
  await scenesController.writeLocalOnly(command.name, json);
  await setAgentBaseline(command.name, { at: new Date().toISOString(), action: "edit", elements });
  return {
    ...edit,
    ...images.info,
    ...sceneSize(json, elements),
    elements,
    files,
    appState: data.appState || {},
    revision: await rememberRevision(command.name, elements, json),
  };
};

export const saveLocalScene = async ({ name, json, replace, open }: Extract<LocalSceneCommand, { type: "local-save" }>) => {
  await scenesController.createLocalOnly(name, json, { replace: !!replace });
  const file = parseScene(json);
  await setAgentBaseline(name, { at: new Date().toISOString(), action: "save", elements: file.elements });
  if (open) {
    await scenesController.open(name);
  }
  return { saved: name, localOnly: true, revision: await rememberRevision(name, file.elements, json) };
};
