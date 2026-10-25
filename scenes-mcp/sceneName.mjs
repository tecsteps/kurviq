// What a scene name may be (stored as scenes/<name>.excalidraw): letters,
// numbers, spaces and _ . ( ) -, up to 100 characters, no "..". The one rule
// for the app, the local server, the Worker and the MCP tools.

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,99}$/u;

/** a valid scene name */
export const isSceneName = (name) => typeof name === "string" && NAME_RE.test(name) && !name.includes("..");
