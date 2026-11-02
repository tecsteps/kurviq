// Field-level conflicts of an agent's edit: which `update` entries set a
// property the user changed since the agent's version (basedOn). Element-level
// merging protects the user's other elements; this protects the same property
// of the same element (e.g. the user re-worded a text the agent recolors by
// resending its markdown). Pure: used by edit_scene / edit_open_scene before
// the edit is sent.

import { changedFields } from "./elementContent.mjs";
import { paraText, richDocOf } from "./richDoc.mjs";
import { markdownOfElement } from "./richText.mjs";

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** comparable form: null and missing are the same, numbers rounded, keys sorted */
const canon = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(canon);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort((a, b) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })) {
      const field = canon(value[key]);
      if (field !== null) {
        out[key] = field;
      }
    }
    return out;
  }
  return value;
};

const differs = (a, b) => JSON.stringify(canon(a)) !== JSON.stringify(canon(b));

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
export const formatText = (el) => {
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

/**
 * The properties of `props` (an update, or a shape's label spec) that clash
 * with what the user changed on this element (base → current).
 */
const clashesOn = (base, current, props, { label = false } = {}) => {
  const clashes = [];
  const add = (property, yours, theirs) => clashes.push({ property, yours, theirs });
  const checkText = () => {
    const textSet =
      props.text !== undefined || props.markdown !== undefined || props.originalText !== undefined || props.customData?.rich !== undefined;
    if (textSet && textChanged(base, current)) {
      const yours = {};
      for (const key of ["markdown", "text", "originalText"]) {
        if (props[key] !== undefined) {
          yours[key] = shown(props[key]);
        }
      }
      add("text", yours, textNow(current));
    }
  };
  checkText();
  if (!label) {
    const checkPosition = () => {
      // x / y (also slide-relative): a move
      if ((props.x !== undefined || props.y !== undefined) && (differs(base.x, current.x) || differs(base.y, current.y))) {
        const yours = {};
        for (const key of ["x", "y", "slide"]) {
          if (props[key] !== undefined) {
            yours[key] = props[key];
          }
        }
        add("position", yours, { x: current.x, y: current.y, ...(current.frameId ? { frameId: current.frameId } : {}) });
      }
    };
    checkPosition();
    const checkSlide = () => {
      // onto another slide
      if ((props.slide !== undefined || props.frameId !== undefined) && differs(base.frameId, current.frameId)) {
        add("slide", props.slide !== undefined ? { slide: props.slide } : { frameId: props.frameId }, { frameId: current.frameId ?? null });
      }
    };
    checkSlide();
    const checkSize = () => {
      // size; a text that measures itself only changed size because its words did
      const autoSized = current.type === "text" && current.autoResize !== false && textChanged(base, current);
      if ((props.width !== undefined || props.height !== undefined) && !autoSized && (differs(base.width, current.width) || differs(base.height, current.height))) {
        const yours = {};
        for (const key of ["width", "height"]) {
          if (props[key] !== undefined) {
            yours[key] = props[key];
          }
        }
        add("size", yours, { width: current.width, height: current.height });
      }
    };
    checkSize();
  }
  const checkCustomData = (key, value) => {
    const was = base.customData?.[key];
    const now = current.customData?.[key];
    if (isPlainObject(value) && (isPlainObject(was) || isPlainObject(now))) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (differs(was?.[inner], now?.[inner])) {
          add(`customData.${key}.${inner}`, innerValue, now?.[inner] ?? null);
        }
      }
    } else if (differs(was, now)) {
      add(`customData.${key}`, value, now ?? null);
    }
  };
  // customData merges: compared key by key (one level down, like the merge)
  if (isPlainObject(props.customData)) {
    for (const [key, value] of Object.entries(props.customData)) {
      if (key === "rich") {
        continue;
      }
      checkCustomData(key, value);
    }
  }
  // everything else by name (strokeColor, backgroundColor, fontSize, fontFamily, points, …)
  for (const [key, value] of Object.entries(props)) {
    if (!SPECIAL.has(key) && differs(base[key], current[key])) {
      add(key, value, current[key] ?? null);
    }
  }
  return clashes;
};

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
    const clashes = clashesOn(was, is, props);

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
 * Splits an edit's updates by the conflicts: what is sent, and the conflicts
 * as reported (with their resolution).
 */
export const resolveConflicts = ({ base, current, updates, onConflict = "reject" }) => {
  const found = findConflicts({ base, current, updates });
  const rejected = new Set(onConflict === "overwrite" ? [] : found.map((c) => c.index));
  return {
    updates: (updates || []).filter((_, index) => !rejected.has(index)),
    conflicts: found.map(({ index: _index, ...conflict }) => ({
      ...conflict,
      resolution: onConflict === "overwrite" ? "overwritten" : "rejected",
    })),
  };
};

/** one line naming the collisions: "box (text), t2 (position)" */
export const conflictList = (conflicts) => conflicts.map((c) => `${c.id} (${c.properties.join(", ")})`).join(", ");
