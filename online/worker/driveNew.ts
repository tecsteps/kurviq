// Google Drive's "New → More → Kurviq" (specs/2026-11-13-new-scene-from-drive.md):
//
//   GET /drive/new?state={"action":"create","folderId":"…","userId":"…"}
//
// Drive's New URL. The Worker keeps nothing of it: the state goes on to the
// app (/?drive-new=…), which checks the account, asks for the scene's name
// and creates it in that folder with the user's own Drive access. Only
// answered with DRIVE_NEW = "on" (wrangler.jsonc vars), once the Drive UI
// integration's "Creating files" is set up in the Google Cloud console.

import { driveNewAppPath, parseDriveNewState } from "../../scenes-plugin/src/online/driveNewState";

export type DriveNewEnv = {
  /** "on": /drive/new answers; anything else: it says it isn't enabled */
  DRIVE_NEW?: string;
};

export const DRIVE_NEW_PATH = "/drive/new";

const page = (status: number, title: string, text: string) =>
  new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; }
  a { color: #2563eb; }
</style></head>
<body><main>
<h1>${title}</h1>
<p>${text}</p>
<p><a href="/">Open Kurviq</a></p>
</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    },
  );

/** Drive's New URL: to the app with the state, or a page saying why not */
export const handleDriveNew = (url: URL, env: DriveNewEnv): Response => {
  if (env.DRIVE_NEW !== "on") {
    return page(
      404,
      "Not enabled yet",
      "Creating Kurviq scenes from Google Drive's New menu isn't enabled yet. Open Kurviq and create the scene there.",
    );
  }
  const request = parseDriveNewState(url.searchParams.get("state"));
  if (!request) {
    return page(400, "This link doesn't work", "Google Drive's request to create a Kurviq scene is not complete. Try New → More → Kurviq again.");
  }
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(driveNewAppPath(request), url).toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
};
