import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCleanup, check, cleanupPatch, planCleanup, scan, verifyCleanup } from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

const files = {
  "package.json": { name: "app", main: "index.ts" },
  "index.ts": `import { used } from "./lib";\nimport { sideEffect } from "./lazy";\nused();`,
  "lib.ts": `export function used() {}\n\n/** Old helper. */\nexport function unused() {\n  return 1;\n}\n\nexport const a = 1, b = 2;\n`,
  "lazy.ts": `export function sideEffect() {}`,
  "dead.ts": `export const dead = true;\n`,
};

describe("planCleanup", () => {
  it("plans deletions and skips anything unsafe", () => {
    const result = scan({ root: project(files), keepAnalyses: true });
    const plan = planCleanup(result.analyses!.head, result.findings);
    expect(plan.actions.map((a) => (a.type === "delete-file" ? `delete ${a.path}` : `remove ${a.path}#${a.symbol}`))).toEqual([
      "delete dead.ts",
      "remove lib.ts#unused",
    ]);
    expect(plan.skipped).toEqual([
      { target: "lazy.ts#sideEffect", reason: "still imported (without being used) by index.ts" },
      { target: "lib.ts#a", reason: "declared together with other names in one statement" },
      { target: "lib.ts#b", reason: "declared together with other names in one statement" },
    ]);
  });

  it("applies removals including attached comments", () => {
    const root = project(files);
    const result = scan({ root, keepAnalyses: true });
    applyCleanup(root, planCleanup(result.analyses!.head, result.findings));
    expect(existsSync(join(root, "dead.ts"))).toBe(false);
    expect(readFileSync(join(root, "lib.ts"), "utf8")).toBe(`export function used() {}\n\nexport const a = 1, b = 2;\n`);
  });
});

describe("verifyCleanup", () => {
  it("runs checks in a sandbox and returns a patch without touching the tree", () => {
    const root = repo(files, { "extra.ts": "export const extra = 1;\n" });
    const result = check({ root, keepAnalyses: true });
    const plan = planCleanup(result.analyses!.head, result.findings);
    const ok = verifyCleanup(root, plan, ["test ! -e extra.ts"]);
    expect(ok.passed).toBe(true);
    expect(ok.patch).toContain("diff --git a/extra.ts b/extra.ts");
    expect(ok.patch).toContain("-export const extra = 1;");
    expect(existsSync(join(root, "extra.ts"))).toBe(true);

    const bad = verifyCleanup(root, plan, ["echo checking && exit 3", "echo never"]);
    expect(bad.passed).toBe(false);
    expect(bad.checks).toEqual([expect.objectContaining({ command: "echo checking && exit 3", exitCode: 3, output: "checking" })]);
  });

  it("builds a patch for symbol removals", () => {
    const root = project(files);
    const result = scan({ root, keepAnalyses: true });
    const { patch, touched } = cleanupPatch(root, planCleanup(result.analyses!.head, result.findings));
    expect(touched).toEqual(["dead.ts", "lib.ts"]);
    expect(patch).toContain("--- a/lib.ts");
    expect(patch).toContain("-export function unused() {");
  });
});
