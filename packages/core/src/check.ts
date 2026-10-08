import type { ChangedFile, Snapshot } from "./git.js";
import { changedFiles, defaultBase, isGitRepo, mergeBase, revParse, snapshot } from "./git.js";
import { loadConfig } from "./config.js";
import { annotateCoverage, loadCoverage } from "./coverage.js";
import { dependencyFindings, scanDependencyFindings } from "./dependencies.js";
import { applySuppressions, compareAnalyses, renameMap, scanFindings, type Finding } from "./findings.js";
import { detectSuperseded } from "./superseded.js";
import { analyze, summarize, type Analysis, type AnalyzeOptions, type LivenessSummary } from "./liveness.js";
import type { FindingKind, LooseEndsConfig } from "./types.js";

export interface CheckOptions {
  /** Project root (working tree). */
  root: string;
  /** Base revision. Defaults to the merge base with origin/HEAD, main, or master. */
  base?: string;
  /** Head revision. Defaults to the working tree, including uncommitted changes. */
  head?: string;
  config?: Partial<LooseEndsConfig>;
  /** Extra hooks applied to both analyses. */
  analyze?: AnalyzeOptions;
  /** Post-process findings, e.g. to add superseded or dependency findings. */
  extend?: (ctx: CheckContext) => Finding[];
}

export interface CheckContext {
  config: LooseEndsConfig;
  base: Analysis;
  head: Analysis;
  changed: ChangedFile[];
  findings: Finding[];
}

export interface RevisionInfo {
  ref: string;
  commit?: string;
}

export interface CheckResult {
  mode: "check" | "scan";
  config: LooseEndsConfig;
  base?: RevisionInfo;
  head: RevisionInfo;
  changed: ChangedFile[];
  findings: Finding[];
  /** Findings that count toward failure (unsuppressed and in `failOn`). */
  failing: Finding[];
  summary: {
    before?: LivenessSummary;
    after: LivenessSummary;
    byKind: Partial<Record<FindingKind, number>>;
    suppressed: number;
  };
  passed: boolean;
  /** Present when the caller asked to keep analyses for further inspection. */
  analyses?: { base?: Analysis; head: Analysis };
}

/** Compare a change against its base and report new loose ends. */
export function check(options: CheckOptions & { keepAnalyses?: boolean }): CheckResult {
  const config = loadConfig(options.root, options.config);
  if (!isGitRepo(config.root)) throw new Error(`${config.root} is not inside a git repository; use scan for a whole-project report`);

  const baseRef = options.base ?? defaultBase(config.root);
  if (!baseRef) throw new Error("could not find a base branch (tried origin/HEAD, main, master); pass --base");
  const headRef = options.head;
  const headCommit = headRef ? revParse(config.root, headRef) : revParse(config.root, "HEAD");
  if (headRef && !headCommit) throw new Error(`unknown head revision "${headRef}"`);
  const baseCommit = mergeBase(config.root, baseRef, headCommit ?? "HEAD");

  const snapshots: Snapshot[] = [];
  try {
    const baseSnap = snapshot(config.root, baseCommit);
    snapshots.push(baseSnap);
    let headRoot = config.root;
    if (headRef) {
      const headSnap = snapshot(config.root, headRef);
      snapshots.push(headSnap);
      headRoot = headSnap.root;
    }
    const base = analyze({ ...config, root: baseSnap.root }, options.analyze);
    const head = analyze({ ...config, root: headRoot }, options.analyze);
    const changed = changedFiles(config.root, baseCommit, headRef);
    let findings = compareAnalyses(base, head, { changed });
    findings = detectSuperseded(base, head, changed, findings, renameMap(changed));
    findings = [...findings, ...dependencyFindings(base, head)];
    if (options.extend) findings = [...findings, ...options.extend({ config, base, head, changed, findings })];
    const { invalid } = applySuppressions(head, findings);
    findings = [...findings, ...invalid];
    if (config.coverage) annotateCoverage(findings, loadCoverage(config.root, config.coverage), config.coverage);
    return finish({
      mode: "check",
      config,
      base: { ref: baseRef, commit: baseCommit },
      head: { ref: headRef ?? "working tree", commit: headCommit },
      changed,
      findings,
      before: summarize(base),
      after: summarize(head),
      analyses: options.keepAnalyses ? { base, head } : undefined,
    });
  } finally {
    for (const snap of snapshots) snap.dispose();
  }
}

export interface ScanOptions {
  root: string;
  config?: Partial<LooseEndsConfig>;
  analyze?: AnalyzeOptions;
  extend?: (analysis: Analysis, findings: Finding[]) => Finding[];
}

/** Whole-project report of unreachable code, independent of any change. */
export function scan(options: ScanOptions & { keepAnalyses?: boolean }): CheckResult {
  const config = loadConfig(options.root, options.config);
  const head = analyze(config, options.analyze);
  let findings = [...scanFindings(head), ...scanDependencyFindings(head)];
  if (options.extend) findings = [...findings, ...options.extend(head, findings)];
  const { invalid } = applySuppressions(head, findings);
  findings = [...findings, ...invalid];
  if (config.coverage) annotateCoverage(findings, loadCoverage(config.root, config.coverage), config.coverage);
  return finish({
    mode: "scan",
    config,
    head: { ref: "working tree", commit: isGitRepo(config.root) ? revParse(config.root, "HEAD") : undefined },
    changed: [],
    findings,
    after: summarize(head),
    analyses: options.keepAnalyses ? { head } : undefined,
  });
}

function finish(input: {
  mode: "check" | "scan";
  config: LooseEndsConfig;
  base?: RevisionInfo;
  head: RevisionInfo;
  changed: ChangedFile[];
  findings: Finding[];
  before?: LivenessSummary;
  after: LivenessSummary;
  analyses?: CheckResult["analyses"];
}): CheckResult {
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const findings = input.findings.sort(
    (a, b) => order[a.severity]! - order[b.severity]! || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind),
  );
  const failing = findings.filter((f) => !f.suppressed && input.config.failOn.includes(f.kind));
  const byKind: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) if (!f.suppressed) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return {
    mode: input.mode,
    config: input.config,
    base: input.base,
    head: input.head,
    changed: input.changed,
    findings,
    failing,
    summary: { before: input.before, after: input.after, byKind, suppressed: findings.filter((f) => f.suppressed).length },
    passed: failing.length === 0,
    analyses: input.analyses,
  };
}
