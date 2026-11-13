// Bytes in and out of the Worker: request (and answer) bodies read with a
// size limit, and base64. One reader for every route, so none of them buffers
// more than it accepts, whatever Content-Length says (a chunked body has none).

/** a body read up to `max` bytes (stopped as soon as it is bigger: nothing over the limit is buffered); null: too big */
export const readBytes = async (body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> => {
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
};

/** the same as text (UTF-8); null: too big */
export const readText = async (body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> => {
  const bytes = await readBytes(body, max);
  return bytes && new TextDecoder().decode(bytes);
};

/** a request's JSON body up to `max` bytes: the value, "too-big", or "invalid" (not JSON) */
export const readJson = async (request: Request, max: number): Promise<{ value: unknown } | "too-big" | "invalid"> => {
  if (Number(request.headers.get("Content-Length") || 0) > max) {
    return "too-big";
  }
  const text = await readText(request.body, max);
  if (text === null) {
    return "too-big";
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return "invalid";
  }
};

/** base64 of bytes (in chunks: spreading a large array into one call would overflow the stack) */
export const base64FromBytes = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // NOSONAR S7758: base64 needs one binary character per byte
  }
  return btoa(binary);
};

/** the bytes of base64 text (a key from the Worker's secrets) */
export const bytesFromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0)); // NOSONAR S7758: base64 decoding reads binary bytes, not Unicode code points
