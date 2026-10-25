// types of elementContent.mjs (used by the app's merge)
type Stamped = { version: number; versionNonce: number; [key: string]: any };
export declare const sameContent: (a: Stamped | undefined, b: Stamped | undefined) => boolean;
export declare const changedFields: (a: Stamped, b: Stamped) => string[];
