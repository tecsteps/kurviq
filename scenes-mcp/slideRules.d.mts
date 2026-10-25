// types of slideRules.mjs (used by the app's slides.ts)
type El = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; customData?: any };
export declare const slideData: (el: { customData?: any } | null | undefined) => any;
export declare const isSlideFrame: (el: { type: string; isDeleted?: boolean } | null | undefined) => boolean;
export declare const deckOrder: <T extends El>(elements: readonly T[]) => T[];
export declare const canon: (value: unknown) => string;
export declare const CHANGE_NAMES: Record<string, string>;
export declare const anchorX: (el: any) => number;
export declare const tracked: (el: any, slide: { x: number; y: number }) => Record<string, unknown>;
export declare const changedByHand: (el: any, slide: { x: number; y: number }, base: Record<string, unknown>) => Set<string>;
