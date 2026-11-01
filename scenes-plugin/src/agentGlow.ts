// An agent's edit arriving on the canvas: what it added fades and rises into place, and every
// element it added, changed or deleted gets a soft glow that fades out, with an "Agent" tag on
// top, so the user notices what changed. Visual only: render overrides (fade-in) and an overlay
// of fixed-position boxes; nothing in the scene is touched. Off while presenting (the presenter
// owns the render overrides then) and with "reduce motion" the fade-in is skipped.

import { getCommonBounds, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import "./agentGlow.scss";

type El = { id: string; isDeleted?: boolean; version: number; versionNonce?: number; containerId?: string | null; opacity: number } & Record<string, any>;

const FADE_MS = 450;
const GLOW_MS = 1800;
/** bigger edits: glow the whole area once instead of every element */
const MAX_BOXES = 40;

let running: { stop: () => void } | null = null;

/** presenting (present.tsx sets the class): the presenter owns the render overrides */
const presenting = () => document.body.classList.contains("slides-presenting");

/**
 * Show what an agent changed. `before`: the elements on the canvas before the edit (by id),
 * `after`: the elements the edit wrote (all of them, or only the changed ones).
 */
export const showAgentChange = (api: ExcalidrawImperativeAPI | null, before: ReadonlyMap<string, El>, after: readonly El[]) => {
  if (!api || typeof document === "undefined" || presenting()) {
    return;
  }
  const added: El[] = [];
  const changed: El[] = [];
  const deleted: El[] = [];
  for (const el of after) {
    const was = before.get(el.id);
    if (el.containerId) {
      // a label: its shape stands for it (glows when the label changed)
      const shape = after.find((item) => item.id === el.containerId) ?? (api.getSceneElements().find((item) => item.id === el.containerId) as El | undefined);
      if (shape && !shape.isDeleted && !el.isDeleted && was && (was.version !== el.version || was.versionNonce !== el.versionNonce) && !changed.includes(shape)) {
        changed.push(shape);
      }
      continue;
    }
    if (el.isDeleted) {
      if (was && !was.isDeleted) {
        deleted.push(was);
      }
    } else if (!was || was.isDeleted) {
      added.push(el);
    } else if (was.version !== el.version || was.versionNonce !== el.versionNonce) {
      changed.push(el);
    }
  }
  if (!added.length && !changed.length && !deleted.length) {
    return;
  }
  running?.stop();

  // the new elements (and their labels) fade and rise into place
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const fading = new Map<string, number>();
  if (!reduceMotion) {
    const addedIds = new Set(added.map((el) => el.id));
    for (const el of after) {
      if (!el.isDeleted && (addedIds.has(el.id) || (el.containerId && addedIds.has(el.containerId)))) {
        fading.set(el.id, el.opacity ?? 100);
      }
    }
  }

  // the glow boxes, in scene coordinates
  const boxes: Array<{ bounds: readonly [number, number, number, number]; kind: "added" | "changed" | "deleted" }> = [];
  const all = [...added.map((el) => ({ el, kind: "added" as const })), ...changed.map((el) => ({ el, kind: "changed" as const })), ...deleted.map((el) => ({ el, kind: "deleted" as const }))];
  if (all.length > MAX_BOXES) {
    boxes.push({ bounds: getCommonBounds(all.map((item) => item.el) as any), kind: "changed" });
  } else {
    for (const { el, kind } of all) {
      boxes.push({ bounds: getCommonBounds([el] as any), kind });
    }
  }
  const area = getCommonBounds(all.map((item) => item.el) as any);

  const layer = document.createElement("div");
  layer.className = "kq-agent-glow";
  const nodes = boxes.map((box) => {
    const node = document.createElement("div");
    node.className = `kq-agent-glow__box kq-agent-glow__box--${box.kind}`;
    layer.appendChild(node);
    return node;
  });
  const tag = document.createElement("div");
  tag.className = "kq-agent-glow__tag";
  tag.textContent = "✦ Agent";
  layer.appendChild(tag);
  // inside the editor, under its toolbars and sidebars (z-index of the canvas buttons)
  (document.querySelector(".excalidraw") ?? document.body).appendChild(layer);

  const start = performance.now();
  let frame = 0;
  const place = () => {
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const pad = 6;
    boxes.forEach((box, i) => {
      const [x1, y1, x2, y2] = box.bounds;
      const topLeft = sceneCoordsToViewportCoords({ sceneX: x1, sceneY: y1 }, appState);
      const node = nodes[i].style;
      node.left = `${topLeft.x - pad}px`;
      node.top = `${topLeft.y - pad}px`;
      node.width = `${(x2 - x1) * zoom + pad * 2}px`;
      node.height = `${(y2 - y1) * zoom + pad * 2}px`;
    });
    const corner = sceneCoordsToViewportCoords({ sceneX: area[0], sceneY: area[1] }, appState);
    tag.style.left = `${corner.x - pad}px`;
    tag.style.top = `${corner.y - pad - 26}px`;
  };
  const tick = (now: number) => {
    const t = now - start;
    place();
    if (fading.size) {
      const progress = Math.min(1, t / FADE_MS);
      const eased = 1 - (1 - progress) ** 3;
      api.setElementRenderOverrides(
        progress >= 1
          ? null
          : new Map(
              [...fading].map(([id, opacity]) => [
                id,
                { opacity: opacity * eased, ...((api.getSceneElements().find((el) => el.id === id) as El | undefined)?.containerId ? {} : { offset: { x: 0, y: 14 * (1 - eased) } }) },
              ]),
            ),
      );
      if (progress >= 1) {
        fading.clear();
      }
    }
    if (t < GLOW_MS) {
      frame = requestAnimationFrame(tick);
    } else {
      stop();
    }
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    if (fading.size && !presenting()) {
      api.setElementRenderOverrides(null);
    }
    layer.remove();
    if (running === handle) {
      running = null;
    }
  };
  const handle = { stop };
  running = handle;
  frame = requestAnimationFrame(tick);
};
