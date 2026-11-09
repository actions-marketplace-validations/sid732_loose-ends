import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import { MODULE_BODY } from "./parse.js";
import { pythonDependencyId } from "./python/link.js";
import { PYTHON_IMPLICIT, importNames, normalizeDist } from "./python/packages.js";
import type { PythonProject } from "./python/project.js";
import { isPython } from "./resolve.js";
import { symbolId } from "./graph.js";
import { discoverJavaModules, type JavaModule } from "./java/project.js";
import { JAVA_IMPLICIT, groupPackages } from "./java/packages.js";
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

export type DependencyUse = "live" | "test-only" | "script" | "config" | "unused" | "ignored";

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
    const configs = configText(analysis.config.root, pkg.dir);
    const nested = packages.filter((p) => p !== pkg && p.dir.startsWith(pkg.dir ? pkg.dir + "/" : "")).map((p) => p.dir);
    // A package with no production-live source file (a sample, a template, a test suite) is reported
    // through its files already, and its dependencies serve tests or nothing; listing each would only repeat that.
    const own = [...analysis.build.graph.modules.keys()].filter(
      (f) => !isPython(f) && !f.endsWith(".java") && (pkg.dir === "" || f.startsWith(pkg.dir + "/")) && !nested.some((d) => f.startsWith(d + "/")),
    );
    if (own.length > 0 && !own.some((f) => {
        const state = stateOf(analysis, fileId(f));
        return state.liveness === "live" ? state.root?.kind !== "tooling" : !["orphaned", "test-only"].includes(state.liveness);
      })) continue;
    for (const name of Object.keys(deps).sort()) {
      let use: DependencyUse;
      if (ignore(name)) use = "ignored";
      else {
        use = usage(analysis, pkg, nested, name);
        if (use === "unused" && usedByScript(scripts, name)) use = "script";
        else if (use === "unused" && namedInConfig(configs, name)) use = "config";
      }
      out.push({ package: pkg.name, manifest, name, use, line: lineOf(text, name) });
    }
  }
  out.push(...pythonDependencyReport(analysis));
  out.push(...javaDependencyReport(analysis));
  return out;
}

/** How each compile-scope Maven or Gradle dependency is used, judged by the packages Java files import. */
function javaDependencyReport(analysis: Analysis): DependencyReport[] {
  if (!analysis.build.java) return [];
  const modules = discoverJavaModules(analysis.config.root);
  const ignore = createMatcher([...JAVA_IMPLICIT, ...analysis.config.ignoreDependencies]);
  // Imported packages, with the best liveness of an importing file, per module.
  const imported: Array<{ pkg: string; file: string; use: DependencyUse }> = [];
  for (const node of analysis.graph.nodes.values()) {
    if (node.kind !== "dependency" || !node.id.startsWith("dep:java:")) continue;
    for (const edge of analysis.graph.in(node.id)) {
      const file = analysis.graph.nodes.get(edge.from)?.file;
      if (!file) continue;
      const state = stateOf(analysis, edge.from).liveness;
      imported.push({ pkg: node.name!, file, use: state === "live" || state === "uncertain" ? "live" : state === "test-only" ? "test-only" : "unused" });
    }
  }
  const out: DependencyReport[] = [];
  for (const module of modules) {
    const prefix = module.dir ? module.dir + "/" : "";
    const resources = javaResourceText(analysis.config.root, module);
    // Kotlin is not analyzed, so a module with Kotlin sources may use any dependency from there.
    const kotlin = fg.sync([`${prefix}src/**/*.kt`], { cwd: analysis.config.root, onlyFiles: true, ignore: ["**/build/**"] }).length > 0;
    for (const dep of module.dependencies) {
      const name = `${dep.group}:${dep.artifact}`;
      let use: DependencyUse;
      if (ignore(name) || kotlin) use = "ignored";
      else {
        const packages = groupPackages(dep.group);
        const matches = (pkg: string) => packages.some((p) => pkg === p || pkg.startsWith(p + "."));
        const uses = imported.filter((i) => i.file.startsWith(prefix) && matches(i.pkg)).map((i) => i.use);
        use = uses.includes("live") ? "live" : uses.includes("test-only") ? "test-only" : "unused";
        if (use === "unused" && packages.some((p) => resources.includes(p))) use = "config";
      }
      out.push({ package: module.name, manifest: module.buildFile, name, use, line: dep.line });
    }
  }
  return out;
}

