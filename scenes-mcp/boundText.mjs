// Shapes and their labels belong together: whoever picks one gets the other.
// The one rule for the MCP's region / element selections and the tab's
// pictures.

/** containers bring their labels, labels bring their containers */
export const withBoundText = (picked, all) => {
  const ids = new Set(picked.map((el) => el.id));
  for (const el of all) {
    if (el.containerId && ids.has(el.containerId)) {
      ids.add(el.id);
    }
    if (ids.has(el.id) && el.containerId) {
      ids.add(el.containerId);
    }
  }
  return all.filter((el) => ids.has(el.id));
};
