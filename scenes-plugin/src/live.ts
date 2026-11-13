import { editorYield } from "./editorYield";
// Live channel to the scenes server: lets agents (via the scenes MCP server)
// drive the editor that is open in the browser (switch scenes, save the
// open scene, convert MCP-style elements with real font metrics) and keeps
// the editor in sync when an agent saves a scene.

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  FONT_FAMILY,
  Fonts,
  restoreElements,
} from "@excalidraw/excalidraw";
import {
  BOUND_TEXT_PADDING,
  DEFAULT_FONT_SIZE,
  getFontString,
  getLineHeight,
} from "@excalidraw/common";
import { measureText, refreshTextDimensions, syncInvalidIndices, wrapText } from "@excalidraw/element";

import { BASE_URL, IS_ONLINE, TAB_ID, scenesApi } from "./api";
import { IDLE_PUSH_MS, scenesController } from "./controller";
import { penRefusal } from "./online/pen";
import {
  connection,
  claimPubName,
  spaceAccount,
  listPermissions,
  loadPubName,
  pubLink,
  releasePubName,
  setLinkAccess,
  sharedFileId,
  sharedFolderId,
  sharedFolders,
  shareLink,
} from "./online/drive";
import { linkAccessOf } from "./online/shareAccess";
import {
  editLocalScene,
  editOpenScene,
  editSceneOnDrive,
  readLocalScene,
  readOpenScene,
  saveLocalScene,
  withTemplate,
} from "./cowork";
import { bodyStyle, placeOnSlides } from "./slides";
import { checkDeck } from "./deckCheck";
import { pickSlides, slidesHtml } from "./pdfExport";
import { renderScene } from "./render";
import { applyMarkdown } from "./richText/agent";
import { layoutRich } from "./richText/layout";
import { docFromMarkdown, plainOf } from "./richText/model";
import { getCheckpoint, setCheckpoint } from "./storage";
import { addFont, customFonts, fontFamilyValue, fontFromGoogle, registerSceneFonts } from "./fonts";
import { fillFiles, leanScene } from "./leanFiles";
import { editsRunning, getPayload, keepPayload, onceForRequest } from "./agentRequests";
import { getUpload, keepUpload, withUploads } from "./uploads";
import { createReceiver, sendMessage } from "./online/frames";
import { needsConversion } from "../../scenes-mcp/convert.mjs";
import { PSEUDO_TYPES, commentsOnly } from "../../scenes-mcp/agentEdits.mjs";
import { OUTDATED_MESSAGE, checkServerBuild } from "./online/version";

import { pairing } from "./online/pairing";
import { serveRequest } from "./online/tabServer";

import type { EditCommand, LocalSceneCommand, ReadCommand, SceneEditCommand } from "./cowork";

import type { ClashChoice } from "./merge";
import type { RenderCommand } from "./render";

type Command =
  | { type: "status" }
  | { type: "open"; name: string }
  | { type: "create"; name: string }
  | { type: "save"; name?: string }
  | { type: "local-only"; name: string; on: boolean }
  | { type: "short-link"; name: string; shortName?: string | null; access?: "restricted" | "reader" | "writer" }
  | { type: "convert"; elements: any[]; deck?: string }
  | { type: "deck-check"; elements: any[]; files?: Record<string, any>; kurviqFonts?: unknown; deck: string; background?: string }
  | {
      type: "measure";
      items: Array<{ text: string; fontSize?: number; fontFamily?: number; lineHeight?: number; maxWidth?: number }>;
    }
  | {
      type: "slides-html";
      elements: any[];
      files?: any;
      kurviqFonts?: unknown;
      deck: string;
      background?: string;
      slides?: string | Array<number | string>;
      includeSkipped?: boolean;
    }
  | { type: "preview"; elements: any[] }
  | { type: "rename"; name: string; to: string }
  | { type: "delete"; name: string }
  | { type: "clone"; name: string; to: string; open?: boolean }
  | { type: "checkpoint-save"; id: string; data: unknown }
  | { type: "checkpoint-load"; id: string }
  | { type: "conflict-info"; name: string }
  | { type: "flush"; name: string }
  | SceneEditCommand
  | LocalSceneCommand
  | {
      type: "conflict-resolve";
      name: string;
      resolution: "merge" | "mine" | "theirs" | "both";
      choices?: Record<string, ClashChoice>;
      otherwise?: ClashChoice;
    }
  | (RenderCommand & { conflict?: { name: string; side: "mine" | "theirs" } })
  | ReadCommand
  | EditCommand
  /** online: a request of the remote MCP to "the scenes server" (served by this tab) */
  | { type: "http"; request: import("./online/tabServer").TabRequest }
  | { type: "upload"; file: { id: string; mimeType: string; dataURL: string } }
  | { type: "add-font"; name: string }
  /** online: a big edit an agent uploaded, kept until edit_scene names it */
  | { type: "upload-payload"; payload: { id: string; json: string } }
  | { type: "payload"; id: string }
  /** the health check (app_status): through the same queues as edits and pictures */
  | { type: "ping" };

/** hidden headless tab started by the scenes server, only renders/converts */
export const IS_RENDERER = new URLSearchParams(window.location.search).has(
  "scenes-renderer",
);

