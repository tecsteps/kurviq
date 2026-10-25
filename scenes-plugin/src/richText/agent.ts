// Formatted text for agents: `markdown` instead of `text` on a text element,
// on a shape's `label`, or in an update (see SKILL.md).

import { docFromMarkdown, isPlainDoc, markdownOf, plainOf, richDocOf } from "./model";

const withRich = (customData: Record<string, any> | null | undefined, doc: ReturnType<typeof docFromMarkdown> | null) => {
  const { rich: _old, ...rest } = customData || {};
  return doc && !isPlainDoc(doc) ? { ...rest, rich: doc } : rest;
};

/** text + customData for markdown-like text */
export const fromMarkdown = (markdown: string, customData?: Record<string, any> | null) => {
  const doc = docFromMarkdown(markdown);
  return { text: plainOf(doc), customData: withRich(customData, doc) };
};

/**
 * An element as an agent wrote it: `markdown` (text, or a shape's label)
 * becomes the plain `text` plus the formatting in `customData.rich`.
 */
export const applyMarkdown = (el: any) => {
  if (!el || typeof el !== "object") {
    return el;
  }
  let next = el;
  if (typeof el.markdown === "string" && el.type === "text") {
    const { markdown, ...rest } = el;
    next = { ...rest, ...fromMarkdown(markdown, el.customData) };
  }
  const label = next.label;
  if (label && typeof label === "object" && typeof label.markdown === "string") {
    const { markdown, ...rest } = label;
    next = { ...next, label: { ...rest, ...fromMarkdown(markdown, label.customData) } };
  }
  return next;
};

/**
 * An update an agent sends: `markdown` sets text and formatting; plain
 * `text` drops the formatting.
 */
export const applyMarkdownUpdate = (el: any, patch: Record<string, any>) => {
  // (an update's customData merges into the element's: `rich: null` removes the formatting)
  if (typeof patch.markdown === "string") {
    const { markdown, ...rest } = patch;
    const { text, customData } = fromMarkdown(markdown, (patch.customData as any) ?? el?.customData);
    return { ...rest, text, customData: { ...customData, rich: customData.rich ?? null } };
  }
  if (typeof patch.text === "string" && !patch.customData?.rich) {
    return { ...patch, customData: { ...(patch.customData || {}), rich: null } };
  }
  return patch;
};

/** the markdown-like text of a formatted text element (null: plain text) */
export const markdownOfElement = (el: any) => {
  const doc = el?.type === "text" ? richDocOf(el) : null;
  return doc ? markdownOf(doc) : null;
};
