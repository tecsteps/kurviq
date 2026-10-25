// /api/fonts/google?family=Geist: a font from Google Fonts for Kurviq's
// "Add font", fetched here so visitors' browsers never talk to Google (and
// the page's CSP stays strict). Nothing is stored: Cloudflare's cache keeps
// the answer for a day.

import { FAMILY_RE, googleFaces } from "../../scenes-mcp/googleFonts.mjs";

const json = (status: number, body: unknown, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });

export const handleFonts = async (request: Request, ctx: ExecutionContext): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/fonts/google") {
    return null;
  }
  const family = (url.searchParams.get("family") || "").trim();
  if (request.method !== "GET" || !FAMILY_RE.test(family)) {
    return json(400, { error: "Name: letters, digits, spaces, . _ - (up to 60)" });
  }
  const key = new Request(`${url.origin}/api/fonts/google?family=${encodeURIComponent(family.toLowerCase())}`);
  const hit = await caches.default.match(key);
  if (hit) {
    return hit;
  }
  let response: Response;
  try {
    const faces = await googleFaces(family);
    response = faces
      ? json(200, { family, faces }, "public, max-age=86400")
      : json(404, { error: `"${family}" is not on Google Fonts (check the spelling on fonts.google.com)` }, "public, max-age=600");
  } catch (error: any) {
    return json(502, { error: error.message || "Google Fonts not reachable" });
  }
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
};
