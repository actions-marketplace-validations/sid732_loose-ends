import { describe, expect, it } from "vitest";
import { MODULE_BODY, parseModule } from "@loose-ends/core";

const decl = (info: ReturnType<typeof parseModule>, name: string) => info.declarations.find((d) => d.name === name);

describe("parseModule imports", () => {
  it("records static, namespace, default, and side-effect imports", () => {
    const info = parseModule(
      "a.ts",
      `import React from "react";
import * as fs from "node:fs";
import { a, b as c } from "./lib";
import type { T } from "./types";
import "./polyfill";`,
    );
    expect(info.imports.map((i) => [i.kind, i.specifier, i.typeOnly])).toEqual([
      ["static", "react", false],
      ["static", "node:fs", false],
      ["static", "./lib", false],
      ["static", "./types", true],
      ["side-effect", "./polyfill", false],
    ]);
    expect(info.imports[2]?.bindings).toEqual([
      { local: "a", imported: "a" },
      { local: "c", imported: "b" },
    ]);
    expect(info.imports[1]?.bindings).toEqual([{ local: "fs", imported: "*" }]);
  });

  it("records re-exports", () => {
    const info = parseModule("a.ts", `export * from "./x";\nexport { y as z } from "./y";\nexport * as ns from "./n";`);
    expect(info.imports.map((i) => i.kind)).toEqual(["reexport-all", "reexport", "reexport"]);
    expect(info.imports[1]?.bindings).toEqual([{ local: "z", imported: "y" }]);
    expect(info.imports[2]?.bindings).toEqual([{ local: "ns", imported: "*" }]);
  });

  it("records require and dynamic import with owners and load timing", () => {
    const info = parseModule(
      "a.js",
      `const express = require("express");
const { join } = require("path");
function lazy() { return import("./heavy"); }
const plugin = require("./plugin").default;
async function locale(l) { return import(\`./locales/\${l}.json\`); }
load(require(name));`,
    );
    const byspec = Object.fromEntries(info.imports.map((i) => [i.specifier || i.pattern || "?", i]));
    expect(byspec["express"]?.bindings).toEqual([{ local: "express", imported: "*" }]);
    expect(byspec["path"]?.bindings).toEqual([{ local: "join", imported: "join" }]);
    expect(byspec["./heavy"]).toMatchObject({ kind: "dynamic", owner: "lazy", atLoad: false });
    expect(byspec["./plugin"]).toMatchObject({ kind: "require", owner: MODULE_BODY, atLoad: true });
    expect(byspec["./locales/*.json"]).toMatchObject({ kind: "dynamic", owner: "locale" });
    expect(info.hasUnresolvableDynamic).toBe(true);
  });
});

describe("parseModule declarations", () => {
  it("captures declarations, exports, and references", () => {
    const info = parseModule(
      "a.ts",
      `import { helper } from "./helper";
const LIMIT = 3;
export function run(input: Input) { return helper(input).slice(0, LIMIT); }
function unused() { return 1; }
interface Input { value: string }
export default class Service { go() { return run({ value: "x" }); } }
export const a = 1, b = a + 1;`,
    );
    expect(decl(info, "run")).toMatchObject({ kind: "function", exportedAs: ["run"] });
    expect(decl(info, "run")?.references).toEqual(expect.arrayContaining(["helper", "LIMIT", "Input"]));
    expect(decl(info, "unused")?.exportedAs).toEqual([]);
    expect(decl(info, "Service")).toMatchObject({ kind: "class", exportedAs: ["default"] });
    expect(decl(info, "Service")?.references).toContain("run");
    expect(decl(info, "Service")?.references).not.toContain("go");
    expect(decl(info, "b")?.references).toEqual(["a"]);
    expect(decl(info, "b")?.statementSize).toBe(2);
  });

  it("handles separate export lists and default identifiers", () => {
    const info = parseModule("a.ts", `function a() {}\nfunction b() {}\nexport { a as alpha };\nexport default b;`);
    expect(decl(info, "a")?.exportedAs).toEqual(["alpha"]);
    expect(info.localExports).toContainEqual({ exported: "default", local: "b" });
  });

  it("treats top-level statements as body references", () => {
    const info = parseModule("server.js", `const app = express();\napp.use(router);\nmodule.exports = { app };`);
    expect(info.bodyReferences).toEqual(expect.arrayContaining(["app", "router"]));
    expect(info.bodyReferences).not.toContain("use");
    expect(info.commonjs).toBe(true);
  });

  it("tracks JSX component references", () => {
    const info = parseModule("page.tsx", `import { Button } from "./button";\nexport default function Page() { return <main><Button onClick={go} /></main>; }`);
    expect(decl(info, "default")?.references ?? decl(info, "Page")?.references).toEqual(expect.arrayContaining(["Button", "go"]));
    expect(decl(info, "Page")?.references).not.toContain("onClick");
  });

  it("skips overload signatures", () => {
    const info = parseModule("a.ts", `export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any) { return a; }`);
    expect(info.declarations.filter((d) => d.name === "f")).toHaveLength(1);
  });
});
