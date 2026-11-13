// Runs one of the app's TypeScript modules in node with the dependencies it
// names given by the test (the browser-only editor packages can't be
// resolved by the test runner), as coworkEdits.test.ts does.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("../../excalidraw/node_modules/typescript");

export const runModule = (url: URL, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) => {
  const source = readFileSync(url, "utf8").replaceAll("import.meta.env", "__env");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, any> = {};
  runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => {
      if (!(name in dependencies)) {
        throw new Error(`Unexpected dependency of ${url.pathname}: ${name}`);
      }
      return dependencies[name];
    },
    __env: {},
    console, setTimeout, clearTimeout, queueMicrotask, structuredClone, TextEncoder,
    Map, Set, Date, Math, Error, JSON, Object, Array, Number, String, Symbol, Promise,
    ...globals,
  });
  return exports;
};
