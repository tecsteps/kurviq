// types of googleFonts.mjs (used by the app and the Worker)
export declare const FAMILY_RE: RegExp;
export declare const MAX_FONT_BYTES: number;
export declare const toDataUrl: (bytes: ArrayBuffer, mime: string) => string;
export declare const googleFaces: (family: string) => Promise<Array<{ data: string; range?: string }> | null>;
