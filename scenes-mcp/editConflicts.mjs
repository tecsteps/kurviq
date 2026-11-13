// Field-level conflicts of an agent's edit: which `update` entries set a
// property the user changed since the agent's version (basedOn), and which
// `upsert` adds would replace an element the user changed. Element-level
// merging protects the user's other elements; this protects the same property
// of the same element (e.g. the user re-worded a text the agent recolors by
// resending its markdown). Pure: used by edit_scene / edit_open_scene before
// the edit is sent.

import { isPlainObject } from "./agentEdits.mjs";
import { changedFields, comparable, sameContent } from "./elementContent.mjs";
import { paraText, richDocOf } from "./richDoc.mjs";
import { markdownOfElement } from "./richText.mjs";

// compared as the merge and userChanges compare (null, missing and empty lists are the same)
const differs = (a, b) => JSON.stringify(comparable(a)) !== JSON.stringify(comparable(b));

const MAX_VALUE = 2000;
/** a value for the report (long texts cut) */
const shown = (value) => (typeof value === "string" && value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value);

const plainText = (el) => el?.originalText ?? el?.text ?? "";

/** the text and its formatting changed */
const textChanged = (base, current) =>
  differs(plainText(base), plainText(current)) || differs(base?.customData?.rich, current?.customData?.rich);

/** the text as the user left it (plain, plus markdown when formatted) */
const textNow = (el) => {
  const markdown = markdownOfElement(el);
  return { text: shown(plainText(el)), ...(markdown !== null ? { markdown: shown(markdown) } : {}) };
};

/** the paragraphs' text without list markers (what `format.match` is searched in) */
const formatText = (el) => {
  const doc = el?.type === "text" ? richDocOf(el, plainText(el)) : null;
  return doc ? doc.p.map(paraText).join("\n") : plainText(el);
};

