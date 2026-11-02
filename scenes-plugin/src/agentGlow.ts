// An agent's edit arriving on the canvas morphs in instead of popping: a changed element
// crossfades from its old look to the new one (the old one drawn by Excalidraw on an overlay)
// and glides from its old place to the new one; a new element fades and rises in; a deleted one
// fades out where it was. A soft glow and an "Agent" tag mark the area for a moment, so the user
// notices what changed. Visual only: render overrides (the new elements) and an overlay (old
// looks, glow); nothing in the scene is touched. Off while presenting (the presenter owns the
// render overrides then); with "reduce motion" only the glow shows.

import { exportToCanvas, getCommonBounds, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import "./agentGlow.scss";

type El = { id: string; isDeleted?: boolean; version: number; versionNonce?: number; containerId?: string | null; opacity: number; x: number; y: number } & Record<string, any>;

const MORPH_MS = 700;
const GLOW_MS = 2200;
/** bigger edits: no old-look overlays (cost), one glow around the whole area */
const MAX_MORPHS = 30;
const MAX_BOXES = 40;
/** room around an old look, for strokes that reach past the element's box */
const GHOST_PAD = 12;

let running: { stop: () => void } | null = null;

/** presenting (present.tsx sets the class): the presenter owns the render overrides */
const presenting = () => document.body.classList.contains("slides-presenting");

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

type Ghost = { node: HTMLCanvasElement; bounds: readonly [number, number, number, number]; zoom: number; dx: number; dy: number; deleted: boolean };

const collectGhosts = (api: ExcalidrawImperativeAPI, before: ReadonlyMap<string, El>, changed: El[], deleted: El[], morphing: boolean, layer: HTMLElement) => {
  // the old looks of changed and deleted elements, drawn by Excalidraw
  const ghosts: Ghost[] = [];
  if (morphing) {
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const ratio = window.devicePixelRatio || 1;
    for (const el of [...changed, ...deleted]) {
      const was = before.get(el.id);
      if (!was) {
        continue;
      }
      const old = [was, ...labelsOf(before, was.id)];
      const isDeleted = deleted.includes(el);
      const ghost: Ghost = {
        node: document.createElement("canvas"),
        bounds: getCommonBounds(old as any),
        zoom,
        dx: isDeleted ? 0 : el.x - was.x,
        dy: isDeleted ? 0 : el.y - was.y,
        deleted: isDeleted,
      };
      ghost.node.className = "kq-agent-glow__ghost";
      ghosts.push(ghost);
      layer.appendChild(ghost.node);
      exportToCanvas({
        elements: old as any,
        appState: { ...appState, exportBackground: false, exportWithDarkMode: appState.theme === "dark" } as any,
        files: api.getFiles(),
        exportPadding: GHOST_PAD,
        getDimensions: (width: number, height: number) => ({ width: width * zoom * ratio, height: height * zoom * ratio, scale: zoom * ratio }),
      })
        .then((canvas) => {
          canvas.className = "kq-agent-glow__ghost";
          canvas.style.cssText = ghost.node.style.cssText;
          canvas.style.width = `${canvas.width / ratio}px`;
          canvas.style.height = `${canvas.height / ratio}px`;
          ghost.node.replaceWith(canvas);
          ghost.node = canvas;
        })
        .catch(() => {});
    }
  }

  return ghosts;
};

type Morph = { opacity: number; kind: "added" | "changed"; dx: number; dy: number };
const labelsOf = (map: ReadonlyMap<string, El>, id: string) => [...map.values()].filter((el) => el.containerId === id && !el.isDeleted);

const collectMorphs = (added: El[], changed: El[], before: ReadonlyMap<string, El>, now: ReadonlyMap<string, El>) => {
  // the new elements: id → how they come in (labels follow their shape)
  const morphs = new Map<string, Morph>();
  for (const el of added) {
    for (const item of [el, ...labelsOf(now, el.id)]) {
      morphs.set(item.id, { opacity: item.opacity ?? 100, kind: "added", dx: 0, dy: 0 });
    }
  }
  for (const el of changed) {
    const was = before.get(el.id)!;
    const dx = was.x - el.x;
    const dy = was.y - el.y;
    for (const item of [el, ...labelsOf(now, el.id)]) {
      morphs.set(item.id, { opacity: item.opacity ?? 100, kind: "changed", dx, dy });
    }
  }
  return morphs;
};

const markChangedContainer = (el: El, was: El | undefined, now: ReadonlyMap<string, El>, added: El[], changed: El[]) => {
  // a label: its shape stands for it (morphs when the label changed)
  const shape = now.get(el.containerId!);
  if (
    shape &&
    !el.isDeleted &&
    was &&
    (was.version !== el.version || was.versionNonce !== el.versionNonce) &&
    !changed.includes(shape) &&
    !added.some((item) => item.id === shape.id)
  ) {
    changed.push(shape);
  }
};

const classifyChanges = (before: ReadonlyMap<string, El>, after: readonly El[], now: ReadonlyMap<string, El>) => {
  const added: El[] = [];
  const changed: El[] = [];
  const deleted: El[] = [];
  const differs = (a: El, b: El) => a.version !== b.version || a.versionNonce !== b.versionNonce;
  for (const el of after) {
    const was = before.get(el.id);
    if (el.containerId) {
      markChangedContainer(el, was, now, added, changed);
      continue;
    }
    if (el.isDeleted) {
      if (was && !was.isDeleted) {
        deleted.push(was);
      }
    } else if (!was || was.isDeleted) {
      added.push(el);
    } else if (differs(was, el) && !changed.some((item) => item.id === el.id)) {
      changed.push(now.get(el.id) ?? el);
    }
  }
  return { added, changed, deleted };
};

/**
 * Show what an agent changed. `before`: the elements on the canvas before the edit (by id),
 * `after`: the elements the edit wrote (all of them, or only the changed ones).
 */
export const showAgentChange = (api: ExcalidrawImperativeAPI | null, before: ReadonlyMap<string, El>, after: readonly El[]) => {
  if (!api || typeof document === "undefined" || presenting()) {
    return;
  }
  const now = new Map((api.getSceneElements() as unknown as El[]).map((el) => [el.id, el]));
  const { added, changed, deleted } = classifyChanges(before, after, now);
  if (!added.length && !changed.length && !deleted.length) {
    return;
  }
  running?.stop();

  const reduceMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const morphing = !reduceMotion && added.length + changed.length + deleted.length <= MAX_MORPHS;

  const morphs = morphing ? collectMorphs(added, changed, before, now) : new Map<string, Morph>();
  if (morphing) {
    // hidden right away (before the next paint), the old looks cover their place meanwhile
    api.setElementRenderOverrides(new Map([...morphs].map(([id, morph]) => [id, { opacity: 0, offset: { x: morph.dx, y: morph.dy } }])));
  }

  const layer = document.createElement("div");
  layer.className = "kq-agent-glow";
  // inside the editor, under its toolbars and sidebars (z-index of the canvas buttons)
  (document.querySelector(".excalidraw") ?? document.body).appendChild(layer);

  const ghosts = collectGhosts(api, before, changed, deleted, morphing, layer);

  // the glow boxes around the result, in scene coordinates
  const marked = [...added.map((el) => ({ el, kind: "added" })), ...changed.map((el) => ({ el, kind: "changed" })), ...deleted.map((el) => ({ el, kind: "deleted" }))];
  const boxes =
    marked.length > MAX_BOXES
      ? [{ bounds: getCommonBounds(marked.map((item) => item.el) as any), kind: "changed" }]
      : marked.map(({ el, kind }) => ({ bounds: getCommonBounds([el] as any), kind }));
  const area = getCommonBounds(marked.map((item) => item.el) as any);
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

  const start = performance.now();
  let frame = 0;
  const tick = (time: number) => {
    const t = time - start;
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const progress = Math.min(1, t / MORPH_MS);
    const glide = easeInOut(progress);
    const fade = easeOut(progress);

    // the old looks: glide to the new place and fade out
    for (const ghost of ghosts) {
      const [x1, y1] = ghost.bounds;
      const at = sceneCoordsToViewportCoords({ sceneX: x1 - GHOST_PAD + ghost.dx * glide, sceneY: y1 - GHOST_PAD + ghost.dy * glide }, appState);
      const style = ghost.node.style;
      style.left = `${at.x}px`;
      style.top = `${at.y}px`;
      style.opacity = String(ghost.deleted ? 1 - fade : 1 - glide);
      style.transform = `scale(${(zoom / ghost.zoom) * (ghost.deleted ? 1 - 0.06 * fade : 1)})`;
    }
    // the new elements: fade in, glide from the old place (changed) or rise a little (added)
    if (morphs.size) {
      api.setElementRenderOverrides(
        progress >= 1
          ? null
          : new Map(
              [...morphs].map(([id, morph]) => [
                id,
                morph.kind === "added"
                  ? { opacity: morph.opacity * fade, offset: { x: 0, y: 16 * (1 - fade) } }
                  : { opacity: morph.opacity * glide, offset: { x: morph.dx * (1 - glide), y: morph.dy * (1 - glide) } },
              ]),
            ),
      );
      if (progress >= 1) {
        morphs.clear();
      }
    }
    // the glow and the tag, where the result is
    const pad = 6;
    boxes.forEach((box, i) => {
      const [x1, y1, x2, y2] = box.bounds;
      const topLeft = sceneCoordsToViewportCoords({ sceneX: x1, sceneY: y1 }, appState);
      const style = nodes[i].style;
      style.left = `${topLeft.x - pad}px`;
      style.top = `${topLeft.y - pad}px`;
      style.width = `${(x2 - x1) * zoom + pad * 2}px`;
      style.height = `${(y2 - y1) * zoom + pad * 2}px`;
    });
    const corner = sceneCoordsToViewportCoords({ sceneX: area[0], sceneY: area[1] }, appState);
    tag.style.left = `${corner.x - pad}px`;
    tag.style.top = `${corner.y - pad - 26}px`;

    if (t < GLOW_MS) {
      frame = requestAnimationFrame(tick);
    } else {
      stop();
    }
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    if (morphs.size && !presenting()) {
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
