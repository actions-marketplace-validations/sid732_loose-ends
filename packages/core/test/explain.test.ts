import { describe, expect, it } from "vitest";
import { analyze, explain, loadConfig } from "@loose-ends/core";
import { project } from "./helpers/project.js";

const files = {
  "package.json": { name: "app", main: "src/index.ts", dependencies: { zod: "1" } },
  "src/index.ts": `import { run } from "./run";\nrun();`,
  "src/run.ts": `import { z } from "zod";\nexport function run() { return z; }\nexport function spare() {}`,
  "src/dead/entry.ts": `import { helper } from "./helper";\nexport const go = () => helper();`,
  "src/dead/helper.ts": `export function helper() {}`,
};

describe("explain", () => {
  const analysis = () => analyze(loadConfig(project(files)));

  it("explains live code with a path from its root", () => {
    const e = explain(analysis(), "src/run.ts#run")!;
    expect(e.liveness).toBe("live");
    expect(e.root?.source).toBe("package.json#exports");
    expect(e.path.map((s) => s.node)).toEqual(["src/index.ts", "src/run.ts#run"]);
    expect(e.referencedBy).toEqual([{ from: "src/index.ts", edge: "reference", line: 1, liveness: "live" }]);
  });

  it("lists file exports with their liveness", () => {
    const e = explain(analysis(), "src/run.ts")!;
    expect(e.exports).toEqual([
      { name: "run", symbol: "src/run.ts#run", liveness: "live" },
      { name: "spare", symbol: "src/run.ts#spare", liveness: "orphaned" },
    ]);
  });

  it("finds the top of an unreachable subgraph", () => {
    const e = explain(analysis(), "src/dead/helper.ts#helper")!;
    expect(e.liveness).toBe("orphaned");
    expect(e.orphanSources).toEqual(["src/dead/entry.ts"]);
    expect(e.suggestions.join(" ")).toMatch(/starts at: src\/dead\/entry\.ts/);
  });

  it("explains dependencies and unknown targets", () => {
    expect(explain(analysis(), "zod")?.liveness).toBe("live");
    expect(explain(analysis(), "src/nope.ts")).toBeUndefined();
  });
});
