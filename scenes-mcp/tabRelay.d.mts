// types of tabRelay.mjs (used by the Worker's pairing object)
export type TabRank = { visible?: boolean; focusedAt?: number; connectedAt?: number };
export declare const COMMAND_TIMEOUT_MS: number;
export declare const SLOW_COMMANDS: Set<string>;
export declare const SLOW_TIMEOUT_MS: number;
export declare const FLUSH_TIMEOUT_MS: number;
export declare const commandTimeout: (type: unknown) => number;
export declare const tabOrder: (a: TabRank, b: TabRank) => number;
export declare const bestTab: <T>(tabs: Iterable<T>, rankOf: (tab: T) => TabRank) => T | null;
