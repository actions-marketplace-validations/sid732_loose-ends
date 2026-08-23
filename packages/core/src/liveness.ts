import { posix } from "node:path";
import { buildGraph, fileId, type BuildResult, type GraphEdge, type GraphNode, type LivenessGraph } from "./graph.js";
import { discoverRoots, type Root, type RootProvider } from "./roots.js";
import type { LooseEndsConfig } from "./types.js";

export type Liveness =
  /** Reachable from a production or tooling root. */
  | "live"
  /** Reachable only from tests. */
  | "test-only"
  /** Not reachable from any root. */
  | "orphaned"
  /** Not reachable, but explicitly marked as intentionally unused. */
  | "dormant"
  /** Possibly reachable through dynamic behavior the graph cannot follow. */
  | "uncertain";

export interface NodeState {
  liveness: Liveness;
  /** Root that first reached this node. */
  root?: Root;
  /** Edge used to reach this node on the shortest path from `root`. */
  via?: GraphEdge;
  /** Why the node is dormant or uncertain. */
  note?: string;
}

export interface Analysis {
  config: LooseEndsConfig;
  build: BuildResult;
  graph: LivenessGraph;
  roots: Root[];
  states: Map<string, NodeState>;
}

export interface AnalyzeOptions {
  providers?: RootProvider[];
  read?: (abs: string) => string;
  /** Hook to adjust states after reachability, e.g. dormant markers. */
  postProcess?: (analysis: Analysis) => void;
}

const STRONG_EDGE = (edge: GraphEdge) => edge.kind !== "pattern";

/** Build the graph, discover roots, and classify every node. */
export function analyze(config: LooseEndsConfig, options: AnalyzeOptions = {}): Analysis {
  const build = buildGraph(config, { read: options.read });
  const roots = discoverRoots(config, build, options.providers);
  const analysis = classify(config, build, roots);
  options.postProcess?.(analysis);
  return analysis;
}

export function classify(config: LooseEndsConfig, build: BuildResult, roots: Root[]): Analysis {
  const graph = build.graph;
  const states = new Map<string, NodeState>();

  const productionRoots = roots.filter((r) => r.kind !== "test");
  const testRoots = roots.filter((r) => r.kind === "test");

  walk(graph, productionRoots, STRONG_EDGE, (id, root, via) => {
    if (states.has(id)) return false;
    states.set(id, { liveness: "live", root, via });
    return true;
  });

  // Anything reachable from live code through a pattern import may be live.
  const live = [...states.keys()];
  const uncertainSeeds: Array<{ id: string; via: GraphEdge }> = [];
  for (const id of live) {
    for (const edge of graph.out(id)) if (edge.kind === "pattern" && !states.has(edge.to)) uncertainSeeds.push({ id: edge.to, via: edge });
  }
  for (const seed of uncertainSeeds) {
    walk(graph, [{ node: seed.id, kind: "production", source: "pattern", reason: "template-literal import" }], () => true, (id, root, via) => {
      if (states.has(id)) return false;
      states.set(id, { liveness: "uncertain", root, via: via ?? seed.via, note: `may be loaded by a dynamic import pattern at ${seed.via.from.replace(/^file:|^sym:/, "")}:${seed.via.line ?? "?"}` });
      return true;
    });
  }

  // Unresolvable dynamic imports (import(expr), require(expr)) in live code make siblings uncertain.
  const dynamicDirs: Array<{ dir: string; file: string }> = [];
  for (const [path, info] of graph.modules) {
    if (info.hasUnresolvableDynamic && states.get(fileId(path))?.liveness === "live") dynamicDirs.push({ dir: posix.dirname(path), file: path });
  }

  walk(graph, testRoots, STRONG_EDGE, (id, root, via) => {
    if (states.has(id)) return false;
    states.set(id, { liveness: "test-only", root, via });
    return true;
  });

  for (const node of graph.nodes.values()) {
    if (states.has(node.id)) continue;
    const file = node.file;
    const dynamic = file ? dynamicDirs.find((d) => d.dir === "." || file.startsWith(d.dir + "/")) : undefined;
    if (dynamic && node.kind === "file") {
      states.set(node.id, { liveness: "uncertain", note: `${dynamic.file} contains an import with a computed specifier` });
      continue;
    }
    states.set(node.id, { liveness: "orphaned" });
  }

  // Symbols in uncertain files inherit the uncertainty when not otherwise reached.
  for (const node of graph.nodes.values()) {
    if (node.kind !== "symbol" || !node.file) continue;
    const state = states.get(node.id)!;
    const fileState = states.get(fileId(node.file))!;
    if (state.liveness === "orphaned" && fileState.liveness === "uncertain" && (node.exportedAs?.length ?? 0) > 0) {
      states.set(node.id, { liveness: "uncertain", note: fileState.note });
    }
  }

  return { config, build, graph, roots, states };
}

/**
 * Breadth-first traversal. `visit` returns false to stop expanding a node
 * (already seen), so the first root to reach a node owns its path.
 */
function walk(
  graph: LivenessGraph,
  roots: Root[],
  follow: (edge: GraphEdge) => boolean,
  visit: (id: string, root: Root, via: GraphEdge | undefined) => boolean,
) {
  const queue: Array<{ id: string; root: Root }> = [];
  for (const root of roots) {
    if (visit(root.node, root, undefined)) queue.push({ id: root.node, root });
  }
  for (let i = 0; i < queue.length; i++) {
    const { id, root } = queue[i]!;
    for (const edge of graph.out(id)) {
      if (!follow(edge)) continue;
      if (visit(edge.to, root, edge)) queue.push({ id: edge.to, root });
    }
  }
}

/** Edges from the root to `id`, in order. Empty if the node is itself a root or unreachable. */
export function pathTo(analysis: Analysis, id: string): GraphEdge[] {
  const path: GraphEdge[] = [];
  const seen = new Set<string>();
  let current = analysis.states.get(id);
  while (current?.via && !seen.has(current.via.from)) {
    seen.add(current.via.from);
    path.unshift(current.via);
    current = analysis.states.get(current.via.from);
  }
  return path;
}

export function stateOf(analysis: Analysis, id: string): NodeState {
  return analysis.states.get(id) ?? { liveness: "orphaned" };
}

export interface LivenessSummary {
  files: Record<Liveness, number>;
  symbols: Record<Liveness, number>;
  dependencies: Record<Liveness, number>;
}

export function summarize(analysis: Analysis): LivenessSummary {
  const empty = (): Record<Liveness, number> => ({ live: 0, "test-only": 0, orphaned: 0, dormant: 0, uncertain: 0 });
  const out: LivenessSummary = { files: empty(), symbols: empty(), dependencies: empty() };
  for (const node of analysis.graph.nodes.values()) {
    if (node.isTest) continue;
    if (node.kind === "dependency" && node.exportedAs?.includes("builtin")) continue;
    const bucket = node.kind === "file" ? out.files : node.kind === "symbol" ? out.symbols : out.dependencies;
    bucket[stateOf(analysis, node.id).liveness]++;
  }
  return out;
}

/** Human label for a node, e.g. `src/a.ts`, `src/a.ts#run`, or `lodash`. */
export function label(node: GraphNode | undefined, id?: string): string {
  if (!node) return (id ?? "?").replace(/^(file|sym|dep):/, "");
  if (node.kind === "file") return node.file!;
  if (node.kind === "symbol") return `${node.file}#${node.name}`;
  return node.name!;
}
