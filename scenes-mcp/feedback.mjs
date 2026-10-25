// Bug reports and change requests (kurviq.com only): what is accepted. The
// Worker checks every report with this (the app's form and the agent tool
// check the same, to say so before sending): plain text only, no code or
// markup, no hidden characters, limited length.

export const FEEDBACK_KINDS = ["bug", "change"];
export const TITLE_MAX = 120;
export const TEXT_MAX = 2000;
const TITLE_MIN = 3;
const TEXT_MIN = 10;

// invisible / direction-changing characters (zero-width, bidi overrides,
// word joiners, byte order mark ...) and control characters except newline,
// as code point ranges (no such characters in this file itself)
const HIDDEN_RANGES = [
  [0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff0, 0xfffb], [0xe0000, 0xe0fff],
];
const hex = (code) => code.toString(16).padStart(4, "0");
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => `\\u{${hex(a)}}-\\u{${hex(b)}}`).join("")}]`, "gu");

// code and markup: HTML / XML tags, code fences and backticks, template and
// script syntax, data / javascript URLs (stored with bound parameters: SQL needs no filter)
const CODE = [
  /<\s*\/?\s*[a-z!?][^>]*>/i,
  /`/,
  /\$\{|\{\{|\}\}|<\?|\?>|<%|%>/,
  /\b(?:javascript|vbscript|data)\s*:/i,
  /\bon[a-z]+\s*=\s*["']/i,
];

/** text as plain text: hidden characters out, spaces tidied */
const plain = (value, { multiline }) => {
  let text = String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(HIDDEN, "");
  text = multiline ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  return text.trim();
};

/**
 * A report as it may be stored, or why not:
 * { ok: true, value: { kind, title, text, scene } } | { ok: false, error }
 */
export const cleanFeedback = ({ kind, title, text, scene } = {}) => {
  if (!FEEDBACK_KINDS.includes(kind)) {
    return { ok: false, error: 'kind must be "bug" or "change"' };
  }
  const cleanTitle = plain(title, { multiline: false });
  const cleanText = plain(text, { multiline: true });
  if (cleanTitle.length < TITLE_MIN || cleanTitle.length > TITLE_MAX) {
    return { ok: false, error: `The title needs ${TITLE_MIN} to ${TITLE_MAX} characters` };
  }
  if (cleanText.length < TEXT_MIN || cleanText.length > TEXT_MAX) {
    return { ok: false, error: `The description needs ${TEXT_MIN} to ${TEXT_MAX} characters` };
  }
  if (CODE.some((pattern) => pattern.test(cleanTitle) || pattern.test(cleanText))) {
    return { ok: false, error: "Plain text only, please: no code, markup or scripts" };
  }
  const cleanScene = scene == null ? null : plain(scene, { multiline: false }).slice(0, 100) || null;
  return { ok: true, value: { kind, title: cleanTitle, text: cleanText, scene: cleanScene } };
};
