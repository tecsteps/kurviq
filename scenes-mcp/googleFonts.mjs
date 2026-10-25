// A font from Google Fonts by name: its Latin files (latin, latin-ext) as
// data URLs. Used by the local install's app directly and by Kurviq's Worker
// (online, visitors' browsers never talk to Google).

/** a font's name: letters, digits, spaces, . _ - (up to 60) */
export const FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
/** a font file may be this big (fonts with many scripts are bigger; that is what Google's subsets are for) */
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

export const toDataUrl = (bytes, mime) => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
};

/** Google's CSS for a family → [{ data, range }], or null: no such font on Google Fonts */
export const googleFaces = async (family) => {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`, {
    headers: {
      // a current browser: Google answers with woff2
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    },
  });
  if (!css.ok) {
    return null;
  }
  const blocks = [...(await css.text()).matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
  const wanted = blocks.filter(([, subset]) => subset === "latin" || subset === "latin-ext");
  const faces = [];
  for (const [, , body] of (wanted.length ? wanted : blocks).slice(0, 4)) {
    const url = body.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
    if (!url) {
      continue;
    }
    const file = await fetch(url);
    if (!file.ok) {
      throw new Error(`Google Fonts answered ${file.status}`);
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_FONT_BYTES) {
      throw new Error("The font is too large");
    }
    faces.push({ data: toDataUrl(bytes, "font/woff2"), ...(range ? { range } : {}) });
  }
  return faces.length ? faces : null;
};
