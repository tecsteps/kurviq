// Small constants the editor (editor.ts) and its toolbar (toolbar.ts) share.

/** Apple keyboards: ⌘ instead of Ctrl */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** the font sizes ⌘⇧. / ⌘⇧, step through, and the toolbar offers (from 10) */
export const SIZE_STEPS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96];
