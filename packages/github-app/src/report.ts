import { formatMarkdown, type CheckResult, type Finding } from "@loose-ends/core";
import type { RepoSettings } from "./settings.js";

export interface ProjectResult {
  /** Project path inside the repository ("." for the root). */
  project: string;
  result?: CheckResult;
  error?: string;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
  raw_details?: string;
}

const LEVEL = { error: "failure", warning: "warning", info: "notice" } as const;

const prefixed = (project: string, file: string) => (project === "." || project === "" ? file : `${project.replace(/\/$/, "")}/${file}`);

export function annotationsFor(project: string, findings: Finding[]): Annotation[] {
  return findings
    .filter((f) => f.file && !f.suppressed)
    .map((f) => ({
      path: prefixed(project, f.file!),
      start_line: f.line ?? 1,
      end_line: f.endLine ?? f.line ?? 1,
      annotation_level: LEVEL[f.severity],
      title: `Loose Ends: ${f.kind}`,
      message: f.message,
      raw_details: JSON.stringify(f.evidence, null, 2).slice(0, 64_000),
    }));
}

export interface CheckOutput {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  annotations: Annotation[];
  /** Markdown for the PR comment. */
  comment: string;
  findings: number;
  blocking: number;
}

const MAX_SUMMARY = 65_000;

export function buildOutput(results: ProjectResult[], settings: RepoSettings, links: { linkBase: string }, warnings: string[] = []): CheckOutput {
  const sections: string[] = [];
  const annotations: Annotation[] = [];
  let findings = 0;
  let blocking = 0;
  let errored = false;
  for (const { project, result, error } of results) {
    const heading = results.length > 1 ? `### \`${project}\`\n\n` : "";
    if (error || !result) {
      errored = true;
      sections.push(`${heading}⚠️ Loose Ends could not analyze this project: ${error ?? "unknown error"}\n`);
      continue;
    }
    findings += result.findings.filter((f) => !f.suppressed).length;
    blocking += result.failing.length;
    const linkBase = project === "." ? links.linkBase : `${links.linkBase}${project.replace(/\/$/, "")}/`;
    sections.push(heading + formatMarkdown(result, { linkBase }));
    annotations.push(...annotationsFor(project, result.findings));
  }
  if (warnings.length) sections.push(warnings.map((w) => `> ⚠️ ${w}`).join("\n") + "\n");

  const conclusion = errored ? "neutral" : blocking > 0 && settings.blockMerges ? "failure" : "success";
  const title = errored
    ? "Analysis failed"
    : blocking > 0
      ? `${blocking} blocking loose end${blocking === 1 ? "" : "s"}`
      : findings > 0
        ? `No blocking loose ends (${findings} non-blocking)`
        : "No new loose ends";
  let summary = sections.join("\n");
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY) + "\n\n_Report truncated. Run `npx loose-ends check` locally for the full output._\n";
  return { conclusion, title, summary, annotations, comment: summary, findings, blocking };
}
