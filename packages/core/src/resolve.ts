import { builtinModules } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import ts from "typescript";
import { SOURCE_EXTENSIONS } from "./config.js";
import { toRelative } from "./paths.js";
import type { LooseEndsConfig } from "./types.js";
import { discoverPackages, resolveExports, type WorkspacePackage } from "./workspace.js";

export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "external"; package: string; builtin: boolean }
  | { kind: "asset"; path: string }
  | { kind: "unresolved"; specifier: string };

interface PathsConfig {
  /** Directory paths are relative to, relative to the project root. */
  base: string;
  paths: Record<string, string[]>;
}

const BUILTINS = new Set(builtinModules);
const OUT_DIRS = ["dist", "build", "lib", "out", "esm", "cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * Resolves import specifiers to project files, workspace packages, or external
 * dependencies. Paths are POSIX and relative to the project root.
 */
export class Resolver {
  readonly packages: WorkspacePackage[];
  private readonly byName = new Map<string, WorkspacePackage>();
  private readonly tsconfigCache = new Map<string, PathsConfig | undefined>();
  private readonly cache = new Map<string, Resolution>();

  constructor(
    private readonly config: LooseEndsConfig,
    private readonly files: ReadonlySet<string>,
  ) {
    this.packages = discoverPackages(config.root);
    for (const pkg of this.packages) if (pkg.name) this.byName.set(pkg.name, pkg);
  }

  resolve(from: string, specifier: string): Resolution {
    const key = `${posix.dirname(from)}\0${specifier}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.resolveUncached(from, specifier);
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** Map a path from a manifest (possibly a build output) to an analyzed source file. */
  resolveEntry(dir: string, target: string): string | undefined {
    const rel = posix.normalize(posix.join(dir, target));
    return this.fileOrSource(rel);
  }

  private resolveUncached(from: string, specifier: string): Resolution {
    const clean = specifier.replace(/[?#].*$/, "");
    if (clean.startsWith("node:") || BUILTINS.has(clean) || BUILTINS.has(clean.split("/")[0]!)) {
      return { kind: "external", package: clean.replace(/^node:/, "").split("/")[0]!, builtin: true };
    }
    if (clean.startsWith(".") || clean.startsWith("/")) {
      const base = clean.startsWith("/") ? clean.slice(1) : posix.join(posix.dirname(from), clean);
      return this.resolvePath(posix.normalize(base), specifier);
    }

    const aliased = this.resolveAlias(from, clean);
    if (aliased) return aliased;

    const { name, subpath } = splitPackage(clean);
    const workspace = this.byName.get(name);
    if (workspace) {
      const target = this.resolveWorkspace(workspace, subpath);
      if (target) return { kind: "file", path: target };
    }
    return { kind: "external", package: name, builtin: false };
  }

  private resolvePath(rel: string, specifier: string): Resolution {
    const file = this.fileOrSource(rel);
    if (file) return { kind: "file", path: file };
    const abs = join(this.config.root, rel);
    if (existsSync(abs) && statSync(abs).isFile()) return { kind: "asset", path: rel };
    return { kind: "unresolved", specifier };
  }

  /** Try the path as written, with source extensions, as a directory index, and as a TS-for-JS mapping. */
  private fileOrSource(rel: string): string | undefined {
    const candidates: string[] = [rel];
    const ext = posix.extname(rel);
    const mapped = JS_TO_TS[ext];
    if (mapped) for (const m of mapped) candidates.push(rel.slice(0, -ext.length) + m);
    for (const e of SOURCE_EXTENSIONS) candidates.push(rel + e);
    for (const e of SOURCE_EXTENSIONS) candidates.push(posix.join(rel, "index" + e));
    for (const c of candidates) if (this.files.has(c)) return c;

    // Build output paths like dist/index.js usually mirror src/index.ts.
    const segments = rel.split("/");
    const outIndex = segments.findIndex((s) => OUT_DIRS.includes(s));
    if (outIndex !== -1) {
      const swapped = [...segments.slice(0, outIndex), "src", ...segments.slice(outIndex + 1)].join("/");
      const stripped = swapped.replace(/\.(d\.)?(m|c)?[jt]sx?$/, "");
      for (const e of SOURCE_EXTENSIONS) if (this.files.has(stripped + e)) return stripped + e;
      for (const e of SOURCE_EXTENSIONS) if (this.files.has(posix.join(stripped, "index" + e))) return posix.join(stripped, "index" + e);
    }
    return undefined;
  }

  private resolveWorkspace(pkg: WorkspacePackage, subpath: string): string | undefined {
    const manifest = pkg.manifest;
    const targets = resolveExports(manifest.exports, subpath === "" ? "." : `./${subpath}`);
    if (subpath === "") {
      for (const field of ["source", "module", "main"] as const) {
        const value = manifest[field];
        if (typeof value === "string") targets.push(value);
      }
      targets.push("src/index", "index");
    } else if (manifest.exports === undefined) {
      targets.push(subpath, `src/${subpath}`);
    }
    for (const target of targets) {
      const hit = this.resolveEntry(pkg.dir, target);
      if (hit) return hit;
    }
    return undefined;
  }

  private resolveAlias(from: string, specifier: string): Resolution | undefined {
    const cfg = this.pathsFor(posix.dirname(from));
    if (!cfg) return undefined;
    for (const [pattern, targets] of Object.entries(cfg.paths)) {
      const star = pattern.indexOf("*");
      let matched: string | undefined;
      if (star === -1) {
        if (pattern === specifier) matched = "";
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
          matched = specifier.slice(prefix.length, specifier.length - suffix.length);
        }
      }
      if (matched === undefined) continue;
      for (const target of targets) {
        const rel = posix.normalize(posix.join(cfg.base, target.replace("*", matched)));
        const file = this.fileOrSource(rel);
        if (file) return { kind: "file", path: file };
      }
    }
    return undefined;
  }

  /** Find the nearest tsconfig/jsconfig at or above a directory and read its path aliases. */
  private pathsFor(dir: string): PathsConfig | undefined {
    if (this.tsconfigCache.has(dir)) return this.tsconfigCache.get(dir);
    let result: PathsConfig | undefined;
    const explicit = dir === "" || dir === "." ? this.config.tsconfig : undefined;
    const candidates = explicit ? [explicit] : ["tsconfig.json", "jsconfig.json"].map((n) => posix.join(dir === "." ? "" : dir, n));
    for (const candidate of candidates) {
      const abs = join(this.config.root, candidate);
      if (existsSync(abs)) {
        result = readPaths(this.config.root, abs);
        break;
      }
    }
    if (!result && dir !== "" && dir !== ".") result = this.pathsFor(parentDir(dir));
    this.tsconfigCache.set(dir, result);
    return result;
  }
}

function parentDir(dir: string): string {
  const parent = posix.dirname(dir);
  return parent === "." ? "" : parent;
}

function readPaths(root: string, abs: string): PathsConfig | undefined {
  const read = ts.readConfigFile(abs, ts.sys.readFile);
  if (read.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(abs), undefined, abs);
  const options = parsed.options;
  const paths = options.paths;
  if (!paths && !options.baseUrl) return undefined;
  const baseAbs = (options.pathsBasePath as string | undefined) ?? options.baseUrl ?? dirname(abs);
  const base = toRelative(root, normalize(options.baseUrl ?? baseAbs));
  const out: Record<string, string[]> = { ...(paths ?? {}) };
  // baseUrl alone makes bare specifiers resolve relative to it.
  if (options.baseUrl && !("*" in out)) out["*"] = ["*"];
  return { base, paths: out };
}

export function splitPackage(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) {
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  return { name: parts[0]!, subpath: parts.slice(1).join("/") };
}
