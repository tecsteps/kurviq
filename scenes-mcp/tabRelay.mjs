// The rules both relays between agents and the user's Kurviq tabs share: the
// local scenes server (scenes-server/server.mjs) and kurviq.com's pairing
// object (online/worker/pairing.ts). Which tab an agent talks to, and how long
// a tab may take to answer a command, are the same on both hosts.

/** how long a tab may take to answer a command (ms) */
export const COMMAND_TIMEOUT_MS = 30_000;
/** edits (saves with pictures) and pictures may take longer */
export const SLOW_COMMANDS = new Set(["scene-edit", "local-edit", "render", "deck-check", "convert", "upload", "upload-payload", "http"]);
export const SLOW_TIMEOUT_MS = 75_000;
/** a tab pushing its unpushed changes before an agent reads or edits a scene */
export const FLUSH_TIMEOUT_MS = 15_000;

/** the time a command of this type may take */
export const commandTimeout = (type) => (SLOW_COMMANDS.has(String(type ?? "")) ? SLOW_TIMEOUT_MS : COMMAND_TIMEOUT_MS);

/**
 * > 0 when tab `a` ranks before tab `b` for agents: visible first, then the
 * most recently focused, then the most recently connected
 */
export const tabOrder = (a, b) =>
  (a.visible ? 1 : 0) - (b.visible ? 1 : 0) || (a.focusedAt || 0) - (b.focusedAt || 0) || (a.connectedAt || 0) - (b.connectedAt || 0);

/** the tab of `tabs` agents talk to (`rankOf` gives its { visible, focusedAt, connectedAt }); null without tabs */
export const bestTab = (tabs, rankOf) => {
  let best = null;
  let bestRank = null;
  for (const tab of tabs) {
    const rank = rankOf(tab);
    if (best === null || tabOrder(rank, bestRank) > 0) {
      best = tab;
      bestRank = rank;
    }
  }
  return best;
};
