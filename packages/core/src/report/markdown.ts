import type { CheckResult } from "../check.js";
import type { Finding } from "../findings.js";
import type { Severity } from "../types.js";
import { counts, evidenceLines, location, plural, shortCommit } from "./common.js";

/** Hidden marker so bots can find and update their previous comment. */
export const MARKDOWN_MARKER = "<!-- loose-ends-report -->";

export interface MarkdownOptions {
  /** Prefix for file links, e.g. `https://github.com/o/r/blob/<sha>/`. */
  linkBase?: string;
  /** Maximum findings rendered before truncating. */
  limit?: number;
}

const BADGE: Record<Severity, string> = { error: "🔴", warning: "🟡", info: "🔵" };

const escape = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function link(f: Finding, options: MarkdownOptions): string {
  const text = `\`${location(f)}\``;
  if (!options.linkBase || !f.file) return text;
  const anchor = f.line ? `#L${f.line}${f.endLine && f.endLine !== f.line ? `-L${f.endLine}` : ""}` : "";
  return `[${text}](${options.linkBase}${f.file}${anchor})`;
}

export function formatMarkdown(result: CheckResult, options: MarkdownOptions = {}): string {
  const limit = options.limit ?? 50;
  const active = result.findings.filter((f) => !f.suppressed);
  const suppressed = result.findings.filter((f) => f.suppressed);
  const n = counts(result);
  const out: string[] = [MARKDOWN_MARKER];

  const status = result.passed ? (active.length ? "⚠️" : "✅") : "❌";
  const title =
    active.length === 0
      ? result.mode === "check"
        ? "No new loose ends"
        : "No loose ends"
      : `${plural(active.length, result.mode === "check" ? "new loose end" : "loose end")}`;
  out.push(`## ${status} Loose Ends: ${title}`);
  if (result.mode === "check" && result.base) {
    const head = result.head.commit ? `${result.head.ref} (${shortCommit(result.head.commit)})` : result.head.ref;
    out.push(`<sub>${result.base.ref} (${shortCommit(result.base.commit)}) → ${head} · ${plural(result.changed.length, "file")} changed</sub>`);
  }
  out.push("");

  if (active.length) {
    out.push("| | Kind | Location | Finding |", "|---|---|---|---|");
    for (const f of active.slice(0, limit)) {
      const blocking = result.failing.includes(f) ? " **(blocking)**" : "";
      out.push(`| ${BADGE[f.severity]} | \`${f.kind}\` | ${link(f, options)} | ${escape(f.message)}${blocking} |`);
    }
    if (active.length > limit) out.push("", `_…and ${active.length - limit} more. See the JSON report for the full list._`);
    out.push("");

    const withEvidence = active.slice(0, limit).filter((f) => evidenceLines(f).length);
    if (withEvidence.length) {
      out.push("<details><summary>Evidence</summary>", "");
      for (const f of withEvidence) {
        out.push(`**\`${f.target}\`** · \`${f.kind}\``);
        for (const line of evidenceLines(f)) out.push(`- ${escape(line)}`);
        out.push("");
      }
      out.push("</details>", "");
    }
  }

  if (suppressed.length) {
    out.push(`<details><summary>${plural(suppressed.length, "suppressed finding")}</summary>`, "");
    for (const f of suppressed) out.push(`- \`${f.target}\` (${f.kind}): ${escape(f.suppressed!.reason)} _(${f.suppressed!.origin})_`);
    out.push("", "</details>", "");
  }

  out.push(
    `<sub>${n.error} errors · ${n.warning} warnings · ${n.info} info${result.passed ? "" : ` · blocking: ${[...new Set(result.failing.map((f) => f.kind))].join(", ")}`}. ` +
      "Every change should lead somewhere.</sub>",
  );
  return out.join("\n") + "\n";
}
