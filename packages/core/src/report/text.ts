import type { CheckResult } from "../check.js";
import type { Explanation } from "../explain.js";
import type { Severity } from "../types.js";
import { counts, evidenceLines, headline, location, plural } from "./common.js";

export interface TextOptions {
  color?: boolean;
  /** Include suppressed findings. */
  showSuppressed?: boolean;
}

const codes = { red: 31, yellow: 33, cyan: 36, green: 32, dim: 2, bold: 1 } as const;

function paint(enabled: boolean) {
  return (style: keyof typeof codes, text: string) => (enabled ? `\u001b[${codes[style]}m${text}\u001b[0m` : text);
}

const ICON: Record<Severity, string> = { error: "✖", warning: "▲", info: "●" };
const TONE: Record<Severity, keyof typeof codes> = { error: "red", warning: "yellow", info: "cyan" };

export function formatText(result: CheckResult, options: TextOptions = {}): string {
  const c = paint(options.color ?? false);
  const out: string[] = [];
  out.push(c("bold", `Loose Ends · ${headline(result)}`));
  if (result.mode === "check") out.push(c("dim", `${plural(result.changed.length, "file")} changed`));
  out.push("");

  const shown = result.findings.filter((f) => options.showSuppressed || !f.suppressed);
  if (shown.length === 0) out.push(c("green", result.mode === "check" ? "No new loose ends." : "No loose ends found."));
  for (const f of shown) {
    const tone = f.suppressed ? "dim" : TONE[f.severity];
    out.push(`${c(tone, `${ICON[f.severity]} ${f.severity.padEnd(7)}`)} ${c("bold", f.kind)}  ${location(f)}${f.suppressed ? c("dim", " (suppressed)") : ""}`);
    out.push(`  ${f.message}`);
    for (const line of evidenceLines(f)) out.push(c("dim", `  ${line}`));
    if (f.suppressed) out.push(c("dim", `  suppressed: ${f.suppressed.reason} (${f.suppressed.origin})`));
    out.push("");
  }

  const n = counts(result);
  const parts = [plural(n.error, "error"), plural(n.warning, "warning"), `${n.info} info`];
  if (result.summary.suppressed) parts.push(`${result.summary.suppressed} suppressed`);
  out.push(`Summary: ${parts.join(", ")}`);
  const live = result.summary.after.files;
  out.push(c("dim", `Files: ${live.live} live, ${live["test-only"]} test-only, ${live.orphaned} orphaned, ${live.uncertain} uncertain, ${live.dormant} dormant`));
  if (result.mode === "check") {
    out.push(
      result.passed
        ? c("green", "Result: pass")
        : c("red", `Result: fail (${plural(result.failing.length, "finding")} in failOn: ${[...new Set(result.failing.map((f) => f.kind))].join(", ")})`),
    );
  }
  return out.join("\n") + "\n";
}

export function formatExplanation(e: Explanation, options: TextOptions = {}): string {
  const c = paint(options.color ?? false);
  const tone = e.liveness === "live" ? "green" : e.liveness === "orphaned" ? "red" : e.liveness === "test-only" ? "yellow" : "cyan";
  const out: string[] = [`${c("bold", e.target)}  ${c(tone, e.liveness)}`];
  if (e.note) out.push(c("dim", e.note));
  if (e.isRoot && e.root) out.push(`Root: ${e.root.reason} (${e.root.source}, ${e.root.kind})`);
  else if (e.root) out.push(`Reached from root: ${e.root.reason} (${e.root.source})`);
  if (e.path.length > 1) {
    out.push("", "Path:");
    e.path.forEach((step, i) => out.push(`  ${i === 0 ? " " : "→"} ${step.node}${step.edge ? c("dim", `  [${step.edge}${step.line ? ` line ${step.line}` : ""}]`) : ""}`));
  }
  if (e.referencedBy.length) {
    out.push("", "Referenced by:");
    for (const r of e.referencedBy) out.push(`  ${r.from}  ${c("dim", `${r.edge}${r.line ? ` at line ${r.line}` : ""}, ${r.liveness}`)}`);
  } else if (!e.isRoot) {
    out.push("", "Referenced by: nothing");
  }
  if (e.exports?.length) {
    out.push("", "Exports:");
    for (const x of e.exports) out.push(`  ${x.name.padEnd(24)} ${x.liveness}`);
  }
  if (e.orphanSources.length) out.push("", `Unreachable subgraph (${e.orphanSubgraphSize} nodes) starts at: ${e.orphanSources.join(", ")}`);
  if (e.suggestions.length) out.push("", ...e.suggestions.map((s) => `- ${s}`));
  return out.join("\n") + "\n";
}
