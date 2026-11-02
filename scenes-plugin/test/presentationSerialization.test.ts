import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as migration from "../../scenes-mcp/presentation.mjs";

// Exercise the production serializer with upstream's filtering behavior.
const source = readFileSync(new URL("../src/presentation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} as Record<string, any> };
const upstream = (elements: any[], app: any, files: any) => JSON.stringify({
  elements, files, appState: { viewBackgroundColor: app.viewBackgroundColor },
});
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "@excalidraw/excalidraw") return { serializeAsJSON: upstream };
  if (name === "../../scenes-mcp/presentation.mjs") return migration;
  throw new Error(`Unexpected serializer dependency: ${name}`);
}, loaded, loaded.exports);

describe("scene serialization", () => {
  it.each([false, true])("keeps explicit %s through upstream filtering", (flag) => {
    const app = { viewBackgroundColor: "#ffffff", kurviqPresentation: flag, kurviqPresentationAt: 42 };
    const json = loaded.exports.serializeAsJSON([], app, {}, "local");
    expect(JSON.parse(json).appState).toEqual(app);
  });
});