/** the size texts will have in this tab (with the real fonts), plain or formatted (markdown), wrapped at maxWidth */
const measureTexts = async (
  input: Array<{ text?: string; markdown?: string; fontSize?: number; fontFamily?: number; lineHeight?: number; maxWidth?: number }>,
) => {
  // formatted text (markdown): laid out as it will show
  const items = input.map((item) => {
    if (typeof item.markdown !== "string") {
      return { ...item, text: item.text ?? "", doc: null };
    }
    const doc = docFromMarkdown(item.markdown);
    return { ...item, text: plainOf(doc), doc };
  });
  await Fonts.loadElementsFonts(
    items.map((item) => ({
      type: "text",
      fontFamily: (fontFamilyValue(item.fontFamily) as number) ?? FONT_FAMILY.Excalifont,
      text: item.text,
      originalText: item.text,
    })) as any,
  ).catch(() => []);
  return items.map((item) => {
    const fontFamily = (fontFamilyValue(item.fontFamily) as number) ?? FONT_FAMILY.Excalifont;
    const fontSize = item.fontSize ?? DEFAULT_FONT_SIZE;
    const font = getFontString({ fontSize, fontFamily } as any);
    const lineHeight = (item.lineHeight ?? getLineHeight(fontFamily as any)) as any;
    if (item.doc) {
      const spec = { fontFamily, fontSize, lineHeight, textAlign: "left" };
      const layout = layoutRich(spec, item.doc, item.maxWidth ?? null);
      return {
        markdown: item.markdown,
        width: Math.ceil(layout.width),
        height: Math.ceil(layout.height),
        lines: layout.text.split("\n").length,
        ...(item.maxWidth ? { wrapped: layout.text } : {}),
      };
    }
    const text = item.maxWidth ? wrapText(item.text, font, item.maxWidth) : item.text;
    const size = measureText(text, font, lineHeight);
    return {
      text: item.text,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      lines: text.split("\n").length,
      ...(item.maxWidth ? { wrapped: text } : {}),
    };
  });
};

/** whether scene JSON names a font (a string fontFamily), pretty-printed or compact */
const namesFonts = (json: string) => /"fontFamily":\s*"/.test(json);

/** the font names (not numbers) an agent used in an element: its own, its label's, a deck theme's */
const fontNamesOf = (el: any): string[] =>
  [el?.fontFamily, el?.label?.fontFamily, el?.customData?.slides?.theme?.fontFamily].filter(
    (value): value is string => typeof value === "string",
  );

/**
 * Fonts an agent names that this tab doesn't know yet are fetched from
 * Google Fonts (like "Add font…" in the font picker), so agents can use any
 * Google font without the user adding it first. A name that isn't there
 * is a clear error instead of a broken text.
 */
const ensureFonts = async (command: any) => {
  const elements: any[] = [
    ...(Array.isArray(command.add) ? command.add : []),
    ...(Array.isArray(command.update) ? command.update : []),
    ...(Array.isArray(command.elements) ? command.elements : []),
    ...(Array.isArray(command.items) ? command.items : []),
  ];
  for (const json of [command.json, command.request?.method === "PUT" ? command.request.body : null]) {
    if (typeof json === "string" && namesFonts(json)) {
      try {
        elements.push(...(JSON.parse(json).elements || []));
      } catch {}
    }
  }
  const missing = new Set(
    elements.flatMap(fontNamesOf).filter((name) => typeof fontFamilyValue(name) === "string"),
  );
  for (const name of missing) {
    try {
      await addFont(await fontFromGoogle(name, { online: IS_ONLINE })); // NOSONAR S9382: in order on purpose (font registration must finish in request order)
    } catch (error: any) {
      throw new Error(
        `Font "${name}": ${error.message}. Use a font from fonts.google.com by its exact name, one of app_status → customFonts, or Excalidraw's own (Excalifont, Nunito, Helvetica …). A font file must be added by the user (font picker → "Add font…" → Font file).`,
      );
    }
  }
};

/** a scene file (JSON) from an agent: font names become numbers */
const sceneJsonWithFontIds = (json: string) => {
  if (!namesFonts(json)) {
    return json;
  }
  try {
    const data = JSON.parse(json);
    return JSON.stringify({ ...data, elements: (data.elements || []).map(withFontIds) });
  } catch {
    return json;
  }
};

/** an agent may name a font ("Geist") where Excalidraw stores its number */
const withFontIds = (el: any) => {
  if (!el || typeof el !== "object") {
    return el;
  }
  const next = { ...el };
  if (typeof next.fontFamily === "string") {
    next.fontFamily = fontFamilyValue(next.fontFamily);
  }
  if (typeof next.label?.fontFamily === "string") {
    next.label = { ...next.label, fontFamily: fontFamilyValue(next.label.fontFamily) };
  }
  const theme = next.customData?.slides?.theme;
  if (typeof theme?.fontFamily === "string") {
    next.customData = {
      ...next.customData,
      slides: { ...next.customData.slides, theme: { ...theme, fontFamily: fontFamilyValue(theme.fontFamily) } },
    };
  }
  return next;
};

const withBodyStyle = (el: any, body: NonNullable<ReturnType<typeof bodyStyle>>) => {
  if (el.version !== undefined) {
    return el;
  }
  if (el.type === "text" && !el.containerId) {
    return { fontFamily: body.fontFamily, fontSize: body.fontSize, strokeColor: body.strokeColor, ...el };
  }
  if (el.label && typeof el.label === "object" && el.label.text !== undefined) {
    return { ...el, label: { fontFamily: body.fontFamily, strokeColor: body.strokeColor, ...el.label } };
  }
  return el;
};

const restoreArrowBindings = (result: any[], rawById: Map<string, any>, byId: Map<string, any>) => {
  for (const arrow of result) {
    const raw = rawById.get(arrow.id);
    if (!raw || !needsConversion(raw) || arrow.type !== "arrow") {
      continue;
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = raw[key];
      const target = binding?.elementId && byId.get(binding.elementId);
      if (!target) {
        continue;
      }
      arrow[key] = {
        elementId: target.id,
        fixedPoint: binding.fixedPoint ?? [0.5, 0.5],
        mode: binding.mode ?? "orbit",
      };
      if (!target.boundElements?.some((b: any) => b.id === arrow.id)) {
        target.boundElements = [
          ...(target.boundElements || []),
          { type: "arrow", id: arrow.id },
        ];
      }
    }
  }
};

