// Elements written in the short create_view format (labels, no version
// stamps, markdown) are converted by the user's tab with the real Excalidraw
// (text measured with the real fonts). The one rule for when that is needed,
// for the MCP tools and the tab's renderer.

/** an element in the short create_view format still needs conversion */
export const needsConversion = (el) =>
  el?.label !== undefined || el?.version === undefined || el?.markdown !== undefined;
