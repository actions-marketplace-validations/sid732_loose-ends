import { describe, expect, it } from "vitest";
import { discoverFiles, loadConfig, parseTarget, targetMatches } from "@loose-ends/core";
import { project } from "./helpers/project.js";

describe("discoverFiles", () => {
  it("finds sources, skips excluded and gitignored files, flags tests", () => {
    const root = project({
      ".gitignore": "generated/\n",
      "src/index.ts": "",
      "src/view.tsx": "",
      "src/index.test.ts": "",
      "src/types.d.ts": "",
      "generated/client.ts": "",
      "node_modules/pkg/index.js": "",
      "dist/index.js": "",
      "README.md": "",
    });
    const files = discoverFiles(loadConfig(root));
    expect(files.map((f) => f.path)).toEqual(["src/index.test.ts", "src/index.ts", "src/view.tsx"]);
    expect(files.find((f) => f.path === "src/index.test.ts")?.isTest).toBe(true);
    expect(files.find((f) => f.path === "src/index.ts")?.isTest).toBe(false);
  });
});

describe("targets", () => {
  it("parses file and symbol targets", () => {
    expect(parseTarget("src/a.ts")).toEqual({ file: "src/a.ts" });
    expect(parseTarget("src/a.ts#run")).toEqual({ file: "src/a.ts", symbol: "run" });
  });

  it("matches globs and symbols", () => {
    expect(targetMatches("src/legacy/**", "src/legacy/old.ts")).toBe(true);
    expect(targetMatches("src/legacy/**", "src/legacy/old.ts", "x")).toBe(true);
    expect(targetMatches("src/a.ts#run", "src/a.ts", "run")).toBe(true);
    expect(targetMatches("src/a.ts#run", "src/a.ts", "stop")).toBe(false);
    expect(targetMatches("src/a.ts#run", "src/a.ts")).toBe(false);
  });
});
