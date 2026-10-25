// Shared scenes: kurviq.com/@<owner>/<scene>. The owner is a GitHub account
// or organization (globally unique), the scene a file in its repository, so
// the link is unique without anything stored here.
//
//   /api/public/<owner>/<scene>  a public scene, from <owner>/kurviq-public on
//                                GitHub, kept in Cloudflare's cache for a minute
//   /@<owner>/<scene>            the app, with the scene's title for link
//                                previews (Slack, Teams, …) and the scene preloaded
//
// Private scenes are never fetched here: the visitor's browser reads them
// from GitHub with the visitor's own access.

import { isSceneName } from "../../scenes-mcp/sceneName.mjs";

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const PUBLIC_REPO = "kurviq-public";

const parse = (owner: string, encoded: string) => {
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return OWNER_RE.test(owner) && isSceneName(name) ? { owner, name } : null;
};

const apiPath = (owner: string, name: string) => `/api/public/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** a public scene, through the edge cache (stale copies are fine for a minute) */
const publicScene = async (origin: string, owner: string, name: string, ctx: ExecutionContext) => {
  const cache = caches.default;
  const key = new Request(`${origin}${apiPath(owner, name)}`);
  const hit = await cache.match(key);
  if (hit) {
    return hit;
  }
  const upstream = await fetch(
    `https://raw.githubusercontent.com/${owner}/${PUBLIC_REPO}/HEAD/scenes/${encodeURIComponent(name)}.excalidraw`,
  );
  const response = upstream.ok
    ? new Response(upstream.body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
          // someone else's content: data only, never a page
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Kurviq-Source": `github.com/${owner}/${PUBLIC_REPO}`,
        },
      })
    : new Response("Not a public scene", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=30" },
      });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
};

/** /api/public/<owner>/<scene> */
export const handlePublicApi = (request: Request, ctx: ExecutionContext): Promise<Response> | null => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/public\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  // (the owner needs no decoding: GitHub names are letters, digits and dashes)
  const scene = parse(match[1], match[2]);
  if (!scene || request.method !== "GET") {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  return publicScene(url.origin, scene.owner, scene.name, ctx);
};

/** /@<owner>/<scene>: the app page, titled after the scene (if it is public) */
export const handleSharedPage = async (
  request: Request,
  assets: Fetcher,
  ctx: ExecutionContext,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/(?:@|%40)([^/]+)\/([^/]+)\/?$/i);
  if (!match || request.method !== "GET") {
    return null;
  }
  const scene = parse(match[1], match[2]);
  // the app's page itself (asking for this path would redirect "@" to "%40")
  const page = await assets.fetch(new Request(new URL("/", url), { headers: request.headers }));
  if (!scene || !(page.headers.get("Content-Type") || "").includes("text/html")) {
    return page;
  }
  const isPublic = (await publicScene(url.origin, scene.owner, scene.name, ctx)).ok;
  const title = isPublic ? `${scene.name} by @${scene.owner} · Kurviq` : `A shared scene on Kurviq`;
  const description = isPublic
    ? `A drawing by @${scene.owner}, made with Kurviq. Open it in your browser: no sign-up.`
    : `Shared with you on Kurviq. Sign in with GitHub to see it, if you have access to it on GitHub.`;
  const link = scene ? `${url.origin}/@${scene.owner}/${encodeURIComponent(scene.name)}` : url.href;
  const content = (value: string) => ({ element: (el: Element) => el.setAttribute("content", value) });
  const rewritten = new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(title) })
    .on('meta[property="og:title"], meta[name="twitter:title"]', content(title))
    .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', content(description))
    .on('meta[property="og:url"]', content(link))
    .on('link[rel="canonical"]', { element: (el) => el.setAttribute("href", link) })
    .on("head", {
      element: (el) =>
        el.append(
          isPublic
            ? `<link rel="preload" href="${apiPath(scene.owner, scene.name)}" as="fetch" crossorigin="anonymous">`
            : `<meta name="robots" content="noindex">`,
          { html: true },
        ),
    })
    .transform(page);
  const response = new Response(rewritten.body, rewritten);
  response.headers.set("Cache-Control", "no-cache");
  return response;
};
