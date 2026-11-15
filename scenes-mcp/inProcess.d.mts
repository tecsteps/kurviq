// types of inProcess.mjs (used by the app's WebMCP bridge)
export declare const passThroughValidator: {
  getValidator: () => (input: unknown) => { valid: true; data: unknown; errorMessage: undefined };
};
export declare const connectInProcess: (server: unknown, name?: string) => Promise<{
  listTools(): Promise<{ tools: Array<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }> }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ content?: Array<Record<string, any>>; isError?: boolean }>;
  close(): Promise<void>;
}>;
