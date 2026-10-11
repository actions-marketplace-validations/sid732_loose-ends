import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { project, repo } from "../../core/test/helpers/project.js";
import { cli } from "./helpers.js";

const base = {
  "package.json": { name: "app", main: "index.ts" },
  "index.ts": `import { a } from "./a";\na();`,
  "a.ts": `export function a() {}`,
};

describe("loose-ends fix", () => {
  it("prints a dry-run plan and writes a patch", async () => {
    const root = repo(base, { "b.ts": "export const b = 1;\n" });
    const out = await cli(root, "fix", "--patch", "cleanup.diff");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("delete  b.ts");
    expect(readFileSync(join(root, "cleanup.diff"), "utf8")).toContain("deleted file mode");
    expect(existsSync(join(root, "b.ts"))).toBe(true);
  });

  it("refuses to apply when verification fails", async () => {
    const root = repo(base, { "b.ts": "export const b = 1;\n" });
    const out = await cli(root, "fix", "--apply", "--check", "exit 4");
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("✖ exit 4");
    expect(out.stderr).toContain("working tree was not changed");
    expect(existsSync(join(root, "b.ts"))).toBe(true);
  });

  it("applies after checks pass", async () => {
    const root = repo(base, { "b.ts": "export const b = 1;\n" });
    const out = await cli(root, "fix", "--apply", "--check", "true");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Verification passed.");
    expect(existsSync(join(root, "b.ts"))).toBe(false);
  });

  it("cleans up the whole project with --scan", async () => {
    const root = project({ ...base, "old.ts": "export const old = 1;\n" });
    const out = await cli(root, "fix", "--scan", "--apply");
    expect(out.stderr).toContain("applying without verification");
    expect(existsSync(join(root, "old.ts"))).toBe(false);
  });
});
