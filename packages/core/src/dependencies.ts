import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dependencyId, fileId } from "./graph.js";
import { makeFinding, type Finding } from "./findings.js";
import { stateOf, type Analysis } from "./liveness.js";
import { createMatcher } from "./paths.js";
import type { WorkspacePackage } from "./workspace.js";

/** Packages that are commonly required without being imported directly. */
const IMPLICIT = [
  "react-dom",
  "typescript",
  "tslib",
  "@types/*",
  "sharp",
  "pg",
  "pg-native",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "@prisma/client",
  "prisma",
  "tailwindcss",
  "postcss",
  "autoprefixer",
  "@tailwindcss/*",
  "eslint-config-*",
  "eslint-plugin-*",
  "@babel/*",
  "core-js",
  "regenerator-runtime",
  "server-only",
  "client-only",
];

/** Packages the compiler imports on behalf of JSX (`jsxImportSource`). */
const JSX_RUNTIMES = ["react", "preact", "solid-js", "@emotion/react", "hono"];

export type DependencyUse = "live" | "test-only" | "script" | "unused" | "ignored";

export interface DependencyReport {
  package: string;
  manifest: string;
  name: string;
  use: DependencyUse;
  line?: number;
}

/** How each production dependency of each workspace package is used. */
export function dependencyReport(analysis: Analysis): DependencyReport[] {
  const ignore = createMatcher([...IMPLICIT, ...analysis.config.ignoreDependencies]);
  const out: DependencyReport[] = [];
  const packages = analysis.build.resolver.packages;
  for (const pkg of packages) {
    const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies };
    const manifest = pkg.dir ? `${pkg.dir}/package.json` : "package.json";
    const text = readManifest(analysis.config.root, manifest);
    const scripts = Object.values(pkg.manifest.scripts ?? {}).join("\n");
    const nested = packages.filter((p) => p !== pkg && p.dir.startsWith(pkg.dir ? pkg.dir + "/" : "")).map((p) => p.dir);
    for (const name of Object.keys(deps).sort()) {
      let use: DependencyUse;
      if (ignore(name)) use = "ignored";
      else {
        use = usage(analysis, pkg, nested, name);
        if (use === "unused" && usedByScript(scripts, name)) use = "script";
      }
      out.push({ package: pkg.name, manifest, name, use, line: lineOf(text, name) });
    }
  }
  return out;
}

function usage(analysis: Analysis, pkg: WorkspacePackage, nested: string[], name: string): DependencyUse {
  const id = dependencyId(name);
  const prefix = pkg.dir ? pkg.dir + "/" : "";
  let testOnly = false;
  for (const edge of analysis.graph.nodes.has(id) ? analysis.graph.in(id) : []) {
    const from = analysis.graph.nodes.get(edge.from);
    const file = from?.file;
    if (!file || !file.startsWith(prefix)) continue;
    // A root-level manifest still covers hoisted use from nested packages that don't declare it.
    if (nested.some((dir) => file.startsWith(dir + "/")) && declares(analysis, file, name)) continue;
    const state = stateOf(analysis, edge.from).liveness;
    if (state === "live" || state === "uncertain") return "live";
    if (state === "test-only") testOnly = true;
  }
  if (JSX_RUNTIMES.includes(name)) {
    for (const [file, info] of analysis.graph.modules) {
      if (!info.jsx || !file.startsWith(prefix)) continue;
      const state = stateOf(analysis, fileId(file)).liveness;
      if (state === "live" || state === "uncertain") return "live";
      if (state === "test-only") testOnly = true;
    }
  }
  return testOnly ? "test-only" : "unused";
}

function declares(analysis: Analysis, file: string, name: string): boolean {
  const owner = analysis.build.resolver.packages
    .filter((p) => p.dir && file.startsWith(p.dir + "/"))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  return !!owner && name in { ...owner.manifest.dependencies, ...owner.manifest.optionalDependencies, ...owner.manifest.devDependencies };
}

function usedByScript(scripts: string, name: string): boolean {
  const bare = name.replace(/^@[^/]+\//, "");
  const candidates = new Set([name, bare, bare.replace(/-cli$/, ""), bare.replace(/^cli-/, "")]);
  return [...candidates].some((c) => new RegExp(`(^|[\\s/;&|(])${escape(c)}($|[\\s;&|)])`, "m").test(scripts));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readManifest(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
}

function lineOf(text: string, name: string): number | undefined {
  const index = text.search(new RegExp(`"${escape(name)}"\\s*:`));
  return index === -1 ? undefined : text.slice(0, index).split("\n").length;
}

function finding(report: DependencyReport, message: string, before?: DependencyUse): Finding {
  const f = makeFinding("unused-dependency", undefined, `dep:${report.name}`, message, {
    before: before === undefined ? undefined : before === "live" || before === "script" ? "live" : before === "test-only" ? "test-only" : "orphaned",
    after: report.use === "test-only" ? "test-only" : "orphaned",
    note:
      report.use === "test-only"
        ? "Only tests import it. Move it to devDependencies, or import it from production code."
        : "No live code imports it and no script runs it. Remove it, or add it to ignoreDependencies if it is loaded implicitly.",
  });
  return { ...f, target: `${report.manifest}#dependencies.${report.name}`, file: report.manifest, line: report.line, symbol: undefined };
}

const isProblem = (use: DependencyUse) => use === "unused" || use === "test-only";

/** Dependencies this change added without using, or stopped using without removing. */
export function dependencyFindings(base: Analysis, head: Analysis): Finding[] {
  if (!head.config.dependencies) return [];
  const before = new Map(dependencyReport(base).map((r) => [`${r.manifest}\0${r.name}`, r]));
  const out: Finding[] = [];
  for (const report of dependencyReport(head)) {
    if (!isProblem(report.use)) continue;
    const prev = before.get(`${report.manifest}\0${report.name}`);
    const where = report.package ? ` of ${report.package}` : "";
    const how = report.use === "test-only" ? "is only used by tests" : "is not used by any live code";
    if (!prev) {
      out.push(finding(report, `Dependency \`${report.name}\`${where} was added in this change and ${how}.`));
    } else if (!isProblem(prev.use) && prev.use !== "ignored") {
      out.push(finding(report, `Dependency \`${report.name}\`${where} was used before this change and now ${how}.`, prev.use));
    }
  }
  return out;
}

/** Whole-project dependency report for scan mode. */
export function scanDependencyFindings(analysis: Analysis): Finding[] {
  if (!analysis.config.dependencies) return [];
  return dependencyReport(analysis)
    .filter((r) => isProblem(r.use))
    .map((r) =>
      finding(r, `Dependency \`${r.name}\`${r.package ? ` of ${r.package}` : ""} ${r.use === "test-only" ? "is only used by tests" : "is not used by any live code"}.`),
    );
}
