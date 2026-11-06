import { createHash } from "node:crypto";
import { allSuppressions, type SuppressionRecord } from "./directives.js";
import type { ChangedFile } from "./git.js";
import { fileId, type GraphEdge, type GraphNode } from "./graph.js";
import { label, pathTo, stateOf, type Analysis, type Liveness } from "./liveness.js";
import { targetMatches } from "./paths.js";
import type { FindingKind, Severity } from "./types.js";

export interface PathStep {
  /** Node label, e.g. `src/a.ts#run`. */
  node: string;
  /** Edge kind used to reach this step from the previous one. */
  edge?: GraphEdge["kind"];
  /** Line in the previous step's file that creates the edge. */
  line?: number;
}

export interface Evidence {
  before?: Liveness;
  after: Liveness;
  /** How the code was (or is) reached, root first. */
  path?: PathStep[];
  /** Root that reached it. */
  root?: string;
  /** The edge on the old path that no longer keeps it alive. */
  brokenEdge?: { from: string; to: string; reason: "removed" | "source-not-live" };
  /** Files or symbols that still import or reference it (themselves not live). */
  referencedBy?: string[];
  /** Related code, e.g. the implementation that replaced this one. */
  related?: string[];
  note?: string;
  /** Runtime coverage hits, when a coverage report was supplied. */
  coverage?: { hits: number; source: string };
  /** Similarity score for superseded findings. */
  similarity?: number;
}

export interface Finding {
  /** Stable identifier: hash of kind and target. */
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** `path` or `path#symbol`. */
  target: string;
  node: string;
  file?: string;
  symbol?: string;
  line?: number;
  endLine?: number;
  message: string;
  evidence: Evidence;
  suppressed?: { reason: string; origin: string };
}

export const SEVERITY: Record<FindingKind, Severity> = {
  "orphaned-addition": "error",
  "newly-orphaned": "error",
  superseded: "error",
  "invalid-suppression": "error",
  "test-only-addition": "warning",
  "newly-test-only": "warning",
  "unused-dependency": "warning",
  duplicate: "warning",
  uncertain: "info",
  orphaned: "warning",
  "test-only": "info",
};

export function makeFinding(kind: FindingKind, node: GraphNode | undefined, nodeId: string, message: string, evidence: Evidence): Finding {
  const target = label(node, nodeId);
  return {
    id: createHash("sha1").update(`${kind}\0${target}`).digest("hex").slice(0, 12),
    kind,
    severity: SEVERITY[kind],
    target,
    node: nodeId,
    file: node?.file,
    symbol: node?.kind === "symbol" ? node.name : undefined,
    line: node?.declaration?.line ?? (node?.kind === "file" ? 1 : node?.line),
    endLine: node?.declaration?.endLine,
    message,
    evidence,
  };
}

/** Nodes that findings are reported for: source files and declared symbols outside tests. */
function reportable(node: GraphNode): boolean {
  if (node.isTest) return false;
  if (node.kind === "file") return true;
  return node.kind === "symbol" && node.declaration !== undefined;
}

export function describePath(analysis: Analysis, id: string): PathStep[] {
  const edges = pathTo(analysis, id);
  const state = stateOf(analysis, id);
  const first = edges[0]?.from ?? (state.root ? state.root.node : id);
  const steps: PathStep[] = [{ node: label(analysis.graph.nodes.get(first), first) }];
  for (const edge of edges) steps.push({ node: label(analysis.graph.nodes.get(edge.to), edge.to), edge: edge.kind, line: edge.line });
  return steps;
}

function referencedBy(analysis: Analysis, id: string): string[] {
  const out = new Set<string>();
  for (const edge of analysis.graph.in(id)) {
    if (edge.kind === "contains") continue;
    const from = analysis.graph.nodes.get(edge.from);
    if (from) out.add(label(from));
  }
  return [...out].sort().slice(0, 10);
}

