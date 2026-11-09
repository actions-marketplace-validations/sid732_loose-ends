import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { discoverFiles, type SourceFile } from "./discover.js";
import { createMatcher } from "./paths.js";
import { MODULE_BODY, parseComponent, parseModule, type Declaration, type ImportBinding, type ImportRecord, type ModuleInfo } from "./parse.js";
import { Resolver, isPython, type Resolution } from "./resolve.js";
import { parseNotebook, parsePython } from "./python/parse.js";
import { PythonLinker } from "./python/link.js";
import { parseJava } from "./java/parse.js";
import { JavaLinker } from "./java/link.js";
import type { LooseEndsConfig } from "./types.js";

export type NodeKind = "file" | "symbol" | "dependency";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** File path for file and symbol nodes. */
  file?: string;
  /** Local name for symbols, package name for dependencies. */
  name?: string;
  /** Export names, for symbols. */
  exportedAs?: string[];
  isTest: boolean;
  /** Present for symbols declared in source. Absent for re-export aliases. */
  declaration?: Declaration;
  line?: number;
}

export type EdgeKind =
  /** Loading a module executes its body. */
  | "import"
  /** A declaration or module body references a symbol. */
  | "reference"
  /** A symbol only exists if its module is loaded. */
  | "contains"
  /** A re-export alias points at the original symbol. */
  | "reexport"
  /** `import()` or `require()` with a literal specifier. */
  | "dynamic"
  /** `import()` with a template literal; reachability is a guess. */
  | "pattern"
  /** Code uses an external package. */
  | "dependency"
  /** A root node introduced by root discovery. */
  | "root";

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Source line in `from` that creates the edge, when known. */
  line?: number;
}

export interface UnresolvedImport {
  file: string;
  specifier: string;
  line: number;
}

export const fileId = (path: string) => `file:${path}`;
export const symbolId = (path: string, name: string) => `sym:${path}#${name}`;
export const dependencyId = (name: string) => `dep:${name}`;

