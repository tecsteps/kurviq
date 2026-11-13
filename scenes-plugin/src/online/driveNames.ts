// The names and limits a scene's Drive file carries, shared by the app
// (./drive.ts) and the Worker (online/worker/shared.ts, driveApi.ts): one
// place for the wire contract between the two, like ./pubName.ts.

/** a scene file's MIME type in Drive */
export const SCENE_MIME = "application/vnd.excalidraw+json";

/** the author's name on the public page, set only when they choose (a public property of the file) */
export const BYLINE_PROPERTY = "kurviqBy";

/** Drive takes at most 124 bytes (UTF-8) for a property's key and value together */
export const BYLINE_MAX_BYTES = 124 - BYLINE_PROPERTY.length;

const utf8Size = (codePoint: number) => {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  return codePoint < 0x10000 ? 3 : 4;
};

/** the text cut to at most `max` bytes of UTF-8, never inside a character */
export const cutBytes = (text: string, max: number) => {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Size(char.codePointAt(0) ?? 0);
    if (bytes > max) {
      break;
    }
    end += char.length;
  }
  return text.slice(0, end);
};

/** the author's name as shown (a public property: anyone with edit access may write anything there) */
export const cleanByline = (value: unknown) =>
  cutBytes((typeof value === "string" ? value : "").replaceAll(/[\u0000-\u001f\u007f]/g, "").trim(), BYLINE_MAX_BYTES);
