import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_EXCLUDE, loadConfig, parseConfig } from "@loose-ends/core";
import { project } from "./helpers/project.js";

describe("loadConfig", () => {
  it("returns defaults when no config exists", () => {
    const root = project({ "package.json": { name: "app" } });
    const config = loadConfig(root);
    expect(config.root).toBe(root);
    expect(config.exclude).toEqual(DEFAULT_EXCLUDE);
    expect(config.frameworks).toBe("auto");
    expect(config.source).toBeUndefined();
  });

  it("reads loose-ends.config.json and extends defaults", () => {
    const root = project({
      "loose-ends.config.json": {
        entries: ["src/jobs/*.ts"],
        extendExclude: ["**/generated/**"],
        dormant: [{ target: "src/legacy/**", reason: "kept for the v1 export" }],
      },
    });
    const config = loadConfig(root);
    expect(config.entries).toEqual(["src/jobs/*.ts"]);
    expect(config.exclude).toContain("**/generated/**");
    expect(config.exclude).toContain("**/node_modules/**");
    expect(config.dormant[0]?.reason).toBe("kept for the v1 export");
    expect(config.source).toMatch(/loose-ends\.config\.json$/);
  });

  it("falls back to package.json#looseEnds", () => {
    const root = project({ "package.json": { name: "app", looseEnds: { checks: ["npm test"] } } });
    expect(loadConfig(root).checks).toEqual(["npm test"]);
  });

  it("applies overrides last", () => {
    const root = project({ "loose-ends.config.json": { checks: ["npm test"] } });
    expect(loadConfig(root, { checks: ["npm run build"] }).checks).toEqual(["npm run build"]);
  });
});

describe("parseConfig", () => {
  it("rejects unknown keys", () => {
    expect(() => parseConfig({ entrys: [] })).toThrow(ConfigError);
  });

  it("requires a reason on suppressions", () => {
    expect(() => parseConfig({ suppressions: [{ target: "src/a.ts" }] })).toThrow(/needs a reason/);
    expect(() => parseConfig({ suppressions: [{ target: "src/a.ts", reason: "  " }] })).toThrow(/needs a reason/);
  });

  it("validates finding kinds and dates", () => {
    expect(() => parseConfig({ failOn: ["nope"] })).toThrow(/unknown finding kind/);
    expect(() => parseConfig({ suppressions: [{ target: "a", reason: "r", expires: "soon" }] })).toThrow(/invalid expires/);
  });

  it("validates frameworks", () => {
    expect(parseConfig({ frameworks: ["next"] }).frameworks).toEqual(["next"]);
    expect(() => parseConfig({ frameworks: ["rails"] })).toThrow(/unknown framework/);
  });
});
