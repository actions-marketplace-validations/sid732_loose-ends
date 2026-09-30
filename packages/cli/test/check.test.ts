import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { project, repo } from "../../core/test/helpers/project.js";
import { cli } from "./helpers.js";

const base = {
  "package.json": { name: "app", main: "src/index.ts" },
  "src/index.ts": `import { a } from "./a";\na();`,
  "src/a.ts": `export function a() {}`,
};

describe("loose-ends check", () => {
  it("exits 0 when the change is clean", async () => {
    const root = repo(base);
    const out = await cli(root, "check");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No new loose ends.");
  });

  it("exits 1 on blocking findings and writes reports to files", async () => {
    const root = repo(base, { "src/b.ts": "export const b = 1;" });
    const text = await cli(root, "check");
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("orphaned-addition  src/b.ts:1");

    const json = await cli(root, "check", "--format", "json", "--output", "out/report.json");
    expect(json.code).toBe(1);
    expect(json.stderr).toContain("fail: 1 blocking of 1 findings → out/report.json");
    expect(JSON.parse(readFileSync(join(root, "out/report.json"), "utf8")).passed).toBe(false);
  });

  it("supports --no-fail and --fail-on", async () => {
    const root = repo(base, { "src/b.ts": "export const b = 1;" });
    expect((await cli(root, "check", "--no-fail")).code).toBe(0);
    expect((await cli(root, "check", "--fail-on", "superseded")).code).toBe(0);
  });

  it("reports usage errors with exit code 2", async () => {
    const root = repo(base);
    const bad = await cli(root, "check", "--format", "xml");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown format "xml"');
    expect((await cli(root, "check", "--fail-on", "nope")).stderr).toContain('unknown finding kind "nope"');
    const notRepo = await cli(project(base), "check");
    expect(notRepo.code).toBe(2);
    expect(notRepo.stderr).toContain("not inside a git repository");
  });
});

describe("loose-ends scan", () => {
  it("reports existing debt without failing", async () => {
    const root = project({ ...base, "src/old.ts": "export const old = 1;" });
    const out = await cli(root, "scan", "--format", "markdown");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("`orphaned` | `src/old.ts:1`");
    expect((await cli(root, "scan", "--fail")).code).toBe(1);
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("prints help and version", async () => {
    const root = project(base);
    const help = await cli(root, "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("check");
    expect((await cli(root, "--version")).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});
