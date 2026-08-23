import { describe, expect, it } from "vitest";
import { analyze, dependencyId, fileId, label, loadConfig, pathTo, stateOf, summarize, symbolId } from "@loose-ends/core";
import { project } from "./helpers/project.js";

function run(files: Record<string, string | object>) {
  return analyze(loadConfig(project(files)));
}

const liveness = (a: ReturnType<typeof run>, id: string) => stateOf(a, id).liveness;

describe("analyze", () => {
  const app = {
    "package.json": { name: "app", main: "src/index.ts", dependencies: { express: "4.0.0", lodash: "4.0.0" } },
    "src/index.ts": `import express from "express";\nimport { router } from "./routes";\nconst app = express();\napp.use(router);\napp.listen(3000);`,
    "src/routes.ts": `import { list } from "./users";\nexport const router = { get: list };\nexport function legacyRoute() {}`,
    "src/users.ts": `export function list() { return format([]); }\nfunction format(x: unknown[]) { return x; }\nexport function remove() {}`,
    "src/old-users.ts": `export function list() { return []; }`,
    "src/fixtures-only.ts": `export const sample = [1, 2];`,
    "src/users.test.ts": `import { remove } from "./users";\nimport { sample } from "./fixtures-only";\nremove(); sample;`,
  };

  it("classifies files and symbols", () => {
    const a = run(app);
    expect(liveness(a, fileId("src/index.ts"))).toBe("live");
    expect(liveness(a, fileId("src/users.ts"))).toBe("live");
    expect(liveness(a, symbolId("src/users.ts", "list"))).toBe("live");
    expect(liveness(a, symbolId("src/users.ts", "format"))).toBe("live");
    expect(liveness(a, symbolId("src/routes.ts", "legacyRoute"))).toBe("orphaned");
    expect(liveness(a, symbolId("src/users.ts", "remove"))).toBe("test-only");
    expect(liveness(a, fileId("src/fixtures-only.ts"))).toBe("test-only");
    expect(liveness(a, fileId("src/old-users.ts"))).toBe("orphaned");
    expect(liveness(a, dependencyId("express"))).toBe("live");
  });

  it("explains how a node is reached", () => {
    const a = run(app);
    const path = pathTo(a, symbolId("src/users.ts", "format"));
    expect(path.map((e) => label(a.graph.nodes.get(e.to)))).toEqual(["src/routes.ts#router", "src/users.ts#list", "src/users.ts#format"]);
    expect(stateOf(a, fileId("src/index.ts")).root?.source).toBe("package.json#exports");
  });

  it("summarizes production nodes", () => {
    const s = summarize(run(app));
    expect(s.files).toMatchObject({ live: 3, orphaned: 1, "test-only": 1 });
  });

  it("marks pattern-imported and computed-import targets as uncertain", () => {
    const a = run({
      "package.json": { name: "app", main: "main.ts" },
      "main.ts": "import { load } from './i18n';\nload('en');\nimport { plugin } from './plugins';\nplugin('x');",
      "i18n.ts": "export const load = (l: string) => import(`./locales/${l}.ts`);",
      "locales/en.ts": "export default {};",
      "plugins/index.ts": "export function plugin(name: string) { return import(name); }",
      "plugins/extra.ts": "export const x = 1;",
    });
    expect(liveness(a, fileId("locales/en.ts"))).toBe("uncertain");
    expect(stateOf(a, fileId("locales/en.ts")).note).toMatch(/dynamic import pattern/);
    expect(liveness(a, fileId("plugins/extra.ts"))).toBe("uncertain");
    expect(liveness(a, symbolId("plugins/extra.ts", "x"))).toBe("uncertain");
  });
});