/** Resource and Kotlin text of a module, where classes are named by string or used outside Java. */
function javaResourceText(root: string, module: JavaModule): string {
  const prefix = module.dir ? `${module.dir}/` : "";
  const files = fg.sync([`${prefix}src/main/**/*.{properties,yml,yaml,xml,json,kt,kts,conf}`, `${prefix}src/main/resources/META-INF/**`], { cwd: root, onlyFiles: true, ignore: ["**/node_modules/**", "**/build/**", "**/target/**"] });
  // Not the build file: it names every dependency's group.
  return files.slice(0, 2000).map((f) => readManifest(root, f).slice(0, 256 * 1024)).join("\n");
}

/** How each production dependency of each Python project (requirements, pyproject, setup.py, Pipfile) is used. */
function pythonDependencyReport(analysis: Analysis): DependencyReport[] {
  if (![...analysis.graph.modules.keys()].some(isPython)) return [];
  const projects = analysis.build.resolver.python.projects;
  const ignore = createMatcher([...PYTHON_IMPLICIT, ...analysis.config.ignoreDependencies.map(normalizeDist)]);
  const userIgnore = createMatcher(analysis.config.ignoreDependencies);
  const out: DependencyReport[] = [];
  for (const project of projects) {
    const prefix = project.dir ? project.dir + "/" : "";
    const nested = projects.filter((p) => p !== project && p.dir.startsWith(prefix));
    const commands = commandText(analysis.config.root, project.dir);
    const strings = liveStrings(analysis, prefix);
    for (const manifest of project.manifests) {
      for (const dep of manifest.dependencies) {
        let use: DependencyUse;
        if (ignore(normalizeDist(dep.name)) || userIgnore(dep.name)) use = "ignored";
        else {
          const names = importNames(dep.name);
          use = pythonUsage(analysis, prefix, nested, dep.name, names);
          if (use === "unused" && [dep.name, normalizeDist(dep.name), ...names].some((n) => usedByScript(commands, n))) use = "script";
          else if (use === "unused" && (names.some((n) => strings.has(n)) || [dep.name, ...names].some((n) => namedInConfig(project.configText, n)))) use = "config";
        }
        out.push({ package: project.name, manifest: manifest.path, name: dep.name, use, line: dep.line });
      }
    }
  }
  return out;
}

function pythonUsage(analysis: Analysis, prefix: string, nested: PythonProject[], dist: string, names: string[]): DependencyUse {
  let testOnly = false;
  const norm = normalizeDist(dist);
  for (const name of names) {
    const id = pythonDependencyId(name);
    if (!analysis.graph.nodes.has(id)) continue;
    for (const edge of analysis.graph.in(id)) {
      const file = analysis.graph.nodes.get(edge.from)?.file;
      if (!file || !file.startsWith(prefix)) continue;
      // A nested project that declares the package itself owns that use.
      if (nested.some((p) => file.startsWith(p.dir + "/") && p.manifests.some((m) => m.dependencies.some((d) => normalizeDist(d.name) === norm)))) continue;
      const state = stateOf(analysis, edge.from).liveness;
      if (state === "live" || state === "uncertain") return "live";
      if (state === "test-only") testOnly = true;
    }
  }
  return testOnly ? "test-only" : "unused";
}

