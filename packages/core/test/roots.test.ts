import { describe, expect, it } from "vitest";
import { buildGraph, discoverRoots, fileId, loadConfig, scriptTargets, symbolId } from "@loose-ends/core";
import { project } from "./helpers/project.js";

function rootsOf(files: Record<string, string | object>) {
  const config = loadConfig(project(files));
  const build = buildGraph(config);
  return discoverRoots(config, build);
}

describe("discoverRoots", () => {
  it("uses main, exports, and bin with public exports", () => {
    const roots = rootsOf({
      "package.json": { name: "lib", main: "dist/index.js", bin: { lib: "bin/cli.js" } },
      "src/index.ts": "export const api = 1;\nconst internal = 2;",
      "bin/cli.js": "#!/usr/bin/env node\nrequire('../dist/index.js');",
    });
    const nodes = roots.map((r) => r.node);
    expect(nodes).toContain(fileId("src/index.ts"));
    expect(nodes).toContain(symbolId("src/index.ts", "api"));
    expect(nodes).not.toContain(symbolId("src/index.ts", "internal"));
    expect(roots.find((r) => r.node === fileId("bin/cli.js"))?.source).toBe("package.json#bin");
  });

  it("classifies script entries", () => {
    const roots = rootsOf({
      "package.json": { name: "app", scripts: { start: "node server.js", seed: "tsx scripts/seed.ts", "test:smoke": "node smoke/run.js" } },
      "server.js": "",
      "scripts/seed.ts": "",
      "smoke/run.js": "",
    });
    const kind = (p: string) => roots.find((r) => r.node === fileId(p))?.kind;
    expect(kind("server.js")).toBe("production");
    expect(kind("scripts/seed.ts")).toBe("tooling");
    expect(kind("smoke/run.js")).toBe("test");
  });

  it("falls back to conventional entries", () => {
    const roots = rootsOf({ "package.json": { name: "app" }, "src/index.ts": "", "src/other.ts": "" });
    expect(roots.map((r) => r.node)).toEqual([fileId("src/index.ts")]);
  });

  it("adds config entries and test files", () => {
    const roots = rootsOf({
      "package.json": { name: "app", main: "index.js" },
      "loose-ends.config.json": { entries: ["jobs/*.ts", "hooks.ts#onEvent"] },
      "index.js": "",
      "jobs/nightly.ts": "export function run() {}",
      "hooks.ts": "export function onEvent() {}\nexport function other() {}",
      "src/a.test.ts": "",
    });
    const nodes = roots.map((r) => r.node);
    expect(nodes).toEqual(expect.arrayContaining([fileId("jobs/nightly.ts"), symbolId("jobs/nightly.ts", "run"), symbolId("hooks.ts", "onEvent")]));
    expect(nodes).not.toContain(symbolId("hooks.ts", "other"));
    expect(roots.find((r) => r.node === fileId("src/a.test.ts"))?.kind).toBe("test");
  });
});

describe("scriptTargets", () => {
  it("pulls file arguments out of commands", () => {
    expect(scriptTargets("tsx watch src/server.ts")).toEqual(["src/server.ts"]);
    expect(scriptTargets("NODE_ENV=prod node --enable-source-maps dist/main.js && node ./scripts/post.mjs")).toEqual([
      "dist/main.js",
      "scripts/post.mjs",
    ]);
    expect(scriptTargets("vitest run 'src/**/*.test.ts'")).toEqual([]);
    expect(scriptTargets("node scripts/build")).toEqual(["scripts/build"]);
  });
});
