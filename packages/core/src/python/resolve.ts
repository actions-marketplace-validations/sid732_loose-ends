import { posix } from "node:path";
import type { Resolution } from "../resolve.js";
import { STDLIB } from "./packages.js";
import type { PythonProject } from "./project.js";

/**
 * Resolves Python imports (`a.b.c`, `.sibling`, `..pkg`) to analyzed files.
 * Absolute imports are looked up from the importing file's package root
 * (where `python -m` or a script run would put it on sys.path), then from
 * each Python project's directory and its `src/`, then from parent directories.
 */
export class PythonResolver {
  /** Directories that hold Python files, directly or below. */
  private readonly dirs = new Set<string>();
  private readonly sourceRoots: string[];
  private readonly cache = new Map<string, Resolution>();

  constructor(
    private readonly files: ReadonlySet<string>,
    readonly projects: PythonProject[],
  ) {
    for (const file of files) {
      if (!file.endsWith(".py")) continue;
      let dir = parent(file);
      while (dir && !this.dirs.has(dir)) {
        this.dirs.add(dir);
        dir = parent(dir);
      }
    }
    const roots = new Set<string>();
    for (const p of projects) for (const r of [p.dir, join(p.dir, "src"), ...p.sourceDirs.map((d) => join(p.dir, d))]) roots.add(r);
    roots.add("");
    roots.add("src");
    this.sourceRoots = [...roots].filter((r) => r === "" || this.dirs.has(r));
  }

  resolve(from: string, specifier: string): Resolution {
    const key = `${parent(from)}\0${specifier}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.resolveUncached(from, specifier);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private resolveUncached(from: string, specifier: string): Resolution {
    if (specifier.startsWith(".")) {
      const dots = /^\.+/.exec(specifier)![0].length;
      let dir = parent(from);
      for (let i = 1; i < dots; i++) dir = parent(dir);
      const rest = specifier.slice(dots);
      const parts = rest ? rest.split(".") : [];
      const file = parts.length ? this.lookup(dir, parts) : this.packageFile(dir);
      if (file) return { kind: "file", path: file };
      if (this.dirs.has(join(dir, ...parts)) || (!parts.length && this.dirs.has(dir))) return { kind: "asset", path: join(dir, ...parts) };
      return { kind: "unresolved", specifier };
    }
    const parts = specifier.split(".");
    const roots = this.rootsFor(from);
    for (const root of roots) {
      const file = this.lookup(root, parts);
      if (file) return { kind: "file", path: file };
    }
    const head = parts[0]!;
    if (STDLIB.has(head)) return { kind: "external", package: head, builtin: true };
    // A directory of modules without __init__.py is a namespace package.
    for (const root of roots) if (this.dirs.has(join(root, ...parts))) return { kind: "asset", path: join(root, ...parts) };
    return { kind: "external", package: head, builtin: false };
  }

  /** Resolve `module.path` (from an entry point or a command) relative to a directory first. */
  resolveModule(dir: string, dotted: string): string | undefined {
    const parts = dotted.split(".");
    for (const root of [dir, ...this.sourceRoots]) {
      const file = this.lookup(root, parts);
      if (file) return file;
    }
    return undefined;
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  /** `a/b/c.py` or `a/b/c/__init__.py` under `dir`. */
  lookup(dir: string, parts: string[]): string | undefined {
    const base = join(dir, ...parts);
    if (this.files.has(base + ".py")) return base + ".py";
    return this.packageFile(base);
  }

  packageFile(dir: string): string | undefined {
    const init = join(dir, "__init__.py");
    return this.files.has(init) ? init : undefined;
  }

  /**
   * `__init__.py` files Python runs before a module: its package and every
   * parent package. Folders without one (namespace packages) are passed over.
   */
  ancestors(path: string): string[] {
    const out: string[] = [];
    if (path === "__init__.py") return out;
    let dir = path.endsWith("/__init__.py") ? parent(parent(path)) : parent(path);
    if (path.endsWith("/__init__.py") && parent(path) === "") return out;
    for (;;) {
      const init = this.packageFile(dir);
      if (init) out.push(init);
      if (dir === "") break;
      dir = parent(dir);
    }
    return out;
  }

  /** The directory that holds the top-level package containing `file`. */
  packageRoot(file: string): string {
    let dir = parent(file);
    while (dir !== "" && this.packageFile(dir)) dir = parent(dir);
    return dir;
  }

  private rootsFor(from: string): string[] {
    const out: string[] = [];
    const add = (dir: string) => {
      if (!out.includes(dir)) out.push(dir);
    };
    const top = this.packageRoot(from);
    add(top);
    for (const root of this.sourceRoots) add(root);
    for (let dir = top; dir !== ""; ) {
      dir = parent(dir);
      add(dir);
    }
    return out;
  }
}

function parent(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}
