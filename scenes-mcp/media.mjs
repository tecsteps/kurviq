// Images for agents: an element { type: "image", src | svg | icon, … } becomes
// a real Excalidraw image element plus its file (data URL), so agents can put
// logos, screenshots and icons into scenes without writing scene JSON.

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// Local inputs stay inside the directory the MCP server was launched in.
const LOCAL_ROOT = process.cwd();
const confinedPath = async (file) => {
  const root = await realpath(LOCAL_ROOT);
  const resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`file "${file}": must be inside ${LOCAL_ROOT}`);
  }
  return resolved;
};

const MAX_BYTES = 5 * 1024 * 1024;

/** icon sets by prefix: "lucide:arrow-right", "simple-icons:github" */
const ICON_SETS = {
  lucide: (name) => `https://unpkg.com/lucide-static/icons/${name}.svg`,
  "simple-icons": (name) => `https://cdn.jsdelivr.net/npm/simple-icons/icons/${name}.svg`,
};

/** remote images per call, and how long one may take */
const MAX_REMOTE = 20;
const FETCH_TIMEOUT_MS = 15_000;

/** download with a deadline and a byte limit (stops reading at the limit) */
const fetchBytes = async (url) => {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  if (!/^https?:$/.test(new URL(res.url || url).protocol)) {
    throw new Error(`${url}: redirected to a non-web address`);
  }
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    throw new Error(`${url}: larger than ${MAX_BYTES / 1024 / 1024} MB`);
  }
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {}); // NOSONAR S9382: cancel this stream before reporting its size limit
      throw new Error(`${url}: larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), mimeType: res.headers.get("content-type")?.split(";")[0] || null };
};

const svgSize = (bytes) => {
  const svg = bytes.toString("utf8");
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] || "";
  const num = (attr) => {
    const value = tag.match(new RegExp(String.raw`\b${attr}="([\d.]+)(px)?"`))?.[1];
    return value ? Number.parseFloat(value) : null;
  };
  const viewBox = tag
    .match(/viewBox="([^"]+)"/)?.[1]
    ?.split(/[\s,]+/)
    .map(Number);
  const width = num("width") ?? viewBox?.[2];
  const height = num("height") ?? viewBox?.[3];
  return width && height ? { width, height } : null;
};

/** intrinsic size of PNG / GIF / JPEG / WebP / SVG, or null */
const imageSize = (bytes, mimeType) => {
  try {
    if (mimeType === "image/svg+xml") {
      return svgSize(bytes);
    }
    if (bytes.subarray(1, 4).toString() === "PNG") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.subarray(0, 3).toString() === "GIF") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.subarray(8, 12).toString() === "WEBP" && bytes.subarray(12, 16).toString() === "VP8X") {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset < bytes.length) {
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {}
  return null;
};

/**
 * SVGs without width/height (e.g. simple-icons: viewBox only) get a default
 * size of 300x150 in browsers and render distorted: set it from the viewBox
 */
const sizedSvg = (svg) => {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag || /\swidth=/.test(tag)) {
    return svg;
  }
  const viewBox = tag.match(/viewBox="([^"]+)"/)?.[1]?.split(/[\s,]+/).map(Number);
  if (viewBox?.length !== 4) {
    return svg;
  }
  return svg.replace(tag, tag.replace(/<svg\b/i, `<svg width="${viewBox[2]}" height="${viewBox[3]}"`));
};

/** recolor an icon: lucide uses currentColor, simple-icons has no fill */
const tintSvg = (svg, color, set) => {
  if (set === "simple-icons") {
    return svg.replace(/<svg\b/, `<svg fill="${color}"`);
  }
  return svg.replaceAll("currentColor", color);
};

/** lucide's icon names with their tags (for suggestions), loaded once */
let lucideTags = null;
const loadLucideTags = async () => {
  if (!lucideTags) {
    lucideTags = fetchBytes("https://unpkg.com/lucide-static/tags.json")
      .then(({ bytes }) => JSON.parse(bytes.toString("utf8")))
      .catch(() => {
        lucideTags = null;
        return {};
      });
  }
  return lucideTags;
};

/** lucide icons whose name or tags match the words of a missing name */
const suggestIcons = async (name) => {
  const tags = await loadLucideTags();
  const words = name.split("-").filter((word) => word.length > 2);
  const nameScore = (icon, word) => {
    if (icon.split("-").includes(word)) return 3;
    return icon.includes(word) ? 2 : 0;
  };
  const score = (icon) =>
    words.reduce(
      (sum, word) =>
        sum + nameScore(icon, word) + ((tags[icon] || []).some((tag) => tag.includes(word)) ? 1 : 0),
      0,
    );
  return Object.keys(tags)
    .map((icon) => [icon, score(icon)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, 6)
    .map(([icon]) => `lucide:${icon}`);
};

const loadSource = async (el) => {
  if (el.svg) {
    return { bytes: Buffer.from(String(el.svg)), mimeType: "image/svg+xml", what: "inline svg" };
  }
  if (el.icon) {
    const [set, name] = String(el.icon).split(":");
    if (!ICON_SETS[set] || !/^[a-z0-9-]+$/.test(name || "")) {
      throw new Error(`icon "${el.icon}": use "lucide:<name>" or "simple-icons:<slug>" (e.g. "lucide:database", "simple-icons:github")`);
    }
    const { bytes } = await fetchBytes(ICON_SETS[set](name)).catch(() => {
      throw new Error(`icon "${el.icon}" not found (lucide names: lucide.dev/icons, simple-icons slugs: simpleicons.org)`);
    });
    const svg = tintSvg(bytes.toString("utf8"), el.color || "#1e1e1e", set);
    return { bytes: Buffer.from(svg), mimeType: "image/svg+xml", what: el.icon, icon: true };
  }
  const src = String(el.src);
  if (src.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (!match) {
      throw new Error("src: invalid data URL");
    }
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    return { bytes, mimeType: match[1], what: "data URL" };
  }
  if (/^https?:\/\//.test(src)) {
    const { bytes, mimeType } = await fetchBytes(src);
    const ext = path.extname(new URL(src).pathname).toLowerCase();
    return { bytes, mimeType: MIME_BY_EXT[ext] || mimeType, what: src };
  }
  if (!path.isAbsolute(src)) {
    throw new Error(`src "${src}": use an absolute file path, an http(s) URL or a data URL`);
  }
  const ext = path.extname(src).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    throw new Error(`src "${src}": only ${Object.keys(MIME_BY_EXT).join(" ")} files`);
  }
  return { bytes: await readFile(await confinedPath(src)), mimeType: MIME_BY_EXT[ext], what: src };
};

const imageElement = (el, source, files) => {
  if (source.mimeType === "image/svg+xml") {
    source.bytes = Buffer.from(sizedSvg(source.bytes.toString("utf8")));
  }
  if (!source.mimeType?.startsWith("image/")) {
    throw new Error(`${source.what}: not an image (${source.mimeType || "unknown type"})`);
  }
  if (source.bytes.length > MAX_BYTES) {
    throw new Error(`${source.what}: larger than ${MAX_BYTES / 1024 / 1024} MB`);
  }
  const fileId = createHash("sha1").update(source.bytes).digest("hex"); // NOSONAR S4790: content identifier for Excalidraw deduplication, not authentication
  files[fileId] = {
    id: fileId,
    mimeType: source.mimeType,
    dataURL: `data:${source.mimeType};base64,${source.bytes.toString("base64")}`,
    created: Date.now(),
  };
  // size: as given, else keep the aspect ratio of the image
  const natural = imageSize(source.bytes, source.mimeType) || { width: 1, height: 1 };
  const fallback = source.icon ? 48 : Math.min(400, natural.width || 200);
  const width = el.width ?? (el.height ? (el.height * natural.width) / natural.height : fallback);
  const height = el.height ?? (width * natural.height) / natural.width;
  const rest = { ...el };
  delete rest.src;
  delete rest.svg;
  delete rest.icon;
  delete rest.color;
  return { ...rest, type: "image", fileId, status: "saved", width, height, scale: [1, 1] };
};

/**
 * Turn image elements with src / svg / icon into Excalidraw image elements
 * (fileId) and collect their files. Other elements pass through unchanged.
 */
export const resolveImages = async (elements) => {
  const files = {};
  const out = [];
  const wanted = (el) => el?.type === "image" && !el.fileId && (el.src || el.svg || el.icon);
  const remote = elements.filter((el) => wanted(el) && (el.icon || /^https?:\/\//.test(String(el.src || "")))).length;
  if (remote > MAX_REMOTE) {
    throw new Error(`${remote} images from the web in one call: at most ${MAX_REMOTE} (nothing was saved)`);
  }
  // load all sources first, so every unknown icon is reported at once
  const loaded = await Promise.all(
    elements.map((el) => (wanted(el) ? loadSource(el).catch((error) => ({ error, el })) : null)),
  );
  const failed = loaded.filter((source) => source?.error);
  if (failed.length) {
    const lines = await Promise.all(
      failed.map(async ({ error, el }) => {
        const [set, name] = String(el.icon || "").split(":");
        const ideas = set === "lucide" && name ? await suggestIcons(name) : [];
        const prefix = el.id ? `${el.id}: ` : "";
        const suffix = ideas.length ? `; similar: ${ideas.join(", ")}` : "";
        return `- ${prefix}${error.message}${suffix}`;
      }),
    );
    throw new Error(`${failed.length} image${failed.length === 1 ? "" : "s"} could not be loaded (nothing was saved):\n${lines.join("\n")}`);
  }
  for (const [i, el] of elements.entries()) {
    if (!wanted(el)) {
      out.push(el);
      continue;
    }
    const source = loaded[i];
    out.push(imageElement(el, source, files));
  }
  return { elements: out, files };
};

/**
 * Edit input from a file, so big edits don't have to go through the chat:
 * a JSON file with { add?: [...], update?: [...], delete?: [...] } (or just
 * an array = add).
 */
export const readEditFile = async (file) => {
  if (!path.isAbsolute(file)) {
    throw new Error(`file "${file}": use an absolute path`);
  }
  const data = JSON.parse(await readFile(await confinedPath(file), "utf8"));
  return Array.isArray(data) ? { add: data } : data;
};
