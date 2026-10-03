import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { project } from "../../core/test/helpers/project.js";
import { cli } from "./helpers.js";

const app = {
  "package.json": { name: "app", main: "src/index.ts", scripts: { build: "tsc", test: "vitest" }, dependencies: { next: "15" } },
  "src/index.ts": `import { a } from "./a";\na();`,
  "src/a.ts": `export function a() {}\nexport function unused() {}`,
  "app/page.tsx": "export default function Page() {}",
};

describe("loose-ends explain", () => {
  it("explains a symbol", async () => {
    const out = await cli(project(app), "explain", "src/a.ts#unused");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("src/a.ts#unused  orphaned");
    expect(out.stdout).toContain("Referenced by: nothing");
  });

  it("emits JSON and errors on unknown targets", async () => {
    const root = project(app);
    const json = JSON.parse((await cli(root, "explain", "src/a.ts", "--format", "json")).stdout);
    expect(json.liveness).toBe("live");
    const missing = await cli(root, "explain", "src/zzz.ts");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("not a known file");
  });
});

describe("loose-ends roots", () => {
  it("lists file roots with reasons", async () => {
    const out = await cli(project(app), "roots");
    expect(out.stdout).toMatch(/app\/page\.tsx\s+production\s+Next\.js app router file/);
    expect(out.stdout).toMatch(/src\/index\.ts\s+production\s+entry point "src\/index\.ts" of app/);
    const json = JSON.parse((await cli(project(app), "roots", "--format", "json", "--symbols")).stdout);
    expect(json.map((r: { target: string }) => r.target)).toContain("app/page.tsx#Page");
  });
});

describe("loose-ends init", () => {
  it("writes a starter config once", async () => {
    const root = project(app);
    const out = await cli(root, "init");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Detected frameworks: next");
    const config = JSON.parse(readFileSync(join(root, "loose-ends.config.json"), "utf8"));
    expect(config.checks).toEqual(["npm run build", "npm run test"]);
    expect(config.frameworks).toBeUndefined();
    const again = await cli(root, "init");
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("already exists");
    expect((await cli(root, "init", "--force")).code).toBe(0);
  });
});
