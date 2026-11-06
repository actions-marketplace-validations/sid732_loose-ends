import type { CheckResult } from "../check.js";
import type { Finding, PathStep } from "../findings.js";
import type { Severity } from "../types.js";

export const TOOL = { name: "loose-ends", version: "1.0.2", url: "https://github.com/sid732/loose-ends" };

export function location(f: Finding): string {
  if (!f.file) return f.target;
  return f.line ? `${f.file}:${f.line}` : f.file;
}

export function formatPath(path: PathStep[] | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;
  return path.map((s) => s.node).join(" → ");
}

export function counts(result: CheckResult): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of result.findings) if (!f.suppressed) out[f.severity]++;
  return out;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 7) : "";
}

export function headline(result: CheckResult): string {
  if (result.mode === "scan") return `scan of ${result.config.root}`;
  const base = result.base ? `${result.base.ref}${result.base.commit ? ` (${shortCommit(result.base.commit)})` : ""}` : "?";
  return `check ${base} → ${result.head.ref}`;
}

/** Extra evidence lines shared by the text and markdown reporters. */
export function evidenceLines(f: Finding): string[] {
  const e = f.evidence;
  const lines: string[] = [];
  if (e.brokenEdge) {
    lines.push(
      e.brokenEdge.reason === "removed"
        ? `edge removed: ${e.brokenEdge.from} → ${e.brokenEdge.to}`
        : `${e.brokenEdge.from} is no longer live, so its edge to ${e.brokenEdge.to} no longer counts`,
    );
  }
  const path = formatPath(e.path);
  if (path) lines.push(`${e.before === "live" ? "was reached via" : "reached via"}: ${path}`);
  if (e.root) lines.push(`root: ${e.root}`);
  if (e.related?.length) lines.push(`related: ${e.related.join(", ")}`);
  if (e.referencedBy?.length && e.after !== "live") lines.push(`still referenced by unreachable code: ${e.referencedBy.join(", ")}`);
  if (e.coverage) lines.push(`runtime coverage: ${e.coverage.hits} hit${e.coverage.hits === 1 ? "" : "s"} (${e.coverage.source})`);
  if (e.note) lines.push(e.note);
  return lines;
}
