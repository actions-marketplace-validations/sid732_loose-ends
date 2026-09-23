import type { CheckResult } from "../check.js";
import { TOOL } from "./common.js";

export const JSON_REPORT_VERSION = 1;

/** Stable, machine-readable report. Analyses and resolved config internals are omitted. */
export function toJsonReport(result: CheckResult) {
  return {
    version: JSON_REPORT_VERSION,
    tool: TOOL,
    mode: result.mode,
    passed: result.passed,
    base: result.base,
    head: result.head,
    config: { source: result.config.source, failOn: result.config.failOn },
    summary: result.summary,
    changed: result.changed,
    findings: result.findings.map((f) => ({ ...f, failing: result.failing.includes(f) })),
  };
}

export function formatJson(result: CheckResult): string {
  return JSON.stringify(toJsonReport(result), null, 2) + "\n";
}
