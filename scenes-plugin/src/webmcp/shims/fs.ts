// node:fs/promises for scenes-mcp/media.mjs in the browser (../bridge.ts):
// a page has no files. Images come as data URLs or inline SVG instead.

const missing = (path: string) =>
  Object.assign(
    new Error(
      `"${path}": local files are not available to tools of the Kurviq page. Pass the content inline instead (a data URL or inline "svg" for images, the JSON itself instead of a file).`,
    ),
    { code: "ENOENT" },
  );

export const readFile = (path: string) => Promise.reject(missing(path));

export const realpath = (path: string) => Promise.reject(missing(path));
