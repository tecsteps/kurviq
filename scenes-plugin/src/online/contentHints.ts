// Drive's content hints for a scene's file: a preview (thumbnail, for Drive's
// grid and Google's picker) and the words to index (Drive's search). The tab
// that saves the scene builds both and sends them with the content in the
// same upload (drive.ts, driveScenes.save): agents' edits and the pen
// holder's saves go through it too. Google keeps them with the file; nothing
// goes to Kurviq's server.
//
// Rendering must neither hold up the save nor the editor: previews are kept
// per scene and content (MD5), a save waits for a render at most TIME_BOX_MS
// (a later one is sent afterwards as a metadata-only change, if Drive still
// has that content), and a scene whose render is slow is drawn again at most
// every SLOW_EVERY_MS while it is edited; saves in between carry its last
// preview (Drive drops a preview whenever the content changes without one).

import { presentationOf } from "../../../scenes-mcp/presentation.mjs";
import { deckOrder, slideData } from "../../../scenes-mcp/slideRules.mjs";

import { sceneIndexText } from "./indexText";

export type Thumbnail = { image: string; mimeType: string };
export type ContentHints = { indexableText?: string; thumbnail?: Thumbnail };
/** what the preview shows: the whole scene, or one slide (its frame) */
export type ThumbnailTarget = { frameId: string | null };

/** about this wide (px) */
export const THUMBNAIL_WIDTH = 400;
/** at most twice as tall as wide, so a long strip of a scene stays a sensible image */
const THUMBNAIL_MAX_HEIGHT = 800;
/** Drive's limit for a thumbnail (counted on the encoded image, to be safe) */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

const TIME_BOX_MS = 1500;
const SLOW_MS = 400;
const SLOW_EVERY_MS = 2 * 60_000;
const MAX_SCENES = 30;

/** standard base64 → URL-safe base64 (RFC 4648 §5), as Drive's thumbnail.image wants it */
export const toBase64Url = (base64: string) => base64.replaceAll("+", "-").replaceAll("/", "_");

/** the length of n bytes in base64 */
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** scale of a width × height drawing for a preview THUMBNAIL_WIDTH wide (at most THUMBNAIL_MAX_HEIGHT tall) */
export const thumbnailScale = (width: number, height: number) => {
  if (!(width > 0) || !(height > 0)) {
    return 1;
  }
  return Math.min(THUMBNAIL_WIDTH / width, THUMBNAIL_MAX_HEIGHT / height);
};

type SceneData = { elements?: any[]; appState?: Record<string, unknown>; files?: unknown };

/**
 * What the preview of a scene shows: a presentation's first slide (the first
 * one not skipped), else everything; null when nothing is drawn.
 */
export const thumbnailTarget = (data: SceneData | null | undefined): ThumbnailTarget | null => {
  const visible = (Array.isArray(data?.elements) ? data.elements : []).filter((element) => element && !element.isDeleted);
  if (!visible.length) {
    return null;
  }
  const slides: any[] = presentationOf({ elements: visible, appState: data?.appState }) ? deckOrder(visible) : [];
  const first = slides.find((slide) => !slideData(slide).skip) ?? slides[0];
  return { frameId: first?.id ?? null };
};

type Render = (data: SceneData, target: ThumbnailTarget) => Promise<Thumbnail | null>;
type Patch = (hints: ContentHints) => Promise<unknown>;

const renderInBrowser: Render = async (data, target) => {
  if (typeof document === "undefined") {
    return null; // no canvas here (unit tests): no preview
  }
  const { renderThumbnail } = await import("./thumbnail");
  return renderThumbnail(data, target);
};

const late = (ms: number) => new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms));

type Drawn = { checksum: string; thumbnail: Thumbnail | null; at: number; took: number };
type Latest = { checksum: string; indexableText: string; data: SceneData | null };

const withHints = (indexableText: string, thumbnail: Thumbnail | null): ContentHints | null => {
  if (!indexableText && !thumbnail) {
    return null;
  }
  return { ...(indexableText ? { indexableText } : {}), ...(thumbnail ? { thumbnail } : {}) };
};

/** a map that keeps its MAX_SCENES newest keys */
const remember = <T>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SCENES) {
    map.delete(map.keys().next().value!);
  }
};

type Options = { render?: Render; now?: () => number; timeBox?: number };

/**
 * The content hints of one tab: forSave before the upload, afterSave once
 * Drive has the content (with a function that sends hints as a metadata-only
 * change of that file, for previews that came too late for the upload).
 * Scenes are known by their name (one tab works in one space).
 */
