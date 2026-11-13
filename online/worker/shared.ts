// Shared scenes: kurviq.com/s/<fileId>/<slug>. The file id is the scene's
// Google Drive file (unique, and it stays when the scene is renamed), the
// slug only makes the link readable; nothing is stored here.
//
//   /api/public/<fileId>   a scene shared "anyone with the link" on Drive,
//                          read with Kurviq's API key, kept in Cloudflare's
//                          cache for a minute (?v=<version>: that version)
//   /api/public/<fileId>/version   its current version (Drive's MD5), cached
//                          for 5 s: open viewers poll it and reload on change
//   /s/<fileId>/<slug>     the app, with the scene's title for link previews
//                          (Slack, Teams, …) and the scene preloaded
//   /pub/<name>            the same for a short link (./pubLinks.ts)
//
// Scenes shared only with people are never fetched here: the visitor's
// browser reads them from Drive with the visitor's own sign-in.

import { pubNameFromPath } from "../../scenes-plugin/src/online/pubName";

import { googleUrls } from "./google";
import type { GoogleEnv } from "./google";
import { pubFile } from "./pubLinks";
import type { PubEnv } from "./pubLinks";

export type SharedEnv = GoogleEnv & {
  /** API key (Drive API only) for files shared "anyone with the link" */
  GOOGLE_API_KEY?: string;
};

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const SCENE_MIME = "application/vnd.excalidraw+json";
const EXTENSION = ".excalidraw";
/** bigger scenes are opened in the browser (signed in), not through the Worker */
const MAX_BYTES = 25 * 1024 * 1024;

const apiPath = (fileId: string) => `/api/public/${fileId}`;

/** the author's name on the public page, set only when they choose (scenes-plugin/src/online/drive.ts setByline) */
const BYLINE_PROPERTY = "kurviqBy";

const notPublic = () =>
  new Response("Not a public scene", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=30" },
  });

/** a public scene, through the edge cache (stale copies are fine for a minute) */
const publicScene = async (origin: string, fileId: string, env: SharedEnv, ctx: ExecutionContext, version?: string) => {
  const cache = caches.default;
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  const key = new Request(`${origin}${apiPath(fileId)}${query}`);
  const hit = await cache.match(key);
  if (hit) {
    return hit;
  }
  if (!env.GOOGLE_API_KEY) {
    return notPublic();
  }
  const drive = `${googleUrls(env).api}/files/${fileId}`;
  const meta = await fetch(`${drive}?fields=name,mimeType,size,properties&supportsAllDrives=true&key=${env.GOOGLE_API_KEY}`);
  const info: any = meta.ok ? await meta.json() : null;
  const isScene = !!info && (info.mimeType === SCENE_MIME || String(info.name).endsWith(EXTENSION)) && Number(info.size || 0) <= MAX_BYTES;
  const upstream = isScene ? await fetch(`${drive}?alt=media&supportsAllDrives=true&key=${env.GOOGLE_API_KEY}`) : null;
  const name = isScene ? String(info.name).replace(/\.excalidraw$/, "") : "";
  // the author, only if they chose to be named (Share…: "Show my name"): a public property of the file
  const by = isScene ? String(info.properties?.[BYLINE_PROPERTY] ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  const response = upstream?.ok
    ? new Response(upstream.body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // a minute, no stale copies: changes and turning off public sharing show within about 2 minutes
          "Cache-Control": "public, max-age=60",
          // someone else's content: data only, never a page
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Kurviq-Name": encodeURIComponent(name),
          ...(by ? { "X-Kurviq-By": encodeURIComponent(by) } : {}),
          "Access-Control-Expose-Headers": "X-Kurviq-Name, X-Kurviq-By",
        },
      })
    : notPublic();
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
};

/** a public scene's current version (MD5 of its content), for viewers to notice changes */
const publicVersion = async (origin: string, fileId: string, env: SharedEnv, ctx: ExecutionContext) => {
  const cache = caches.default;
  const key = new Request(`${origin}${apiPath(fileId)}/version`);
  const hit = await cache.match(key);
  if (hit) {
    return hit;
  }
  if (!env.GOOGLE_API_KEY) {
    return notPublic();
  }
  const meta = await fetch(
    `${googleUrls(env).api}/files/${fileId}?fields=md5Checksum,mimeType,name&supportsAllDrives=true&key=${env.GOOGLE_API_KEY}`,
  );
  const info: any = meta.ok ? await meta.json() : null;
  const isScene = !!info?.md5Checksum && (info.mimeType === SCENE_MIME || String(info.name).endsWith(EXTENSION));
  const response = isScene
    ? new Response(JSON.stringify({ version: info.md5Checksum }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=5" },
      })
    : notPublic();
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
};

