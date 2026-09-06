import { describe, expect, it } from "vitest";
import { check, scan } from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

const base = {
  "package.json": { name: "app", main: "src/index.ts" },
  "src/index.ts": `import { handle } from "./handler";\nhandle();`,
  "src/handler.ts": `import { format } from "./format";\nexport function handle() { return format(1); }`,
  "src/format.ts": `export function format(n: number) { return String(n); }`,
  "src/legacy.ts": `export function oldThing() {}`,
};

const summary = (r: ReturnType<typeof check>) => r.findings.map((f) => `${f.kind} ${f.target}`);

describe("check", () => {
  it("passes a change that wires new code in", () => {
    const root = repo(base, {
      "src/handler.ts": `import { format } from "./format";\nimport { audit } from "./audit";\nexport function handle() { audit(); return format(1); }`,
      "src/audit.ts": `export function audit() {}`,
    });
    const result = check({ root });
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("flags added files and symbols nothing reaches", () => {
    const root = repo(base, {
      "src/new-handler.ts": `import { format } from "./format";\nexport function handleV2() { return format(2); }`,
      "src/format.ts": `export function format(n: number) { return String(n); }\nexport function formatFancy() {}`,
    });
    const result = check({ root });
    expect(summary(result)).toEqual(["orphaned-addition src/format.ts#formatFancy", "orphaned-addition src/new-handler.ts"]);
    expect(result.passed).toBe(false);
    expect(result.findings[1]?.line).toBe(1);
  });

  it("does not report pre-existing orphans", () => {
    const root = repo(base, { "src/legacy.ts": `export function oldThing() { return 1; }` });
    expect(check({ root }).findings).toEqual([]);
  });

  it("flags code orphaned by a removed edge and shows the broken edge", () => {
    const root = repo(base, { "src/handler.ts": `export function handle() { return "1"; }` });
    const result = check({ root });
    expect(summary(result)).toEqual(["newly-orphaned src/format.ts"]);
    const evidence = result.findings[0]!.evidence;
    expect(evidence.before).toBe("live");
    expect(evidence.brokenEdge).toEqual({ from: "src/handler.ts", to: "src/format.ts", reason: "removed" });
    expect(evidence.path?.map((s) => s.node)).toEqual(["src/index.ts", "src/handler.ts", "src/format.ts"]);
    expect(evidence.path?.[2]).toMatchObject({ edge: "import", line: 1 });
  });

  it("flags additions reachable only from tests", () => {
    const root = repo(base, {
      "src/helper.ts": `export function helper() {}`,
      "src/helper.test.ts": `import { helper } from "./helper";\nhelper();`,
    });
    expect(summary(check({ root }))).toEqual(["test-only-addition src/helper.ts"]);
    expect(check({ root }).passed).toBe(true);
  });

  it("compares committed refs and follows renames", () => {
    const root = repo(
      base,
      { "src/format.ts": null, "src/formatting.ts": base["src/format.ts"], "src/handler.ts": `import { format } from "./formatting";\nexport function handle() { return format(1); }` },
      { commitHead: true },
    );
    const result = check({ root, base: "main", head: "feature" });
    expect(result.changed.map((c) => c.status)).toContain("renamed");
    expect(result.findings).toEqual([]);
  });

  it("honors suppressions and reports expired ones", () => {
    const root = repo(base, {
      "src/extra.ts": `export const extra = 1;`,
      "src/other.ts": `export const other = 1;`,
      "loose-ends.config.json": {
        suppressions: [
          { target: "src/extra.ts", reason: "wired up in the follow-up PR" },
          { target: "src/gone.ts", reason: "old", expires: "2020-01-01" },
        ],
      },
    });
    const result = check({ root });
    expect(result.findings.find((f) => f.target === "src/extra.ts")?.suppressed?.reason).toBe("wired up in the follow-up PR");
    expect(result.failing.map((f) => `${f.kind} ${f.target}`)).toEqual(["invalid-suppression src/gone.ts", "orphaned-addition src/other.ts"]);
  });
});

describe("scan", () => {
  it("reports all unreachable code without git", () => {
    const result = scan({ root: project(base) });
    expect(summary(result)).toEqual(["orphaned src/legacy.ts"]);
    expect(result.passed).toBe(true);
  });
});
