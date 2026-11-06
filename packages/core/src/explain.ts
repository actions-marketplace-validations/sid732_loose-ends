import { dependencyId, fileId, symbolId, type EdgeKind, type GraphNode } from "./graph.js";
import { describePath, type PathStep } from "./findings.js";
import { label, stateOf, type Analysis, type Liveness } from "./liveness.js";
import { parseTarget } from "./paths.js";
import type { RootKind } from "./roots.js";

export interface Reference {
  from: string;
  edge: EdgeKind;
  line?: number;
  liveness: Liveness;
}

export interface Explanation {
  target: string;
  node: string;
  kind: GraphNode["kind"];
  liveness: Liveness;
  note?: string;
  root?: { kind: RootKind; source: string; reason: string };
  /** Whether the node is itself a root. */
  isRoot: boolean;
  /** How the node is reached, root first. Empty for roots and unreachable nodes. */
  path: PathStep[];
  /** Nodes that import or reference this one. */
  referencedBy: Reference[];
  /** For unreachable code: the top of the unreachable subgraph containing it. */
  orphanSources: string[];
  /** Size of the unreachable subgraph hanging off `orphanSources`. */
  orphanSubgraphSize?: number;
  /** Exports and their liveness, for files. */
  exports?: Array<{ name: string; symbol: string; liveness: Liveness }>;
  suggestions: string[];
}

/** Find a graph node by `path`, `path#symbol`, or a package name. */
export function findNode(analysis: Analysis, target: string): GraphNode | undefined {
  const graph = analysis.graph;
  const direct = graph.nodes.get(target);
  if (direct) return direct;
  const { file, symbol } = parseTarget(target.replace(/^\.\//, ""));
  if (symbol) {
    const byLocal = graph.nodes.get(symbolId(file, symbol));
    if (byLocal) return byLocal;
    return graph.symbolsOf(file).find((s) => s.exportedAs?.includes(symbol));
  }
  return graph.nodes.get(fileId(file)) ?? graph.nodes.get(dependencyId(target));
}

export function explain(analysis: Analysis, target: string): Explanation | undefined {
  const node = findNode(analysis, target);
  if (!node) return undefined;
  const state = stateOf(analysis, node.id);
  const root = analysis.roots.find((r) => r.node === node.id);
  const referencedBy = analysis.graph
    .in(node.id)
    .filter((e) => e.kind !== "contains")
    .map((e) => ({ from: label(analysis.graph.nodes.get(e.from), e.from), edge: e.kind, line: e.line, liveness: stateOf(analysis, e.from).liveness }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const explanation: Explanation = {
    target: label(node),
    node: node.id,
    kind: node.kind,
    liveness: state.liveness,
    note: state.note,
    root: state.root ? { kind: state.root.kind, source: state.root.source, reason: state.root.reason } : undefined,
    isRoot: !!root,
    path: state.liveness === "live" || state.liveness === "test-only" || state.liveness === "uncertain" ? describePath(analysis, node.id) : [],
    referencedBy,
    orphanSources: [],
    suggestions: [],
  };

  if (node.kind === "file") {
    explanation.exports = analysis.graph
      .symbolsOf(node.file!)
      .filter((s) => (s.exportedAs?.length ?? 0) > 0)
      .map((s) => ({ name: s.exportedAs!.join(", "), symbol: label(s), liveness: stateOf(analysis, s.id).liveness }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  if (state.liveness === "orphaned" || state.liveness === "dormant") {
    const { sources, size } = orphanSubgraph(analysis, node.id);
    explanation.orphanSources = sources;
    explanation.orphanSubgraphSize = size;
  }
  explanation.suggestions = suggest(explanation);
  return explanation;
}

/** Walk incoming edges through non-live code to find what nothing references. */
function orphanSubgraph(analysis: Analysis, id: string): { sources: string[]; size: number } {
  const seen = new Set<string>([id]);
  const queue = [id];
  const sources: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const incoming = analysis.graph.in(current).filter((e) => e.kind !== "contains");
    const parents = incoming.filter((e) => stateOf(analysis, e.from).liveness !== "live");
    const node = analysis.graph.nodes.get(current);
    const container = analysis.graph.out(current).filter((e) => e.kind === "contains");
    const fileLive = container.some((c) => stateOf(analysis, c.to).liveness === "live");
    // A symbol inside an unreachable file is covered by the file; only report it when its file is live.
    if (incoming.length === 0 && (node?.kind !== "symbol" || fileLive)) sources.push(label(node, current));
    const members = node?.kind === "file" ? analysis.graph.in(current).filter((e) => e.kind === "contains").map((e) => e.from) : [];
    const next = [...parents.map((e) => e.from), ...members, ...container.filter((c) => !fileLive).map((c) => c.to)];
    for (const from of next) {
      if (seen.has(from)) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  // Fall back to the node itself when it is part of a cycle no one enters.
  return { sources: sources.length ? [...new Set(sources)].sort() : [label(analysis.graph.nodes.get(id), id)], size: seen.size };
}

function suggest(e: Explanation): string[] {
  switch (e.liveness) {
    case "live":
      return [];
    case "test-only":
      return [
        "Only tests use this. Call it from production code, or move it next to the tests if it is a test helper.",
      ];
    case "uncertain":
      return ["Liveness depends on a dynamic import. Add a literal import, list it in `entries`, or mark it with a `loose-ends: entry` comment."];
    case "dormant":
      return [];
    case "orphaned": {
      const out = [`Nothing reachable uses ${e.target}.`];
      if (e.orphanSources.length && !(e.orphanSources.length === 1 && e.orphanSources[0] === e.target)) {
        out.push(`It is only reachable from other unreachable code that starts at: ${e.orphanSources.join(", ")}.`);
      }
      out.push("Wire it into a live code path, delete it, add it to `entries` if a framework loads it, or mark it `dormant` with a reason.");
      return out;
    }
  }
}