const restoreFrameBounds = (result: any[], rawById: Map<string, any>) => {
  for (const el of result) {
    const raw = rawById.get(el.id);
    if (raw && (el.type === "frame" || el.type === "magicframe") && needsConversion(raw)) {
      for (const key of ["x", "y", "width", "height"] as const) {
        if (typeof raw[key] === "number") {
          el[key] = raw[key];
        }
      }
    }
  }
};

const restoreTextBox = (el: any, raw: any, byId: Map<string, any>) => {
  // text with a given width: a box from x to x + width, its lines wrap at
  // the width and textAlign aligns them inside it (the converter would treat
  // x as the anchor of the alignment and shrink the box to the text)
  if (el.type === "text" && !el.containerId && !el.customData?.rich && raw.autoResize !== true && typeof raw.width === "number" && raw.width > 0) {
    el.autoResize = false;
    el.width = raw.width;
    if (typeof raw.x === "number") {
      el.x = raw.x;
    }
    const { x: _x, y: _y, ...size } = refreshTextDimensions(el, null, byId as any) || ({} as any);
    Object.assign(el, size, { width: raw.width });
    return;
  }
  // autoResize: true with a width: one line, aligned inside that box
  if (el.type === "text" && !el.containerId && el.autoResize !== false && typeof raw.width === "number" && typeof raw.x === "number") {
    if (el.textAlign === "center") {
      el.x = raw.x + (raw.width - el.width) / 2;
    } else if (el.textAlign === "right") {
      el.x = raw.x + raw.width - el.width;
    } else {
      el.x = raw.x;
    }
  }
};

const restoreRichText = (el: any, raw: any, byId: Map<string, any>) => {
  // formatted text: measured as it shows (the converter measured it as
  // plain text); with `autoResize: false` it wraps at its width
  if (el.type === "text" && !el.containerId && el.customData?.rich) {
    if (raw.autoResize !== true && typeof raw.width === "number") {
      el.autoResize = false;
      el.width = raw.width;
      if (typeof raw.x === "number") {
        el.x = raw.x;
      }
    }
    Object.assign(el, refreshTextDimensions(el, null, byId as any) || {});
  }
};

const restoreConvertedText = (result: any[], rawById: Map<string, any>, byId: Map<string, any>) => {
  for (const el of result) {
    const raw = rawById.get(el.id);
    // labels made from `label` live on their shape's slide
    if (el.containerId && !raw) {
      const container = byId.get(el.containerId);
      if (container && el.frameId !== (container.frameId ?? null)) {
        el.frameId = container.frameId ?? null;
      }
    }
    if (!raw || !needsConversion(raw)) {
      continue;
    }
    // closed (fillable) lines: the converter drops `polygon`
    if (el.type === "line" && typeof raw.polygon === "boolean") {
      el.polygon = raw.polygon;
    }
    restoreRichText(el, raw, byId);
    restoreTextBox(el, raw, byId);
  }
};

/**
 * Same conversion the excalidraw-mcp widget applies to `create_view`
 * elements (labels -> bound text, hand-drawn font), so scenes look exactly
 * like what the agent drew.
 */
const convertMcpElements = async (raw: any[], { deck }: { deck?: string } = {}) => {
  const input = raw.map(withFontIds);
  // in a deck, new text without its own font / size / color takes the template's body text style (like the app's defaults)
  const body = bodyStyle(input.filter((el) => el?.version !== undefined));
  const elements = placeOnSlides(input.map(applyMarkdown), input).map((el) => (el && body ? withBodyStyle(el, body) : el));
  // text is measured during conversion: the fonts (incl. the characters
  // used) must be loaded, otherwise widths are computed with a fallback font
  // and the text gets cut off in the user's browser
  await document.fonts.load("20px Excalifont").catch(() => {});
  const textLike = elements
    .filter((el) => el && (el.type === "text" || el.label?.text))
    .map((el) => ({
      type: "text",
      fontFamily: el.label?.fontFamily ?? el.fontFamily ?? FONT_FAMILY.Excalifont,
      text: el.label?.text ?? el.text ?? "",
      originalText: el.label?.text ?? el.text ?? "",
    }));
  await Fonts.loadElementsFonts(textLike as any).catch(() => []);
  const real = elements
    .filter((el) => el && !PSEUDO_TYPES.has(el.type))
    .map((el) => (el.label?.text && el.version === undefined ? fitLabel(el) : el))
    // new frames: their children are the elements naming them in frameId (if not listed)
    .map((el, _, all) =>
      (el.type === "frame" || el.type === "magicframe") && el.version === undefined && !Array.isArray(el.children)
        ? { ...el, children: all.filter((child) => child.frameId === el.id).map((child) => child.id) }
        : el,
    );
  // elements that are already complete (e.g. from an existing scene) are not
  // converted again (needsConversion); that would detach their bound text
  const rawById = new Map(real.map((el) => [el.id, el]));

  const converted = convertToExcalidrawElements(
    real.filter(needsConversion).map((el) => {
      const next = el.type === "text" ? { fontFamily: FONT_FAMILY.Excalifont, ...el } : el;
      return el.label
        ? {
            ...next,
            label: {
              textAlign: "center",
              verticalAlign: "middle",
              fontFamily: FONT_FAMILY.Excalifont,
              // readable by default (else it takes the shape's border color)
              strokeColor: "#1e1e1e",
              // predictable id, so later edits can address the label
              id: `${el.id}-label`,
              ...el.label,
            },
          }
        : next;
    }),
    { regenerateIds: false },
  );

  // keep the original z-order; labels go right after their container
  const convertedById = new Map(converted.map((el: any) => [el.id, el]));
  const labelsOf = new Map<string, any[]>();
  for (const el of converted as any[]) {
    if (el.containerId && !rawById.has(el.id)) {
      labelsOf.set(el.containerId, [...(labelsOf.get(el.containerId) || []), el]);
    }
  }
  const result: any[] = [];
  for (const raw of real) {
    const el = convertedById.get(raw.id);
    if (el) {
      // new elements get fresh fractional indices fitting their position
      result.push(
        { ...el, index: null },
        ...(labelsOf.get(raw.id) || []).map((label) => ({ ...label, index: null })),
      );
    } else {
      result.push({ ...raw });
    }
  }

  // convertToExcalidrawElements only understands `start`/`end`; carry over the
  // `startBinding`/`endBinding` ({ elementId, fixedPoint }) used by excalidraw-mcp
  const byId = new Map(result.map((el) => [el.id, el]));
  restoreArrowBindings(result, rawById, byId);
  // normalize like the editor does on load (fractional indices, bindings, …)
  // so the committed file doesn't change again when the app saves it
  // frames keep the position and size given: the converter fits frames with
  // children to them whenever x / y is 0 (falsy)
  restoreFrameBounds(result, rawById);
  restoreConvertedText(result, rawById, byId);
  syncInvalidIndices(result);
  const restored = restoreElements(result, null, { repairBindings: true });
  return deck ? withTemplate(restored, deck) : restored;
};