/** Heads of dotted strings in live Python code (`INSTALLED_APPS = ["corsheaders"]`, `"whitenoise.middleware.X"`). */
function liveStrings(analysis: Analysis, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const [path, info] of analysis.graph.modules) {
    if (!info.stringRefs || !path.startsWith(prefix)) continue;
    for (const ref of info.stringRefs) {
      const owner = ref.owner === MODULE_BODY ? `file:${path}` : symbolId(path, ref.owner);
      const state = stateOf(analysis, owner).liveness;
      if (state === "live" || state === "uncertain") out.add(ref.value.split(/[.:]/)[0]!);
    }
  }
  return out;
}

/** Deploy, container, and task-runner files that may start a package's CLI (`gunicorn`, `alembic upgrade`). */
function commandText(root: string, dir: string): string {
  const prefix = dir ? `${dir}/` : "";
  const patterns = ["Procfile*", "Dockerfile*", "*.dockerfile", "docker-compose*.y*ml", "compose*.y*ml", "Makefile", "justfile", "*.sh", "app.yaml", "fly.toml", "render.yaml", "railway.json", "nixpacks.toml", "pyproject.toml", "tox.ini", "setup.cfg", "*.service", "supervisord*.conf"];
  const files = new Set([...fg.sync(patterns.map((p) => prefix + p), { cwd: root, onlyFiles: true }), ...fg.sync(patterns.concat([".github/workflows/*.y*ml"]), { cwd: root, onlyFiles: true, dot: true })]);
  return [...files].map((f) => readManifest(root, f).slice(0, 256 * 1024).replace(/["'[\],]/g, " ")).join("\n");
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

/** Packages whose command has a different name. */
const BIN_NAMES: Record<string, string> = { "react-email": "email", typescript: "tsc", "@biomejs/biome": "biome", "npm-run-all": "run-p" };

function usedByScript(scripts: string, name: string): boolean {
  const bare = name.replace(/^@[^/]+\//, "");
  const candidates = new Set([name, bare, bare.replace(/-cli$/, ""), bare.replace(/^cli-/, "")]);
  if (BIN_NAMES[name]) candidates.add(BIN_NAMES[name]);
  return [...candidates].some((c) => new RegExp(`(^|[\\s/;&|(])${escape(c)}($|[\\s;&|)])`, "m").test(scripts));
}

const CONFIG_FILE = /^(tsconfig[\w.-]*\.json|jsconfig\.json|\.[\w.-]+rc(\.(json|js|cjs|mjs|ya?ml))?|[\w.-]+\.config\.(js|cjs|mjs|ts|mts|cts|json)|[\w.-]+\.json)$/;
const SKIP_CONFIG = new Set(["package.json", "package-lock.json"]);

/** Text of config files at a package root: tsconfig extends, eslint/prettier/babel configs, and so on. */
function configText(root: string, dir: string): string {
  const abs = join(root, dir);
  let names: string[] = [];
  try {
    names = readdirSync(abs);
  } catch {
    return "";
  }
  return names
    .filter((n) => CONFIG_FILE.test(n) && !SKIP_CONFIG.has(n))
    .map((n) => readManifest(abs, n).slice(0, 256 * 1024))
    .join("\n");
}

/** A package named in a config (`"extends": "@acme/tsconfig/base.json"`, `plugins: ["tailwindcss-animate"]`). */
function namedInConfig(text: string, name: string): boolean {
  return new RegExp(`["'\`]${escape(name)}(/[^"'\`]*)?["'\`]`).test(text);
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
    before: before === undefined ? undefined : isUsed(before) ? "live" : before === "test-only" ? "test-only" : "orphaned",
    after: report.use === "test-only" ? "test-only" : "orphaned",
    note:
      report.use === "test-only"
        ? "Only tests import it. Move it to devDependencies, or import it from production code."
        : "No live code imports it and no script runs it. Remove it, or add it to ignoreDependencies if it is loaded implicitly.",
  });
  return { ...f, target: `${report.manifest}#dependencies.${report.name}`, file: report.manifest, line: report.line, symbol: undefined };
}

const isProblem = (use: DependencyUse) => use === "unused" || use === "test-only";
const isUsed = (use: DependencyUse) => use === "live" || use === "script" || use === "config";

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
