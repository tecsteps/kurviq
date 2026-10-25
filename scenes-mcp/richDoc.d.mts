// types of richDoc.mjs (used by the app's rich text model)
/** formatting of a piece of text */
export type Marks = {
  /** bold */
  b?: true;
  /** italic */
  i?: true;
  /** underline */
  u?: true;
  /** strikethrough */
  s?: true;
  /** text color */
  c?: string;
  /** highlight (background) color */
  h?: string;
  /** link */
  a?: string;
  /** size, relative to the element's font size */
  z?: number;
};

export type Run = Marks & {
  t: string;
};

export type ParaKind = "ul" | "ol" | "todo";

export type Para = {
  /** list item kind (none: a plain paragraph) */
  k?: ParaKind;
  /** list nesting level, 0 = top */
  d?: number;
  /** a checked checklist item */
  x?: true;
  r: Run[];
};

export type RichDoc = {
  v: 1;
  p: Para[];
};

export declare const MARK_KEYS: readonly ["b", "i", "u", "s", "c", "h", "a", "z"];

export type MarkKey = typeof MARK_KEYS[number];

export declare const MAX_DEPTH = 4;

/** the marker each paragraph shows in front of it ("" for none) */
export declare const markersOf: (doc: RichDoc) => string[];

export declare const paraText: (para: Para) => string;

/** the plain text: the element's `originalText` */
export declare const plainOf: (doc: RichDoc) => string;

export declare const sameMarks: (a: Marks, b: Marks) => boolean;

export declare const marksOf: (run: Marks) => Marks;

/** links only to the web and to mail (no javascript:, data: …) */
export declare const safeLink: (value: unknown) => string | null;

/** merges neighbors with the same formatting, drops empty pieces */
export declare const normalizeDoc: (doc: RichDoc) => RichDoc;

export declare const docFromPlain: (text: string) => RichDoc;

/** true if the doc has no formatting at all (plain text would do) */
export declare const isPlainDoc: (doc: RichDoc) => boolean;

/**
 * The formatting of a text element, if it still applies to its text
 * (`originalText`, or the one given).
 */
export declare const richDocOf: (
  element:
    | {
        type?: string;
        customData?: Record<string, any> | null;
        originalText?: string;
      }
    | null
    | undefined,
  originalText?: string,
) => RichDoc | null;

/** a doc as the markdown-like text docFromMarkdown reads */
export declare const markdownOf: (doc: RichDoc) => string;