/**
 * Grow a labelled shape so that no word of its label is broken across lines
 * (e.g. "AI" in a small circle becoming "A/I"). Keeps the shape's center.
 */
const fitLabel = (el: any) => {
  if (!["rectangle", "ellipse", "diamond"].includes(el.type) || !el.width) {
    return el;
  }
  const fontSize = el.label.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = el.label.fontFamily ?? FONT_FAMILY.Excalifont;
  const font = getFontString({ fontSize, fontFamily });
  const longestWord = Math.max(
    ...String(el.label.text)
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => measureText(word, font, getLineHeight(fontFamily)).width),
  );
  // usable width inside the shape (as Excalidraw lays out bound text)
  let factor = 1;
  if (el.type === "ellipse") factor = Math.SQRT2;
  else if (el.type === "diamond") factor = 2;
  const needed = (longestWord + BOUND_TEXT_PADDING * 2 + 2) * factor;
  if (el.width >= needed) {
    return el;
  }
  const grow = needed - el.width;
  let height = el.height;
  if (el.type !== "rectangle") {
    height = Math.max(el.height ?? 0, el.height ? (el.height * needed) / el.width : needed);
  }
  return { ...el, x: el.x - grow / 2, width: needed, ...(el.height ? { y: el.y - (height - el.height) / 2, height } : {}) };
};

// -----------------------------------------------------------------------------
// live preview: watch an agent draw (every create_view call is mirrored here)
// -----------------------------------------------------------------------------

const LIVE_SCENE = "agent-live";
let liveToken = 0;

