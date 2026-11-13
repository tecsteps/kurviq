// The words Google Drive indexes for a scene (contentHints.indexableText):
// the scene's name, the text of its text elements and labels (formatted text
// as plain text) and its slide titles. Not comments (conversation, not
// content) and not speaker notes (they can hold private remarks). Built in
// the tab that saves; Kurviq's server never sees it.

/** Drive indexes at most 128 KB of a file's indexable text */
export const INDEX_TEXT_MAX_BYTES = 128 * 1024;

type SceneElement = {
  id?: string;
  type?: string;
  isDeleted?: boolean;
  text?: unknown;
  originalText?: unknown;
  containerId?: string | null;
  name?: unknown;
};

const clean = (value: unknown) => (typeof value === "string" ? value.replaceAll(/\s+/g, " ").trim() : "");

/** what an element contributes: a text's plain text (labels too), a frame's (slide's) title */
const wordsOf = (element: SceneElement, deleted: ReadonlySet<string>) => {
  if (element.type === "text") {
    if (element.containerId && deleted.has(element.containerId)) {
      return ""; // the label of a deleted shape
    }
    // originalText is the text without wrapping; formatted text keeps its plain text there too
    return clean(element.originalText ?? element.text);
  }
  if (element.type === "frame" || element.type === "magicframe") {
    return clean(element.name);
  }
  return "";
};

const encoder = new TextEncoder();

/** the text cut to at most maxBytes (UTF-8), at a word boundary (whitespace) */
export const cutAtWord = (text: string, maxBytes = INDEX_TEXT_MAX_BYTES) => {
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  if (/\s/.test(text[end] ?? "")) {
    return text.slice(0, end).trimEnd();
  }
  let space = end;
  while (space > 0 && !/\s/.test(text[space - 1])) {
    space--;
  }
  // one word longer than the limit: cut inside it
  return text.slice(0, space > 0 ? space : end).trimEnd();
};

/**
 * The indexable text of a scene: its name, then each distinct text (in
 * element order) on its own line, cut to Drive's limit at a word boundary.
 */
export const sceneIndexText = (name: string, data: { elements?: unknown } | null | undefined, maxBytes = INDEX_TEXT_MAX_BYTES) => {
  const elements = (Array.isArray(data?.elements) ? data.elements : []) as SceneElement[];
  const deleted = new Set(elements.filter((element) => element?.isDeleted && element.id).map((element) => element.id as string));
  const lines = new Set<string>();
  const title = clean(name);
  if (title) {
    lines.add(title);
  }
  for (const element of elements) {
    if (!element || element.isDeleted) {
      continue;
    }
    const words = wordsOf(element, deleted);
    if (words) {
      lines.add(words); // template copies repeat the same footer on every slide: once is enough
    }
  }
  return cutAtWord([...lines].join("\n"), maxBytes);
};
