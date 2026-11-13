// When has an element changed? Its content, not its `version`: the app and
// agents re-save elements with new version stamps (and add / omit empty
// fields, reorder keys) without changing them, which must not count as a
// change. The one rule for the app's merge, the MCP's userChanges and the
// conflict check of agent edits (editConflicts.mjs).

const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "index"]);

const byCodeUnits = (a, b) => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

/**
 * Comparable content: no empty fields (null / [] / missing), sorted keys,
 * rounded numbers, without the `volatile` keys (by default the version
 * stamps and the z-order). The one canonical form of elements: the app's
 * merge, the MCP's userChanges, the agent edit checks (editConflicts.mjs)
 * and the agent edit diff (scenes-plugin/src/editDiff.ts, with its own keys).
 */
export const normalize = (value, volatile = VOLATILE) => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, volatile));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort(byCodeUnits)) {
      const field = value[key];
      const empty = field === null || field === undefined || (Array.isArray(field) && !field.length);
      if (!volatile.has(key) && !empty) {
        out[key] = normalize(field, volatile);
      }
    }
    return out;
  }
  return value;
};

/** one value (an element, or one of its properties) in comparable form: empty (null, missing, []) is null */
export const comparable = (value) => {
  const out = normalize(value);
  return out === undefined || out === null || (Array.isArray(out) && !out.length) ? null : out;
};

const sameStamp = (a, b) => a.version === b.version && a.versionNonce === b.versionNonce;

/** two versions of an element have the same content (both missing counts as the same) */
export const sameContent = (a, b) => {
  if (!a || !b) {
    return !a && !b;
  }
  return sameStamp(a, b) || JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

/** fields whose content differs between two versions of an element */
export const changedFields = (a, b) => {
  if (sameStamp(a, b)) {
    return [];
  }
  const [na, nb] = [normalize(a), normalize(b)];
  return [...new Set([...Object.keys(na), ...Object.keys(nb)])].filter((key) => JSON.stringify(na[key]) !== JSON.stringify(nb[key]));
};
