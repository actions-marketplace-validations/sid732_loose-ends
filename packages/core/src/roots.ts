import { posix } from "node:path";
import type { BuildResult } from "./graph.js";
import { fileId, symbolId } from "./graph.js";
import { createMatcher, parseTarget } from "./paths.js";
import type { LooseEndsConfig } from "./types.js";
import { manifestEntries, type WorkspacePackage } from "./workspace.js";
import { FRAMEWORK_PROVIDERS } from "./frameworks.js";

export type RootKind = "production" | "tooling" | "test";

export interface Root {
  /** Graph node kept alive by this root. */
  node: string;
  kind: RootKind;
  /** Short machine-readable source, e.g. `package.json#bin`. */
  source: string;
  /** Human-readable explanation. */
  reason: string;
}

export interface RootContext {
  config: LooseEndsConfig;
  build: BuildResult;
  /** All analyzed file paths. */
  files: string[];
  add(root: Root): void;
  /** Mark a file and, optionally, all or some of its exports as roots. */
  addFile(path: string, root: Omit<Root, "node">, exports?: "all" | string[]): void;
}

export interface RootProvider {
  name: string;
  discover(ctx: RootContext): void;
}

const SCRIPT_RUNNERS = new Set(["node", "tsx", "ts-node", "ts-node-esm", "bun", "deno", "nodemon", "vite-node", "esno", "esr", "babel-node", "jiti"]);
const TEST_SCRIPT = /^(test|e2e|cypress|playwright|coverage)(:|$)|:test$/;
const TOOLING_SCRIPT = /^(build|lint|format|gen|generate|codegen|clean|prepare|prebuild|postbuild|postinstall|release|typecheck|check|db|migrate|seed|scripts?)(:|$)/;
const CONVENTIONAL_ENTRIES = ["index", "src/index", "src/main", "main", "server", "src/server", "app", "src/app"];

/** Roots derived from package manifests: main, module, bin, exports, and scripts. */
export const packageRoots: RootProvider = {
  name: "package",
  discover(ctx) {
    for (const pkg of ctx.build.resolver.packages) {
      const entries = manifestEntries(pkg.manifest);
      let found = 0;
      for (const target of entries) {
        const file = ctx.build.resolver.resolveEntry(pkg.dir, target);
        if (!file) continue;
        found++;
        const isBin = binTargets(pkg).includes(target);
        ctx.addFile(
          file,
          {
            kind: "production",
            source: `${manifestPath(pkg)}#${isBin ? "bin" : "exports"}`,
            reason: `${isBin ? "bin" : "entry point"} "${target}" of ${pkg.name || "the root package"}`,
          },
          isBin ? undefined : "all",
        );
      }
      for (const [name, command] of Object.entries(pkg.manifest.scripts ?? {})) {
        for (const target of scriptTargets(command)) {
          const file = ctx.build.resolver.resolveEntry(pkg.dir, target);
          if (!file) continue;
          found++;
          const kind = TEST_SCRIPT.test(name) ? "test" : TOOLING_SCRIPT.test(name) ? "tooling" : "production";
          ctx.addFile(file, { kind, source: `${manifestPath(pkg)}#scripts.${name}`, reason: `run by the "${name}" script` });
        }
      }
      if (found === 0) {
        for (const candidate of CONVENTIONAL_ENTRIES) {
          const file = ctx.build.resolver.resolveEntry(pkg.dir, candidate);
          if (!file) continue;
          ctx.addFile(file, {
            kind: "production",
            source: `${manifestPath(pkg)}#convention`,
            reason: `conventional entry "${candidate}" (no main, exports, bin, or script entry found)`,
          });
          break;
        }
      }
    }
  },
};

/** Entries from configuration. Accepts file globs and `path#symbol` targets. */
export const configRoots: RootProvider = {
  name: "config",
  discover(ctx) {
    for (const entry of ctx.config.entries) {
      const { file, symbol } = parseTarget(entry);
      const match = createMatcher([file]);
      for (const path of ctx.files.filter(match)) {
        const reason = `listed in entries ("${entry}")`;
        if (symbol) ctx.add({ node: symbolId(path, symbol), kind: "production", source: "config#entries", reason });
        else ctx.addFile(path, { kind: "production", source: "config#entries", reason }, "all");
      }
    }
  },
};

/** Every file matching a test pattern is a test root. */
export const testRoots: RootProvider = {
  name: "tests",
  discover(ctx) {
    for (const file of ctx.build.files) {
      if (file.isTest) ctx.addFile(file.path, { kind: "test", source: "testPatterns", reason: "matches a test pattern" }, "all");
    }
  },
};

export const DEFAULT_PROVIDERS: RootProvider[] = [packageRoots, configRoots, ...FRAMEWORK_PROVIDERS, testRoots];

/** Run root providers and return de-duplicated roots in a stable order. */
export function discoverRoots(config: LooseEndsConfig, build: BuildResult, providers: RootProvider[] = DEFAULT_PROVIDERS): Root[] {
  const roots = new Map<string, Root>();
  const files = build.files.map((f) => f.path);
  const ctx: RootContext = {
    config,
    build,
    files,
    add(root) {
      if (!build.graph.nodes.has(root.node)) return;
      const key = `${root.node}\0${root.kind}`;
      if (!roots.has(key)) roots.set(key, root);
    },
    addFile(path, root, exports) {
      ctx.add({ ...root, node: fileId(path) });
      if (!exports) return;
      for (const sym of build.graph.symbolsOf(path)) {
        const exportedAs = sym.exportedAs ?? [];
        if (exportedAs.length === 0) continue;
        if (exports === "all" || exportedAs.some((e) => exports.includes(e))) ctx.add({ ...root, node: sym.id });
      }
    },
  };
  for (const provider of providers) provider.discover(ctx);
  return [...roots.values()].sort((a, b) => a.node.localeCompare(b.node) || a.kind.localeCompare(b.kind));
}

function manifestPath(pkg: WorkspacePackage): string {
  return pkg.dir ? `${pkg.dir}/package.json` : "package.json";
}

function binTargets(pkg: WorkspacePackage): string[] {
  const bin = pkg.manifest.bin;
  if (typeof bin === "string") return [bin];
  return bin ? Object.values(bin) : [];
}

/**
 * Extract file arguments from a package script, e.g.
 * `tsx watch src/server.ts && node scripts/seed.js --force`.
 */
export function scriptTargets(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let runner = false;
    for (const raw of tokens) {
      const token = raw.replace(/^['"]|['"]$/g, "");
      if (/^[A-Z_]+=/.test(token)) continue;
      const bin = posix.basename(token);
      if (SCRIPT_RUNNERS.has(bin)) {
        runner = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (/\.(m|c)?[jt]sx?$/.test(token) && !token.includes("*")) out.push(token.replace(/^\.\//, ""));
      else if (runner && /^[\w./@-]+$/.test(token) && token.includes("/") && !token.startsWith("@")) out.push(token.replace(/^\.\//, ""));
    }
  }
  return [...new Set(out)];
}
