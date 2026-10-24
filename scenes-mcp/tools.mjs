/**
 * The scenes MCP tools, independent of where they run:
 *
 * = the upstream excalidraw-mcp tools (read_me, create_view, …) unchanged,
 *   plus tools to manage git-backed scenes (list/get/save/open/rename/delete/
 *   clone, co-working on scenes, slides, conflicts, …).
 *
 * Stateless: drafts (create_view checkpoints) and agent baselines are kept by
 * the app in the browser; scenes live in the browser and on GitHub.
 *
 * Everything goes through `serverFetch` = the scenes server's HTTP API:
 *  - locally (./server.mjs, stdio): the scenes server on this machine;
 *    detached mode (default) = the agent works in its own headless Excalidraw
 *    tab, live mode = in the user's open tab
 *  - online (../online/worker, Kurviq): the user's open Kurviq tab answers
 *    it through the pairing WebSocket
 */
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { convertInNode, needsConversion } from "./convert.mjs";
import { markdownOfElement } from "./richText.mjs";
import { byIds, commonBounds, deckOrder, diffElements, findSlide, inRegion, summarize, toRect } from "./inspect.mjs";
import { readEditFile, resolveImages } from "./media.mjs";

/** get_scene returns an overview instead of all elements above this size */
const SUMMARY_THRESHOLD = 150;
/** element data returned for a region / elementIds selection at most */
const MAX_SELECTED = 150;
/** changed elements reported in detail per kind (the rest: ids only) */
const MAX_CHANGE_DETAILS = 25;

/**
 * @param {object} options
 * @param {(pathname: string, init?: RequestInit) => Promise<Response>} options.serverFetch the scenes server's API
 * @param {string} options.unreachable error message when serverFetch fails
 * @param {"detached" | "live"} options.mode
 * @param {string} options.appHint the app's URL (in messages to agents)
 * @param {string} options.skill SKILL.md (the server's instructions)
 * @param {(server: McpServer, store: object) => void} options.registerUpstream registers excalidraw-mcp's tools
 * @param {(name: string, pdf: Uint8Array, file?: string) => Promise<object>} options.savePdf
 * @param {boolean} [options.livePreview] live mode: mirror create_view into the app
 * @param {string} [options.name] server name
 * @param {boolean} [options.githubOptional] online: the user's app may have no GitHub connected
 *   (app_status `github: false`) — new scenes are then local-only
 */
