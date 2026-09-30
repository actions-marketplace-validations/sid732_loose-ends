import { resolve } from "node:path";
import { FINDING_KINDS, REPORT_FORMATS, check, formatReport, scan, type FindingKind, type LooseEndsConfig, type ReportFormat } from "@loose-ends/core";
import type { Command } from "commander";
import { emit, type CliIO } from "../io.js";

export interface ReportFlags {
  format: string;
  output?: string;
  color?: boolean;
  linkBase?: string;
  pathPrefix?: string;
  failOn?: string;
}

export class UsageError extends Error {}

export function parseFormat(value: string): ReportFormat {
  if (!REPORT_FORMATS.includes(value as ReportFormat)) {
    throw new UsageError(`unknown format "${value}" (expected ${REPORT_FORMATS.join(", ")})`);
  }
  return value as ReportFormat;
}

export function parseKinds(value: string | undefined): FindingKind[] | undefined {
  if (value === undefined) return undefined;
  const kinds = value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of kinds) if (!FINDING_KINDS.includes(k as FindingKind)) throw new UsageError(`unknown finding kind "${k}"`);
  return kinds as FindingKind[];
}

export function overrides(flags: ReportFlags & { coverage?: string }): Partial<LooseEndsConfig> {
  const out: Partial<LooseEndsConfig> = {};
  const failOn = parseKinds(flags.failOn);
  if (failOn) out.failOn = failOn;
  if (flags.coverage) out.coverage = flags.coverage;
  return out;
}

export function addReportOptions(cmd: Command): Command {
  return cmd
    .option("-f, --format <format>", `output format: ${REPORT_FORMATS.join(", ")}`, "text")
    .option("-o, --output <file>", "write the report to a file instead of stdout")
    .option("--color", "force colored text output")
    .option("--no-color", "disable colored text output")
    .option("--link-base <url>", "prefix for file links in markdown output")
    .option("--path-prefix <path>", "prefix for file paths in SARIF output (project path inside the repo)")
    .option("--fail-on <kinds>", "comma-separated finding kinds that fail the run");
}

export function registerCheck(program: Command, io: CliIO, setExit: (code: number) => void): void {
  addReportOptions(
    program
      .command("check")
      .description("compare a change against its base and report new loose ends")
      .argument("[dir]", "project root", ".")
      .option("-b, --base <ref>", "base revision (default: merge base with origin/HEAD, main, or master)")
      .option("--head <ref>", "head revision (default: the working tree, including uncommitted changes)")
      .option("--coverage <file>", "coverage report (istanbul JSON or lcov) used as supporting evidence")
      .option("--no-fail", "always exit 0, even when blocking findings exist"),
  ).action((dir: string, flags: ReportFlags & { base?: string; head?: string; coverage?: string; fail: boolean }) => {
    const format = parseFormat(flags.format);
    const result = check({ root: resolve(io.cwd, dir), base: flags.base, head: flags.head, config: overrides(flags) });
    emit(io, formatReport(result, format, { color: flags.color ?? io.color, linkBase: flags.linkBase, pathPrefix: flags.pathPrefix }), flags.output);
    if (flags.output) {
      io.stderr(`${result.passed ? "pass" : "fail"}: ${result.failing.length} blocking of ${result.findings.length} findings → ${flags.output}\n`);
    }
    setExit(result.passed || !flags.fail ? 0 : 1);
  });

  addReportOptions(
    program
      .command("scan")
      .description("report every unreachable file, symbol, and dependency in the project")
      .argument("[dir]", "project root", ".")
      .option("--coverage <file>", "coverage report (istanbul JSON or lcov) used as supporting evidence")
      .option("--fail", "exit 1 when findings in failOn exist (scan never fails by default)"),
  ).action((dir: string, flags: ReportFlags & { coverage?: string; fail?: boolean }) => {
    const format = parseFormat(flags.format);
    const config = overrides(flags);
    if (flags.fail && !config.failOn) config.failOn = ["orphaned", "invalid-suppression"];
    const result = scan({ root: resolve(io.cwd, dir), config });
    emit(io, formatReport(result, format, { color: flags.color ?? io.color, linkBase: flags.linkBase, pathPrefix: flags.pathPrefix }), flags.output);
    setExit(flags.fail && !result.passed ? 1 : 0);
  });
}
