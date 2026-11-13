// Images an agent uploads (kurviq.com/mcp/<key>/upload, see
// online/worker/index.ts): the Worker passes the file straight to this tab,
// which keeps it here (this browser only) until a scene uses it. An agent
// then adds { "type": "image", "fileId": "…" }, and the file goes into the
// scene like a pasted image. The model never has to carry the image's bytes.

import { createStore, delMany, get, keys, set } from "idb-keyval";

export type UploadedFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  width: number;
  height: number;
  created: number;
};

const store = createStore("kurviq-agent-uploads", "files");
/** uploads kept (the oldest go first; once in a scene, the scene has its own copy) */
export const MAX_UPLOADS = 100;
const MIME_RE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
/** the uploads' ids and times: pruning never loads the pictures themselves */
const UPLOAD_INDEX = "upload-index";
/** uploads written one at a time in this tab (the index is read and written whole) */
let uploadWrites: Promise<unknown> = Promise.resolve();

/** the picture's size, from the browser */
const naturalSize = (dataURL: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => reject(new Error("Not a readable image"));
    image.src = dataURL;
  });

/** keep an uploaded image (checked: an image type, a data URL of that type, readable) */
export const keepUpload = async (file: { id: string; mimeType: string; dataURL: string }) => {
  if (
    !/^[0-9a-f]{40}$/.test(file.id) ||
    !MIME_RE.test(file.mimeType) ||
    !file.dataURL.startsWith(`data:${file.mimeType};base64,`)
  ) {
    throw new Error("Not an image upload");
  }
  const size = await naturalSize(file.dataURL);
  const entry: UploadedFile = { ...file, ...size, created: Date.now() };
  const write = uploadWrites.then(async () => {
    await set(file.id, entry, store);
    // before the index existed: the stored uploads, as the oldest (their keys only, not the pictures)
    const index =
      (await get<Record<string, number>>(UPLOAD_INDEX, store)) ??
      Object.fromEntries((await keys(store)).filter((key) => String(key) !== UPLOAD_INDEX).map((key) => [String(key), 0]));
    index[file.id] = entry.created;
    const byAge = Object.entries(index).sort((a, b) => a[1] - b[1]);
    const drop = byAge.slice(0, Math.max(0, byAge.length - MAX_UPLOADS)).map(([id]) => id);
    drop.forEach((id) => delete index[id]);
    if (drop.length) {
      await delMany(drop, store);
    }
    await set(UPLOAD_INDEX, index, store);
  });
  uploadWrites = write.catch(() => {});
  await write;
  return entry;
};

/** an upload by its id (only real ids: the store also holds the index) */
export const getUpload = (id: string) =>
  /^[0-9a-f]{40}$/.test(id) ? get<UploadedFile>(id, store).catch(() => undefined) : Promise.resolve(undefined);

/** an Excalidraw file record of an upload */
const asFile = ({ id, mimeType, dataURL, created }: UploadedFile) => ({ id, mimeType, dataURL, created });

/**
 * Image elements that name an uploaded fileId: the files they need (for a
 * command's files map) and their size where the agent left it out.
 */
export const withUploads = async (elements: any[], files: Record<string, any> = {}) => {
  const out: any[] = [];
  const added: Record<string, any> = {};
  for (const el of elements) {
    if (el?.type !== "image" || typeof el.fileId !== "string" || (files[el.fileId] && el.width && el.height)) {
      out.push(el);
      continue;
    }
    const upload = await getUpload(el.fileId); // NOSONAR S9382: preserve upload lookup and error order
    if (!upload) {
      out.push(el);
      continue;
    }
    if (!files[el.fileId]) {
      added[el.fileId] = asFile(upload);
    }
    const ratio = upload.height / upload.width;
    const width = el.width ?? (el.height ? el.height / ratio : upload.width);
    const height = el.height ?? width * ratio;
    out.push({ ...el, width, height, status: el.status ?? "saved" });
  }
  return { elements: out, files: { ...files, ...added } };
};