export const createScenesMcp = ({
  serverFetch,
  unreachable,
  mode,
  appHint,
  skill,
  registerUpstream,
  savePdf,
  livePreview = true,
  name = "Kurviq",
  githubOptional = false,
  /**
   * reads that only look at a scene take it without image bytes (Kurviq
   * online: the tab that serves it keeps the images and fills them in for
   * pictures)
   */
  leanReads = false,
  /**
   * the server can read the agent's files (edit files, image src paths, PDF
   * output); Kurviq online can't, so those options aren't offered there
   */
  localFiles = true,
  /** Kurviq online: where agents upload images and big edits (payloadId) */
  uploadUrl = null,
}) => {
  const LOCAL_FILES = !!localFiles;
  const APP_HINT = appHint;
  const MODE = mode;

  // -----------------------------------------------------------------------------
  // checkpoint store — create_view checkpoints (agent drafts) live in the
  // browser (IndexedDB of the app, or of the throwaway headless renderer when
  // no tab is open). This process and the scenes server keep no data at all.
  // -----------------------------------------------------------------------------

  const checkCheckpointId = (id) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new Error("Invalid checkpoint id");
    }
  };

  const store = {
    async save(id, data) {
      checkCheckpointId(id);
      await agentCommand({ type: "checkpoint-save", id, data });
    },
    async load(id) {
      checkCheckpointId(id);
      return (await agentCommand({ type: "checkpoint-load", id })).data ?? null;
    },
  };

  const newCheckpointId = () =>
    crypto.randomUUID().replace(/-/g, "").slice(0, 18);

  // -----------------------------------------------------------------------------
  // scenes server client
  // -----------------------------------------------------------------------------

  const call = async (pathname, init = {}) => {
    let res;
    try {
      res = await serverFetch(pathname, init);
    } catch {
      throw new Error(unreachable);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {}
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return text;
  };

  const callJson = async (pathname, init) => JSON.parse(await call(pathname, init));

  const appCommand = (command) =>
    callJson("/api/app/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    }).then((res) => res.result);

  /** the agent's own work (render, convert, drafts): its headless tab in detached mode */
  const agentCommand = (command) =>
    appCommand(MODE === "detached" ? { ...command, agentSide: true } : command);

  /** ask the user's tabs to push their unpushed changes of a scene (sync only) */
  const flushUser = async (name) => {
    try {
      return await callJson("/api/app/flush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch {
      return null;
    }
  };

  const sceneUrl = (name) => `/api/scenes/${encodeURIComponent(name)}`;

  /**
   * Kurviq online: reads that only look at a scene take it "lean" (images
   * without their bytes; the user's tab keeps them and fills them in for
   * pictures), so scenes full of images stay within the server's CPU budget.
   */
  const LEAN = !!leanReads;
  const leanQuery = (lean) => (lean && LEAN ? "?lean=1" : "");

  /** a scene on GitHub plus its blob sha (null if it doesn't exist) */
  const loadSceneWithSha = async (name, { lean = false } = {}) => {
    const res = await serverFetch(`${sceneUrl(name)}${leanQuery(lean)}`).catch(() => {
      throw new Error(unreachable);
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return { file: await res.json(), sha: res.headers.get("x-scene-sha") };
  };

  const loadSceneFile = async (name, { lean = false } = {}) => {
    try {
      return JSON.parse(await call(`${sceneUrl(name)}${leanQuery(lean)}`));
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  };

  /**
   * Local-only scenes exist only in the user's browser (never on GitHub): the
   * flush answer says so, and they are then read and edited through the
   * user's app.
   */
  const isLocalOnly = (flushed) => (flushed?.results || []).some((r) => r && r.localOnly);

  const LOCAL_NOTE =
    "Local-only scene: it exists only in the user's browser and is never synced to GitHub (the user decides if it ever is). You read and edit it through their app, which must be open.";

  const loadLocalScene = (name, since, { lean = false } = {}) =>
    appCommand({ type: "local-read", name, targetScene: name, ...(since ? { since } : {}), ...(lean && LEAN ? { lean: true } : {}) });

  /** a scene's content: from the user's browser if it is local-only, else from GitHub */
  const loadAnyScene = async (name, { lean = false } = {}) => {
    const flushed = await flushUser(name);
    if (isLocalOnly(flushed)) {
      return { local: true, file: (await loadLocalScene(name, undefined, { lean })).file };
    }
    return { local: false, file: await loadSceneFile(name, { lean }) };
  };

  const notFound = (name) =>
    new Error(
      `Scene "${name}" not found on GitHub. list_scenes shows what exists. (Local-only scenes live in the user's browser: they are only reachable while the app is open.)`,
    );

  // -----------------------------------------------------------------------------
  // elements
  // -----------------------------------------------------------------------------

  const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

  /** resolve create_view-style input (restoreCheckpoint / delete pseudo elements) */
  const resolveElements = async (input) => {
    const restore = input.find((el) => el.type === "restoreCheckpoint");
    let base = [];
    if (restore?.id) {
      const checkpoint = await store.load(restore.id);
      if (!checkpoint) {
        throw new Error(`Checkpoint "${restore.id}" not found`);
      }
      base = checkpoint.elements;
    }
    const deleteIds = new Set();
    for (const el of input) {
      if (el.type === "delete") {
        for (const id of String(el.ids ?? el.id).split(",")) {
          deleteIds.add(id.trim());
        }
      }
    }
    return [...base, ...input].filter(
      (el) =>
        !PSEUDO_TYPES.has(el.type) &&
        !deleteIds.has(el.id) &&
        !deleteIds.has(el.containerId),
    );
  };

  const toSceneElements = async (elements, deck) => {
    const isDeck = elements.some((el) => el?.type === "frame" && el.customData?.slides?.role === "template");
    if (!elements.some(needsConversion) && !isDeck) {
      return { elements, convertedBy: "none" };
    }
    try {
      // a deck's slides get their template copies (header, footer, page numbers)
      const result = await agentCommand({ type: "convert", elements, ...(deck ? { deck } : {}) });
      return { elements: result.elements, convertedBy: "browser" };
    } catch (error) {
      if (error.status !== 409 && error.status !== 504) {
        throw error;
      }
      return { elements: convertInNode(elements), convertedBy: "node (estimated text sizes)" };
    }
  };

  /** compact form for the model: drop noise fields and defaults */
  const compact = (elements) =>
    elements.map((el) => {
      const out = {};
      for (const [key, value] of Object.entries(el)) {
        if (
          ["seed", "version", "versionNonce", "updated", "isDeleted", "index", "lineHeight", "originalText", "autoResize", "baseline"].includes(key) ||
          value === null ||
          (Array.isArray(value) && value.length === 0) ||
          (key === "angle" && value === 0) ||
          (key === "opacity" && value === 100) ||
          (key === "locked" && value === false) ||
          (key === "strokeColor" && value === "#1e1e1e") ||
          (key === "backgroundColor" && value === "transparent") ||
          (key === "fillStyle" && value === "solid") ||
          (key === "strokeWidth" && value === 2) ||
          (key === "strokeStyle" && value === "solid") ||
          (key === "roughness" && value === 1)
        ) {
          continue;
        }
        out[key] = typeof value === "number" ? Math.round(value * 100) / 100 : value;
      }
      // formatted text: as the markdown it's written in (not the raw runs)
      if (el.customData?.rich) {
        const markdown = markdownOfElement(el);
        if (markdown !== null) {
          out.markdown = markdown;
        }
        const { rich: _rich, ...customData } = el.customData;
        if (Object.keys(customData).length) {
          out.customData = customData;
        } else {
          delete out.customData;
        }
      }
      return out;
    });

  // -----------------------------------------------------------------------------
  // tools
  // -----------------------------------------------------------------------------

  /** long id lists cost the agent context: the first ones and a count */
  const ID_LIST_MAX = 30;
  const idList = (ids = []) =>
    ids.length > ID_LIST_MAX ? [...ids.slice(0, ID_LIST_MAX), `… and ${ids.length - ID_LIST_MAX} more (${ids.length} in all)`] : ids;

  const text = (value) => ({
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  });

  const tool = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return { ...text(`Error: ${error.message}`), isError: true };
    }
  };

  const SCENE_NAME = z
    .string()
    .describe("Scene name: letters, numbers, spaces and _ . ( ) - (max 100 chars). Stored as scenes/<name>.excalidraw in the git repo.");

  const TEXTS_OFFSET = z
    .number()
    .optional()
    .describe("Overview: the labels are paged (100 per call); pass the offset the previous answer names to get the next ones");

  /** elements on a slide get x / y relative to its top-left corner (and "slide": its frame id), as edits take them */
  const relativeToSlides = (picked, all) => {
    const frames = new Map(all.filter((el) => el.type === "frame" || el.type === "magicframe").map((el) => [el.id, el]));
    return picked.map((el) => {
      const frame = el.frameId && frames.get(el.frameId);
      return frame ? { ...el, slide: frame.id, x: el.x - frame.x, y: el.y - frame.y } : el;
    });
  };

  /** element data for a region / elementIds selection, capped */
  const selection = (elements, { region, elementIds, relative }) => {
    const picked = elementIds?.length ? byIds(elements, elementIds) : inRegion(elements, region);
    return {
      selected: picked.length,
      bounds: toRect(commonBounds(picked)),
      elements: compact((relative ? relativeToSlides(picked, elements) : picked).slice(0, MAX_SELECTED)),
      ...(picked.length > MAX_SELECTED
        ? { more: `${picked.length - MAX_SELECTED} more elements in this selection: use a smaller region or elementIds` }
        : {}),
    };
  };

  /**
   * add / update / delete of an edit, from the arguments and/or a JSON file;
   * image elements (src / svg / icon) become image elements + files
   */
  /** an edit the agent uploaded (kept by the user's tab), like an edit file */
  const payloadEdit = async (id) => {
    const { json } = await appCommand({ type: "payload", id });
    const data = JSON.parse(json);
    return Array.isArray(data) ? { add: data } : data;
  };

  const editInput = async ({ add, update, delete: remove, file, payloadId }) => {
    const fromFile = file ? await readEditFile(file) : payloadId ? await payloadEdit(payloadId) : {};
    let addElements = [];
    for (const source of [add, fromFile.add]) {
      if (!source) {
        continue;
      }
      const parsed = typeof source === "string" ? JSON.parse(source) : source;
      if (!Array.isArray(parsed)) {
        throw new Error("add must be a JSON array");
      }
      addElements.push(...parsed);
    }
    addElements = addElements.filter((el) => !PSEUDO_TYPES.has(el.type));
    const { elements, files } = await resolveImages(addElements);
    const updates = [...(update || []), ...(fromFile.update || [])];
    const deletes = [...(remove || []), ...(fromFile.delete || [])];
    if (!elements.length && !updates.length && !deletes.length) {
      throw new Error("Nothing to do: pass add, update and/or delete (or an uploaded payloadId / a file with them)");
    }
    return { add: elements, update: updates, delete: deletes, files };
  };

  const EDIT_FILE = z
    .string()
    .optional()
    .describe('Absolute path of a JSON file with { "add": [...], "update": [...], "delete": [...] } (or just an array = add). Use it for big edits instead of pasting JSON.');

  const PAYLOAD_ID = z
    .string()
    .optional()
    .describe(`An edit you uploaded: { "add": [...], "update": [...], "delete": [...] } (or an array = add) as JSON, POSTed with curl --data-binary @edit.json ${uploadUrl ?? "<agent link>/upload"} (answers with its payloadId). Use it for big edits instead of pasting JSON.`);

  /** where big edits come from: a local file, or (online) an upload */
  const EDIT_SOURCE = LOCAL_FILES ? { file: EDIT_FILE } : { payloadId: PAYLOAD_ID };
  const BIG_EDITS = LOCAL_FILES
    ? "Big edits: put them in a JSON file and pass file (absolute path)."
    : `Big edits: upload the JSON ({ "add", "update", "delete" }) with curl --data-binary @edit.json ${uploadUrl ?? "<agent link>/upload"} and pass the payloadId it answers (nothing passes through your context twice).`;

  const IMAGES_HELP = `Images and icons: add { "type": "image", "id": "...", "x": 0, "y": 0, "width": 48, plus ONE of "src" (${LOCAL_FILES ? "absolute file path, " : ""}http(s) URL or data URL of a png/jpg/gif/webp/svg), "svg" (inline SVG markup) or "icon" ("lucide:<name>", e.g. "lucide:database", or "simple-icons:<slug>", e.g. "simple-icons:github"; "color" tints it)${LOCAL_FILES ? "" : ', or "fileId" of an image you uploaded (read_me: "Images from your machine")'} }. width or height alone keeps the aspect ratio. At most 20 images fetched per call (src / icon; uploaded fileIds don't count).
  Labels: label { text, strokeColor, fontSize, fontFamily, textAlign, verticalAlign } — the text is dark (#1e1e1e) unless you set strokeColor; the label's id is "<shape id>-label"; a shape grows so that no word of its label is broken.`;

  /** what an edit reports besides added / updated / deleted */
  const EDIT_EXTRAS = ["alreadyApplied", "slideNumbers", "alsoDeleted", "replaced", "restyled", "layerProblems", "imagesRepaired", "imagesWithoutFile", "sceneFile"];
  const editExtras = (edited) =>
    Object.fromEntries(EDIT_EXTRAS.filter((key) => edited?.[key] !== undefined).map((key) => [key, edited[key]]));

  /** options of edit_scene / edit_open_scene beyond add / update / delete */
  const EDIT_HELP = `  - Layer order: in update (or on added elements) "zIndex": "front" | "back" (above / below everything else on its slide) or "above" / "below": "<element id>".
  - upsert: true lets add reuse ids of existing elements (they are replaced). Ids of deleted elements can always be used again.
  - Deleting a slide (frame) deletes everything on it, template copies included (like in the editor).
  - "slide": n counts slides in deck order AS IT IS NOW, after this edit's deletions: numbers shift when slides are deleted or moved. Prefer frame ids ("slide": "q12"); the result's slideNumbers says which frame each number hit.
  - Changing fontFamily / fontSize of a text measures it again (a box with "autoResize": false keeps its width and re-wraps). A free text with "width" wraps at that width; textAlign aligns inside x … x + width.
  - Deck theme: updating the template frame's customData.slides.theme re-applies it to slide elements that still had the old theme's values; restyle: true applies it to every slide element, also over fonts / colors set by hand (font sizes stay).`;

  const registerSceneTools = (server) => {
    server.registerTool(
      "list_scenes",
      {
        description:
          "List the scenes in the git-backed scene repo (pulls first), the user's local-only scenes (only in their browser, never synced; listed while the app is open), plus which scene is currently open in the user's Excalidraw app and whether it has uncommitted changes.",
        annotations: { readOnlyHint: true },
      },
      tool(async () => {
        const { scenes } = await callJson("/api/scenes?refresh");
        const app = await callJson("/api/app/state");
        const status = app.connected ? await appCommand({ type: "status" }).catch(() => null) : null;
        const localOnly = (status?.scenes || [])
          .filter((line) => / local-only /.test(line))
          .map((line) => line.slice(0, line.indexOf(": local-only")));
        return text({
          scenes,
          ...(localOnly.length ? { localOnlyScenes: localOnly, localOnlyNote: LOCAL_NOTE } : {}),
          app,
        });
      }),
    );

    const REGION = z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .describe("Scene-coordinate rectangle");

    server.registerTool(
      "get_scene",
      {
        description: `Read a scene as stored on GitHub (the user's browser may have newer, not yet pushed changes — list_scenes / app_status show the sync status; for the scene open in the app use read_open_scene). Scenes can be huge, so:
  - summary=true (default for scenes with more than ${SUMMARY_THRESHOLD} elements): overview only — scene bounds, element counts, frames and all text labels with their positions. Use it to find the part you need.
  - region or elementIds: only the elements in that area / those elements (+ their labels).
  - otherwise all elements (compact).
  Always returns a checkpointId of the FULL scene. To modify the scene, call create_view with [{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...new elements / {"type":"delete","ids":"..."}] and then save_scene with the checkpointId create_view returns. To LOOK at a scene, use view_scene.`,
        inputSchema: {
          name: SCENE_NAME,
          summary: z.boolean().optional().describe("Return an overview instead of elements"),
          textsOffset: TEXTS_OFFSET,
          region: REGION.optional(),
          elementIds: z.array(z.string()).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ name, summary, region, elementIds, textsOffset }) => {
        const { file, local } = await loadAnyScene(name, { lean: true });
        if (!file) {
          throw notFound(name);
        }
        const elements = (file.elements || []).filter((el) => !el.isDeleted);
        const checkpointId = newCheckpointId();
        await store.save(checkpointId, { elements });
        const base = { name, checkpointId, elementCount: elements.length, ...(local ? { localOnly: LOCAL_NOTE } : {}) };

        if (elementIds?.length || region) {
          return text({ ...base, ...selection(elements, { region, elementIds }) });
        }
        if (summary ?? elements.length > SUMMARY_THRESHOLD) {
          return text({
            ...base,
            note: "Overview only. Use region/elementIds for element data, view_scene to see it.",
            ...summarize(elements, { textsOffset }),
          });
        }
        return text({ ...base, sceneBounds: toRect(commonBounds(elements)), elements: compact(elements) });
      }),
    );

    // ---------------------------------------------------------------------------
    // co-working on the scene open in the user's app
    // ---------------------------------------------------------------------------

    /** element data for a (possibly huge) scene, honoring summary/region/elementIds/slide */
    const sceneView = (elements, { summary, region, elementIds, textsOffset, slide, relative }, defaultSummary) => {
      const relativeNote = relative ? { coordinates: 'x / y of elements on a slide count from its top-left corner ("slide": its frame id): pass them back the same way' } : {};
      if (slide !== undefined) {
        const frame = findSlide(elements, slide);
        if (!frame) {
          throw new Error(`slide ${JSON.stringify(slide)}: no such slide (the deck has ${deckOrder(elements).length}; use a number from 1, a frame id or "template")`);
        }
        const on = elements.filter((el) => el.frameId === frame.id && !el.customData?.slides?.copyOf);
        const copies = elements.filter((el) => el.frameId === frame.id && el.customData?.slides?.copyOf).length;
        const number = deckOrder(elements).findIndex((f) => f.id === frame.id) + 1;
        const picked = relative ? relativeToSlides(on, elements) : on;
        return {
          slide: { ...(number ? { number } : { template: true }), id: frame.id, name: frame.name ?? null, ...toRect(commonBounds([frame])) },
          ...(frame.customData?.slides ? { slideData: frame.customData.slides } : {}),
          selected: on.length,
          elements: compact(picked.slice(0, MAX_SELECTED)),
          ...(on.length > MAX_SELECTED ? { more: `${on.length - MAX_SELECTED} more elements on this slide: use elementIds or region` } : {}),
          ...(copies ? { templateCopies: `${copies} template copies on this slide (not listed)` } : {}),
          ...relativeNote,
        };
      }
      if (elementIds?.length || region) {
        return { ...selection(elements, { region, elementIds, relative }), ...relativeNote };
      }
      if (summary ?? defaultSummary) {
        return summarize(elements, { textsOffset });
      }
      return { sceneBounds: toRect(commonBounds(elements)), elements: compact(relative ? relativeToSlides(elements, elements) : elements), ...relativeNote };
    };

    /** how big a scene's file is, from its files (lean reads keep each picture's size) */
    const fileStats = (file) => {
      const files = Object.values(file?.files || {});
      if (!files.length) {
        return {};
      }
      const used = new Set((file.elements || []).filter((el) => !el.isDeleted && el.fileId).map((el) => el.fileId));
      const bytes = files.reduce((sum, f) => sum + (f?.size ?? f?.dataURL?.length ?? 0), 0);
      const unused = files.filter((f) => f?.id && !used.has(f.id)).length;
      return {
        sceneFile: `${files.length} pictures, ${(bytes / 1024 / 1024).toFixed(1)} MB of image data${unused ? ` (${unused} no longer used: dropped with the next edit)` : ""}`,
      };
    };

    const SLIDE_FILTER = z
      .union([z.number(), z.string()])
      .optional()
      .describe('Only the elements of this slide: number (deck order), frame id or "template" (template copies left out)');
    const RELATIVE = z
      .boolean()
      .optional()
      .describe('x / y of elements on a slide relative to its top-left corner (with "slide": frame id), as edits take them');

    /** render via the app (or the hidden renderer) → MCP image content */
    const renderImage = async (command, { userTab = false } = {}) => {
      const { png, ...meta } = await (userTab ? appCommand : agentCommand)({ type: "render", ...command });
      return { image: { type: "image", data: png, mimeType: "image/png" }, meta };
    };

    /** best-effort picture of some elements of the open scene */
    const imageOfOpen = async (elementIds, targetScene) => {
      if (!elementIds.length) {
        return [];
      }
      try {
        const { image, meta } = await renderImage({
          elementIds,
          maxSize: 1200,
          ...(targetScene !== undefined ? { targetScene } : {}),
        });
        return [image, { type: "text", text: `Image above: the affected area (${meta.elementsRendered} elements, bounds ${JSON.stringify(meta.renderedBounds)}).` }];
      } catch (error) {
        return [{ type: "text", text: `(could not render image: ${error.message})` }];
      }
    };


    const sceneLabel = (scene) => scene ?? "Untitled (not saved yet)";

    /** how the open scene syncs — so agents leave pushing to the app */
    const syncNote = ({ scene, syncStatus, autoSync }) => {
      if (scene === null) {
        return "Untitled scene, not on GitHub. Only save it (save_open_scene with a name) if the user asks.";
      }
      if (syncStatus === "conflict") {
        return `CONFLICT: the user's version and GitHub's both changed the same elements. Nothing syncs until it is resolved — get_conflict("${scene}") shows the clashes, resolve_conflict settles them.`;
      }
      return autoSync
        ? `status: ${syncStatus}. Auto-sync is on: the app pushes changes (yours and the user's) to GitHub by itself about 10 s after the last edit. Don't push yourself.`
        : `status: ${syncStatus}. Auto-sync is OFF for this scene: the user decides when it goes to GitHub. Don't push unless the user asks.`;
    };

    /** diff → compact report of what changed */
    const describeChanges = (before, after, sinceText) => {
      const { added, modified, deleted } = diffElements(before, after);
      const changedIds = [...added, ...modified.map((m) => m.element)].map((el) => el.id);
      const count = added.length + modified.length + deleted.length;
      const isFrame = (el) => el?.type === "frame" || el?.type === "magicframe";
      return {
        count,
        changedIds,
        // slides added, deleted or moved: slide numbers may mean other slides now
        framesChanged:
          added.some(isFrame) ||
          deleted.some(isFrame) ||
          modified.some(({ element, changedFields }) => isFrame(element) && changedFields.some((f) => ["x", "y", "customData"].includes(f))),
        report: {
          summary: count
            ? `${added.length} added, ${modified.length} modified, ${deleted.length} deleted ${sinceText}`
            : `No changes ${sinceText}`,
          ...(added.length ? { added: compact(added.slice(0, MAX_CHANGE_DETAILS)) } : {}),
          ...(modified.length
            ? {
                modified: modified.slice(0, MAX_CHANGE_DETAILS).map(({ element, changedFields }) => ({
                  changedFields,
                  ...compact([element])[0],
                })),
              }
            : {}),
          ...(deleted.length ? { deleted: deleted.slice(0, MAX_CHANGE_DETAILS) } : {}),
          ...(added.length > MAX_CHANGE_DETAILS || modified.length > MAX_CHANGE_DETAILS || deleted.length > MAX_CHANGE_DETAILS
            ? {
                moreChanges: {
                  note: `Details for the first ${MAX_CHANGE_DETAILS} per kind; the rest by id (read them with elementIds).`,
                  addedIds: added.slice(MAX_CHANGE_DETAILS).map((el) => el.id),
                  modifiedIds: modified.slice(MAX_CHANGE_DETAILS).map(({ element }) => element.id),
                  deletedIds: deleted.slice(MAX_CHANGE_DETAILS).map((el) => el.id),
                },
              }
            : {}),
        },
      };
    };

    /**
     * User changes on the open scene since an agent last read/edited it. The
     * baseline is kept per scene by the app in the browser (IndexedDB) and comes
     * back with the read command (withBaseline).
     */
    const userChangesSinceAgent = (baseline, elements) => {
      if (!baseline) {
        return { count: 0, changedIds: [], report: null, firstLook: true };
      }
      const when = `since an agent last ${baseline.action === "edit" ? "edited" : baseline.action === "save" ? "saved" : "read"} this scene (${baseline.at})`;
      return {
        ...describeChanges(baseline.elements, elements, `by the user (or pulled from GitHub) ${when}`),
        firstLook: false,
      };
    };

    if (MODE === "live") {
      server.registerTool(
        "read_open_scene",
        {
          description: `Read the scene the user has open in the Excalidraw app RIGHT NOW, including their unsaved manual edits — and find out what the USER changed since an agent last looked.
    Automatic change tracking: the app remembers (per scene, in the browser) what the canvas looked like after the last read_open_scene / edit_open_scene by any agent. Every call reports "userChanges" relative to that (added / modified with changedFields / deleted) and then moves the baseline to now. You don't need to remember anything — just call this before you edit, and it tells you what the user did in the meantime. With view=true you also get an IMAGE of the user's changes (or of the scene if nothing changed / first look).
    Scene data: summary=true (default above ${SUMMARY_THRESHOLD} elements) gives an overview (bounds, counts, frames, all text labels with positions); region / elementIds give element data for a part; otherwise all elements. changesOnly=true skips the scene data.
    since=<revision> (optional, advanced) diffs against a specific revision instead of the stored baseline.`,
          inputSchema: {
            scene: z
              .string()
              .optional()
              .describe("Read this scene, if it is open in one of the user's tabs (default: the tab the user used last). Pass it when you keep co-working on a scene."),
            view: z.boolean().optional().describe("Also return an IMAGE: of the user's changes, or of the scene"),
            changesOnly: z.boolean().optional().describe("Only report the user's changes, no scene data"),
            summary: z.boolean().optional(),
            textsOffset: TEXTS_OFFSET,
            region: REGION.optional(),
            elementIds: z.array(z.string()).optional(),
            since: z.string().optional().describe("Advanced: diff against this revision instead of the stored baseline"),
          },
          annotations: { readOnlyHint: true },
        },
        tool(async ({ scene, since, view, changesOnly, summary, region, elementIds, textsOffset }) => {
          const revision = newCheckpointId();
          const open = await appCommand({
            type: "read",
            ...(scene ? { targetScene: scene } : {}),
            withBaseline: !since,
            storeBaseline: "read",
            revision,
          });
          if (scene && open.scene !== scene) {
            // (the app stored nothing for the other scene)
            throw new Error(
              `"${scene}" is not open in any tab — the user's app shows ${sceneLabel(open.scene)}. Ask the user, or open_scene("${scene}").`,
            );
          }
          const elements = open.elements;

          let changes;
          if (since) {
            const previous = await store.load(since);
            if (!previous) {
              throw new Error(`Revision "${since}" not found (expired?) — call without since`);
            }
            changes = { ...describeChanges(previous.elements, elements, `since revision ${since}`), firstLook: false };
          } else {
            changes = userChangesSinceAgent(open.agentBaseline, elements);
          }

          const result = text({
            scene: sceneLabel(open.scene),
            unsavedChanges: open.dirty,
            sync: syncNote(open),
            elementCount: elements.length,
            userChanges: changes.firstLook
              ? "First time an agent reads this scene — no earlier baseline to compare with. From now on, changes by the user will be reported."
              : changes.report,
            revision,
            ...(changesOnly ? {} : sceneView(elements, { summary, region, elementIds, textsOffset }, elements.length > SUMMARY_THRESHOLD)),
          });
          if (view) {
            if (changes.changedIds.length) {
              result.content.push(...(await imageOfOpen(changes.changedIds, open.scene)));
            } else if (elements.length) {
              try {
                const { image, meta } = await renderImage({
                  targetScene: open.scene,
                  ...(region ? { region } : {}),
                  ...(elementIds?.length ? { elementIds } : {}),
                });
                result.content.push(image, {
                  type: "text",
                  text: `Image above: the scene (${meta.elementsRendered}/${meta.elementsTotal} elements, scale ${meta.scale}).`,
                });
              } catch (error) {
                result.content.push({ type: "text", text: `(could not render image: ${error.message})` });
              }
            }
          }
          return result;
        }),
      );

      server.registerTool(
        "edit_open_scene",
        {
          description: `Edit the scene open in the user's app, live and in place — merged with the user's own work (never overwrites their other changes) and undoable by the user as one step (Cmd/Ctrl+Z). This is THE way to co-work on a drawing with the user, and to change any existing scene. It does not push to GitHub and you don't need to: the app's auto-sync pushes about 10 s after the last edit (save_open_scene only when the user asks to push now).
    Safety net: before applying, it checks whether the USER changed the scene since an agent last read/edited it. If so, your edit is still applied, but the result starts with a WARNING listing the user's changes (plus an image of them) — look at them and adjust if your edit conflicts with what the user did. Calling read_open_scene first avoids surprises.
    - add: JSON array string of new elements in create_view format (labels, startBinding/endBinding — arrows may bind to existing elements). Use new unique ids.
    - update: [{ "id": "...", ...props }] partial updates of existing elements, e.g. move (x, y), resize, recolor, change "text" of a text element. Like in the editor, a moved / resized shape takes its label and bound arrows along, and a moved frame (slide) takes everything on it. A shape's label: { "id": "box", "label": { "text": "…", "fontSize": 28 } } (changes it or adds one; it is re-wrapped and the shape grows to fit).
    - delete: ids to remove (a container's label goes with it).
    - To label an EXISTING shape, add a text element with "containerId": "<shape id>" (it gets centered in the shape).
  ${EDIT_HELP}
    ${BIG_EDITS}
  ${IMAGES_HELP}
  Returns an IMAGE of the edited area (view=false to skip). Nothing is applied if the user switched to another scene since your last read (or pass expectScene explicitly).`,
          inputSchema: {
            add: z.string().optional().describe("JSON array string of new elements (create_view format)"),
            update: z
              .array(z.object({ id: z.string() }).passthrough())
              .optional()
              .describe("Partial updates: [{ id, ...props }]"),
            delete: z.array(z.string()).optional(),
            expectScene: z
              .string()
              .optional()
              .describe("The scene you are co-working on (as returned by read_open_scene) — routes the edit to the tab showing it; nothing is applied if no tab shows it"),
            ...EDIT_SOURCE,
            upsert: z.boolean().optional().describe("add with the id of an existing element replaces that element"),
            restyle: z.boolean().optional().describe("Deck: apply the deck theme to every slide element, also over fonts / colors set by hand"),
            view: z.boolean().optional().describe("Return an IMAGE of the edited area (default true)"),
          },
        },
        tool(async ({ add, update, delete: remove, file, payloadId, expectScene, upsert, restyle, view = true }) => {
          const edit = await editInput({ add, update, delete: remove, file, payloadId });

          // what did the user do since an agent last looked?
          const before = await appCommand({
            type: "read",
            ...(expectScene !== undefined ? { targetScene: expectScene } : {}),
            withBaseline: true,
          });
          const changes = userChangesSinceAgent(before.agentBaseline, before.elements);
          const revision = newCheckpointId();

          const edited = await appCommand({
            type: "edit",
            targetScene: before.scene,
            expectScene: expectScene !== undefined ? expectScene : before.scene,
            ...(edit.add.length ? { add: edit.add } : {}),
            ...(edit.update.length ? { update: edit.update } : {}),
            ...(edit.delete.length ? { delete: edit.delete } : {}),
            ...(Object.keys(edit.files).length ? { files: edit.files } : {}),
            ...(upsert ? { upsert } : {}),
            ...(restyle ? { restyle } : {}),
            storeBaseline: "edit",
            revision,
          });
          const { elements, agentBaseline: _previous, ...info } = edited;

          const warning = changes.firstLook
            ? "You edited without reading this scene first (no earlier agent baseline). Call read_open_scene before editing next time."
            : changes.count
            ? `WARNING: the user changed this scene since an agent last looked (${changes.report.summary}). Your edit was applied and merged — check the user's changes below and fix your edit if it conflicts with them.`
            : null;

          const result = text({
            ...(warning ? { warning } : {}),
            ...(changes.count ? { userChanges: changes.report } : {}),
            scene: sceneLabel(info.scene),
            addedIds: info.addedIds,
            updated: info.updated,
            deleted: info.deleted,
            ...editExtras(info),
            ...(info.missingIds ? { missingIds: info.missingIds } : {}),
            revision,
            note:
              info.scene === null
                ? "Live in the user's app. The scene is untitled — it reaches GitHub once it gets a name (save_open_scene with name)."
                : info.autoSync
                ? "Live in the user's app, not pushed yet — the app's auto-sync pushes it after 10s without edits (save_open_scene pushes now)."
                : "Live in the user's app. Auto-sync is OFF for this scene — it is only pushed when the user saves or you call save_open_scene.",
          });
          if (view) {
            result.content.push(...(await imageOfOpen([...info.addedIds, ...info.updated], info.scene)));
            if (changes.count) {
              const userIds = changes.changedIds.filter((id) => elements.some((el) => el.id === id));
              if (userIds.length) {
                result.content.push({ type: "text", text: "Next image: what the USER changed since an agent last looked." });
                result.content.push(...(await imageOfOpen(userIds, info.scene)));
              }
            }
          }
          return result;
        }),
      );
    }

    // ---------------------------------------------------------------------------
    // detached mode: the agent works in its own headless Excalidraw on the
    // GitHub version; the user's app picks its commits up within seconds
    // ---------------------------------------------------------------------------

    /** a specific version (blob sha) of a scene */
    const loadVersion = async (name, sha) =>
      JSON.parse(await call(`${sceneUrl(name)}?sha=${encodeURIComponent(sha)}${LEAN ? "&lean=1" : ""}`));

    /** user's sync state for this scene, after the flush — so the agent knows what it sees */
    const userSyncNote = (flushed) => {
      const results = (flushed?.results || []).filter((r) => r && !r.error);
      if (!flushed || !flushed.tabs) {
        return "The user's app is not open: you see the GitHub version.";
      }
      if (results.some((r) => r.status === "conflict")) {
        return "The user's app has a merge CONFLICT on this scene: their newest edits are not on GitHub until it is resolved (get_conflict / resolve_conflict, or the user in the sidebar).";
      }
      if (results.some((r) => r.autoSync === false && ["ahead", "local", "diverged"].includes(r.status))) {
        return "Auto-sync is OFF for this scene in the user's app and they have unpushed changes, which you don't see. The user decides when to push.";
      }
      return "Up to date: the user's app pushed its changes of this scene before this read.";
    };

    /** what the user (or anyone else) changed since `since` or the agent's last commit */
    const changesSince = async (name, current, since) => {
      let base = null;
      let label;
      if (since) {
        base = await loadVersion(name, since).catch(() => null);
        if (!base) {
          throw new Error(`Revision "${since}" of "${name}" not found — call without since/basedOn`);
        }
        label = `since revision ${since.slice(0, 7)}`;
      } else {
        const { version } = await callJson(`${sceneUrl(name)}/agent-version`);
        if (version) {
          base = await loadVersion(name, version.sha).catch(() => null);
          label = `since an agent last edited this scene (${version.at})`;
        }
      }
      if (!base) {
        return { count: 0, changedIds: [], report: null, firstLook: true };
      }
      return {
        ...describeChanges((base.elements || []).filter((el) => !el.isDeleted), current, `by the user (or others) ${label}`),
        firstLook: false,
      };
    };

    /** image of some elements of a scene version */
    const imageOf = async (file, elementIds, caption) => {
      if (!elementIds.length) {
        return [];
      }
      try {
        const { image, meta } = await renderImage({
          scene: { elements: file.elements || [], files: file.files || {}, appState: file.appState || {} },
          elementIds,
          maxSize: 1200,
        });
        return [image, { type: "text", text: `Image above: ${caption} (${meta.elementsRendered} elements, bounds ${JSON.stringify(meta.renderedBounds)}).` }];
      } catch (error) {
        return [{ type: "text", text: `(could not render image: ${error.message})` }];
      }
    };

    /** a local-only scene from the user's browser, shaped like a GitHub version */
    const localVersion = async (name, since) => {
      const { file, revision, base } = await loadLocalScene(name, since, { lean: true });
      return {
        file,
        sha: revision,
        changes: (elements) =>
          base
            ? { ...describeChanges((base.elements || []).filter((el) => !el.isDeleted), elements, `by the user ${base.label}`), firstLook: false }
            : { count: 0, changedIds: [], report: null, firstLook: true },
      };
    };

    function registerDetachedTools() {
      server.registerTool(
        "read_scene",
        {
          description: `Read a scene and find out what the USER changed since an agent last edited it. You work on your own copy (a headless Excalidraw), never in the user's browser: before reading, the user's app is asked to push its unpushed changes of this scene, so you see their latest work.
  userChanges lists what changed (added / modified with changedFields / deleted) since the last agent edit of this scene (found in the git history), or since revision=<since> if you pass one. The result has a "revision": pass it as basedOn to edit_scene, or as since to the next read_scene, to get exactly what changed in between. view=true adds an IMAGE of the user's changes (or of the scene).
  Scene data: summary=true (default above ${SUMMARY_THRESHOLD} elements) gives an overview (bounds, counts, slides in deck order, all text labels with positions); slide = one slide's elements (number, frame id or "template"); region / elementIds give element data for a part; otherwise all elements. relative=true gives x / y of elements on a slide relative to the slide, as edits take them with "slide". changesOnly=true skips the scene data. sceneFile tells how big the file is (pictures).`,
          inputSchema: {
            name: SCENE_NAME,
            view: z.boolean().optional().describe("Also return an IMAGE: of the user's changes, or of the scene"),
            changesOnly: z.boolean().optional().describe("Only report the user's changes, no scene data"),
            summary: z.boolean().optional(),
            textsOffset: TEXTS_OFFSET,
            region: REGION.optional(),
            elementIds: z.array(z.string()).optional(),
            slide: SLIDE_FILTER,
            relative: RELATIVE,
            since: z.string().optional().describe("A revision returned earlier: report changes since then"),
          },
          annotations: { readOnlyHint: true },
        },
        tool(async ({ name, view, changesOnly, summary, region, elementIds, slide, relative, since, textsOffset }) => {
          const flushed = await flushUser(name);
          const local = isLocalOnly(flushed);
          const current = local ? await localVersion(name, since) : await loadSceneWithSha(name, { lean: true });
          if (!current) {
            throw notFound(name);
          }
          const elements = (current.file.elements || []).filter((el) => !el.isDeleted);
          const changes = local ? current.changes(elements) : await changesSince(name, elements, since);
          const result = text({
            scene: name,
            revision: current.sha,
            sync: local ? LOCAL_NOTE : userSyncNote(flushed),
            elementCount: elements.length,
            ...fileStats(current.file),
            userChanges: changes.firstLook
              ? "No earlier agent edit of this scene found — everything is new to you. From your first edit on, the user's changes are reported."
              : changes.report,
            ...(changesOnly ? {} : sceneView(elements, { summary, region, elementIds, textsOffset, slide, relative }, elements.length > SUMMARY_THRESHOLD)),
          });
          if (view) {
            if (changes.changedIds.length) {
              result.content.push(...(await imageOf(current.file, changes.changedIds, "what the user changed")));
            } else if (elements.length) {
              try {
                const { image, meta } = await renderImage({
                  scene: { elements: current.file.elements || [], files: current.file.files || {}, appState: current.file.appState || {} },
                  ...(region ? { region } : {}),
                  ...(elementIds?.length ? { elementIds } : {}),
                });
                result.content.push(image, {
                  type: "text",
                  text: `Image above: the scene (${meta.elementsRendered}/${meta.elementsTotal} elements, scale ${meta.scale}).`,
                });
              } catch (error) {
                result.content.push({ type: "text", text: `(could not render image: ${error.message})` });
              }
            }
          }
          return result;
        }),
      );

      server.registerTool(
        "edit_scene",
        {
          description: `Edit a scene: applied in your own headless Excalidraw to the newest version and committed to GitHub right away (one commit per edit). The user's app picks it up within seconds and merges it with whatever they are doing: their other changes are never overwritten, and their view is not touched. This is the ONLY way to change an existing scene: never push, sync, write .excalidraw files or call the scenes server's HTTP API yourself (direct writes are refused).
  Safety net: the user's app first pushes its unpushed changes of this scene. If the user changed the scene since basedOn (the revision from your last read_scene / edit_scene; default: the last agent edit), your edit is still applied, but the result starts with a WARNING listing their changes (plus an image) — check them and adjust your edit if it clashes.
  - add: JSON array string of new elements in create_view format (labels, startBinding/endBinding — arrows may bind to existing elements). Use new unique ids.
  - update: [{ "id": "...", ...props }] partial updates of existing elements, e.g. move (x, y), resize, recolor, change "text" of a text element (labels are text elements with containerId).
  - delete: ids to remove (a container's label goes with it).
  - To label an EXISTING shape, add a text element with "containerId": "<shape id>" (it gets centered in the shape).
${EDIT_HELP}
  ${BIG_EDITS}
  ${IMAGES_HELP}
  Safe to retry: every edit has a requestId (yours, or one the result names). Sent again with the same requestId, an edit that already landed is not applied twice: you get its result with alreadyApplied. After a timeout, retry with the same requestId.
  Returns an IMAGE of the edited area (view=false to skip) and the new revision.`,
          inputSchema: {
            name: SCENE_NAME,
            add: z.string().optional().describe("JSON array string of new elements (create_view format)"),
            update: z
              .array(z.object({ id: z.string() }).passthrough())
              .optional()
              .describe("Partial updates: [{ id, ...props }]"),
            delete: z.array(z.string()).optional(),
            ...EDIT_SOURCE,
            basedOn: z.string().optional().describe("The revision your edit is based on (from read_scene / edit_scene)"),
            upsert: z.boolean().optional().describe("add with the id of an existing element replaces that element"),
            restyle: z.boolean().optional().describe("Deck: apply the deck theme to every slide element, also over fonts / colors set by hand"),
            requestId: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,80}$/)
              .optional()
              .describe("Your id for this edit (letters, digits, _ . : -): sent again, it is never applied twice. Default: a new one, named in the result"),
            view: z.boolean().optional().describe("Return an IMAGE of the edited area (default true)"),
          },
        },
        tool(async ({ name, add, update, delete: remove, file, payloadId, basedOn, upsert, restyle, requestId: givenRequestId, view = true }) => {
          const requestId = givenRequestId || `edit-${newCheckpointId()}`;
          const edit = await editInput({ add, update, delete: remove, file, payloadId });

          // what did the user do since the agent's version?
          const local = isLocalOnly(await flushUser(name));
          const before = local ? await localVersion(name, basedOn) : await loadSceneWithSha(name, { lean: true });
          if (!before) {
            throw new Error(`Scene "${name}" not found on GitHub. Create new scenes with create_view + save_scene.`);
          }
          const beforeElements = (before.file.elements || []).filter((el) => !el.isDeleted);
          const changes = local ? before.changes(beforeElements) : await changesSince(name, beforeElements, basedOn);

          // local-only scenes are edited in the user's app (their only copy)
          const command = {
            type: local ? "local-edit" : "scene-edit",
            ...(local ? { targetScene: name } : {}),
            name,
            requestId,
            ...(edit.add.length ? { add: edit.add } : {}),
            ...(edit.update.length ? { update: edit.update } : {}),
            ...(edit.delete.length ? { delete: edit.delete } : {}),
            ...(Object.keys(edit.files).length ? { files: edit.files } : {}),
            ...(upsert ? { upsert } : {}),
            ...(restyle ? { restyle } : {}),
          };
          const send = () => (local ? appCommand : agentCommand)(command);
          let edited;
          try {
            edited = await send();
          } catch (error) {
            if (error.status !== 504) {
              throw error;
            }
            // the tab was slow: asking again joins the edit still running there (or
            // returns its result), it is never applied twice
            try {
              edited = await send();
            } catch (again) {
              if (again.status !== 504) {
                throw again;
              }
              throw new Error(
                `${again.message} Your edit may still land: it has requestId "${requestId}". Call edit_scene again with the same arguments plus requestId: "${requestId}": if it was applied you get its result (alreadyApplied), otherwise it is applied then; it is never applied twice. app_status shows whether the tab is busy.`,
              );
            }
          }
          const after = {
            elements: edited.elements,
            files: { ...(before.file.files || {}), ...edit.files },
            appState: before.file.appState || {},
          };

          const usesSlideNumbers = [...edit.add, ...edit.update].some((el) => typeof el?.slide === "number" || /^\d+$/.test(String(el?.slide ?? "")));
          const warning = [
            changes.firstLook
              ? basedOn
                ? null
                : "You edited without reading this scene first. Call read_scene before editing next time."
              : changes.count
              ? `WARNING: the user changed this scene since your version (${changes.report.summary}). Your edit was applied on top of their changes — check them below and fix your edit if it clashes.`
              : null,
            usesSlideNumbers && changes.framesChanged
              ? `WARNING: slides were added, deleted or reordered since your version, and your edit names slides by number: check slideNumbers below (which frame each number hit) and use frame ids.`
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null;

          const result = text({
            ...(warning ? { warning } : {}),
            ...(changes.count ? { userChanges: changes.report } : {}),
            scene: name,
            addedIds: idList(edited.addedIds),
            updated: idList([...new Set(edited.updated)]),
            deleted: idList(edited.deleted),
            ...editExtras(edited),
            ...(edited.missingIds ? { missingIds: edited.missingIds } : {}),
            requestId,
            revision: local ? edited.revision : edited.sha,
            ...(local
              ? { note: `${LOCAL_NOTE} Your edit is in their app now; nothing else to do.` }
              : { commit: edited.commit, note: "Committed to GitHub. The user's app merges it within seconds; nothing else to do." }),
          });
          if (view) {
            result.content.push(...(await imageOf(after, [...edited.addedIds, ...edited.updated], "the edited area")));
            if (changes.count) {
              const userIds = changes.changedIds.filter((id) => edited.elements.some((el) => el.id === id));
              if (userIds.length) {
                result.content.push({ type: "text", text: "Next image: what the USER changed." });
                result.content.push(...(await imageOf(after, userIds, "the user's changes")));
              }
            }
          }
          return result;
        }),
      );
    }

    if (MODE === "detached") {
      registerDetachedTools();
    }

    server.registerTool(
      "view_scene",
      {
        description: `SEE a scene: returns an actual PNG image of it, rendered by Excalidraw itself (no browser automation needed — uses the open app tab or a hidden headless renderer).
  Source (pick one): name = scene in the repo; checkpointId = a create_view/get_scene checkpoint (e.g. to check your drawing before saving); neither = the scene currently open in the user's app, including unsaved edits.
  Slides: slide = slide number (1-based, deck order) or frame id renders exactly that slide as the audience sees it — with the template's header/footer/logo and filled-in {page}/{total}/{deck}; step = what is visible after that many clicks (default: everything). slides = "all" (or "2-5") renders a contact sheet of the whole deck in one image; add steps=true for every click state.
  Focus (optional): elementIds = just those elements (+padding, + whatever overlaps that area) — ideal to check the part you worked on; region = a scene-coordinate rectangle. Without focus the whole scene is rendered; for huge scenes render an overview first (get_scene summary=true tells you where things are), then zoom in with region.
  The result also reports renderedBounds/sceneBounds (scene coordinates) and the scale.`,
        inputSchema: {
          name: SCENE_NAME.optional(),
          checkpointId: z.string().optional(),
          elementIds: z.array(z.string()).optional(),
          region: REGION.optional(),
          padding: z.number().optional().describe("Margin around elementIds in scene px (default 80)"),
          maxSize: z.number().optional().describe("Longest side of the image in px (default 1500, max 4000)"),
          slide: z.union([z.number(), z.string()]).optional().describe("Render just this slide: number (1-based, deck order) or frame id"),
          step: z.number().optional().describe("With slide / slides: show what is visible after this many clicks"),
          slides: z
            .union([z.string(), z.array(z.union([z.number(), z.string()]))])
            .optional()
            .describe('Contact sheet: these slides in ONE image ("all", "2-5", [1, 3]), each as presented, labelled with number and title'),
          steps: z.boolean().optional().describe("With slides: one tile per click step (what the audience sees after 0, 1, 2 … clicks)"),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ name, checkpointId, elementIds, region, padding, maxSize, slide, step, slides, steps }) => {
        let scene;
        let source;
        if (checkpointId) {
          const checkpoint = await store.load(checkpointId);
          if (!checkpoint) {
            throw new Error(`Checkpoint "${checkpointId}" not found`);
          }
          scene = { elements: checkpoint.elements.filter((el) => !PSEUDO_TYPES.has(el.type)) };
          source = `checkpoint ${checkpointId}`;
        } else if (name) {
          const { file, local } = await loadAnyScene(name, { lean: true });
          if (!file) {
            throw notFound(name);
          }
          scene = { elements: file.elements || [], files: file.files || {}, appState: file.appState || {} };
          source = `scene "${name}" (${local ? "local only, from the user's browser" : "repo"})`;
        } else {
          const state = await callJson("/api/app/state");
          if (!state.connected) {
            throw new Error("No scene name given and the app is not open — pass name or checkpointId");
          }
          source = `open scene in the app: ${state.current === null ? "Untitled" : `"${state.current}"`}${state.dirty ? " (unsaved edits)" : ""}`;
        }
        const { image, meta } = await renderImage({
          ...(scene ? { scene, deck: name ?? "Untitled" } : {}),
          ...(slide !== undefined ? { slide } : {}),
          ...(step !== undefined ? { step } : {}),
          ...(slides !== undefined ? { sheet: slides } : {}),
          ...(steps ? { steps } : {}),
          ...(elementIds?.length ? { elementIds } : {}),
          ...(region ? { region } : {}),
          ...(padding !== undefined ? { padding } : {}),
          ...(maxSize !== undefined ? { maxSize } : {}),
        });
        return {
          content: [image, { type: "text", text: JSON.stringify({ source, ...meta }, null, 2) }],
        };
      }),
    );

    server.registerTool(
      "validate_deck",
      {
        description: `CHECK a presentation (a scene with slides) the way a careful reviewer would, measured by Excalidraw itself: lists the slides in deck order (number, frame id, title, click steps, notes) and findings per slide — elements cut off at the slide edge, elements lying on a slide without being part of it (frameId missing: left out of presentations/PDFs), labels that don't fit their shape, free text bigger than its own box (the user's browser cuts it off at the box, although view_scene draws it whole), overlapping text, text over images, text too small or too low in contrast, click steps that never hide or have gaps, placeholders outside the template, missing speaker notes, wrong slide size.
  Text on a picture is checked against the picture's colors under it. Intended findings (a decorative circle bleeding off the slide, sticky notes on a mock UI) can be silenced per element: "customData": { "slides": { "ignore": ["clipped", "overlap"] } } (finding kinds, or true for all); on a slide frame for its slide-wide findings (e.g. ["notes"]).
  Run it after building or changing a deck; fix the findings with edit_scene, then look at the slides you changed with view_scene(slide: n).`,
        inputSchema: { name: SCENE_NAME },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ name }) => {
        const { file } = await loadAnyScene(name, { lean: true });
        if (!file) {
          throw notFound(name);
        }
        const result = await agentCommand({
          type: "deck-check",
          elements: file.elements || [],
          // pictures (for text on them); lean online: the tab fills in the bytes
          files: file.files || {},
          deck: name,
          background: file.appState?.viewBackgroundColor || "#ffffff",
        });
        return text(result);
      }),
    );

    server.registerTool(
      "measure_text",
      {
        description: `Measure text BEFORE placing it, exactly as Excalidraw will (real fonts): width and height in px for each item, and with maxWidth the wrapped lines. Use it to size boxes, table cells and chart labels, or to right-align / center text without guessing.
  fontFamily: 5 Excalifont (hand-drawn, default), 6 Nunito, 7 Lilita One, 8 Comic Shanns, 1 Virgil, 2 Helvetica, 3 Cascadia, or the name of any Google font (e.g. "Inter", added on first use) or of a font in app_status → customFonts.`,
        inputSchema: {
          items: z
            .array(
              z.object({
                text: z.string().optional(),
                markdown: z.string().optional().describe("formatted text instead of text (see read_me: Formatted text)"),
                fontSize: z.number().optional().describe("default 20"),
                fontFamily: z.union([z.number(), z.string()]).optional(),
                lineHeight: z.number().optional().describe("default: the font's"),
                maxWidth: z.number().optional().describe("wrap at this width"),
              }),
            )
            .describe("Texts to measure (up to 200)"),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ items }) => {
        if (items.length > 200) {
          throw new Error("At most 200 items per call");
        }
        if (items.some((item) => typeof item.text !== "string" && typeof item.markdown !== "string")) {
          throw new Error("Each item needs text or markdown");
        }
        return text(await agentCommand({ type: "measure", items }));
      }),
    );

    // PDFs are written to the agent's machine: not with Kurviq online (the user exports there)
    if (LOCAL_FILES) {
    server.registerTool(
      "export_pdf",
      {
        description: `Export slides of a presentation scene as a PDF file: one 16:9 page per slide (with the template's header/footer and filled-in page numbers), real selectable text with embedded fonts, pictures embedded once. Only when the user asks for a PDF.
  slides: "all" (default; skipped slides left out unless includeSkipped), or which ones: [1, 3] / "2-4, 7" (1-based, deck order) or frame ids.`,
        inputSchema: {
          name: SCENE_NAME,
          slides: z.union([z.string(), z.array(z.union([z.number(), z.string()]))]).optional().describe('"all" (default), "1, 3-5" or [1, 3]'),
          includeSkipped: z.boolean().optional(),
          file: z.string().optional().describe("Absolute path of the PDF to write (default: <scene name>.pdf in the current directory)"),
        },
      },
      tool(async ({ name, slides, includeSkipped, file }) => {
        const { file: scene } = await loadAnyScene(name);
        if (!scene) {
          throw notFound(name);
        }
        const { html, slides: exported } = await agentCommand({
          type: "slides-html",
          elements: scene.elements || [],
          files: scene.files || {},
          deck: name,
          background: scene.appState?.viewBackgroundColor || "#ffffff",
          ...(slides !== undefined ? { slides } : {}),
          ...(includeSkipped ? { includeSkipped } : {}),
        });
        const res = await serverFetch("/api/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) {
          throw new Error(`PDF export failed: ${(await res.text()).slice(0, 300)}`);
        }
        const pdf = new Uint8Array(await res.arrayBuffer());
        const saved = await savePdf(name, pdf, file);
        return text({ ...saved, pages: exported.length, slides: exported, sizeKB: Math.round(pdf.length / 1024) });
      }),
    );
    }

    server.registerTool(
      "save_scene",
      {
        description: `Save a NEW drawing as a scene: writes scenes/<name>.excalidraw, commits and pushes it to GitHub.
  Provide EITHER checkpointId (from create_view: draw with create_view, then save its checkpoint) OR elements (same JSON format as create_view, incl. restoreCheckpoint/delete). open=true switches the user's app to it${MODE === "detached" ? " (only when the user asked to see it)" : ""}.
  NOT for changing an existing scene: the user's app holds the newest version (possibly with unpushed edits) and syncs it to GitHub by itself (auto-sync), so writing to GitHub directly races with it and causes conflicts. To change an existing scene: ${MODE === "detached" ? "read_scene + edit_scene" : "open_scene(name) if it isn't open, then read_open_scene + edit_open_scene; the app pushes"}. save_scene refuses existing scenes unless replace=true: for when the user explicitly wants the whole scene replaced by a new drawing, or when the app isn't open in any browser (the app merges it on its next sync).
  ${IMAGES_HELP}
  ${MODE === "live" ? 'Note: while you draw, every create_view call is mirrored live into the user\'s app (scene "agent-live"), so the user can watch.' : ""}`,
        inputSchema: {
          name: SCENE_NAME,
          checkpointId: z.string().optional().describe("Checkpoint id returned by create_view / get_scene"),
          elements: z.string().optional().describe("JSON array string of elements (create_view format)"),
          ...(LOCAL_FILES
            ? { elementsFile: z.string().optional().describe("Absolute path of a JSON file with the elements array (instead of elements)") }
            : { payloadId: PAYLOAD_ID }),
          open: z.boolean().optional().describe("Switch the user's Excalidraw app to this scene after saving"),
          replace: z
            .boolean()
            .optional()
            .describe("Overwrite an EXISTING scene with this drawing. Only when the user explicitly asked to replace the whole scene"),
          local: z
            .boolean()
            .optional()
            .describe("Keep it only in the user's browser: a local-only scene, never synced to GitHub (needs the app open). Only when the user asks for a local / private / not-synced scene"),
        },
      },
      tool(async ({ name, checkpointId, elements, elementsFile, payloadId, open, replace, local }) => {
        if (elementsFile) {
          elements = JSON.stringify((await readEditFile(elementsFile)).add || []);
        }
        if (payloadId) {
          const add = (await payloadEdit(payloadId)).add || [];
          elements = typeof add === "string" ? add : JSON.stringify(add);
        }
        if (!checkpointId && !elements) {
          throw new Error(`Provide checkpointId, elements or ${LOCAL_FILES ? "elementsFile" : "payloadId"}`);
        }
        if (!local && githubOptional && (await callJson("/api/app/state")).github === false) {
          local = true; // no GitHub in the user's app: the browser is the scene's home
        }
        const flushed = await flushUser(name);
        const emptyLocal = (flushed?.results || []).some((r) => r && r.localOnly && r.empty);
        if (isLocalOnly(flushed) && !local && !emptyLocal) {
          throw new Error(
            `"${name}" exists as a local-only scene in the user's browser. Change it with read_scene + edit_scene; replace it with save_scene(local: true, replace: true) only if the user wants the whole scene replaced.`,
          );
        }
        const current = local ? null : await loadSceneWithSha(name);
        if (current && !replace) {
          throw new Error(
            `Scene "${name}" already exists. Don't overwrite it: ${MODE === "detached" ? `change it with read_scene("${name}") + edit_scene("${name}", …), which merges with the user's work.` : `the user's app syncs it by itself. To change it, open_scene("${name}") (if it isn't open), read_open_scene, then edit_open_scene; the app pushes the result.`} Only if the user explicitly wants the whole scene replaced by your drawing, or the app is not open at all (app_status: connected false; it then merges your version on its next sync), call save_scene again with replace: true.`,
          );
        }
        let input = [];
        if (checkpointId) {
          input.push({ type: "restoreCheckpoint", id: checkpointId });
        }
        if (elements) {
          const parsed = JSON.parse(elements);
          if (!Array.isArray(parsed)) {
            throw new Error("elements must be a JSON array");
          }
          input = parsed.some((el) => el.type === "restoreCheckpoint") ? parsed : [...input, ...parsed];
        }
        const withImages = await resolveImages(await resolveElements(input));
        const { elements: sceneElements, convertedBy } = await toSceneElements(withImages.elements, name);

        const existing = current?.file ?? null;
        const fileIds = new Set(sceneElements.map((el) => el.fileId).filter(Boolean));
        const files = Object.fromEntries(
          Object.entries({ ...(existing?.files || {}), ...withImages.files }).filter(([id]) => fileIds.has(id)),
        );
        const scene = {
          type: "excalidraw",
          version: 2,
          source: "excalidraw-scenes-mcp",
          elements: sceneElements,
          // the name ties the content to this scene (the server rejects mismatches)
          appState: { ...(existing?.appState || { viewBackgroundColor: "#ffffff", gridSize: 20 }), name },
          files,
        };
        if (local) {
          // the user's app keeps it (their browser is its only home)
          const saved = await appCommand({ type: "local-save", name, json: JSON.stringify(scene), replace: !!replace, open: !!open });
          const savedCheckpointId = newCheckpointId();
          await store.save(savedCheckpointId, { elements: sceneElements });
          return text({
            ...saved,
            elementCount: sceneElements.length,
            convertedBy,
            checkpointId: savedCheckpointId,
            note: LOCAL_NOTE,
          });
        }
        const result = await callJson(sceneUrl(name), {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp",
            // only replace the version we just looked at
            "X-Base-Sha": current?.sha || "none",
          },
          body: JSON.stringify(scene, null, 2),
        });
        let app = null;
        if (open) {
          app = await appCommand({ type: "open", name });
          if (MODE === "live") {
            // the agent knows this content — later user edits are reported relative to it
            await appCommand({ type: "read", targetScene: name, storeBaseline: "save" }).catch(() => null);
          }
        }
        // checkpoint of the saved state, for further edits
        const savedCheckpointId = newCheckpointId();
        await store.save(savedCheckpointId, { elements: sceneElements });
        return text({
          saved: name,
          created: !existing,
          commit: result.commit,
          changed: result.changed,
          elementCount: sceneElements.length,
          convertedBy,
          checkpointId: savedCheckpointId,
          ...(MODE === "detached" ? { revision: result.sha } : {}),
          ...(app ? { app } : {}),
        });
      }),
    );

    // ---------------------------------------------------------------------------
    // rename / delete / clone — through the app when it is open (keeps its
    // local copies, unpushed changes and agent baselines consistent and works
    // offline), else directly on GitHub
    // ---------------------------------------------------------------------------

    const appConnected = async () => (await callJson("/api/app/state")).connected;

    const viaGitHubNote =
      MODE === "detached"
        ? "Done on GitHub. The user's app follows within seconds (their unpushed changes were pushed first)."
        : "The app is not open in a browser, so this was done on GitHub directly — the app picks it up on its next sync.";

    server.registerTool(
      "rename_scene",
      {
        description: `Rename a scene on GitHub (one commit, history kept); the user's app follows (its local copy incl. unpushed changes moves along, the URL follows if it is open). Fails if newName exists.`,
        inputSchema: { name: SCENE_NAME, newName: SCENE_NAME },
      },
      tool(async ({ name, newName }) => {
        if (MODE === "live" && (await appConnected())) {
          return text(await appCommand({ type: "rename", name, to: newName }));
        }
        // the user's unpushed changes go along
        if (isLocalOnly(await flushUser(name))) {
          return text({ ...(await appCommand({ type: "rename", name, to: newName })), note: LOCAL_NOTE });
        }
        const result = await callJson(`${sceneUrl(name)}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp" },
          body: JSON.stringify({ to: newName }),
        });
        return text({ renamed: name, to: newName, commit: result.commit, note: viaGitHubNote });
      }),
    );

    server.registerTool(
      "delete_scene",
      {
        description: `Delete a scene on GitHub (one commit; it stays in the git history); the user's app follows. Only delete when the user asked for it, and name the scene exactly.`,
        inputSchema: { name: SCENE_NAME },
        annotations: { destructiveHint: true },
      },
      tool(async ({ name }) => {
        if (MODE === "live" && (await appConnected())) {
          return text(await appCommand({ type: "delete", name }));
        }
        if (isLocalOnly(await flushUser(name))) {
          return text({ ...(await appCommand({ type: "delete", name })), note: "Deleted in the user's browser (it was local only, so there is no other copy)." });
        }
        const result = await callJson(sceneUrl(name), {
          method: "DELETE",
          headers: { "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp" },
        });
        return text({ deleted: name, commit: result.commit, note: viaGitHubNote });
      }),
    );

    server.registerTool(
      "clone_scene",
      {
        description: `Duplicate a scene under a new name (incl. the user's latest changes). open=true switches the user's app to the copy — only when the user asked to continue in the copy.`,
        inputSchema: {
          name: SCENE_NAME,
          newName: SCENE_NAME,
          open: z.boolean().optional().describe("Switch the user's app to the copy (default false)"),
        },
      },
      tool(async ({ name, newName, open }) => {
        if (MODE === "live" && (await appConnected())) {
          return text(await appCommand({ type: "clone", name, to: newName, open: !!open }));
        }
        if (isLocalOnly(await flushUser(name))) {
          return text({ ...(await appCommand({ type: "clone", name, to: newName, open: !!open })), note: "The copy is local only too." });
        }
        const file = await loadSceneFile(name);
        if (!file) {
          throw notFound(name);
        }
        const result = await callJson(sceneUrl(newName), {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp", "X-Base-Sha": "none" },
          body: JSON.stringify({ ...file, appState: { ...(file.appState || {}), name: newName } }, null, 2),
        });
        const app = open ? await appCommand({ type: "open", name: newName }).catch((error) => ({ error: error.message })) : null;
        return text({ cloned: name, to: newName, commit: result.commit, note: viaGitHubNote, ...(app ? { app } : {}) });
      }),
    );

    server.registerTool(
      "open_scene",
      {
        description:
          MODE === "detached"
            ? "Switch the USER's Excalidraw app (their browser) to a scene. You don't need this for your own work (read_scene / edit_scene work on any scene): only use it when the user asks you to show them a scene. create=true creates a new empty scene there."
            : "Switch the user's Excalidraw app (open in the browser) to a scene. Unsaved changes of the previous scene are kept locally in the browser. Set create=true to create a new empty scene with that name instead.",
        inputSchema: {
          name: SCENE_NAME,
          create: z.boolean().optional().describe("Create a new empty, uncommitted scene"),
        },
      },
      tool(async ({ name, create }) =>
        text(await appCommand({ type: create ? "create" : "open", name })),
      ),
    );

    server.registerTool(
      "add_font",
      {
        description:
          'Add a font from Google Fonts (fonts.google.com) by its exact name, e.g. "Inter", "Geist", "JetBrains Mono", to the user\'s app, so texts can use it with "fontFamily": "Inter" (also in labels and the deck theme). The font then travels with every scene that uses it. Using a Google font name in fontFamily adds it automatically too; this tool is for adding it ahead (e.g. to measure text). Needs the app open.',
        inputSchema: { name: z.string().describe('Font family name as on fonts.google.com, e.g. "Inter"') },
      },
      tool(async ({ name }) => text(await appCommand({ type: "add-font", name }))),
    );

    server.registerTool(
      "app_status",
      {
        description:
          "Which scene is open in the user's Excalidraw app, whether it has unpushed changes, and every scene the app knows about with its sync status: synced, ahead (not pushed yet), behind (newer on GitHub), diverged, conflict (needs get_conflict / resolve_conflict), local (not on GitHub). The app syncs by itself (auto-sync); scenes marked \"auto-sync off\" are pushed only when the user decides. health checks that edits and pictures are answered right now (what the tab is busy with, if not): use it when calls time out.",
        annotations: { readOnlyHint: true },
      },
      tool(async () => {
        const state = await callJson("/api/app/state");
        if (!state.connected) {
          return text({ connected: false, message: "The Excalidraw app is not open in a browser." });
        }
        const status = await appCommand({ type: "status" });
        // the health check: a ping through the same queues as edits and pictures
        const started = Date.now();
        const answered = await Promise.race([
          agentCommand({ type: "ping" }).then(
            () => true,
            (error) => (/Unknown command/.test(error.message) ? true : error.message),
          ),
          new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
        ]);
        const ms = Date.now() - started;
        const health =
          answered === true
            ? `ok: edits and pictures are answered (${ms} ms)`
            : answered === false
            ? `BUSY: edits and pictures wait (no answer within 8 s)${status.busy?.length ? `; working on: ${status.busy.join(", ")}` : ""}. Edits sent now run when it is done (a stuck task is given up after 90 s); if it stays busy, ask the user to bring the tab to the front or reload it.`
            : `error: ${answered}`;
        return text({ connected: true, health, ...status });
      }),
    );

    server.registerTool(
      "set_local_only",
      {
        description:
          "Make a scene local-only (kept only in the user's browser, never pushed to or pulled from GitHub; a copy already on GitHub stays there unchanged) or sync it with GitHub again (localOnly=false: the app pushes it, or merges it with the GitHub copy). Only when the user asks. Needs the app open.",
        inputSchema: { name: SCENE_NAME, localOnly: z.boolean() },
      },
      tool(async ({ name, localOnly }) => {
        if (!(await appConnected())) {
          throw new Error(`Local-only scenes live in the user's app (browser), which is not open. Ask the user to open ${APP_HINT}.`);
        }
        return text(await appCommand({ type: "local-only", name, on: localOnly }));
      }),
    );

    if (MODE === "live") {
      server.registerTool(
        "save_open_scene",
        {
          description:
            "Push the scene open in the user's app to GitHub right now, including the user's edits. Usually NOT needed: with auto-sync on (the default) the app pushes by itself about 10 s after the last edit and pulls GitHub changes within about a minute. Use it only when the user asks to save/commit/push now, or to give an untitled scene a name. If auto-sync is off for the scene, the user wants to decide when it goes to GitHub: only push when they ask.",
          inputSchema: { name: SCENE_NAME.optional() },
        },
        tool(async ({ name }) => text(await appCommand({ type: "save", ...(name ? { name } : {}) }))),
      );
    }

    // ---------------------------------------------------------------------------
    // merge conflicts: the user's version and GitHub's changed the same elements
    // ---------------------------------------------------------------------------

    const requireApp = async () => {
      if (!(await appConnected())) {
        throw new Error(`Conflicts live in the user's app (browser), which is not open. Ask the user to open ${APP_HINT}.`);
      }
    };

    /** a clashing element side by side, compact */
    const clashView = (clash) => {
      const side = (el) => (el ? compact([el])[0] : "deleted");
      return {
        id: clash.id,
        type: (clash.mine || clash.theirs || clash.base)?.type,
        label: (clash.mine || clash.theirs || clash.base)?.text,
        mineChanged: clash.mineChanged,
        githubChanged: clash.theirsChanged,
        base: clash.base ? compact([clash.base])[0] : "(unknown or not in base)",
        mine: side(clash.mine),
        github: side(clash.theirs),
      };
    };

    server.registerTool(
      "get_conflict",
      {
        description: `Show a merge conflict of a scene (status "conflict" in app_status / read_open_scene): elements that the user's local version AND GitHub's version both changed differently since their common version. Everything else was merged automatically. Per clashing element you get base / mine (the user's local version) / github, and which fields each side changed. view=true adds two images of the clashing area: the user's version and GitHub's. Then settle it with resolve_conflict.`,
        inputSchema: {
          name: SCENE_NAME,
          view: z.boolean().optional().describe("Also return images of the clashing area: mine and GitHub's version"),
          limit: z.number().optional().describe("Max clashes with full details (default 40); the rest are listed by id"),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ name, view, limit = 40 }) => {
        await requireApp();
        const info = await appCommand({ type: "conflict-info", name });
        const result = text({
          scene: info.scene,
          clashes: info.clashes.length,
          autoMerged: info.autoMerged,
          ...(info.baseKnown ? {} : { note: "The common base version is unknown, so every difference counts as a clash." }),
          details: info.clashes.slice(0, limit).map(clashView),
          ...(info.clashes.length > limit ? { moreIds: info.clashes.slice(limit).map((c) => c.id) } : {}),
          next: 'resolve_conflict(name, resolution: "merge", choices: {id: "mine" | "github"}, otherwise: "mine" | "github") keeps the auto-merged changes of both sides and decides each clashing element. Other resolutions: "mine" (overwrite GitHub with the user\'s whole version), "github" (discard the user\'s local changes), "both" (GitHub\'s version, user\'s kept as a copy). Ask the user when the right choice is not obvious.',
        });
        if (view && info.clashes.length) {
          const ids = info.clashes.map((c) => c.id);
          for (const side of ["mine", "theirs"]) {
            const sideIds = ids.filter((id) => info.clashes.find((c) => c.id === id)[side]);
            if (!sideIds.length) {
              result.content.push({ type: "text", text: `(${side === "mine" ? "mine" : "GitHub's"}: all clashing elements are deleted there)` });
              continue;
            }
            try {
              const { image, meta } = await renderImage({ conflict: { name, side }, elementIds: sideIds, maxSize: 1200 }, { userTab: true });
              result.content.push(image, {
                type: "text",
                text: `Image above: ${side === "mine" ? "the USER's version (mine)" : "GITHUB's version"} of the clashing area (bounds ${JSON.stringify(meta.renderedBounds)}).`,
              });
            } catch (error) {
              result.content.push({ type: "text", text: `(could not render ${side}: ${error.message})` });
            }
          }
        }
        return result;
      }),
    );

    const SIDE = z.enum(["mine", "github"]);
    const toSide = (choice) => (choice === "github" ? "theirs" : choice);

    server.registerTool(
      "resolve_conflict",
      {
        description: `Resolve a merge conflict of a scene (see get_conflict) and push the result to GitHub.
  - resolution "merge" (recommended): keeps every change that only one side made, and decides each clashing element: choices = {"<element id>": "mine" | "github"}, otherwise = the side for all clashes not in choices. Every clash needs a decision. "mine" = the user's local version of that element, "github" = the version on GitHub; a side where the element is deleted removes it.
  - "mine": the user's whole local version overwrites GitHub (GitHub's other changes are lost).
  - "github": take GitHub's version, discard the user's local changes.
  - "both": take GitHub's version and keep the user's version as a copy scene.
  Afterwards, fix details with read_open_scene / edit_open_scene if needed. Ask the user when it is unclear which version they want; never silently discard their work.`,
        inputSchema: {
          name: SCENE_NAME,
          resolution: z.enum(["merge", "mine", "github", "both"]),
          choices: z.record(z.string(), SIDE).optional().describe('For "merge": element id -> "mine" | "github"'),
          otherwise: SIDE.optional().describe('For "merge": side for clashes not listed in choices'),
        },
        annotations: { destructiveHint: true },
      },
      tool(async ({ name, resolution, choices, otherwise }) => {
        await requireApp();
        const result = await appCommand({
          type: "conflict-resolve",
          name,
          resolution: resolution === "github" ? "theirs" : resolution,
          ...(choices ? { choices: Object.fromEntries(Object.entries(choices).map(([id, c]) => [id, toSide(c)])) } : {}),
          ...(otherwise ? { otherwise: toSide(otherwise) } : {}),
        });
        if (result.resolved === false) {
          return text({
            ...result,
            note: "GitHub changed again meanwhile and the newest version clashes too. Call get_conflict again.",
          });
        }
        return text(result);
      }),
    );
  };

  /**
   * Store handed to the upstream tools: every create_view (and widget edit)
   * saves a checkpoint — mirror it into the open app so the user can watch the
   * agent draw. Fire-and-forget: never slows down or fails the drawing.
   */
  const previewingStore = {
    load: store.load,
    async save(id, data) {
      await store.save(id, data);
      if (MODE === "live" && livePreview) {
        appCommand({ type: "preview", elements: data.elements }).catch(() => {});
      }
    },
  };

  /** the skill doubles as the server's instructions (shown to agents by MCP clients) */
  const INSTRUCTIONS = skill.replace(/^---[\s\S]*?---\s*/, "");

  const server = new McpServer(
    { name, version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );
  /** read_me also explains what this app adds: images/icons, ER heads, slides */
  const SKILL_EXTRAS = ["## Editing elements", "## Limits", "## Formatted text", "## Slides (presentations)"]
    .map((heading) => {
      const start = INSTRUCTIONS.indexOf(heading);
      const end = INSTRUCTIONS.indexOf("\n## ", start + heading.length);
      return start < 0 ? "" : INSTRUCTIONS.slice(start, end < 0 ? undefined : end).trim();
    })
    .filter(Boolean)
    .join("\n\n");
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    registerTool(
      name,
      config,
      name === "read_me"
        ? async (...args) => {
            const result = await handler(...args);
            return {
              ...result,
              content: [
                ...result.content,
                { type: "text", text: `# This Excalidraw's extras (scenes, formatted text, slides, images)\n\n${SKILL_EXTRAS}` },
              ],
            };
          }
        : handler,
    );
  registerUpstream(server, previewingStore);
  server.registerTool = registerTool;
  registerSceneTools(server);
  return server;
};