/** Map base node ids to head ids so renamed files compare as the same code. */
export function renameMap(changed: ChangedFile[]): (baseId: string) => string {
  const renames = new Map<string, string>();
  for (const c of changed) if (c.status === "renamed" && c.oldPath) renames.set(c.oldPath, c.path);
  if (renames.size === 0) return (id) => id;
  return (id) => {
    const match = /^(file|sym):([^#]+)(#.*)?$/.exec(id);
    if (!match) return id;
    const renamed = renames.get(match[2]!);
    return renamed ? `${match[1]}:${renamed}${match[3] ?? ""}` : id;
  };
}

export interface CompareOptions {
  changed?: ChangedFile[];
}

/**
 * Compare base and head analyses and report what the change did to liveness.
 * Pre-existing problems in unchanged code are not reported.
 */
export function compareAnalyses(base: Analysis, head: Analysis, options: CompareOptions = {}): Finding[] {
  const toHead = renameMap(options.changed ?? []);
  const baseIds = new Map<string, string>();
  for (const id of base.graph.nodes.keys()) baseIds.set(toHead(id), id);
  const findings: Finding[] = [];
  const reportedFiles = new Set<string>();

  const nodes = [...head.graph.nodes.values()].filter(reportable).sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "file" ? -1 : 1));
  for (const node of nodes) {
    const after = stateOf(head, node.id);
    if (after.liveness === "live" || after.liveness === "dormant") continue;
    if (node.kind === "symbol" && node.file && reportedFiles.has(node.file)) continue;
    const baseId = baseIds.get(node.id);
    const before = baseId ? stateOf(base, baseId) : undefined;
    const what = node.kind === "file" ? "File" : describeSymbol(node);

    let finding: Finding | undefined;
    if (!before) {
      if (node.kind === "symbol" && node.file && !baseIds.has(fileId(node.file)) && stateOf(head, fileId(node.file)).liveness === after.liveness) {
        continue; // covered by the file-level finding
      }
      if (after.liveness === "orphaned") {
        finding = makeFinding("orphaned-addition", node, node.id, `${what} added in this change is not reachable from any entry point.`, {
          after: "orphaned",
          referencedBy: referencedBy(head, node.id),
          note: hintFor(node),
        });
      } else if (after.liveness === "test-only") {
        finding = makeFinding("test-only-addition", node, node.id, `${what} added in this change is only reachable from tests.`, {
          after: "test-only",
          path: describePath(head, node.id),
          root: after.root?.reason,
        });
      } else if (after.liveness === "uncertain") {
        finding = makeFinding("uncertain", node, node.id, `${what} added in this change may only be reachable through dynamic imports.`, {
          after: "uncertain",
          note: after.note,
        });
      }
    } else if (before.liveness === "live") {
      const evidence: Evidence = {
        before: "live",
        after: after.liveness,
        path: describePath(base, baseId!),
        root: before.root?.reason,
        brokenEdge: brokenEdge(base, head, baseId!, toHead),
        referencedBy: referencedBy(head, node.id),
        note: after.note,
      };
      if (after.liveness === "orphaned") {
        finding = makeFinding("newly-orphaned", node, node.id, `${what} was reachable before this change and no longer is.`, evidence);
      } else if (after.liveness === "test-only") {
        finding = makeFinding("newly-test-only", node, node.id, `${what} was used by production code before this change and is now only reachable from tests.`, evidence);
      } else if (after.liveness === "uncertain") {
        finding = makeFinding("uncertain", node, node.id, `${what} was reachable before this change and may now only be reachable through dynamic imports.`, evidence);
      }
    }
    if (finding) {
      findings.push(finding);
      if (node.kind === "file") reportedFiles.add(node.file!);
    }
  }
  return findings;
}

/** Whole-project report: every unreachable or test-only production node. */
export function scanFindings(analysis: Analysis): Finding[] {
  const findings: Finding[] = [];
  const reportedFiles = new Set<string>();
  const nodes = [...analysis.graph.nodes.values()].filter(reportable).sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "file" ? -1 : 1));
  for (const node of nodes) {
    const state = stateOf(analysis, node.id);
    if (node.kind === "symbol" && node.file && reportedFiles.has(node.file)) continue;
    const what = node.kind === "file" ? "File" : describeSymbol(node);
    let finding: Finding | undefined;
    if (state.liveness === "orphaned") {
      finding = makeFinding("orphaned", node, node.id, `${what} is not reachable from any entry point.`, {
        after: "orphaned",
        referencedBy: referencedBy(analysis, node.id),
        note: hintFor(node),
      });
    } else if (state.liveness === "test-only") {
      finding = makeFinding("test-only", node, node.id, `${what} is only reachable from tests.`, {
        after: "test-only",
        path: describePath(analysis, node.id),
      });
    } else if (state.liveness === "uncertain") {
      finding = makeFinding("uncertain", node, node.id, `${what} may only be reachable through dynamic imports.`, { after: "uncertain", note: state.note });
    }
    if (finding) {
      findings.push(finding);
      if (node.kind === "file" && state.liveness !== "uncertain") reportedFiles.add(node.file!);
    }
  }
  return findings;
}

