import { dependencyId, fileId, symbolId, type EdgeKind, type LivenessGraph } from "../graph.js";
import { MODULE_BODY, type ImportBinding, type ImportRecord, type ModuleInfo } from "../parse.js";
import type { Resolution } from "../resolve.js";
import type { PythonResolver } from "./resolve.js";

/** What a name bound in a module points at. */
interface Target {
  /** Graph nodes a use of the name keeps alive. */
  ids: string[];
  /** The name is a module (file) or a namespace package (directory). */
  module?: { file?: string; dir?: string };
  external?: boolean;
}

/** Graph node id for an external Python distribution's top-level module. */
export const pythonDependencyId = (name: string) => dependencyId(`py:${name}`);

/** Connects Python modules: imports, attribute access on modules, star imports, and dotted-path strings. */
export class PythonLinker {
  private readonly tables = new Map<string, Map<string, Target>>();
  private readonly building = new Set<string>();
  private readonly stringCache = new Map<string, string[]>();

  constructor(
    private readonly graph: LivenessGraph,
    private readonly resolver: PythonResolver,
    private readonly testFiles: ReadonlySet<string>,
  ) {}

  link(path: string): void {
    const info = this.graph.modules.get(path)!;
    const from = fileId(path);
    // Loading a module runs its package's __init__.py first.
    if (path.endsWith(".py")) for (const init of this.resolver.ancestors(path)) this.graph.addEdge({ from, to: fileId(init), kind: "import" });
    const locals = new Set(info.declarations.map((d) => d.name));
    const bindings = new Map<string, Target>();
    const stars: string[] = [];

    for (const record of info.imports) {
      const owner = record.owner === MODULE_BODY ? from : symbolId(path, record.owner);
      const edgeFrom = record.owner === MODULE_BODY ? from : owner;
      if (record.kind === "dynamic") {
        this.linkDynamic(path, record, owner);
        continue;
      }
      const base = this.resolver.resolve(path, record.specifier);
      if (base.kind === "unresolved") this.graph.unresolved.push({ file: path, specifier: record.specifier, line: record.line });
      if (record.kind === "reexport-all") {
        if (base.kind === "file") {
          stars.push(base.path);
          this.importEdges(edgeFrom, base.path, record);
        } else if (base.kind === "external") this.dependencyEdge(edgeFrom, base, record.line);
        continue;
      }
      const plain = record.bindings.some((b) => b.module !== undefined);
      if (base.kind === "file") this.importEdges(edgeFrom, base.path, record);
      else if (base.kind === "external") this.dependencyEdge(edgeFrom, base, record.line);
      for (const binding of record.bindings) {
        const target = this.bindingTarget(path, record, binding, base);
        if (!target) continue;
        if (!plain && target.module?.file) this.importEdges(edgeFrom, target.module.file, record);
        if (!bindings.has(binding.local) || record.owner === MODULE_BODY) bindings.set(binding.local, target);
      }
    }

    const connect = (fromId: string, refs: string[]) => {
      for (const ref of refs) {
        const parts = ref.split(".");
        const head = parts[0]!;
        if (locals.has(head)) {
          this.graph.addEdge({ from: fromId, to: symbolId(path, head), kind: "reference" });
          continue;
        }
        const bound = bindings.get(head);
        if (bound) {
          this.edges(fromId, this.use(bound, parts.slice(1)), bound.external ? "dependency" : "reference");
          continue;
        }
        for (const star of stars) {
          const hit = this.exportOf(star, head, new Set());
          if (hit) {
            this.edges(fromId, this.use(hit, parts.slice(1)), hit.external ? "dependency" : "reference");
            break;
          }
        }
      }
    };
    connect(from, info.bodyReferences);
    for (const decl of info.declarations) connect(symbolId(path, decl.name), decl.references);

    for (const ref of info.stringRefs ?? []) {
      const owner = ref.owner === MODULE_BODY ? from : symbolId(path, ref.owner);
      for (const to of this.stringTargets(path, ref.value)) this.graph.addEdge({ from: owner, to, kind: "dynamic", line: ref.line });
    }

    this.aliases(path, info);
  }

