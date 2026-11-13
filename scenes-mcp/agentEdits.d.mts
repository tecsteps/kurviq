// types of agentEdits.mjs (used by the app's agent commands)
export declare const PSEUDO_TYPES: Set<string>;
export declare const isPlainObject: (value: unknown) => value is Record<string, any>;
export declare const REQUEST_ID: RegExp;
export declare const changesScene: (edit: unknown) => boolean;
export declare const commentsOnly: (edit: unknown) => boolean;
export declare const isEmptyEdit: (edit: unknown) => boolean;