function describeSymbol(node: GraphNode): string {
  const kind = node.declaration?.kind ?? "symbol";
  const noun = kind === "expression" ? "default export" : kind;
  // Every top-level Python name is importable, so "exported" says nothing there.
  const exported = (node.exportedAs?.length ?? 0) > 0 && !node.file?.endsWith(".py") && !node.file?.endsWith(".java") ? "Exported " : "";
  return `${exported}${exported ? noun : noun[0]!.toUpperCase() + noun.slice(1)} \`${node.name}\``;
}

function hintFor(node: GraphNode): string | undefined {
  if (node.kind !== "file") return undefined;
  const comment = node.file?.endsWith(".py") ? "#" : "//";
  return `Import it from live code, add it to \`entries\`, or mark it with \`${comment} loose-ends-file: dormant <reason>\`.`;
}

/** Find the first edge on the base path that no longer keeps the node alive in head. */
function brokenEdge(base: Analysis, head: Analysis, baseId: string, toHead: (id: string) => string): Evidence["brokenEdge"] {
  const edges = pathTo(base, baseId);
  for (const edge of edges) {
    const from = toHead(edge.from);
    const to = toHead(edge.to);
    const fromLabel = label(base.graph.nodes.get(edge.from), edge.from);
    const toLabel = label(base.graph.nodes.get(edge.to), edge.to);
    const stillThere = head.graph.out(from).some((e) => e.to === to);
    if (!stillThere) return { from: fromLabel, to: toLabel, reason: "removed" };
    if (stateOf(head, from).liveness !== "live") return { from: fromLabel, to: toLabel, reason: "source-not-live" };
  }
  return undefined;
}

export interface SuppressionOutcome {
  findings: Finding[];
  /** Suppressions that are missing reasons or have expired. */
  invalid: Finding[];
}

/** Mark findings covered by suppressions and report broken suppressions. */
export function applySuppressions(analysis: Analysis, findings: Finding[], now = new Date()): SuppressionOutcome {
  const records = allSuppressions(analysis);
  const invalid: Finding[] = [];
  const active: SuppressionRecord[] = [];
  for (const record of records) {
    if (!record.reason) {
      invalid.push(invalidFinding(record, `Suppression for \`${record.target}\` at ${record.origin} needs a reason.`));
      continue;
    }
    if (record.expires && Date.parse(record.expires) < now.getTime()) {
      invalid.push(invalidFinding(record, `Suppression for \`${record.target}\` expired on ${record.expires}.`));
      continue;
    }
    active.push(record);
  }
  for (const finding of findings) {
    const match = active.find(
      (s) => (!s.kind || s.kind === finding.kind) && finding.file !== undefined && targetMatches(s.target, finding.file, finding.symbol),
    );
    if (match) finding.suppressed = { reason: match.reason, origin: match.origin };
  }
  for (const problem of analysis.problems) {
    invalid.push({
      ...makeFinding("invalid-suppression", undefined, `file:${problem.file}`, `${problem.message}.`, { after: "orphaned" }),
      file: problem.file,
      line: problem.line,
      target: problem.target,
    });
  }
  return { findings, invalid };
}

function invalidFinding(record: SuppressionRecord, message: string): Finding {
  const [file, lineText] = record.origin.split(/:(?=\d+$)/);
  return {
    ...makeFinding("invalid-suppression", undefined, `file:${record.target}`, message, { after: "orphaned" }),
    target: record.target,
    file,
    line: lineText ? Number(lineText) : undefined,
  };
}
