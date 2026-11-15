// types of tools.mjs (used by the app's WebMCP bridge; the options are documented there)
export declare const createScenesMcp: (options: {
  serverFetch: (pathname: string, init?: RequestInit) => Promise<Response>;
  unreachable: string;
  mode: "detached" | "live";
  appHint: string;
  skill: string;
  reference: string;
  registerUpstream: (server: unknown, store: unknown) => void;
  savePdf?: (name: string, pdf: Uint8Array, file?: string) => Promise<object>;
  livePreview?: boolean;
  name?: string;
  leanReads?: boolean;
  localFiles?: boolean;
  sendFeedback?: ((report: unknown) => Promise<{ id: number } | { error: string }>) | null;
}) => unknown;
