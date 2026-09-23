import { describe, expect, it } from "vitest";
import { analyze, check, explain, formatExplanation, formatJson, formatText, loadConfig } from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

const base = {
  "package.json": { name: "app", main: "src/index.ts" },
  "src/index.ts": `import { a } from "./a";\na();`,
  "src/a.ts": `import { b } from "./b";\nexport function a() { b(); }`,
  "src/b.ts": `export function b() {}`,
};

function failingResult() {
  return check({ root: repo(base, { "src/a.ts": `export function a() {}`, "src/c.ts": `export const c = 1;` }) });
}

describe("text reporter", () => {
  it("renders findings with evidence and a summary", () => {
    const text = formatText(failingResult());
    expect(text).toContain("Loose Ends · check main (");
    expect(text).toContain("✖ error   newly-orphaned  src/b.ts:1");
    expect(text).toContain("edge removed: src/a.ts → src/b.ts");
    expect(text).toContain("was reached via: src/index.ts → src/a.ts → src/b.ts");
    expect(text).toContain("✖ error   orphaned-addition  src/c.ts:1");
    expect(text).toContain("Summary: 2 errors, 0 warnings, 0 info");
    expect(text).toContain("Result: fail (2 findings in failOn: newly-orphaned, orphaned-addition)");
    expect(text).not.toContain("\u001b[");
  });

  it("colors output when asked", () => {
    expect(formatText(failingResult(), { color: true })).toContain("\u001b[31m");
  });

  it("renders a pass", () => {
    const text = formatText(check({ root: repo(base) }));
    expect(text).toContain("No new loose ends.");
    expect(text).toContain("Result: pass");
  });

  it("renders explanations", () => {
    const a = analyze(loadConfig(project(base)));
    const text = formatExplanation(explain(a, "src/b.ts#b")!);
    expect(text).toContain("src/b.ts#b  live");
    expect(text).toMatch(/Path:\n {4}src\/index\.ts\n {2}→ src\/a\.ts#a/);
  });
});

describe("json reporter", () => {
  it("emits a versioned report without internals", () => {
    const report = JSON.parse(formatJson(failingResult()));
    expect(report.version).toBe(1);
    expect(report.tool.name).toBe("loose-ends");
    expect(report.passed).toBe(false);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({ kind: "newly-orphaned", target: "src/b.ts", failing: true });
    expect(report.analyses).toBeUndefined();
    expect(report.config.root).toBeUndefined();
  });
});
