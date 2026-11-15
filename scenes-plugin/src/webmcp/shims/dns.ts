// node:dns/promises for scenes-mcp/media.mjs in the browser (../bridge.ts):
// a page can't look names up (nor reach a private address by name: the
// page's own Content-Security-Policy decides what it may fetch).

export const lookup = () => Promise.resolve([]);
