import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Finding } from "./findings.js";

/** Per-file line hit counts, keyed by project-relative POSIX path. */
export type CoverageMap = Map<string, Map<number, number>>;

export class CoverageError extends Error {}

/** Load an istanbul `coverage-final.json` or an lcov `lcov.info` file. */
export function loadCoverage(root: string, file: string): CoverageMap {
  const abs = resolve(root, file);
  if (!existsSync(abs)) throw new CoverageError(`coverage report not found: ${file}`);
  const text = readFileSync(abs, "utf8");
  return text.trimStart().startsWith("{") ? parseIstanbul(root, text) : parseLcov(root, text);
}

function normalize(root: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  return relative(root, abs).split(sep).join("/");
}

interface IstanbulFile {
  path?: string;
  statementMap?: Record<string, { start: { line: number }; end: { line: number } }>;
  s?: Record<string, number>;
  fnMap?: Record<string, { loc?: { start: { line: number }; end: { line: number } }; decl?: { start: { line: number } } }>;
  f?: Record<string, number>;
}

export function parseIstanbul(root: string, text: string): CoverageMap {
  let data: Record<string, IstanbulFile>;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new CoverageError(`invalid istanbul JSON: ${(error as Error).message}`);
  }
  const out: CoverageMap = new Map();
  for (const [key, file] of Object.entries(data)) {
    const lines = new Map<number, number>();
    for (const [id, loc] of Object.entries(file.statementMap ?? {})) {
      const hits = file.s?.[id] ?? 0;
      for (let line = loc.start.line; line <= loc.end.line; line++) lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    }
    for (const [id, fn] of Object.entries(file.fnMap ?? {})) {
      const line = fn.decl?.start.line ?? fn.loc?.start.line;
      if (line !== undefined) lines.set(line, Math.max(lines.get(line) ?? 0, file.f?.[id] ?? 0));
    }
    out.set(normalize(root, file.path ?? key), lines);
  }
  return out;
}

export function parseLcov(root: string, text: string): CoverageMap {
  const out: CoverageMap = new Map();
  let current: Map<number, number> | undefined;
  const fnLines = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = new Map();
      fnLines.clear();
      out.set(normalize(root, line.slice(3)), current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      current.set(Number(ln), Math.max(current.get(Number(ln)) ?? 0, Number(hits)));
    } else if (line.startsWith("FN:")) {
      const [ln, ...name] = line.slice(3).split(",");
      fnLines.set(name.join(","), Number(ln));
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...name] = line.slice(5).split(",");
      const ln = fnLines.get(name.join(","));
      if (ln !== undefined) current.set(ln, Math.max(current.get(ln) ?? 0, Number(hits)));
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return out;
}

/** Highest hit count of any covered line in [start, end]. Undefined when the file is not in the report. */
export function hitsFor(coverage: CoverageMap, file: string, start = 1, end?: number): number | undefined {
  const lines = coverage.get(file);
  if (!lines) return undefined;
  let max = 0;
  for (const [line, hits] of lines) {
    if (line >= start && (end === undefined || line <= end)) max = Math.max(max, hits);
  }
  return max;
}

/**
 * Attach runtime coverage to findings as supporting evidence. Coverage never
 * changes a finding's kind: the graph decides liveness, coverage explains it.
 */
export function annotateCoverage(findings: Finding[], coverage: CoverageMap, source: string): Finding[] {
  for (const f of findings) {
    if (!f.file || f.kind === "unused-dependency" || f.kind === "invalid-suppression") continue;
    const isFile = !f.symbol;
    const hits = hitsFor(coverage, f.file, isFile ? 1 : f.line, isFile ? undefined : f.endLine ?? f.line);
    if (hits === undefined) continue;
    f.evidence.coverage = { hits, source };
    if (hits > 0 && f.kind === "uncertain") {
      f.evidence.note = `${f.evidence.note ? f.evidence.note + " " : ""}It ran during the coverage run, so it is probably live; add a literal import or an entry to make that explicit.`;
    } else if (hits > 0 && (f.kind === "orphaned-addition" || f.kind === "newly-orphaned" || f.kind === "orphaned")) {
      f.evidence.note = `${f.evidence.note ? f.evidence.note + " " : ""}It executed during the coverage run, which suggests a loader the graph does not know about (a framework convention, a config string, or a computed import).`;
    }
  }
  return findings;
}