  /** Names imported at module level and re-exported (public, or listed in `__all__`) get alias nodes, so "all exports" roots reach them. */
  private aliases(path: string, info: ModuleInfo): void {
    const table = new Map(this.table(path));
    // `from ._api import *` re-exports the target's public names.
    for (const record of info.imports) {
      if (record.kind !== "reexport-all" || record.owner !== MODULE_BODY) continue;
      const res = this.resolver.resolve(path, record.specifier);
      if (res.kind !== "file") continue;
      for (const name of this.publicNames(res.path, new Set())) {
        if (table.has(name)) continue;
        const hit = this.exportOf(res.path, name, new Set());
        if (hit) table.set(name, hit);
      }
    }
    for (const [name, target] of table) {
      const exported = info.pythonAll ? info.pythonAll.includes(name) : !name.startsWith("_");
      if (!exported || target.external || target.ids.length === 0) continue;
      const id = symbolId(path, name);
      if (this.graph.nodes.has(id)) continue;
      this.graph.addNode({ id, kind: "symbol", file: path, name, exportedAs: [name], isTest: this.testFiles.has(path) });
      this.graph.addEdge({ from: id, to: fileId(path), kind: "contains" });
      for (const to of target.ids) this.graph.addEdge({ from: id, to, kind: "reexport" });
    }
  }