export class LivenessGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly outgoing = new Map<string, GraphEdge[]>();
  readonly incoming = new Map<string, GraphEdge[]>();
  readonly modules = new Map<string, ModuleInfo>();
  readonly unresolved: UnresolvedImport[] = [];
  private readonly edgeKeys = new Set<string>();

  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) return existing;
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(edge: GraphEdge): void {
    if (edge.from === edge.to) return;
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    push(this.outgoing, edge.from, edge);
    push(this.incoming, edge.to, edge);
  }

  out(id: string): GraphEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  in(id: string): GraphEdge[] {
    return this.incoming.get(id) ?? [];
  }

  /** Symbol nodes declared in a file. */
  symbolsOf(file: string): GraphNode[] {
    return this.in(fileId(file))
      .filter((e) => e.kind === "contains")
      .map((e) => this.nodes.get(e.from)!)
      .filter(Boolean);
  }

  get edgeCount(): number {
    return this.edgeKeys.size;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface BuildResult {
  graph: LivenessGraph;
  files: SourceFile[];
  resolver: Resolver;
  /** Index of Java types, when the project has Java files. */
  java?: JavaLinker;
}

/** Parse every source file and connect imports, references, and dependencies. */
export function buildGraph(config: LooseEndsConfig, options: { read?: (abs: string) => string } = {}): BuildResult {
  const read = options.read ?? ((abs: string) => readFileSync(abs, "utf8"));
  const files = discoverFiles(config);
  const paths = new Set(files.map((f) => f.path));
  const resolver = new Resolver(config, paths);
  const graph = new LivenessGraph();

  for (const file of files) {
    const parse = file.path.endsWith(".py") ? parsePython : file.path.endsWith(".ipynb") ? parseNotebook : file.path.endsWith(".java") ? parseJava : /\.(vue|svelte|astro)$/.test(file.path) ? parseComponent : parseModule;
    let info: ModuleInfo;
    try {
      info = parse(file.path, read(file.abs));
    } catch {
      info = parse(file.path, "");
    }
    graph.modules.set(file.path, info);
    graph.addNode({ id: fileId(file.path), kind: "file", file: file.path, isTest: file.isTest, line: 1 });
    for (const decl of info.declarations) {
      graph.addNode({
        id: symbolId(file.path, decl.name),
        kind: "symbol",
        file: file.path,
        name: decl.name,
        exportedAs: decl.exportedAs,
        isTest: file.isTest,
        declaration: decl,
        line: decl.line,
      });
      graph.addEdge({ from: symbolId(file.path, decl.name), to: fileId(file.path), kind: "contains", line: decl.line });
      if (decl.sideEffects) graph.addEdge({ from: fileId(file.path), to: symbolId(file.path, decl.name), kind: "reference", line: decl.line });
    }
  }

  const linker = new Linker(graph, resolver, files);
  const python = files.some((f) => isPython(f.path)) ? new PythonLinker(graph, resolver.python, new Set(files.filter((f) => f.isTest).map((f) => f.path))) : undefined;
  const java = files.some((f) => f.path.endsWith(".java")) ? new JavaLinker(graph) : undefined;
  for (const file of files) {
    if (python && isPython(file.path)) python.link(file.path);
    else if (java && file.path.endsWith(".java")) java.link(file.path);
    else linker.link(file);
  }
  return { graph, files, resolver, java };
}

class Linker {
  private readonly testFiles: Set<string>;
  private readonly allPaths: string[];

  constructor(
    private readonly graph: LivenessGraph,
    private readonly resolver: Resolver,
    files: SourceFile[],
  ) {
    this.testFiles = new Set(files.filter((f) => f.isTest).map((f) => f.path));
    this.allPaths = files.map((f) => f.path);
  }

  link(file: SourceFile): void {
    const info = this.graph.modules.get(file.path)!;
    const from = fileId(file.path);
    const locals = new Set(info.declarations.map((d) => d.name));
    const bindings = new Map<string, { record: ImportRecord; binding: ImportBinding; target: Resolution }>();

    for (const record of info.imports) {
      const target = record.specifier ? this.resolver.resolve(file.path, record.specifier) : undefined;
      if (target?.kind === "unresolved") this.graph.unresolved.push({ file: file.path, specifier: record.specifier, line: record.line });
      if (target && (record.kind === "static" || record.kind === "require")) {
        for (const binding of record.bindings) if (binding.local) bindings.set(binding.local, { record, binding, target });
      }
      this.linkRecord(file.path, record, target);
    }

    // Local exports of imported bindings: `import { a } from "./x"; export { a }`.
    for (const exp of info.localExports) {
      if (locals.has(exp.local)) continue;
      const imported = bindings.get(exp.local);
      if (!imported) continue;
      const alias = this.alias(file.path, exp.exported);
      for (const to of this.targetsFor(imported.target, imported.binding.imported)) {
        this.graph.addEdge({ from: alias, to, kind: "reexport", line: imported.record.line });
      }
    }

    const connect = (fromId: string, references: string[], line?: number) => {
      for (const name of references) {
        if (locals.has(name)) {
          this.graph.addEdge({ from: fromId, to: symbolId(file.path, name), kind: "reference", line });
          continue;
        }
        const imported = bindings.get(name);
        if (!imported) continue;
        const kind = imported.target.kind === "external" ? "dependency" : "reference";
        for (const to of this.targetsFor(imported.target, imported.binding.imported)) {
          this.graph.addEdge({ from: fromId, to, kind, line: imported.record.line });
        }
      }
    };

    connect(from, info.bodyReferences);
    for (const decl of info.declarations) connect(symbolId(file.path, decl.name), decl.references, decl.line);
  }

  private linkRecord(path: string, record: ImportRecord, target: Resolution | undefined) {
    const owner = record.owner === MODULE_BODY ? fileId(path) : symbolId(path, record.owner);
    const from = fileId(path);

    if (record.pattern) {
      for (const to of this.patternTargets(path, record.pattern)) {
        this.graph.addEdge({ from: owner, to: fileId(to), kind: "pattern", line: record.line });
      }
      return;
    }
    if (!target || target.kind === "unresolved" || target.kind === "asset") return;

    if (target.kind === "external") {
      const dep = this.dependency(target.package, target.builtin);
      if (record.atLoad || record.typeOnly) this.graph.addEdge({ from, to: dep, kind: "dependency", line: record.line });
      if (record.owner !== MODULE_BODY) this.graph.addEdge({ from: owner, to: dep, kind: "dependency", line: record.line });
      return;
    }

    const targetFile = fileId(target.path);
    if (target.package) {
      // Importing a workspace package by name is a use of that dependency.
      const dep = this.dependency(target.package, false);
      this.graph.addEdge({ from: record.owner === MODULE_BODY ? from : owner, to: dep, kind: "dependency", line: record.line });
    }
    switch (record.kind) {
      case "static":
      case "side-effect":
        if (!record.typeOnly) this.graph.addEdge({ from, to: targetFile, kind: "import", line: record.line });
        break;
      case "reexport":
        if (!record.typeOnly) this.graph.addEdge({ from, to: targetFile, kind: "import", line: record.line });
        for (const binding of record.bindings) {
          const alias = this.alias(path, binding.local);
          for (const to of this.targetsFor(target, binding.imported)) {
            this.graph.addEdge({ from: alias, to, kind: "reexport", line: record.line });
          }
        }
        break;
      case "reexport-all":
        if (!record.typeOnly) this.graph.addEdge({ from, to: targetFile, kind: "import", line: record.line });
        break;
      case "dynamic":
      case "require":
        if (record.atLoad) this.graph.addEdge({ from, to: targetFile, kind: "dynamic", line: record.line });
        if (record.owner !== MODULE_BODY || record.bindings.every((b) => !b.local)) {
          for (const to of this.targetsFor(target, "*")) this.graph.addEdge({ from: owner, to, kind: "dynamic", line: record.line });
        }
        break;
    }
  }

  /** Synthetic node for a name re-exported from another module. */
  private alias(path: string, exported: string): string {
    const id = symbolId(path, exported);
    if (!this.graph.nodes.has(id)) {
      this.graph.addNode({
        id,
        kind: "symbol",
        file: path,
        name: exported,
        exportedAs: [exported],
        isTest: this.testFiles.has(path),
      });
      this.graph.addEdge({ from: id, to: fileId(path), kind: "contains" });
    }
    return id;
  }

  private dependency(name: string, builtin: boolean): string {
    const id = dependencyId(name);
    this.graph.addNode({ id, kind: "dependency", name, isTest: false, exportedAs: builtin ? ["builtin"] : [] });
    return id;
  }

  /** Nodes that an import of `name` from a resolved target keeps alive. */
  targetsFor(target: Resolution, name: string): string[] {
    if (target.kind === "external") return [this.dependency(target.package, target.builtin)];
    if (target.kind !== "file") return [];
    if (name === "*") return [fileId(target.path), ...this.allExports(target.path, new Set())];
    const found = this.findExport(target.path, name, new Set());
    return found.length ? found : [fileId(target.path)];
  }

  private findExport(path: string, name: string, seen: Set<string>): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const info = this.graph.modules.get(path);
    if (!info) return [];
    const direct = info.declarations.filter((d) => d.exportedAs.includes(name)).map((d) => symbolId(path, d.name));
    if (direct.length) return direct;
    const alias = symbolId(path, name);
    const aliasNode = this.graph.nodes.get(alias);
    if (aliasNode && !aliasNode.declaration) return [alias];
    if (info.imports.some((i) => i.kind === "reexport" && i.bindings.some((b) => b.local === name))) {
      return [this.alias(path, name)];
    }
    if (info.localExports.some((e) => e.exported === name)) return [this.alias(path, name)];
    for (const record of info.imports) {
      if (record.kind !== "reexport-all") continue;
      const target = this.resolver.resolve(path, record.specifier);
      if (target.kind !== "file") continue;
      const hit = this.findExport(target.path, name, seen);
      if (hit.length) return hit;
    }
    if (info.commonjs) return [fileId(path)];
    return [];
  }

  private allExports(path: string, seen: Set<string>): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const info = this.graph.modules.get(path);
    if (!info) return [];
    const out = info.declarations.filter((d) => d.exportedAs.length > 0).map((d) => symbolId(path, d.name));
    for (const record of info.imports) {
      if (record.kind === "reexport") for (const b of record.bindings) out.push(this.alias(path, b.local));
      if (record.kind === "reexport-all") {
        const target = this.resolver.resolve(path, record.specifier);
        if (target.kind === "file") out.push(...this.allExports(target.path, seen));
      }
    }
    for (const exp of info.localExports) {
      if (!info.declarations.some((d) => d.name === exp.local)) out.push(this.alias(path, exp.exported));
    }
    return out;
  }

  private patternTargets(from: string, pattern: string): string[] {
    const glob = posix.normalize(posix.join(posix.dirname(from), pattern));
    const match = createMatcher([glob]);
    const matchNoExt = createMatcher([glob.replace(/\.[a-z]+$/i, "") + ".*", glob + ".*", glob + "/index.*"]);
    return this.allPaths.filter((p) => p !== from && (match(p) || matchNoExt(p)));
  }
}
