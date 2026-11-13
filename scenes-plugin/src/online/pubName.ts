// Short links: kurviq.com/pub/<name> for a scene's Google Drive file, in
// addition to its long link /s/<fileId>/<name> (which keeps working). Names
// are global (first come, first served), one per file. The rules here are
// shared by the app (the dialog) and the Worker (online/worker/pubLinks.ts).

export const PUB_MIN = 3;
export const PUB_MAX = 40;

/** taken by Kurviq: its pages and words that would make a link look official */
const RESERVED = new Set([
  "about", "account", "admin", "api", "app", "auth", "billing", "blog", "contact", "docs", "drive", "edit", "features",
  "google", "help", "home", "imprint", "index", "kurviq", "legal", "login", "logout", "mail", "new", "oauth", "official",
  "privacy", "pub", "s", "security", "settings", "signin", "signup", "status", "support", "terms", "www",
]);

/** what is wrong with a short name, or null */
export const pubNameProblem = (name: string): string | null => {
  if (name.length < PUB_MIN) {
    return `At least ${PUB_MIN} characters`;
  }
  if (name.length > PUB_MAX) {
    return `At most ${PUB_MAX} characters`;
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return "Only lowercase letters a to z, digits and hyphens";
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "Hyphens only between letters or digits, one at a time";
  }
  if (RESERVED.has(name) || name.startsWith("kurviq")) {
    return "This name is reserved";
  }
  return null;
};

/** letters that don't fall apart into a base letter and a mark */
const FOLDED: Record<string, string> = { ß: "ss", ø: "o", æ: "ae", œ: "oe", ł: "l", đ: "d", þ: "th" };

/**
 * A text as lowercase letters a to z, digits and single hyphens, at most
 * `max` characters: "Öredev 2026!" → "oredev-2026". While typing, a hyphen at
 * the end stays (the next word starts there). Scene links, short names and
 * the short-name field use it.
 */
export const slugify = (text: string, max: number, { keepTrailingHyphen = false } = {}) => {
  const slug = text
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[ßøæœłđþ]/g, (letter) => FOLDED[letter])
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max);
  return keepTrailingHyphen ? slug : slug.replace(/-+$/, ""); // NOSONAR S8786: input is bounded to `max` characters by the preceding slice
};

/** a scene name as a short name: "Öredev 2026!" → "oredev-2026" */
export const toPubName = (text: string) => slugify(text, PUB_MAX);

/** /pub/<name> (any case; the name is lowercased) */
export const pubNameFromPath = (pathname: string) => {
  const match = /^\/pub\/([A-Za-z0-9-]{1,60})\/?$/.exec(pathname);
  return match ? match[1].toLowerCase() : null;
};