  /** Names `from module import *` brings in: `__all__`, or every public top-level name. */
  private publicNames(path: string, seen: Set<string>): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const info = this.graph.modules.get(path);
    if (!info) return [];
    if (info.pythonAll) return info.pythonAll;
    const out = new Set(info.declarations.filter((d) => !d.name.startsWith("_")).map((d) => d.name));
    for (const name of this.table(path).keys()) if (!name.startsWith("_")) out.add(name);
    for (const record of info.imports) {
      if (record.kind !== "reexport-all" || record.owner !== MODULE_BODY) continue;
      const res = this.resolver.resolve(path, record.specifier);
      if (res.kind === "file") for (const name of this.publicNames(res.path, seen)) out.add(name);
    }
    return [...out];
  }

  private linkDynamic(path: string, record: ImportRecord, owner: string): void {
    if (!record.specifier) return;
    const res = this.resolver.resolve(path, record.specifier);
    if (res.kind === "file") {
      this.graph.addEdge({ from: owner, to: fileId(res.path), kind: "dynamic", line: record.line });
      for (const init of this.resolver.ancestors(res.path)) this.graph.addEdge({ from: owner, to: fileId(init), kind: "dynamic", line: record.line });
    } else if (res.kind === "external") this.dependencyEdge(owner, res, record.line);
  }

  private importEdges(from: string, file: string, record: ImportRecord): void {
    if (record.typeOnly) return;
    this.graph.addEdge({ from, to: fileId(file), kind: "import", line: record.line });
    for (const init of this.resolver.ancestors(file)) this.graph.addEdge({ from, to: fileId(init), kind: "import", line: record.line });
  }

  private dependencyEdge(from: string, res: Extract<Resolution, { kind: "external" }>, line: number): void {
    const id = this.dependency(res.package, res.builtin);
    this.graph.addEdge({ from, to: id, kind: "dependency", line });
  }

  private dependency(name: string, builtin: boolean): string {
    const id = pythonDependencyId(name);
    this.graph.addNode({ id, kind: "dependency", name, isTest: false, exportedAs: builtin ? ["builtin"] : [] });
    return id;
  }

  private edges(from: string, ids: string[], kind: EdgeKind): void {
    for (const to of ids) this.graph.addEdge({ from, to, kind });
  }

  /** What `import x` / `from x import y` binds a name to. */
  private bindingTarget(path: string, record: ImportRecord, binding: ImportBinding, base: Resolution): Target | undefined {
    if (binding.module !== undefined) {
      const res = binding.module === record.specifier ? base : this.resolver.resolve(path, binding.module);
      return this.moduleTarget(res);
    }
    if (base.kind === "external") return { ids: [this.dependency(base.package, base.builtin)], external: true };
    const sub = this.resolver.resolve(path, joinSpec(record.specifier, binding.imported));
    if (sub.kind === "file") return { ids: [fileId(sub.path)], module: { file: sub.path } };
    if (sub.kind === "asset") return { ids: [], module: { dir: sub.path } };
    if (base.kind === "file") return this.exportOf(base.path, binding.imported, new Set()) ?? { ids: [fileId(base.path)] };
    return undefined;
  }

  private moduleTarget(res: Resolution): Target | undefined {
    if (res.kind === "file") return { ids: [fileId(res.path)], module: { file: res.path } };
    if (res.kind === "asset") return { ids: [], module: { dir: res.path } };
    if (res.kind === "external") return { ids: [this.dependency(res.package, res.builtin)], external: true };
    return undefined;
  }

  /** Nodes kept alive by using a bound name, possibly through attributes (`mod.sub.func`). */
  private use(target: Target, attrs: string[]): string[] {
    if (target.external || !target.module) return target.ids;
    if (attrs.length === 0) {
      // The module object itself is used (passed around, getattr): all of its public names may be.
      const file = target.module.file;
      if (!file) return [];
      const info = this.graph.modules.get(file);
      return [fileId(file), ...(info?.declarations ?? []).filter((d) => d.exportedAs.length > 0).map((d) => symbolId(file, d.name))];
    }
    let current: Target = target;
    for (let i = 0; i < attrs.length; i++) {
      const mod = current.module;
      if (!mod) return current.ids;
      const next = mod.file ? this.exportOf(mod.file, attrs[i]!, new Set()) : this.submodule(mod.dir!, attrs[i]!);
      if (!next) return mod.file ? [fileId(mod.file)] : [];
      current = next;
      if (!current.module) return current.ids;
    }
    return current.ids;
  }

  private submodule(dir: string, name: string): Target | undefined {
    const file = this.resolver.lookup(dir, [name]);
    if (file) return { ids: [fileId(file)], module: { file } };
    return undefined;
  }

  /** What `from <module> import name` finds: a declaration, a re-exported import, a submodule, or a star import. */
  exportOf(path: string, name: string, seen: Set<string>): Target | undefined {
    if (seen.has(path)) return undefined;
    seen.add(path);
    const info = this.graph.modules.get(path);
    if (!info) return undefined;
    if (info.declarations.some((d) => d.name === name)) return { ids: [symbolId(path, name)] };
    const bound = this.table(path).get(name);
    if (bound) return bound;
    if (path === "__init__.py" || path.endsWith("/__init__.py")) {
      const sub = this.submodule(path.slice(0, -"__init__.py".length).replace(/\/$/, ""), name);
      if (sub) return sub;
    }
    for (const record of info.imports) {
      if (record.kind !== "reexport-all" || record.owner !== MODULE_BODY) continue;
      const res = this.resolver.resolve(path, record.specifier);
      if (res.kind !== "file") continue;
      const hit = this.exportOf(res.path, name, seen);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Module-level import bindings of a file. */
  private table(path: string): Map<string, Target> {
    const cached = this.tables.get(path);
    if (cached) return cached;
    if (this.building.has(path)) return new Map();
    this.building.add(path);
    const out = new Map<string, Target>();
    const info = this.graph.modules.get(path);
    for (const record of info?.imports ?? []) {
      if (record.owner !== MODULE_BODY || (record.kind !== "static")) continue;
      const base = this.resolver.resolve(path, record.specifier);
      for (const binding of record.bindings) {
        const target = this.bindingTarget(path, record, binding, base);
        if (target) out.set(binding.local, target);
      }
    }
    this.building.delete(path);
    this.tables.set(path, out);
    return out;
  }

  /**
   * A string naming a local module or `module.attr` / `module:attr`
   * ("myapp.middleware.Auth", "app.main:app", INSTALLED_APPS entries).
   */
  private stringTargets(path: string, value: string): string[] {
    const key = `${this.resolver.packageRoot(path)}\0${value}`;
    const cached = this.stringCache.get(key);
    if (cached) return cached;
    let out: string[] = [];
    if (value.endsWith(".py")) {
      // `exec(open("configurator.py").read())`, `runpy.run_path("tools/x.py")`
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const rel = value.replace(/^\.\//, "");
      for (const candidate of [dir ? `${dir}/${rel}` : rel, rel]) {
        if (this.resolver.hasFile(candidate)) {
          out = [fileId(candidate)];
          break;
        }
      }
      this.stringCache.set(key, out);
      return out;
    }
    const [modulePart, attr] = value.includes(":") ? (value.split(":") as [string, string]) : [value, undefined];
    const parts = modulePart.split(".");
    for (let k = parts.length; k >= 1; k--) {
      const res = this.resolver.resolve(path, parts.slice(0, k).join("."));
      if (res.kind !== "file") continue;
      // A bare word only counts when it names a package (`INSTALLED_APPS = ["blog"]`), not any module.
      if (k === 1 && parts.length === 1 && !attr && !res.path.endsWith("__init__.py")) break;
      const rest = [...parts.slice(k), ...(attr ? attr.split(".") : [])];
      const target: Target = { ids: [fileId(res.path)], module: { file: res.path } };
      // A module named by string is loaded and read by attribute name (`urlpatterns`, `host_patterns`), so its public names count.
      out = [fileId(res.path), ...this.use(target, rest)];
      out.push(...this.resolver.ancestors(res.path).map(fileId));
      break;
    }
    this.stringCache.set(key, out);
    return out;
  }
}

function joinSpec(specifier: string, name: string): string {
  return specifier.endsWith(".") ? specifier + name : `${specifier}.${name}`;
}
