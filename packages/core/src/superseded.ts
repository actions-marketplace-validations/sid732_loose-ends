import type { ChangedFile } from "./git.js";
import type { GraphNode } from "./graph.js";
import { makeFinding, type Finding } from "./findings.js";
import { label, stateOf, type Analysis } from "./liveness.js";

/** Jaccard similarity of two sorted shingle arrays. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i]! < b[j]!) i++;
    else j++;
  }
  return shared / (a.length + b.length - shared);
}

/** Strip version and age markers so `fetchUsersV2` and `legacyFetchUsers` compare equal. */
export function normalizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter((w) => w && !/^(v\d+|\d+|new|old|legacy|next|improved|impl|deprecated|refactored|updated|alt)$/.test(w))
    .join("");
}

export interface Replacement {
  old: string;
  replacement: string;
  score: number;
  structure: number;
  callersMoved: string[];
  sameName: boolean;
}

const MIN_TOKENS = 12;

/** Score how likely `fresh` (added in head) replaced `old` (live in base). */
export function scoreReplacement(base: Analysis, head: Analysis, old: GraphNode, fresh: GraphNode, toHead: (id: string) => string): Replacement {
  const a = old.declaration!;
  const b = fresh.declaration!;
  const bigEnough = Math.min(a.tokens, b.tokens) >= MIN_TOKENS;
  const structure = bigEnough ? similarity(a.shape, b.shape) : 0;
  const sameName = normalizeName(old.name!) === normalizeName(fresh.name!) && normalizeName(old.name!).length > 0;
  const oldCallers = new Set(
    base.graph
      .in(old.id)
      .filter((e) => e.kind !== "contains" && e.kind !== "reexport")
      .map((e) => toHead(e.from)),
  );
  const callersMoved = head.graph
    .in(fresh.id)
    .filter((e) => e.kind !== "contains" && oldCallers.has(e.from))
    .map((e) => label(head.graph.nodes.get(e.from), e.from));
  const score = Math.min(1, (callersMoved.length > 0 ? 0.45 : 0) + (sameName ? 0.25 : 0) + 0.45 * structure);
  return { old: old.id, replacement: fresh.id, score, structure, callersMoved: [...new Set(callersMoved)].sort(), sameName };
}

const qualifies = (r: Replacement) => r.score >= 0.55 || r.structure >= 0.85;

/**
 * Turn newly-orphaned findings into superseded findings when an implementation
 * added in the same change looks like their replacement, and flag added code
 * that duplicates an existing live implementation.
 */
export function detectSuperseded(base: Analysis, head: Analysis, _changed: ChangedFile[], findings: Finding[], toHead: (id: string) => string): Finding[] {
  const baseIds = new Set([...base.graph.nodes.keys()].map(toHead));
  const added = [...head.graph.nodes.values()].filter(
    (n) => n.kind === "symbol" && n.declaration && !n.isTest && !baseIds.has(n.id) && stateOf(head, n.id).liveness === "live",
  );
  const fromHead = new Map([...base.graph.nodes.keys()].map((id) => [toHead(id), id]));
  const out: Finding[] = [];
  const consumed = new Set<string>();

  for (const finding of findings) {
    if (finding.kind !== "newly-orphaned" && finding.kind !== "newly-test-only") {
      out.push(finding);
      continue;
    }
    const headNode = head.graph.nodes.get(finding.node);
    const baseId = fromHead.get(finding.node);
    const candidates =
      headNode?.kind === "file"
        ? base.graph.symbolsOf(base.graph.nodes.get(baseId ?? "")?.file ?? "").filter((n) => n.declaration)
        : baseId
          ? [base.graph.nodes.get(baseId)!].filter((n) => n.declaration)
          : [];
    const matches: Replacement[] = [];
    for (const old of candidates) {
      let best: Replacement | undefined;
      for (const fresh of added) {
        const r = scoreReplacement(base, head, old, fresh, toHead);
        if (qualifies(r) && (!best || r.score > best.score)) best = r;
      }
      if (best) matches.push(best);
    }
    if (matches.length === 0) {
      out.push(finding);
      continue;
    }
    matches.sort((x, y) => y.score - x.score);
    const top = matches[0]!;
    const replacements = [...new Set(matches.map((m) => label(head.graph.nodes.get(m.replacement), m.replacement)))];
    const reasons: string[] = [];
    if (top.callersMoved.length) reasons.push(`its callers now use the new code (${top.callersMoved.slice(0, 3).join(", ")})`);
    if (top.sameName) reasons.push("the names match");
    if (top.structure > 0) reasons.push(`${Math.round(top.structure * 100)}% structural similarity`);
    const superseded = makeFinding(
      "superseded",
      headNode,
      finding.node,
      `${finding.target} appears to have been replaced by ${replacements.slice(0, 3).join(", ")} but was not removed: ${reasons.join("; ")}. Delete it, or mark it dormant with a reason.`,
      { ...finding.evidence, related: replacements, similarity: Math.round(top.score * 100) / 100 },
    );
    out.push(superseded);
    for (const m of matches) consumed.add(m.replacement);
  }

  // Added code that copies an existing live implementation.
  const existing = [...head.graph.nodes.values()].filter(
    (n) =>
      n.kind === "symbol" &&
      n.declaration &&
      !n.isTest &&
      baseIds.has(n.id) &&
      (n.declaration.kind === "function" || n.declaration.kind === "class" || n.declaration.kind === "variable") &&
      n.declaration.tokens >= 40 &&
      stateOf(head, n.id).liveness === "live",
  );
  for (const fresh of added) {
    const decl = fresh.declaration!;
    if (consumed.has(fresh.id) || decl.tokens < 40) continue;
    if (decl.kind !== "function" && decl.kind !== "class" && decl.kind !== "variable") continue;
    let best: { node: GraphNode; score: number } | undefined;
    for (const other of existing) {
      const ratio = other.declaration!.tokens / decl.tokens;
      if (ratio < 0.7 || ratio > 1.4) continue;
      const score = similarity(decl.shape, other.declaration!.shape);
      if (score >= 0.9 && (!best || score > best.score)) best = { node: other, score };
    }
    if (!best) continue;
    out.push(
      makeFinding(
        "duplicate",
        fresh,
        fresh.id,
        `${label(fresh)} added in this change is ${Math.round(best.score * 100)}% structurally identical to ${label(best.node)}. Reuse the existing implementation, or remove the old one.`,
        { after: "live", related: [label(best.node)], similarity: Math.round(best.score * 100) / 100 },
      ),
    );
  }
  return out;
}
