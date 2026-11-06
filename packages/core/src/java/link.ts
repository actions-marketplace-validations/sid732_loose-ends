import { dependencyId, fileId, symbolId, type LivenessGraph } from "../graph.js";

/** JDK packages: never reported as dependencies. */
export const JAVA_BUILTIN =
  /^(java|jdk|sun|com\.sun)(\.|$)|^javax\.(swing|crypto|net|security|sql|xml(?!\.(bind|ws|soap))|naming|management|script|imageio|sound|print|accessibility|lang\.model|annotation\.processing|tools|rmi|smartcardio|transaction\.xa)(\.|$)/;

/** Graph node id for an external Java package. */
export const javaDependencyId = (pkg: string) => dependencyId(`java:${pkg}`);

interface TypeRef {
  file: string;
  name: string;
}

/**
 * Connects Java types. Every top-level type is indexed by its fully qualified
 * name, so resolution needs no source-root configuration: a simple name is
 * looked up through single-type imports, the file's own package, and
 * on-demand imports, the way javac does.
 */
export class JavaLinker {
  /**
   * Fully qualified name -> top-level types. Usually one; repositories with
   * several apps or samples can declare the same name in different modules.
   */
  readonly index = new Map<string, TypeRef[]>();
  private readonly packages = new Map<string, Map<string, TypeRef[]>>();

  constructor(private readonly graph: LivenessGraph) {
    for (const [path, info] of graph.modules) {
      if (info.language !== "java") continue;
      const pkg = info.javaPackage ?? "";
      let members = this.packages.get(pkg);
      if (!members) this.packages.set(pkg, (members = new Map()));
      for (const decl of info.declarations) {
        const ref = { file: path, name: decl.name };
        push(this.index, pkg ? `${pkg}.${decl.name}` : decl.name, ref);
        push(members, decl.name, ref);
      }
    }
  }

  /** Top-level types declared in a package. */
  typesIn(pkg: string): TypeRef[] {
    return [...(this.packages.get(pkg)?.values() ?? [])].flat();
  }

  /** Every type with this exact fully qualified name. */
  all(fqn: string): TypeRef[] {
    return this.index.get(fqn) ?? [];
  }

  /**
   * The type a qualified name refers to, trimming member and nested-type parts
   * (`a.b.Outer.Inner.CONST` -> `a.b.Outer`). With duplicates, the one closest to `from` wins.
   */
  lookup(qualified: string, from = ""): TypeRef | undefined {
    const parts = qualified.split(".");
    for (let k = parts.length; k >= 1; k--) {
      const hit = this.index.get(parts.slice(0, k).join("."));
      if (hit) return closest(hit, from);
    }
    return undefined;
  }

  link(path: string): void {
    const info = this.graph.modules.get(path)!;
    const from = fileId(path);
    const pkg = info.javaPackage ?? "";
    const locals = new Set(info.declarations.map((d) => d.name));
    const nested = new Set(info.javaNested ?? []);
    const single = new Map<string, TypeRef>();
    const wildcardPackages: string[] = [];
    const wildcardTypes: TypeRef[] = [];

    for (const imp of info.javaImports ?? []) {
      const typeName = imp.static && !imp.wildcard ? imp.name.split(".").slice(0, -1).join(".") : imp.name;
      const hit = this.lookup(typeName, path);
      if (imp.wildcard && !imp.static && this.packages.has(imp.name)) {
        wildcardPackages.push(imp.name);
        continue;
      }
      if (hit) {
        // Even an unused import keeps the type: deleting it would break compilation.
        this.graph.addEdge({ from, to: symbolId(hit.file, hit.name), kind: "import", line: imp.line });
        if (imp.wildcard) wildcardTypes.push(hit);
        else single.set(imp.name.split(".").pop()!, hit);
        continue;
      }
      const external = packageOf(typeName, imp.wildcard && !imp.static);
      if (external && !JAVA_BUILTIN.test(external)) this.dependencyEdge(from, external, imp.line);
    }

    const resolve = (chain: string): TypeRef | undefined => {
      const head = chain.split(".")[0]!;
      if (locals.has(head)) return { file: path, name: head };
      if (nested.has(head)) return undefined;
      const imported = single.get(head);
      if (imported) return imported;
      const same = this.packages.get(pkg)?.get(head);
      if (same) return closest(same, path);
      for (const p of wildcardPackages) {
        const hit = this.packages.get(p)?.get(head);
        if (hit) return closest(hit, path);
      }
      // Fully qualified use: `com.acme.util.Strings.trim(x)`.
      if (chain.includes(".") && /^[a-z]/.test(head)) return this.lookup(chain, path);
      return undefined;
    };

    for (const decl of info.declarations) {
      const owner = symbolId(path, decl.name);
      for (const ref of decl.references) {
        const target = resolve(ref);
        if (target && !(target.file === path && target.name === decl.name)) this.graph.addEdge({ from: owner, to: symbolId(target.file, target.name), kind: "reference" });
      }
    }
    for (const ref of info.stringRefs ?? []) {
      // `Class.forName("com.acme.Plugin")`
      const target = this.lookup(ref.value, path);
      if (target) this.graph.addEdge({ from: symbolId(path, ref.owner), to: symbolId(target.file, target.name), kind: "dynamic", line: ref.line });
    }
  }

  private dependencyEdge(from: string, pkg: string, line: number): void {
    const id = javaDependencyId(pkg);
    this.graph.addNode({ id, kind: "dependency", name: pkg, isTest: false, exportedAs: [] });
    this.graph.addEdge({ from, to: id, kind: "dependency", line });
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The candidate sharing the longest directory prefix with `from`. */
function closest(candidates: TypeRef[], from: string): TypeRef {
  if (candidates.length === 1 || !from) return candidates[0]!;
  const target = from.split("/");
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    const parts = c.file.split("/");
    let score = 0;
    while (score < parts.length && score < target.length && parts[score] === target[score]) score++;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Package part of a qualified name: `org.junit.jupiter.api.Test` -> `org.junit.jupiter.api`. */
function packageOf(name: string, isPackage: boolean): string | undefined {
  const parts = name.split(".");
  if (isPackage) return name;
  let k = parts.length - 1;
  // Drop nested types and static members: `a.b.Outer.Inner` -> `a.b`.
  while (k > 0 && /^[A-Z_$]/.test(parts[k - 1]!)) k--;
  return k > 0 ? parts.slice(0, k).join(".") : undefined;
}
