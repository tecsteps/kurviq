// Scenes for the agent, without their image bytes ("lean"). Kurviq's MCP
// runs on Cloudflare with a small CPU budget per request: a scene full of
// illustrations (megabytes of data URLs) parsed there for read_scene or
// view_scene exceeded it. The tab sends such scenes lean (each file keeps its
// id and type, not its data), remembers the bytes, and fills them in again
// when the agent asks for a picture: images only ever stay in the browser.

import { getUpload } from "./uploads";

import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

/** file id → file, from scenes recently sent lean (ids are content hashes: the same everywhere) */
const remembered = new Map<string, BinaryFileData>();
const MAX_REMEMBERED = 400;

const remember = (file: BinaryFileData) => {
  remembered.delete(file.id);
  remembered.set(file.id, file);
  while (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.keys().next().value!);
  }
};

/** a scene file's data without image bytes (the bytes are remembered here) */
export const leanScene = <T extends { files?: Record<string, any> }>(data: T): T => {
  if (!data?.files) {
    return data;
  }
  const files: Record<string, any> = {};
  for (const [id, file] of Object.entries(data.files)) {
    if (file?.dataURL) {
      remember(file);
    }
    files[id] = { id: file?.id ?? id, mimeType: file?.mimeType, lean: true, size: file?.dataURL?.length ?? 0 };
  }
  return { ...data, files };
};

/** the image bytes of lean files, from what this tab knows (the canvas, recent scenes, uploads) */
export const fillFiles = async (files: BinaryFiles | undefined, canvas: BinaryFiles = {}): Promise<BinaryFiles> => {
  const out: BinaryFiles = {};
  for (const [id, file] of Object.entries(files || {})) {
    if ((file as any)?.dataURL) {
      out[id] = file;
      continue;
    }
    const known = canvas[id] ?? remembered.get(id);
    if (known) {
      out[id] = known;
      continue;
    }
    const upload = await getUpload(id); // NOSONAR S9382: in order on purpose (preserves rendering or server operation order)
    if (upload) {
      out[id] = { id, mimeType: upload.mimeType, dataURL: upload.dataURL, created: upload.created } as BinaryFileData;
    }
  }
  return out;
};
