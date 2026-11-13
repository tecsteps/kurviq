// This browser's own comment settings and marks (the list's filter, unread,
// the scene list's counts) in localStorage: never on a server. Storage can be
// blocked or full (private windows): then they last for the page only.

/** a stored value (parsed), or null */
export const readLocal = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/** store a value (as JSON); nothing happens when storage is blocked or full */
export const writeLocal = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // blocked or full: kept for this page only
  }
};
