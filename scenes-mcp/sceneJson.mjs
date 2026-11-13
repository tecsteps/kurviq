// A serialized scene (Excalidraw's JSON: an object, ends with "}") plus one
// more top-level field, without parsing and writing the whole scene again
// (scenes with pictures are large). Used for the fields Kurviq adds when a
// scene is saved: its comments (sceneComments.mjs) and its fonts (the app's
// fonts.ts).

/** the JSON with `"name": value` added as its last top-level field; not an object: unchanged */
export const withTopLevelField = (json, name, value) => {
  const trimmed = json.trimEnd();
  if (!trimmed.endsWith("}")) {
    return json;
  }
  const body = trimmed.slice(0, trimmed.lastIndexOf("}")).trimEnd();
  // an empty object gets no comma before its first field
  const separator = body.endsWith("{") ? "" : ",";
  return `${body}${separator}\n  ${JSON.stringify(name)}: ${JSON.stringify(value)}\n}`;
};
