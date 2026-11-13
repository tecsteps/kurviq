// Shared scenes: kurviq.com/s/<fileId>/<slug>. The file id is the scene's
// Google Drive file (unique, and it stays when the scene is renamed), the
// slug only makes the link readable; nothing is stored here.
//
//   /s/<fileId>/<slug>     the app, with the scene's title for link previews
//                          (Slack, Teams, …)
//   /pub/<name>            the same for a short link (./pubLinks.ts)
//   /api/public/<fileId>   a public scene's name, author and version (metadata
//                          only, never its content; not cached)
//   /api/public/<fileId>/version   its version alone (Drive's MD5)
//
// The scene's content never passes through Kurviq's servers: the viewer reads
// a scene shared "anyone with the link" from Drive in the browser (with
// Kurviq's browser API key), and any other with the visitor's own sign-in
// (scenes-plugin/src/online/drive.ts readSharedScene). The Worker only asks
// Drive for the name, uncached, so a link preview shows the scene's title.

import { BYLINE_PROPERTY, SCENE_MIME, cleanByline } from "../../scenes-plugin/src/online/driveNames";
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
const EXTENSION = ".excalidraw";

export type PublicMeta = { name: string; by: string; version: string | null };

/** a public scene's name, author (if they chose to be named) and version; null: not a public scene (or Drive didn't answer) */
export const publicMeta = async (fileId: string, env: SharedEnv): Promise<PublicMeta | null> => {
  if (!env.GOOGLE_API_KEY || !FILE_ID_RE.test(fileId)) {
    return null;
  }
  const res = await fetch(
    `${googleUrls(env).api}/files/${fileId}?fields=name,mimeType,md5Checksum,properties&supportsAllDrives=true&key=${env.GOOGLE_API_KEY}`,
  ).catch(() => null);
  const info: any = res?.ok ? await res.json().catch(() => null) : null;
  if (!info || !(info.mimeType === SCENE_MIME || String(info.name).endsWith(EXTENSION))) {
    return null;
  }
  return {
    name: String(info.name).replace(/\.excalidraw$/, ""),
    by: cleanByline(info.properties?.[BYLINE_PROPERTY]),
    version: typeof info.md5Checksum === "string" ? info.md5Checksum : null,
  };
};

const metaAnswer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/** /api/public/<fileId>, /api/public/<fileId>/version: metadata only (null: not a request for it) */
export const handlePublicApi = (request: Request, env: SharedEnv): Promise<Response> | null => {
  const url = new URL(request.url);
  const match = /^\/api\/public\/([^/]+)(\/version)?$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  if (!FILE_ID_RE.test(match[1]) || request.method !== "GET") {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  return publicMeta(match[1], env).then((meta) => {
    if (!meta) {
      return metaAnswer({ error: "Not a public scene" }, 404);
    }
    return metaAnswer(match[2] ? { version: meta.version } : meta);
  });
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
 * page, titled after the scene (if it is public: onPublic is called then). A
 * short link's page names its file (meta kurviq-pub), so the app needs no
 * lookup of its own.
 */
export const handleSharedPage = async (
  request: Request,
  env: SharedEnv & PubEnv,
  assets: Fetcher,
  onPublic: () => void,
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
  const meta = await publicMeta(fileId, env);
  if (meta) {
    onPublic();
  }
  const name = meta?.name ?? "";
  const by = meta?.by ?? "";
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
            (name ? "" : `<meta name="robots" content="noindex">`),
          { html: true },
        ),
    })
    .transform(page);
  return uncached(rewritten);
};
