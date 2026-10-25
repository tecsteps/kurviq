// Formatted text (customData.rich, see richDoc.mjs) shown to agents in the
// markdown-like form they write it in (`markdown`).

import { markdownOf, richDocOf } from "./richDoc.mjs";

/** the formatting of a text element as markdown-like text (null: none, or no longer matching its text) */
export const markdownOfElement = (el) => {
  const doc = el?.type === "text" ? richDocOf(el, el.originalText ?? el.text) : null;
  return doc ? markdownOf(doc) : null;
};
