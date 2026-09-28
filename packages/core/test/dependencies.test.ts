import { describe, expect, it } from "vitest";
import { analyze, check, dependencyReport, loadConfig } from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

describe("dependencyReport", () => {
  it("classifies dependency use", () => {
    const root = project({
      "package.json": {
        name: "app",
        main: "index.js",
        scripts: { start: "next start", lint: "eslint ." },
        dependencies: { express: "1", lodash: "1", chalk: "1", next: "1", "react-dom": "1", nanoid: "1", custom: "1" },
      },
      "loose-ends.config.json": { ignoreDependencies: ["custom"] },
      "index.js": "const express = require('express');\nexpress();",
      "dead.js": "const lodash = require('lodash');",
      "index.test.js": "const { nanoid } = require('nanoid');",
    });
    const uses = Object.fromEntries(dependencyReport(analyze(loadConfig(root))).map((r) => [r.name, r.use]));
    expect(uses).toEqual({
      chalk: "unused",
      custom: "ignored",
      express: "live",
      lodash: "unused",
      nanoid: "test-only",
      next: "script",
      "react-dom": "ignored",
    });
  });

  it("checks workspace packages separately", () => {
    const root = project({
      "package.json": { name: "root", workspaces: ["packages/*"], dependencies: { zod: "1" } },
      "packages/a/package.json": { name: "a", main: "index.ts", dependencies: { zod: "1", ms: "1" } },
      "packages/a/index.ts": "import { z } from 'zod';\nz;",
    });
    const report = dependencyReport(analyze(loadConfig(root))).map((r) => `${r.manifest} ${r.name} ${r.use}`);
    expect(report).toEqual(["package.json zod unused", "packages/a/package.json ms unused", "packages/a/package.json zod live"]);
  });

  it("counts imports of workspace packages as dependency use", () => {
    const root = project({
      "package.json": { name: "root", workspaces: ["packages/*"] },
      "packages/core/package.json": { name: "@x/core", main: "src/index.ts" },
      "packages/core/src/index.ts": "export const core = 1;",
      "packages/cli/package.json": { name: "@x/cli", bin: { x: "src/bin.ts" }, dependencies: { "@x/core": "1" } },
      "packages/cli/src/bin.ts": "import { core } from '@x/core';\nconsole.log(core);",
    });
    const report = dependencyReport(analyze(loadConfig(root))).map((r) => `${r.name} ${r.use}`);
    expect(report).toEqual(["@x/core live"]);
  });
});

describe("dependency findings in check", () => {
  const base = {
    "package.json": { name: "app", main: "index.ts", dependencies: { dayjs: "1" } },
    "index.ts": "import dayjs from 'dayjs';\ndayjs();",
  };

  it("reports dependencies added without use", () => {
    const root = repo(base, { "package.json": { name: "app", main: "index.ts", dependencies: { dayjs: "1", axios: "1" } } });
    const findings = check({ root }).findings;
    expect(findings.map((f) => [f.kind, f.target, f.line])).toEqual([["unused-dependency", "package.json#dependencies.axios", 6]]);
  });

  it("reports dependencies that stopped being used", () => {
    const root = repo(base, { "index.ts": "console.log(Date.now());" });
    const findings = check({ root }).findings;
    expect(findings.map((f) => f.message)).toEqual(["Dependency `dayjs` of app was used before this change and now is not used by any live code."]);
  });
});
