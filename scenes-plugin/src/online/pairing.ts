// Kurviq: the agent pairing of this browser. A random key, made here and
// kept in localStorage, ties agents to this browser's open Kurviq tabs.
// Agents add https://kurviq.com/mcp and sign in: the user allows each one on
// Kurviq's approval page, which reads this key (see online/worker/oauth.ts).
// A new key ("Sign out all agents") cuts every agent off. The old way, the key
// in the agent's URL (https://kurviq.com/mcp/<key>), is refused.

const KEY = "kurviq-agent-key";
const listeners = new Set<() => void>();

const makeKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").split("=")[0]; // NOSONAR S7758: base64 encoding uses binary bytes, not Unicode code points
};

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

let key: string | null = read();

const write = (value: string | null) => {
  key = value;
  try {
    if (value) {
      localStorage.setItem(KEY, value);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {}
  listeners.forEach((listener) => listener());
};

// another tab made or replaced the key
window.addEventListener("storage", (event) => {
  if (event.key === KEY) {
    key = read();
    listeners.forEach((listener) => listener());
  }
});

export const pairing = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getKey: () => key,
  /** the key, made on first use */
  ensureKey: () => {
    if (!key) {
      write(makeKey());
    }
    return key!;
  },
  /** a new link: agents with the old one lose access */
  reset: () => write(makeKey()),
  /** agents off: no key, tabs disconnect */
  remove: () => write(null),
  /** what agents add: they sign in there */
  mcpUrl: () => `${window.location.origin}/mcp`,
  liveUrl: (tab: string) =>
    key ? `${window.location.origin.replace(/^http/, "ws")}/live/${key}?tab=${encodeURIComponent(tab)}` : null,
};