/** /api/public/<fileId>, /api/public/<fileId>/version */
export const handlePublicApi = (request: Request, env: SharedEnv, ctx: ExecutionContext): Promise<Response> | null => {
  const url = new URL(request.url);
  const match = /^\/api\/public\/([^/]+)(\/version)?$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  if (!FILE_ID_RE.test(match[1]) || request.method !== "GET") {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  if (match[2]) {
    return publicVersion(url.origin, match[1], env, ctx);
  }
  const version = url.searchParams.get("v");
  return publicScene(url.origin, match[1], env, ctx, version && /^[a-f0-9]{32}$/.test(version) ? version : undefined);
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);

/**
 * The rewritten page goes out without the asset's validators: its title,
 * preload and short-link target depend on the scene, not only on the asset, so
 * a revalidation (304) must never bring back the browser's old copy.
 */
const uncached = (page: Response) => {
  const response = new Response(page.body, page);
  response.headers.set("Cache-Control", "no-cache");
  response.headers.delete("ETag");
  response.headers.delete("Last-Modified");
  return response;
};

/**
 * /s/<fileId>/<slug> and the short link /pub/<name> (./pubLinks.ts): the app
 * page, titled after the scene (if it is public). A short link's page names
 * its file (meta kurviq-pub), so the app needs no lookup of its own.
 */
export const handleSharedPage = async (
  request: Request,
  env: SharedEnv & PubEnv,
  assets: Fetcher,
  ctx: ExecutionContext,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = /^\/s\/([^/]+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
  const pubName = pubNameFromPath(url.pathname);
  if ((!match && !pubName) || request.method !== "GET") {
    return null;
  }
  // the whole page every time (no If-None-Match / If-Modified-Since): it is rewritten below
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const page = await assets.fetch(new Request(new URL("/", url), { headers }));
  const fileId = match ? match[1] : await pubFile(env, pubName!).catch(() => null);
  if (!fileId || !FILE_ID_RE.test(fileId) || !(page.headers.get("Content-Type") || "").includes("text/html")) {
    if (pubName && !fileId) {
      const missing = new HTMLRewriter()
        .on("head", { element: (el) => el.append(`<meta name="robots" content="noindex">`, { html: true }) })
        .transform(page);
      return uncached(missing);
    }
    return page;
  }
  const scene = await publicScene(url.origin, fileId, env, ctx);
  const name = scene.ok ? decodeURIComponent(scene.headers.get("X-Kurviq-Name") || "") : "";
  const by = scene.ok ? decodeURIComponent(scene.headers.get("X-Kurviq-By") || "") : "";
  const title = name ? `${name} · Kurviq` : `A shared scene on Kurviq`;
  const byline = by ? `By ${by}. ` : "";
  const description = name
    ? `${byline}A drawing made with Kurviq. Open it in your browser: no sign-up.`
    : `Shared with you on Kurviq. Sign in with Google to see it, if it was shared with you.`;
  const link = pubName ? `${url.origin}/pub/${pubName}` : `${url.origin}${url.pathname}`;
  const content = (value: string) => ({ element: (el: Element) => el.setAttribute("content", value) });
  const publicName = `${pubName} ${fileId}`;
  const rewritten = new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(title) })
    .on('meta[property="og:title"], meta[name="twitter:title"]', content(title))
    .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', content(description))
    .on('meta[property="og:url"]', content(link))
    .on('link[rel="canonical"]', { element: (el) => el.setAttribute("href", link) })
    .on("head", {
      element: (el) =>
        el.append(
          (pubName ? `<meta name="kurviq-pub" content="${escapeHtml(publicName)}">` : "") +
            (name
              ? `<link rel="preload" href="${escapeHtml(apiPath(fileId))}" as="fetch" crossorigin="anonymous">`
              : `<meta name="robots" content="noindex">`),
          { html: true },
        ),
    })
    .transform(page);
  return uncached(rewritten);
};