const occurrences = (haystack, needle) => {
  let count = 0;
  const first = haystack.indexOf(needle);
  if (!needle) {
    return count;
  }
  for (let at = first; at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
};

/** keys of an update that are not element properties, or are handled as groups */
const SPECIAL = new Set([
  "id",
  "label",
  "format",
  "zIndex",
  "above",
  "below",
  "slide",
  "frameId",
  "text",
  "markdown",
  "originalText",
  "customData",
  "x",
  "y",
  "width",
  "height",
]);

const same = (a, b) => !differs(a, b);

/** every key of `props` in `keys` that is set already has the value `value(key)` */
const setsAlready = (props, keys, value) => keys.every((key) => props[key] === undefined || same(props[key], value(key)));

/** the text an update sets is already the element's (e.g. a retry of an edit that landed) */
const textSettled = (props, current) =>
  setsAlready(props, ["text", "originalText"], () => plainText(current)) &&
  (props.markdown === undefined || same(props.markdown, markdownOfElement(current) ?? plainText(current))) &&
  (props.customData?.rich === undefined || same(props.customData.rich, current.customData?.rich));

const pick = (props, keys) => Object.fromEntries(keys.filter((key) => props[key] !== undefined).map((key) => [key, props[key]]));

const textClash = (base, current, props) => {
  const textSet = props.text !== undefined || props.markdown !== undefined || props.originalText !== undefined || props.customData?.rich !== undefined;
  if (!textSet || !textChanged(base, current) || textSettled(props, current)) {
    return [];
  }
  const yours = pick(props, ["markdown", "text", "originalText"]);
  for (const key of Object.keys(yours)) {
    yours[key] = shown(yours[key]);
  }
  return [{ property: "text", yours, theirs: textNow(current) }];
};

/** x / y as the update means them: slide-relative when it names a slide */
const positionNow = (current, props, frames) => {
  const frame = props.slide === undefined ? null : frames.get(current.frameId);
  return { x: current.x - (frame?.x ?? 0), y: current.y - (frame?.y ?? 0) };
};

/** x / y (also slide-relative): a move */
const positionClash = (base, current, props, frames) => {
  if (props.x === undefined && props.y === undefined) {
    return [];
  }
  if (same(base.x, current.x) && same(base.y, current.y)) {
    return [];
  }
  const now = positionNow(current, props, frames);
  if (setsAlready(props, ["x", "y"], (key) => now[key])) {
    return [];
  }
  return [{ property: "position", yours: pick(props, ["x", "y", "slide"]), theirs: { x: current.x, y: current.y, ...(current.frameId ? { frameId: current.frameId } : {}) } }];
};

/** onto another slide */
const slideClash = (base, current, props) => {
  if ((props.slide === undefined && props.frameId === undefined) || same(base.frameId, current.frameId)) {
    return [];
  }
  const wanted = props.slide === undefined ? props.frameId : props.slide;
  if (wanted === current.frameId) {
    return [];
  }
  return [{ property: "slide", yours: props.slide === undefined ? { frameId: props.frameId } : { slide: props.slide }, theirs: { frameId: current.frameId ?? null } }];
};

/** size; a text that measures itself only changed size because its words did */
const sizeClash = (base, current, props) => {
  if (props.width === undefined && props.height === undefined) {
    return [];
  }
  const autoSized = current.type === "text" && current.autoResize !== false && textChanged(base, current);
  const resized = differs(base.width, current.width) || differs(base.height, current.height);
  if (autoSized || !resized || setsAlready(props, ["width", "height"], (key) => current[key])) {
    return [];
  }
  return [{ property: "size", yours: pick(props, ["width", "height"]), theirs: { width: current.width, height: current.height } }];
};

/** one key of customData: an object compared key by key, anything else as a whole */
const customDataKeyClashes = (key, value, was, now) => {
  if (isPlainObject(value) && (isPlainObject(was) || isPlainObject(now))) {
    return Object.entries(value)
      .filter(([inner, innerValue]) => differs(was?.[inner], now?.[inner]) && differs(innerValue, now?.[inner]))
      .map(([inner, innerValue]) => ({ property: `customData.${key}.${inner}`, yours: innerValue, theirs: now?.[inner] ?? null }));
  }
  return differs(was, now) && differs(value, now) ? [{ property: `customData.${key}`, yours: value, theirs: now ?? null }] : [];
};

/** customData merges: compared key by key (one level down, like the merge) */
const customDataClashes = (base, current, props) => {
  if (!isPlainObject(props.customData)) {
    return [];
  }
  return Object.entries(props.customData)
    .filter(([key]) => key !== "rich")
    .flatMap(([key, value]) => customDataKeyClashes(key, value, base.customData?.[key], current.customData?.[key]));
};

/** everything else by name (strokeColor, backgroundColor, fontSize, fontFamily, points, …) */
const namedClashes = (base, current, props) =>
  Object.entries(props)
    .filter(([key, value]) => !SPECIAL.has(key) && differs(base[key], current[key]) && differs(value, current[key]))
    .map(([key, value]) => ({ property: key, yours: value, theirs: current[key] ?? null }));

/**
 * The properties of `props` (an update, or a shape's label spec) that clash
 * with what the user changed on this element (base → current). A property
 * the element already has the value of does not clash (the user made the
 * same change, or this is a retry of an edit that already landed).
 */
const clashesOn = (base, current, props, { label = false, frames = new Map() } = {}) => [
  ...textClash(base, current, props),
  ...(label ? [] : [...positionClash(base, current, props, frames), ...slideClash(base, current, props), ...sizeClash(base, current, props)]),
  ...customDataClashes(base, current, props),
  ...namedClashes(base, current, props),
];

const formatSpecs = (format) => {
  if (Array.isArray(format)) {
    return format;
  }
  if (format !== undefined && format !== null) {
    return [format];
  }
  return [];
};

/**
 * Which update entries clash with the user's changes between `base` (the
 * agent's version) and `current` (the scene now), both lists of non-deleted
 * elements. Returns one conflict per clashing entry:
 * { index, id, properties, yours, theirs, userChanged, reason? }
 * (`index` = position in `updates`).
 */
export const findConflicts = ({ base, current, updates }) => {
  const before = new Map(base.map((el) => [el.id, el]));
  const now = new Map(current.map((el) => [el.id, el]));
  const labelIn = (list, id) => list.find((el) => el.type === "text" && el.containerId === id);
  const conflicts = [];
  (updates || []).forEach((update, index) => {
    if (!update || typeof update !== "object") {
      return;
    }
    const { id, ...props } = update;
    const was = before.get(id);
    const is = now.get(id);
    if (!was) {
      // new since the agent's version (or no such element: the edit reports it)
      return;
    }
    if (!is) {
      conflicts.push({ index, id, properties: ["deleted"], yours: props, theirs: null, reason: "the user deleted this element" });
      return;
    }
    const clashes = clashesOn(was, is, props, { frames: now });

    // a shape's label (`label: { text | markdown, fontSize, … }`) is its bound text element
    let labelSpec = null;
    if (!(props.label === undefined || is.type === "text")) {
      labelSpec = typeof props.label === "string" ? { text: props.label } : props.label;
    }
    const baseLabel = labelIn(base, id);
    const label = labelIn(current, id);
    const checkLabel = () => {
      if (isPlainObject(labelSpec)) {
        const { id: _ignored, ...spec } = labelSpec; // NOSONAR S1481: rest destructuring excludes id while preserving property getter access
        if (baseLabel && label) {
          clashes.push(...clashesOn(baseLabel, label, spec, { label: true }).map((c) => ({ ...c, property: `label.${c.property}` })));
        } else if (baseLabel && !label) {
          clashes.push({ property: "label", yours: spec, theirs: null, reason: "the user removed the label" });
        } else if (!baseLabel && label && (spec.text !== undefined || spec.markdown !== undefined)) {
          clashes.push({ property: "label.text", yours: spec, theirs: textNow(label) });
        }
      }
    };
    checkLabel();
    // format: only touches formatting; it clashes when the phrase is gone from a text the user changed
    const checkFormat = () => {
      const specs = formatSpecs(props.format);
      if (specs.length) {
        const [baseText, text] = is.type === "text" ? [was, is] : [baseLabel, label];
        if (text && baseText && textChanged(baseText, text)) {
          const haystack = formatText(text);
          const gone = specs.filter((spec) => {
            const match = typeof spec?.match === "string" ? spec.match : "";
            const found = occurrences(haystack, match);
            const wanted = typeof spec?.occurrence === "number" ? spec.occurrence : 1;
            return !found || found < wanted;
          });
          if (gone.length) {
            clashes.push({
              property: is.type === "text" ? "text" : "label.text",
              yours: { format: gone },
              theirs: textNow(text),
              reason: "the phrase to format is no longer in the text: the user changed it",
            });
          }
        }
      }
    };
    checkFormat();
    if (clashes.length) {
      conflicts.push({
        index,
        id,
        properties: clashes.map((c) => c.property),
        yours: Object.fromEntries(clashes.map((c) => [c.property, c.yours])),
        theirs: Object.fromEntries(clashes.map((c) => [c.property, c.theirs])),
        userChanged: changedFields(was, is),
        ...(clashes.some((c) => c.reason) ? { reason: clashes.filter((c) => c.reason).map((c) => c.reason).join("; ") } : {}),
      });
    }
  });
  return conflicts;
};

/**
 * Adds with `upsert` that replace an element the user changed since the
 * agent's version: the whole element would be overwritten, so each one is a
 * conflict ({ index, id, properties: ["replaced"], … }; `index` = position in `adds`).
 */
const upsertConflicts = ({ base, current, adds }) => {
  const before = new Map(base.map((el) => [el.id, el]));
  const now = new Map(current.map((el) => [el.id, el]));
  const conflicts = [];
  (adds || []).forEach((add, index) => {
    const was = before.get(add?.id);
    const is = now.get(add?.id);
    if (was && is && !sameContent(was, is)) {
      conflicts.push({
        index,
        id: add.id,
        properties: ["replaced"],
        yours: { replaced: add },
        theirs: { replaced: is },
        userChanged: changedFields(was, is),
        reason: "upsert replaces the whole element, which the user changed",
      });
    }
  });
  return conflicts;
};

const resolution = (onConflict) => (onConflict === "overwrite" ? "overwritten" : "rejected");

/**
 * Splits an edit's updates (and, with `upsert`, its adds that replace
 * existing elements) by the conflicts: what is sent, and the conflicts as
 * reported (with their resolution).
 */
export const resolveConflicts = ({ base, current, updates, adds, upsert = false, onConflict = "reject" }) => {
  const found = findConflicts({ base, current, updates });
  const replaced = upsert ? upsertConflicts({ base, current, adds }) : [];
  const keep = (list, conflicts) => {
    const rejected = new Set(onConflict === "overwrite" ? [] : conflicts.map((c) => c.index));
    return (list || []).filter((_, index) => !rejected.has(index));
  };
  return {
    updates: keep(updates, found),
    adds: keep(adds, replaced),
    conflicts: [...found, ...replaced].map(({ index: _index, ...conflict }) => ({ ...conflict, resolution: resolution(onConflict) })),
  };
};

/** one line naming the collisions: "box (text), t2 (position)" */
export const conflictList = (conflicts) => conflicts.map((c) => `${c.id} (${c.properties.join(", ")})`).join(", ");

/**
 * The elements of the agent's version (`base`) the conflict check of an edit
 * needs: those its updates (and, with upsert, its adds) name, and their
 * labels. Sent with the edit, so the user's tab checks it again against the
 * version it actually edits (a user change may land after the MCP's check).
 */
export const conflictBaseOf = (base, { updates, adds, upsert = false }) => {
  const named = [...(updates || []), ...(upsert ? adds || [] : [])].map((item) => item?.id).filter((id) => typeof id === "string");
  const ids = new Set(named);
  return (base || []).filter((el) => ids.has(el?.id) || ids.has(el?.containerId));
};

/** the conflicts of the MCP's check and of the tab's check, each once (with "overwrite" both report the same) */
export const withLateConflicts = (first, late) => {
  const key = (conflict) => `${conflict.id}\n${conflict.properties.join(",")}`;
  const seen = new Set(first.map(key));
  return [...first, ...(late || []).filter((conflict) => !seen.has(key(conflict)))];
};