export class ContentHintsCache {
  private readonly render: Render;
  private readonly now: () => number;
  private readonly timeBox: number;
  /** per scene: its last preview */
  private readonly drawn = new Map<string, Drawn>();
  /** per scene: its latest save's content (the data only while a slow preview may still need it) */
  private readonly latest = new Map<string, Latest>();
  /** per scene: the content Drive has (as far as this tab saved it) and how to change its metadata */
  private readonly saved = new Map<string, { checksum: string; patch: Patch }>();
  /** per scene: a preview that came after its upload started, waiting for the upload */
  private readonly waiting = new Map<string, { checksum: string; thumbnail: Thumbnail }>();
  private readonly rendering = new Map<string, Promise<Thumbnail | null>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor({ render = renderInBrowser, now = Date.now, timeBox = TIME_BOX_MS }: Options = {}) {
    this.render = render;
    this.now = now;
    this.timeBox = timeBox;
  }

  /** the hints to send with this content of the scene (null: none) */
  async forSave(name: string, json: string, checksum: string): Promise<ContentHints | null> {
    let data: SceneData;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
    const indexableText = sceneIndexText(name, data);
    remember(this.latest, name, { checksum, indexableText, data });
    this.flush(name);
    const thumbnail = await this.thumbnailFor(name, data, checksum).catch(() => null);
    return withHints(indexableText, thumbnail);
  }

  /** Drive has this content of the scene now; patch sends hints as a metadata-only change of its file */
  afterSave(name: string, checksum: string, patch: Patch) {
    remember(this.saved, name, { checksum, patch });
    const current = this.latest.get(name);
    if (current?.checksum === checksum && !this.timers.has(name)) {
      current.data = null; // no slow preview waits for it: the scene's data (pictures …) isn't kept
    }
    this.flush(name);
  }

  /** a late preview goes out once its content is in Drive, unless newer content came meanwhile */
  private flush(name: string) {
    const preview = this.waiting.get(name);
    const current = this.latest.get(name);
    if (!preview) {
      return;
    }
    if (current?.checksum !== preview.checksum) {
      this.waiting.delete(name); // superseded: the newer save carries its own
      return;
    }
    const target = this.saved.get(name);
    if (target?.checksum === preview.checksum) {
      this.waiting.delete(name);
      // a preview is a nicety: if this fails, the next save sends one again
      target.patch(withHints(current.indexableText, preview.thumbnail)!).catch(() => null);
    }
  }

  private deliverLate(name: string, checksum: string, thumbnail: Thumbnail | null) {
    if (thumbnail) {
      this.waiting.set(name, { checksum, thumbnail });
      this.flush(name);
    }
  }

  /** renders a content once (saves of the same content share it) and remembers how long it took */
  private draw(name: string, data: SceneData, checksum: string, target: ThumbnailTarget) {
    const key = `${name}\n${checksum}`;
    const running = this.rendering.get(key);
    if (running) {
      return running;
    }
    const started = this.now();
    const result = this.render(data, target)
      .catch(() => null)
      .then((thumbnail) => {
        remember(this.drawn, name, { checksum, thumbnail, at: this.now(), took: this.now() - started });
        return thumbnail;
      })
      .finally(() => this.rendering.delete(key));
    this.rendering.set(key, result);
    return result;
  }

  /** a slow scene's next preview, SLOW_EVERY_MS after its last one, of what was saved last by then */
  private scheduleSlow(name: string, last: Drawn) {
    if (this.timers.has(name)) {
      return;
    }
    const timer = setTimeout(() => this.drawSlow(name), Math.max(0, last.at + SLOW_EVERY_MS - this.now()));
    this.timers.set(name, timer);
  }

  private drawSlow(name: string) {
    this.timers.delete(name);
    const current = this.latest.get(name);
    const target = current?.data ? thumbnailTarget(current.data) : null;
    if (!current?.data || !target || this.drawn.get(name)?.checksum === current.checksum) {
      return;
    }
    const { checksum, data } = current;
    current.data = null;
    this.draw(name, data, checksum, target)
      .then((thumbnail) => this.deliverLate(name, checksum, thumbnail))
      .catch(() => null);
  }

  private async thumbnailFor(name: string, data: SceneData, checksum: string) {
    const target = thumbnailTarget(data);
    if (!target) {
      return null; // an empty scene has no preview
    }
    const last = this.drawn.get(name);
    if (last?.checksum === checksum) {
      return last.thumbnail;
    }
    if (last && last.took > SLOW_MS && this.now() - last.at < SLOW_EVERY_MS) {
      this.scheduleSlow(name, last);
      return last.thumbnail; // a moment old, better than none
    }
    const rendered = this.draw(name, data, checksum, target);
    const first = await Promise.race([rendered, late(this.timeBox)]);
    if (first !== "late") {
      return first;
    }
    // too slow for this save: sent once it is ready (if still current)
    rendered.then((thumbnail) => this.deliverLate(name, checksum, thumbnail)).catch(() => null);
    return last?.thumbnail ?? null;
  }
}

/** this tab's content hints */
export const contentHints = new ContentHintsCache();
