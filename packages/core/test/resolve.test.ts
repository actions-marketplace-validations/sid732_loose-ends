import { describe, expect, it } from "vitest";
import { Resolver, discoverFiles, loadConfig, resolveExports, splitPackage } from "@loose-ends/core";
import { project } from "./helpers/project.js";

function resolver(files: Record<string, string | object>) {
  const root = project(files);
  const config = loadConfig(root);
  return new Resolver(config, new Set(discoverFiles(config).map((f) => f.path)));
}

describe("Resolver", () => {
  it("resolves relative paths with extensions, indexes, and .js-to-.ts", () => {
    const r = resolver({ "src/a.ts": "", "src/lib/index.tsx": "", "src/util.ts": "", "src/style.css": "" });
    expect(r.resolve("src/a.ts", "./lib")).toEqual({ kind: "file", path: "src/lib/index.tsx" });
    expect(r.resolve("src/a.ts", "./util.js")).toEqual({ kind: "file", path: "src/util.ts" });
    expect(r.resolve("src/lib/index.tsx", "../util")).toEqual({ kind: "file", path: "src/util.ts" });
    expect(r.resolve("src/a.ts", "./style.css")).toEqual({ kind: "asset", path: "src/style.css" });
    expect(r.resolve("src/a.ts", "./missing")).toEqual({ kind: "unresolved", specifier: "./missing" });
  });

  it("classifies builtins and external packages", () => {
    const r = resolver({ "a.ts": "" });
    expect(r.resolve("a.ts", "node:fs")).toEqual({ kind: "external", package: "fs", builtin: true });
    expect(r.resolve("a.ts", "path")).toEqual({ kind: "external", package: "path", builtin: true });
    expect(r.resolve("a.ts", "@scope/pkg/deep")).toEqual({ kind: "external", package: "@scope/pkg", builtin: false });
  });

  it("resolves tsconfig path aliases, including extends", () => {
    const r = resolver({
      "tsconfig.base.json": { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "~config": ["config/index.ts"] } } },
      "tsconfig.json": { extends: "./tsconfig.base.json" },
      "src/components/button.tsx": "",
      "src/app.ts": "",
      "config/index.ts": "",
    });
    expect(r.resolve("src/app.ts", "@/components/button")).toEqual({ kind: "file", path: "src/components/button.tsx" });
    expect(r.resolve("src/app.ts", "~config")).toEqual({ kind: "file", path: "config/index.ts" });
    expect(r.resolve("src/app.ts", "react")).toMatchObject({ kind: "external", package: "react" });
  });

  it("resolves workspace packages to their source", () => {
    const r = resolver({
      "package.json": { name: "root", workspaces: ["packages/*"] },
      "packages/ui/package.json": { name: "@acme/ui", main: "dist/index.js" },
      "packages/ui/src/index.ts": "",
      "packages/utils/package.json": { name: "@acme/utils", exports: { ".": "./dist/index.js", "./fmt": { import: "./dist/fmt.mjs" } } },
      "packages/utils/src/index.ts": "",
      "packages/utils/src/fmt.mts": "",
      "apps/web/main.ts": "",
    });
    expect(r.resolve("apps/web/main.ts", "@acme/ui")).toEqual({ kind: "file", path: "packages/ui/src/index.ts" });
    expect(r.resolve("apps/web/main.ts", "@acme/utils")).toEqual({ kind: "file", path: "packages/utils/src/index.ts" });
    expect(r.resolve("apps/web/main.ts", "@acme/utils/fmt")).toEqual({ kind: "file", path: "packages/utils/src/fmt.mts" });
  });

  it("reads pnpm workspaces", () => {
    const r = resolver({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
      "libs/core/package.json": { name: "core-lib" },
      "libs/core/index.js": "",
      "app.js": "",
    });
    expect(r.resolve("app.js", "core-lib")).toEqual({ kind: "file", path: "libs/core/index.js" });
  });
});

describe("helpers", () => {
  it("splits package specifiers", () => {
    expect(splitPackage("lodash/fp")).toEqual({ name: "lodash", subpath: "fp" });
    expect(splitPackage("@a/b/c/d")).toEqual({ name: "@a/b", subpath: "c/d" });
  });

  it("resolves exports maps with patterns and conditions", () => {
    const exp = { ".": { types: "./x.d.ts", require: "./a.cjs", import: "./a.mjs" }, "./features/*": "./src/features/*.js" };
    expect(resolveExports(exp, ".")).toEqual(["./a.mjs", "./a.cjs"]);
    expect(resolveExports(exp, "./features/chat")).toEqual(["./src/features/chat.js"]);
    expect(resolveExports("./index.js", ".")).toEqual(["./index.js"]);
  });
});
