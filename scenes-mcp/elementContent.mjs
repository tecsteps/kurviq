// When has an element changed? Its content, not its `version`: the app and
// agents re-save elements with new version stamps (and add / omit empty
// fields, reorder keys) without changing them, which must not count as a
// change. The one rule for the app's merge and the MCP's userChanges.

const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "index"]);

/** comparable content: no version stamps, no empty fields (null / [] / missing), sorted keys, rounded numbers */
const normalize = (value) => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const field = value[key];
      const empty = field === null || field === undefined || (Array.isArray(field) && !field.length);
      if (!VOLATILE.has(key) && !empty) {
        out[key] = normalize(field);
      }
    }
    return out;
  }
  return value;
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
