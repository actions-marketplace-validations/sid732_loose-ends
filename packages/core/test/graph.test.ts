import { describe, expect, it } from "vitest";
import { buildGraph, dependencyId, fileId, loadConfig, symbolId } from "@loose-ends/core";
import { project } from "./helpers/project.js";

function graphOf(files: Record<string, string | object>) {
  return buildGraph(loadConfig(project(files))).graph;
}

const targets = (g: ReturnType<typeof graphOf>, id: string) => g.out(id).map((e) => `${e.kind} ${e.to}`).sort();

describe("buildGraph", () => {
  it("links module imports, symbol references, and containment", () => {
    const g = graphOf({
      "src/main.ts": `import { greet } from "./greet";\nconsole.log(greet("x"));`,
      "src/greet.ts": `import { upper } from "./util";\nexport function greet(n: string) { return upper(n); }\nexport function wave() {}`,
      "src/util.ts": `export const upper = (s: string) => s.toUpperCase();`,
    });
    expect(targets(g, fileId("src/main.ts"))).toEqual([
      `import ${fileId("src/greet.ts")}`,
      `reference ${symbolId("src/greet.ts", "greet")}`,
    ]);
    expect(targets(g, symbolId("src/greet.ts", "greet"))).toEqual([
      `contains ${fileId("src/greet.ts")}`,
      `reference ${symbolId("src/util.ts", "upper")}`,
    ]);
    expect(g.in(symbolId("src/greet.ts", "wave")).filter((e) => e.kind !== "contains")).toEqual([]);
  });

  it("follows re-exports and export-star barrels to the original symbol", () => {
    const g = graphOf({
      "src/app.ts": `import { Button, Card } from "./ui";\nrender(Button, Card);`,
      "src/ui/index.ts": `export { Button } from "./button";\nexport * from "./card";`,
      "src/ui/button.ts": `export const Button = 1;`,
      "src/ui/card.ts": `export const Card = 2;\nexport const Unused = 3;`,
    });
    expect(targets(g, fileId("src/app.ts"))).toContain(`reference ${symbolId("src/ui/index.ts", "Button")}`);
    expect(targets(g, symbolId("src/ui/index.ts", "Button"))).toContain(`reexport ${symbolId("src/ui/button.ts", "Button")}`);
    expect(targets(g, fileId("src/app.ts"))).toContain(`reference ${symbolId("src/ui/card.ts", "Card")}`);
    expect(g.in(symbolId("src/ui/card.ts", "Unused")).filter((e) => e.kind !== "contains")).toEqual([]);
  });

  it("records dependencies, builtins, and unresolved imports", () => {
    const g = graphOf({
      "index.js": `const express = require("express");\nconst fs = require("node:fs");\nimport("./missing");\nexpress();`,
    });
    expect(targets(g, fileId("index.js"))).toEqual(
      expect.arrayContaining([`dependency ${dependencyId("express")}`, `dependency ${dependencyId("fs")}`]),
    );
    expect(g.unresolved).toEqual([{ file: "index.js", specifier: "./missing", line: 3 }]);
  });

  it("links deferred dynamic imports from their owning declaration", () => {
    const g = graphOf({
      "a.ts": `export async function load() { const m = await import("./b"); return m.run(); }`,
      "b.ts": `export function run() {}`,
    });
    expect(targets(g, fileId("a.ts"))).toEqual([]);
    expect(targets(g, symbolId("a.ts", "load"))).toEqual(
      expect.arrayContaining([`dynamic ${fileId("b.ts")}`, `dynamic ${symbolId("b.ts", "run")}`]),
    );
  });

  it("marks template-literal imports as pattern edges", () => {
    const g = graphOf({
      "i18n.ts": "export const load = (l: string) => import(`./locales/${l}.ts`);",
      "locales/en.ts": "export default {};",
      "locales/fr.ts": "export default {};",
    });
    expect(targets(g, symbolId("i18n.ts", "load"))).toEqual([
      `contains ${fileId("i18n.ts")}`,
      `pattern ${fileId("locales/en.ts")}`,
      `pattern ${fileId("locales/fr.ts")}`,
    ]);
  });

  it("does not load modules for type-only imports", () => {
    const g = graphOf({
      "a.ts": `import type { T } from "./t";\nexport const x: T = 1;`,
      "t.ts": `export type T = number;`,
    });
    expect(targets(g, fileId("a.ts"))).toEqual([]);
    expect(targets(g, symbolId("a.ts", "x"))).toContain(`reference ${symbolId("t.ts", "T")}`);
  });
});