const showLive = async (elements: any[]) => {
  const token = ++liveToken;
  const isCurrent = () =>
    token === liveToken && scenesController.getState().current === LIVE_SCENE;

  const converted = await convertMcpElements(elements);
  if (scenesController.getState().current !== LIVE_SCENE) {
    await scenesController.openOrCreate(LIVE_SCENE);
  }
  const api = scenesController.getApi();
  if (!api || !isCurrent()) {
    return;
  }

  const camera = elements.find((el) => el?.type === "cameraUpdate");
  if (camera?.width && camera?.height) {
    api.setViewport({
      target: { x: camera.x, y: camera.y, width: camera.width, height: camera.height },
      fit: "contain",
      animation: true,
    });
  }

  const ids = new Set(converted.map((el: any) => el.id));
  const alreadyShown = new Set(
    api.getSceneElements().map((el) => el.id).filter((id) => ids.has(id)),
  );
  // bound labels appear together with their container
  const steps = converted.filter(
    (el: any) => !(el.containerId && ids.has(el.containerId)),
  );
  const pending = steps.filter((el: any) => !alreadyShown.has(el.id));
  const delay = Math.min(180, 4000 / Math.max(1, pending.length));

  const visible = new Set(alreadyShown);
  const render = () =>
    api.updateScene({
      elements: converted.filter(
        (el: any) =>
          visible.has(el.id) || (el.containerId && visible.has(el.containerId)),
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

  render(); // apply changes/deletions of existing elements right away
  for (const el of pending) {
    await editorYield(delay);
    if (!isCurrent()) {
      return;
    }
    visible.add(el.id);
    render();
  }
  if (!camera && converted.length) {
    await editorYield();
    api.setViewport({
      target: api.getSceneElements(),
      fit: "scale-down",
      animation: true,
    });
  }
};

const driveStatus = (sync: ReturnType<typeof scenesController.getState>["sync"]) => {
  if (sync.notConnected) return "not connected (all scenes stay in the user's browser, local-only)";
  if (sync.readOnly) return `read only: ${sync.readOnly} (scenes can be read, not changed)`;
  if (sync.driveOnline === false) return "offline";
  if (sync.driveOnline) return "online";
  if (sync.lastCheckedAt) return "unknown";
  return "checking (the first check with Drive hasn't finished yet)";
};

/** a scene's row in the status: its sync status, local-only as its own field, notes for agents */
const sceneRow = ({ name, status, pendingRename, localOnly }: ReturnType<typeof scenesController.getState>["list"][number]) => {
  const notes: string[] = [];
  if (localOnly) {
    notes.push("only in the user's browser, never synced to Drive");
  } else if (!scenesController.autoSyncFor(name!)) {
    notes.push("auto-sync off");
  }
  if (pendingRename) {
    notes.push(`rename in Drive pending, still "${pendingRename}" there`);
  }
  return { name: name!, status, localOnly: !!localOnly, ...(notes.length ? { note: notes.join("; ") } : {}) };
};

/** someone else holds the open scene's pen (or nobody, and this tab hasn't taken it) */
const penNote = (holder: string) =>
  holder ? `${holder} is editing the open scene: it is read only here, their tab saves it` : "Nobody is editing the open scene: it is read only here until the user clicks Edit";

const status = () => {
  const { current, dirty, list, sync, autoSync } = scenesController.getState();
  return {
    current,
    dirty,
    autoSync,
    // fonts the user added (besides Excalidraw's own): usable by name as fontFamily
    customFonts: customFonts.list().map((font) => font.family),
    drive: driveStatus(sync),
    // whose scenes this tab shows: each Google account has its own in the browser (null: scenes made signed out)
    account: spaceAccount ?? connection.getState().user?.email ?? null,
    space: spaceOf(),
    lastCheckedAt: sync.lastCheckedAt,
    // the health of this tab: what it is working on (an edit or picture running for minutes is stuck)
    busy: [...busy.values()].map(({ what, since }) => `${what} for ${Math.round((Date.now() - since) / 1000)} s`),
    editsRunning: editsRunning(),
    // a task of this tab that runs longer is given up, so it can't block the ones after it
    queueWatchdog: `${QUEUE_WATCHDOG_MS / 1000} s`,
    // someone else holds the pen of the open scene: it is read only here (their tab saves it)
    ...(scenesController.penLock() === null ? {} : { editing: penNote(scenesController.penLock()!) }),
    visible: document.visibilityState === "visible",
    // one row per scene: status synced / ahead (not pushed) / behind / diverged / conflict / local-only
    scenes: list.filter((item) => item.name !== null).map(sceneRow),
    autoSyncInfo:
      `The app pushes local changes of a scene to Drive by itself (about ${IDLE_PUSH_MS / 1000} s after the last edit) and pulls/merges Drive changes within about a minute (agent edits at once), unless auto-sync is off for that scene. Local-only scenes are never synced. Agents don't need to push. ` +
      "One person edits a Drive scene at a time (the pen): everyone else who has it open sees it read only and follows the changes live. Agent edits go only through the tab that holds the pen; otherwise the tool says who is editing.",
  };
};

/** what this tab's scene list is: the user's own scenes, a shared folder, or one shared scene */
const spaceOf = () => {
  if (sharedFolderId) {
    return "a shared folder (someone's Kurviq folder shared with the user): list_scenes and the scene tools work on its scenes, saved to the owner's folder";
  }
  return sharedFileId ? "one scene someone shared with the user" : "the user's own scenes";
};

/** the folders others shared with the user (each a group in their scene list) */
const sharedFolderStatus = async () => {
  if (!connection.isActive()) {
    return {};
  }
  try {
    const folders = (await sharedFolders()).filter((folder) => folder.folderId !== sharedFolderId);
    if (!folders.length) {
      return {};
    }
    return {
      sharedFolders: folders.map((folder) => ({
        name: folder.name,
        owner: folder.owner,
        ownerEmail: folder.ownerEmail ?? null,
        role: folder.role,
        scenes: folder.scenes.map((scene) => scene.name),
      })),
      sharedFoldersInfo:
        "Folders others shared with the user (role writer: they may edit). Your tools work on the scene list the user's tab shows: to work in one of these folders, ask the user to open it (scene list → the folder's group); don't switch their tab yourself.",
    };
  } catch {
    return {};
  }
};

/** app_status: right after the tab opened, wait a moment for its first Drive check */
const statusSettled = async () => {
  for (let i = 0; i < 25 && !scenesController.getState().sync.lastCheckedAt && !scenesController.getState().sync.notConnected; i++) {
    await editorYield(200); // NOSONAR S9382: in order on purpose (polls Drive status with a delay between checks)
  }
  return { ...status(), ...(await sharedFolderStatus()) };
};

/**
 * Rendering and measuring share the exporter's state (fonts, image caches):
 * run them one at a time, else parallel calls can lose elements
 */
const EXCLUSIVE = new Set(["render", "deck-check", "slides-html", "measure", "convert"]);
let exclusiveQueue: Promise<unknown> = Promise.resolve();

/**
 * A task that never settles (a picture that never loads, a request that
 * hangs) must not block every later one: the queue moves on after this long.
 */
const QUEUE_WATCHDOG_MS = 90_000;
const settledOrLate = (run: Promise<unknown>) =>
  Promise.race([run.catch(() => {}), new Promise((resolve) => setTimeout(resolve, QUEUE_WATCHDOG_MS))]);

/** what runs right now (the health check reports it) */
const busy = new Map<number, { what: string; since: number }>();
let busySeq = 0;
const tracked = async <T,>(what: string, task: () => Promise<T>): Promise<T> => {
  const id = ++busySeq;
  busy.set(id, { what, since: Date.now() });
  try {
    return await task();
  } finally {
    busy.delete(id);
  }
};

const exclusive = <T,>(task: () => Promise<T>) => {
  const run = exclusiveQueue.then(task);
  exclusiveQueue = settledOrLate(run);
  return run;
};

/** online: Drive lets the user read this space, not change it; agents can't either */
const refuseIfReadOnly = async (name: string | null | undefined) => {
  const { readOnly } = scenesController.getState().sync;
  if (readOnly && !(name && scenesController.isLocalOnly(name))) {
    throw new Error(`Read only: ${readOnly}. The user can view these scenes but not change them.`);
  }
  // one editor at a time: an agent edits only through the tab that holds the scene's pen
  const editing = name ? await penRefusal(name) : null;
  if (editing) {
    throw new Error(editing);
  }
};

/** the agent's edits of one scene must not overtake each other */
let agentEdits: Promise<unknown> = Promise.resolve();
const queueEdit = <T,>(task: () => Promise<T>) => {
  const run = agentEdits.then(task);
  agentEdits = settledOrLate(run);
  return run;
};

/** a scene file (JSON) whose image elements may name uploaded files: they go into its files */
const sceneJsonWithUploads = async (json: string) => {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return json;
  }
  if (!Array.isArray(data?.elements) || !data.elements.some((el: any) => el?.type === "image" && el.fileId)) {
    return json;
  }
  const { elements, files } = await withUploads(data.elements, data.files || {});
  return JSON.stringify({ ...data, elements, files });
};

/**
 * Images an agent uploaded (kurviq.com/mcp/<key>/upload) are referenced by
 * fileId: whatever the command, the file comes along from this tab's uploads.
 */
const attachUpdatedUploads = async (command: any) => {
  const files = { ...command.files };
  for (const item of command.update) {
    if (typeof item?.fileId === "string" && !files[item.fileId]) {
      const upload = await getUpload(item.fileId); // NOSONAR S9382: in order on purpose (uploads are attached in command order without concurrent requests)
      if (upload) {
        files[item.fileId] = { id: upload.id, mimeType: upload.mimeType, dataURL: upload.dataURL, created: upload.created };
      }
    }
  }
  command.files = files;
};

const attachUploads = async (command: any) => {
  if (Array.isArray(command.add)) {
    const { elements, files } = await withUploads(command.add, command.files || {});
    command.add = elements;
    command.files = files;
  }
  // an update that points an image at another uploaded picture: that picture comes along too
  // (the canvas holds only pictures a scene used, and none after a reload)
  if (Array.isArray(command.update)) {
    await attachUpdatedUploads(command);
  }
  if (command.type === "convert" && Array.isArray(command.elements)) {
    command.elements = (await withUploads(command.elements)).elements;
  }
  if (command.type === "local-save" && typeof command.json === "string") {
    command.json = sceneJsonWithFontIds(await sceneJsonWithUploads(command.json));
  }
  if (command.type === "http" && command.request?.method === "PUT" && typeof command.request.body === "string") {
    command.request = { ...command.request, body: sceneJsonWithFontIds(await sceneJsonWithUploads(command.request.body)) };
  }
};

const addCommandFont = async (command: Extract<Command, { type: "add-font" }>) => {
  const name = String((command as any).name || "").trim();
  const known = customFonts.byName(name);
  if (!known) {
    await ensureFonts({ add: [{ type: "text", fontFamily: name }] });
  }
  return {
    added: customFonts.byName(name)?.family ?? name,
    alreadyThere: !!known,
    use: `"fontFamily": "${customFonts.byName(name)?.family ?? name}"`,
    customFonts: customFonts.list().map((font) => font.family),
  };
 };

const uploadCommandFile = async (command: Extract<Command, { type: "upload" }>) => {
  // an image the agent uploaded: kept in this tab until a scene uses it
  const file = await keepUpload((command as any).file);
  scenesController.getApi()?.addFiles([{ id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created } as any]);
  const kb = Math.round((file.dataURL.length - file.dataURL.indexOf(",") - 1) * 0.75 / 1024);
  return {
    fileId: file.id,
    mimeType: file.mimeType,
    width: file.width,
    height: file.height,
    kb,
    // the agent decides; Kurviq keeps the image as it is
    ...(kb > 500 || Math.max(file.width ?? 0, file.height ?? 0) > 2400
      ? { note: `Large for a scene: ${kb} KB, ${file.width}×${file.height}. Every picture travels with the scene file and counts toward Kurviq's 30 MB per scene (stored at about 1.8× its size). A slide is 1920×1080: about twice the size it is shown at is enough. WebP (keeps transparency) or JPEG usually needs a fraction of a PNG's bytes. Shrinking is up to you.` }
      : {}),
  };
 };

const commandShortLink = async (command: Extract<Command, { type: "short-link" }>) => {
  // a scene's links: kurviq.com/pub/<short name> (unique on Kurviq) and the long one; optionally who may open them
  const fileId = await scenesController.fileForSharing(command.name);
  if (command.access) {
    await setLinkAccess(fileId, command.access);
  }
  const before = await loadPubName(fileId);
  if (command.shortName === null && before) {
    await releasePubName(fileId, before);
  } else if (command.shortName && command.shortName !== before) {
    await claimPubName(fileId, command.shortName);
  }
  const short = command.shortName === undefined ? before : command.shortName; // NOSONAR S6606: null releases the short link; only undefined keeps the previous name
  const grants = linkAccessOf(await listPermissions(fileId));
  const access = grants.anyone;
  const link = short ? pubLink(short) : shareLink(fileId, command.name);
  return {
    scene: command.name,
    shortLink: short ? pubLink(short) : null,
    longLink: shareLink(fileId, command.name),
    presentLink: `${link}?present`,
    generalAccess: access,
    // "anyone at <domain> with the link" (Google Workspace), set in Kurviq's share panel or in Drive
    ...(grants.domains.length ? { domainAccess: grants.domains.map(({ domain, role }) => ({ domain, role })) } : {}),
    ...(access === "restricted"
      ? { note: "Only people the scene is shared with can open these links (signed in with Google). For everyone: generalAccess \"reader\", only if the user wants it public." }
      : {}),
  };
 };

const commandResolveConflict = async (command: Extract<Command, { type: "conflict-resolve" }>) => {
  switch (command.resolution) {
          case "merge":
            return {
              ...(await scenesController.resolveConflict(command.name, command.choices || {}, command.otherwise)),
              ...status(),
            };
          case "mine":
            await scenesController.keepMine(command.name);
            return { resolved: true, kept: "mine (Drive overwritten)", ...status() };
          case "theirs":
            await scenesController.takeTheirs(command.name);
            return { resolved: true, kept: "Drive's (local changes discarded)", ...status() };
          case "both": {
            const copy = await scenesController.keepBoth(command.name);
            return { resolved: true, kept: `Drive's; local version saved as "${copy}"`, copy, ...status() };
          }
        }
        throw new Error(`Unknown resolution: ${(command as any).resolution}`);
 };

/** a saved scene a render command names (local-only: this browser's copy; else read as the agent's server reads it) */
const namedScene = async (name: string, revision?: string) => {
  if (scenesController.isLocalOnly(name)) {
    return JSON.parse(await scenesController.localOnlyJson(name));
  }
  const query = revision ? `?md5=${encodeURIComponent(revision)}` : "";
  const res = await serveRequest({ method: "GET", path: `/api/scenes/${encodeURIComponent(name)}${query}` });
  if (res.status !== 200) {
    const error = JSON.parse(res.body || "{}").error;
    throw new Error(res.status === 404 ? `Scene "${name}" not found. list_scenes shows what exists.` : error ?? `Scene "${name}" could not be read`);
  }
  return JSON.parse(res.body);
};

const commandRender = async (command: Extract<Command, { type: "render" }>) => {
  if (command.sceneName !== undefined && !command.scene) {
    const scene = await namedScene(command.sceneName, command.revision);
    return renderScene({ ...command, scene, deck: command.deck ?? command.sceneName }, () => {
      throw new Error("unreachable");
    }, convertMcpElements);
  }
  if (command.conflict) {
          const scene = await scenesController.conflictScene(command.conflict.name, command.conflict.side);
          return renderScene({ ...command, scene }, () => {
            throw new Error("unreachable");
          }, convertMcpElements);
        }
        return renderScene(
          command,
          () => {
            const api = scenesController.getApi();
            if (!api) {
              throw new Error("Editor not ready");
            }
            return {
              elements: api.getSceneElements(),
              files: api.getFiles(),
              background: api.getAppState().viewBackgroundColor,
            };
          },
          convertMcpElements,
        );
 };

const runCommand = async (command: Command) => {
  await ensureFonts(command);
  if (Array.isArray((command as any).update)) {
    (command as any).update = (command as any).update.map(withFontIds);
  }
  if (Array.isArray((command as any).items)) {
    (command as any).items = (command as any).items.map(withFontIds);
  }
  await attachUploads(command);
  if (command.type === "add-font") return addCommandFont(command);
  if (command.type === "upload") return uploadCommandFile(command);
  switch (command.type) {
    case "flush":
      return scenesController.flush(command.name);
    case "scene-edit": {
      // comments alone: also where the user may only comment (live sync checks that)
      if (!commentsOnly(command)) {
        await refuseIfReadOnly(command.name);
      }
      const run = onceForRequest(
        command.requestId,
        () => queueEdit(() => editSceneOnDrive(command, convertMcpElements)),
        async () => JSON.parse((await scenesApi.load(command.name)).json).elements || [],
      );
      // saved to Drive from this tab: no server announces it, sync right away
      run.then(() => scenesController.syncNow({ refresh: true })).catch(() => {});
      return run;
    }
    case "upload-payload":
      return keepPayload(command.payload);
    case "payload":
      return { json: await getPayload(String(command.id || "")) };
    case "ping":
      // the health check: answered through the same queues as edits and pictures
      return queueEdit(() => exclusive(() => Promise.resolve({ pong: true })));
    case "http":
      return serveRequest(command.request);
    case "status":
      return statusSettled();
    case "local-read": {
      const read = await readLocalScene(command);
      return (command as any).lean ? { ...read, file: leanScene(read.file) } : read;
    }
    case "local-edit":
      return onceForRequest(
        (command as any).requestId,
        () => queueEdit(() => editLocalScene(command, convertMcpElements)),
        async () => JSON.parse(await scenesController.localOnlyJson(command.name)).elements || [],
      );
    case "local-save":
      return saveLocalScene(command);
    case "local-only":
      await scenesController.setLocalOnly(command.name, command.on);
      return status();
    case "short-link": return commandShortLink(command);
    case "open":
      await scenesController.open(command.name);
      return status();
    case "create":
      await scenesController.create(command.name);
      return status();
    case "save":
      return { ...(await scenesController.save(command.name)), ...status() };
    case "preview":
      // answer right away, the animation runs on its own
      showLive(command.elements).catch((error) =>
        console.error("[scenes] live preview failed", error),
      );
      return { ok: true, scene: LIVE_SCENE };
    case "rename":
      await scenesController.rename(command.name, command.to);
      return { renamed: command.name, to: command.to, ...status() };
    case "delete":
      await scenesController.remove(command.name);
      return { deleted: command.name, ...status() };
    case "clone":
      await scenesController.clone(command.name, command.to, { open: !!command.open });
      return { cloned: command.name, to: command.to, ...status() };
    case "read":
      return readOpenScene(command);
    case "edit":
      if (!commentsOnly(command)) {
        await refuseIfReadOnly(scenesController.getState().current);
      }
      // like the other edits: one at a time, and a request sent again is not applied twice
      return onceForRequest(
        command.requestId,
        () => queueEdit(() => editOpenScene(command, convertMcpElements)),
        () => Promise.resolve([...(scenesController.getApi()?.getSceneElements() ?? [])]),
      );
    case "checkpoint-save":
      await setCheckpoint(command.id, command.data);
      return { ok: true };
    case "checkpoint-load":
      return { data: await getCheckpoint(command.id) };
    case "conflict-info":
      return scenesController.conflictInfo(command.name);
    case "conflict-resolve":
      return commandResolveConflict(command);
    case "render":
      return commandRender(command);
    case "deck-check":
      // the scene's own fonts first: text is measured with them
      await registerSceneFonts(command);
      return checkDeck(restoreElements(command.elements, null, { repairBindings: true }), {
        ...command,
        // pictures, for the contrast of text on them (filled in from this tab: reads are lean)
        files: await fillFiles(command.files as any, scenesController.getApi()?.getFiles()),
      });
    case "slides-html": {
      await registerSceneFonts(command);
      const elements = restoreElements(command.elements, null, { repairBindings: true });
      const frames = pickSlides(elements, command.slides ?? "all", { includeSkipped: command.includeSkipped });
      return {
        html: await slidesHtml(elements, command.files || {}, frames, command),
        slides: frames.map((frame) => frame.name ?? frame.id),
      };
    }
    case "measure":
      return { results: await measureTexts(command.items) };
    case "convert":
      return { elements: await convertMcpElements(command.elements, { deck: command.deck }) };
    default:
      throw new Error(`Unknown command: ${(command as any).type}`);
  }
};

let source: EventSource | null = null;
let focusedAt = document.hasFocus() ? Date.now() : 0;

const tabState = () => {
  const { current, dirty } = scenesController.getState();
  return {
    current,
    dirty,
    visible: document.visibilityState === "visible",
    focusedAt,
    drive: connection.isActive(),
  };
};

const report = () => {
  if (IS_ONLINE) {
    if (socket?.readyState === WebSocket.OPEN) {
      sendMessage(socket, { type: "state", state: tabState() });
    }
    return;
  }
  scenesApi.reportState(tabState()).catch((error) => console.error("[scenes] report state failed", error));
};

const handleCommand = async (event: { id: string; command: Command }, reply: (payload: { ok: boolean; result?: unknown; error?: string }) => void) => {
  try {
    await scenesController.ready;
    const type = event.command.type;
    const run = () => (EXCLUSIVE.has(type) ? exclusive(() => runCommand(event.command)) : runCommand(event.command));
    const result = await (type === "status" ? run() : tracked(type, run));
    reply({ ok: true, result });
  } catch (error: any) {
    reply({ ok: false, error: error.message });
  }
};

if (import.meta.env.DEV || import.meta.env.VITE_APP_GOOGLE_API_BASE) {
  // end-to-end tests (dev, and builds for the fake Google): run an agent's command as the MCP would
  (window as any).__agentCommand = (command: Command) =>
    new Promise((resolve) => {
      handleCommand({ id: `e2e-${Date.now()}`, command }, resolve).catch(() => {});
    });
}

// -----------------------------------------------------------------------------
// online (Kurviq): one WebSocket per tab to this browser's pairing; the
// remote MCP's commands arrive here, results go back the same way
// -----------------------------------------------------------------------------

let socket: WebSocket | null = null;
let socketRetry = 0;
let socketTimer: number | null = null;
let socketWanted = false;
let socketKey: string | null = null;

const openSocket = () => {
  socketTimer = null;
  const url = pairing.liveUrl(TAB_ID);
  if (!socketWanted || !url) {
    return;
  }
  socketKey = pairing.getKey();
  const ws = new WebSocket(url);
  socket = ws;
  const receive = createReceiver();
  let ping: number | null = null;
  ws.onopen = () => {
    socketRetry = 0;
    sendMessage(ws, { type: "state", state: tabState() });
    ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
  };
  ws.onmessage = (message) => {
    if (message.data === "pong") {
      return;
    }
    let event;
    try {
      event = receive(String(message.data));
    } catch (error) {
      console.error("[kurviq] dropped a malformed message from the agent link", error);
      return;
    }
    if (!event) {
      return;
    }
    if (event.type === "command") {
      const answer = (payload: { ok: boolean; result?: unknown; error?: string }) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendMessage(ws, { type: "result", id: event.id, ...payload });
        }
      };
      if (checkServerBuild(event.build)) {
        answer({ ok: false, error: OUTDATED_MESSAGE });
        return;
      }
      handleCommand(event, answer).catch((error) => console.error("[kurviq] command reply failed", error));
    } else if (event.type === "scene-saved" || event.type === "scene-renamed" || event.type === "scene-deleted") {
      scenesController.syncNow().catch((error) => console.error("[scenes] sync failed", error));
    }
  };
  ws.onclose = () => {
    if (ping) {
      clearInterval(ping);
    }
    if (socket === ws) {
      socket = null;
      scheduleSocket();
    }
  };
};

