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

/** `target` is `base` or lies inside it (also when `base` is the file system's root) */
export const insideRoot = (base, target) => {
  const relative = path.relative(base, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Local inputs stay inside the directory the MCP server was launched in.
const LOCAL_ROOT = process.cwd();
const readLocalFile = async (file, encoding) => {
  const base = await realpath(LOCAL_ROOT);
  const target = path.resolve(base, file);
  const resolved = insideRoot(base, target) ? path.resolve(base, await realpath(target)) : null;
  if (!resolved || !insideRoot(base, resolved)) {
    throw new Error(`file "${file}": must be inside ${LOCAL_ROOT}`);
  }
  return readFile(resolved, encoding);
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

const MAX_REDIRECTS = 5;

/** an IPv4 address of this machine or a private / link-local / shared network */
const privateIPv4 = (ip) => {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** IPv4 inside IPv6 (::ffff:127.0.0.1, which URLs write as ::ffff:7f00:1) */
const mappedIPv4 = (ip) => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!hex) {
    return null;
  }
  const [high, low] = [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
};

/** an address (IPv4 or IPv6) of this machine or of a private / link-local network */
export const privateAddress = (address) => {
  const ip = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  if (!ip.includes(":")) {
    return privateIPv4(ip);
  }
  const mapped = mappedIPv4(ip);
  if (mapped) {
    return privateIPv4(mapped);
  }
  return ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
};

const localName = (host) => host === "localhost" || host.endsWith(".localhost");

/** where the MCP server runs on the user's machine: names that resolve to a private address too */
const resolvesPrivate = async (host) => {
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return false;
  }
  // (Kurviq online has no private network behind it; there the lookup may be missing)
  const dns = await import("node:dns/promises").catch(() => null);
  const found = (await dns?.lookup(host, { all: true }).catch(() => [])) ?? [];
  return found.some(({ address }) => privateAddress(address));
};

/** images come from the web only: never from this machine or a private network (also after a redirect) */
const checkTarget = async (target, url) => {
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error(`${url}: only http(s) addresses`);
  }
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (localName(host) || privateAddress(host) || (await resolvesPrivate(host))) {
    throw new Error(`${url}: addresses on this machine or a private network are not allowed`);
  }
};

/** fetch, following redirects one by one so every hop is checked */
const fetchChecked = async (url, signal) => {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkTarget(target, url); // NOSONAR S9382: each redirect hop is checked before it is fetched, in order
    const res = await fetch(target, { redirect: "manual", signal }); // NOSONAR S9382: the next hop depends on this answer
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      return res;
    }
    await res.body?.cancel().catch(() => null); // NOSONAR S9382: the redirect's body is dropped before the next hop
    target = new URL(location, target);
  }
  throw new Error(`${url}: too many redirects`);
};

/** download with a deadline and a byte limit (stops reading at the limit) */
const fetchBytes = async (url) => {
  const res = await fetchChecked(url, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
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
      await reader.cancel().catch(() => null); // NOSONAR S9382: cancel this stream before reporting its size limit
      throw new Error(`${url}: larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), mimeType: res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || null };
};

/** the image type, from the file's first bytes (null: not an image this app takes) */
const sniffImageType = (bytes) => {
  const starts = (...values) => values.every((value, i) => bytes[i] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  // SVG: after an optional <?xml …?>, <!DOCTYPE …> and comments (icon sets start with a license comment)
  const head = bytes
    .subarray(0, 4096)
    .toString("utf8")
    .toLowerCase()
    .replace(/^(\s|<\?xml[^>]*\?>|<!doctype[^>]*>|<!--[\s\S]*?-->)*/, ""); // NOSONAR S8786: bounded to the first 4096 bytes
  return head.startsWith("<svg") ? "image/svg+xml" : null;
};

const GENERIC_TYPES = new Set([null, "application/octet-stream", "binary/octet-stream"]);

/**
 * What a downloaded file is: the server's Content-Type (the URL's extension
 * only when the server names no type), and the file's first bytes must agree
 * that it is an image.
 */
const remoteImageType = (bytes, served, url) => {
  const declared = GENERIC_TYPES.has(served) ? MIME_BY_EXT[path.extname(new URL(url).pathname).toLowerCase()] : served;
  if (!declared?.startsWith("image/")) {
    throw new Error(`${url}: not an image (${served || "unknown type"})`);
  }
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    throw new Error(`${url}: not an image (the content is no png/jpg/gif/webp/svg)`);
  }
  return sniffed;
};

const svgSize = (bytes) => {
  const svg = bytes.toString("utf8");
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] || "";
  const num = (attr) => {
    const value = tag.match(new RegExp(String.raw`\b${attr}=["']([\d.]+)(px)?["']`))?.[1];
    return value ? Number.parseFloat(value) : null;
  };
  const viewBox = tag
    .match(/viewBox=["']([^"']+)["']/)?.[1]
    ?.split(/[\s,]+/)
    .map(Number);
  const width = num("width") ?? viewBox?.[2];
  const height = num("height") ?? viewBox?.[3];
  return width && height ? { width, height } : null;
};

/** WebP: extended (VP8X), lossy (VP8) or lossless (VP8L) */
const webpSize = (bytes) => {
  const chunk = bytes.subarray(12, 16).toString();
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
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
    if (bytes.subarray(8, 12).toString() === "WEBP") {
      return webpSize(bytes);
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
  const viewBox = tag.match(/viewBox=["']([^"']+)["']/)?.[1]?.split(/[\s,]+/).map(Number);
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
    return { bytes, mimeType: remoteImageType(bytes, mimeType, src), what: src };
  }
  if (!path.isAbsolute(src)) {
    throw new Error(`src "${src}": use an absolute file path, an http(s) URL or a data URL`);
  }
  const ext = path.extname(src).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    throw new Error(`src "${src}": only ${Object.keys(MIME_BY_EXT).join(" ")} files`);
  }
  return { bytes: await readLocalFile(src), mimeType: MIME_BY_EXT[ext], what: src };
};

/**
 * The element's size: as given, else with the aspect ratio of the image. When
 * the file's size can't be read, the ratio is unknown: both sides must be
 * given, or it gets a square default.
 */
const imageBox = (el, natural, source) => {
  const given = { width: el.width ?? null, height: el.height ?? null };
  if (given.width !== null && given.height !== null) {
    return given;
  }
  const known = natural && natural.width > 0 && natural.height > 0;
  if (!known && (given.width !== null || given.height !== null)) {
    throw new Error(`${source.what}: its size can't be read from the file, so width or height alone can't keep its aspect ratio: give both`);
  }
  if (!known) {
    const side = source.icon ? 48 : 200;
    return { width: side, height: side };
  }
  const ratio = natural.height / natural.width;
  if (given.width !== null) {
    return { width: given.width, height: given.width * ratio };
  }
  if (given.height !== null) {
    return { width: given.height / ratio, height: given.height };
  }
  const width = source.icon ? 48 : Math.min(400, natural.width);
  return { width, height: width * ratio };
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
  const { width, height } = imageBox(el, imageSize(source.bytes, source.mimeType), source);
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
  const data = JSON.parse(await readLocalFile(file, "utf8"));
  return Array.isArray(data) ? { add: data } : data;
};
