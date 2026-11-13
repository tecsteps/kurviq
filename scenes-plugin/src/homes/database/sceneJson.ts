// A scene file in a database's rows and back (./schema.sql): its elements one
// row each, its pictures in the storage bucket (an index of them in the
// scene's meta row), its comments one row each, and the rest of the file
// (type, appState with background, grid and presentation, fonts) as the
// "envelope". Assembling the rows gives the scene file again, the same
// format as everywhere else, so agents, exports and "Move to…" see one
// format.

/** an element as the database keeps it */
export type ElementRow = { id: string; version: number; version_nonce: number; pos: number; data: Record<string, any>; rev?: number };

/** a picture's entry in the scene's index (its data is in the storage bucket) */
export type FileEntry = { mimeType: string; created?: number };

export type SceneParts = {
  /** the file without elements, pictures and comments (their places kept as placeholders) */
  envelope: string;
  elements: Record<string, any>[];
  /** the pictures: id → Excalidraw's file entry (with its dataURL) */
  files: Record<string, { id: string; mimeType: string; dataURL: string; created?: number }>;
  comments: unknown[];
};

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** a scene file in its parts (throws for something that is not a scene file) */
export const splitScene = (json: string): SceneParts => {
  const data = JSON.parse(json);
  if (!isObject(data)) {
    throw new Error("Not a scene file");
  }
  const elements = Array.isArray(data.elements) ? data.elements.filter((element: unknown) => isObject(element) && typeof element.id === "string") : [];
  const files = isObject(data.files) ? data.files : {};
  const comments = Array.isArray(data.kurviqComments) ? data.kurviqComments : [];
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "elements") {
      envelope.elements = [];
    } else if (key === "files") {
      envelope.files = {};
    } else if (key === "kurviqComments") {
      envelope.kurviqComments = [];
    } else {
      envelope[key] = value;
    }
  }
  return { envelope: JSON.stringify(envelope), elements, files, comments };
};

/** the elements in their order (pos), the deleted ones left out */
export const orderedElements = (rows: readonly ElementRow[]) =>
  [...rows]
    .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1))
    .map((row) => row.data)
    .filter((element) => !element.isDeleted);

/** the scene file of a scene's parts (an empty envelope: a new scene file) */
export const assembleScene = (
  envelope: string | Record<string, unknown> | null,
  elements: readonly Record<string, any>[],
  files: SceneParts["files"],
  comments: readonly unknown[],
) => {
  let data: Record<string, unknown> = {};
  if (typeof envelope === "string") {
    try {
      const parsed = JSON.parse(envelope);
      data = isObject(parsed) ? parsed : {};
    } catch {}
  } else if (envelope) {
    data = { ...envelope };
  }
  if (!Object.keys(data).length) {
    data = { type: "excalidraw", version: 2, source: "https://kurviq.com", elements: [], appState: {}, files: {} };
  }
  data.elements = elements;
  if ("files" in data || Object.keys(files).length) {
    data.files = files;
  }
  if (comments.length) {
    data.kurviqComments = comments;
  } else {
    delete data.kurviqComments;
  }
  return JSON.stringify(data);
};

/** the pictures' index of a scene's pictures */
export const fileIndex = (files: SceneParts["files"]): Record<string, FileEntry> =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([, file]) => isObject(file) && typeof file.dataURL === "string")
      .map(([id, file]) => [id, { mimeType: file.mimeType, ...(typeof file.created === "number" ? { created: file.created } : {}) }]),
  );

/** the elements as the database's rows take them (position: their place in the list) */
export const elementRows = (elements: readonly Record<string, any>[]) =>
  elements.map((element, index) => ({
    ...element,
    version: Number.isFinite(element.version) ? element.version : 1,
    versionNonce: Number.isFinite(element.versionNonce) ? element.versionNonce : 0,
    kurviqPos: index + 1,
  }));