const scheduleSocket = () => {
  if (!socketWanted || socketTimer !== null || !pairing.getKey()) {
    return;
  }
  const delay = Math.min(30_000, 1000 * 2 ** socketRetry++);
  socketTimer = window.setTimeout(openSocket, delay);
};

/** (re)connect when the pairing key appears, changes or is removed */
const followPairing = () => {
  if (pairing.getKey() === socketKey && socket) {
    return;
  }
  const old = socket;
  socket = null;
  old?.close();
  socketRetry = 0;
  if (socketTimer !== null) {
    clearTimeout(socketTimer);
    socketTimer = null;
  }
  if (pairing.getKey()) {
    openSocket();
  }
};

const onFocus = () => {
  focusedAt = Date.now();
  report();
};

/** tell the server when the open scene or its unsaved state changes */
const reportSceneChanges = () => {
  let last = "";
  scenesController.subscribe(() => {
    const { current, dirty } = scenesController.getState();
    const key = JSON.stringify([current, dirty]);
    if (key !== last) {
      last = key;
      report();
    }
  });
};

export const connectLive = () => {
  if (IS_ONLINE) {
    if (socketWanted) {
      return;
    }
    socketWanted = true;
    pairing.subscribe(followPairing);
    connection.subscribe(report);
    followPairing();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", report);
    reportSceneChanges();
    return;
  }
  if (source) {
    return;
  }
  source = new EventSource(
    `${BASE_URL}/api/events?tab=${TAB_ID}${IS_RENDERER ? "&role=renderer" : ""}`,
  );
  source.onopen = report;
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", report);
  source.onmessage = async (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "command") {
      handleCommand(event, (payload) => {
        scenesApi.sendResult(event.id, payload).catch((error) => console.error("[scenes] command result failed", error));
      }).catch((error) => console.error("[scenes] command reply failed", error));
    } else if (["scene-saved", "scene-renamed", "scene-deleted"].includes(event.type)) {
      if (IS_RENDERER || event.source === `app:${TAB_ID}`) {
        return;
      }
      if (event.type === "scene-renamed") {
        await scenesController.followRemoteRename(event.from, event.to, event.md5 ?? null);
      }
      // someone else pushed: check and sync (visible in the activity log)
      scenesController.syncNow().catch((error) => console.error("[scenes] sync failed", error));
    }
  };
  reportSceneChanges();
};
