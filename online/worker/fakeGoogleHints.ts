// The fake Google's contentHints (fakeGoogle.ts): a file's thumbnail and its
// indexable text, checked like Drive's limits, so tests can see what the app
// sends (GET /fake-google/admin/file shows them, thumbnailLink serves the
// picture). Development builds only.

export type StoredHints = { thumb: string | null; thumb_mime: string | null; text: string | null };

/** Drive: a thumbnail of at most 2 MB, indexable text of at most 128 KB */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
export const INDEXABLE_TEXT_MAX_BYTES = 128 * 1024;

const URL_SAFE_BASE64 = /^[\w-]*={0,2}$/;

export class HintsError extends Error {}

/** standard base64 of URL-safe base64 */
const fromUrlSafe = (image: string) => image.replaceAll("-", "+").replaceAll("_", "/");

export const thumbnailBytes = (image: string) => {
  const binary = atob(fromUrlSafe(image));
  return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
};

/**
 * The hints of a files.create / files.update body, checked (HintsError: a
 * 400 at Google); undefined fields: not given.
 */
export const parseHints = (value: unknown): { thumbnail?: { image: string; mimeType: string }; indexableText?: string } | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HintsError("Invalid value for contentHints");
  }
  const { thumbnail, indexableText } = value as { thumbnail?: any; indexableText?: unknown };
  const out: { thumbnail?: { image: string; mimeType: string }; indexableText?: string } = {};
  if (indexableText !== undefined) {
    if (typeof indexableText !== "string" || new TextEncoder().encode(indexableText).length > INDEXABLE_TEXT_MAX_BYTES) {
      throw new HintsError("contentHints.indexableText must be a string of at most 128 KB");
    }
    out.indexableText = indexableText;
  }
  if (thumbnail !== undefined) {
    const image = thumbnail?.image;
    if (typeof image !== "string" || !URL_SAFE_BASE64.test(image) || typeof thumbnail.mimeType !== "string") {
      throw new HintsError("contentHints.thumbnail needs image (URL-safe base64) and mimeType");
    }
    if (thumbnailBytes(image).length > THUMBNAIL_MAX_BYTES) {
      throw new HintsError("contentHints.thumbnail.image is larger than 2 MB");
    }
    out.thumbnail = { image, mimeType: thumbnail.mimeType };
  }
  return out;
};

/** width and height of a PNG (from its header), else null */
export const pngSize = (bytes: Uint8Array) => {
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** a file's stored hints as the admin route shows them */
export const adminHints = (row: StoredHints | null) => {
  if (!row) {
    return { thumbnail: null, indexableText: null };
  }
  const bytes = row.thumb ? thumbnailBytes(row.thumb) : null;
  return {
    thumbnail: row.thumb && bytes ? { mimeType: row.thumb_mime, bytes: bytes.length, image: row.thumb, ...(pngSize(bytes) ?? {}) } : null,
    indexableText: row.text,
  };
};
