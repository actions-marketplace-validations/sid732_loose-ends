export const VERSION = "1.0.0";

export * from "./types.js";
export {
  CONFIG_FILES,
  ConfigError,
  DEFAULT_EXCLUDE,
  DEFAULT_FAIL_ON,
  DEFAULT_INCLUDE,
  DEFAULT_TEST_PATTERNS,
  FINDING_KINDS,
  SOURCE_EXTENSIONS,
  defaultConfig,
  loadConfig,
  parseConfig,
} from "./config.js";
export { createMatcher, parseTarget, targetMatches, toRelative } from "./paths.js";
export type { Matcher } from "./paths.js";
export { discoverFiles } from "./discover.js";
export type { SourceFile } from "./discover.js";
export { MODULE_BODY, collectReferences, createSource, fingerprint, parseModule, scriptKindFor } from "./parse.js";
export type { Declaration, DeclarationKind, Directive, DirectiveAction, ImportBinding, ImportKind, ImportRecord, LocalExport, ModuleInfo } from "./parse.js";
export { Resolver, splitPackage } from "./resolve.js";
export type { Resolution } from "./resolve.js";
export { discoverPackages, flattenTarget, manifestEntries, readPackageJson, resolveExports } from "./workspace.js";
export type { PackageJson, WorkspacePackage } from "./workspace.js";
export { LivenessGraph, buildGraph, dependencyId, fileId, symbolId } from "./graph.js";
export type { BuildResult, EdgeKind, GraphEdge, GraphNode, NodeKind, UnresolvedImport } from "./graph.js";
export { DEFAULT_PROVIDERS, configRoots, discoverRoots, packageRoots, scriptTargets, testRoots } from "./roots.js";
export type { Root, RootContext, RootKind, RootProvider } from "./roots.js";
export {
  FRAMEWORK_PROVIDERS,
  NEXT_ROUTE_EXPORTS,
  detectFrameworks,
  addConfigReferences,
  docusaurusRoots,
  nextRoots,
  serverlessRoots,
  storybookRoots,
  toolConfigRoots,
  viteRoots,
} from "./frameworks.js";
export { analyze, classify, label, pathTo, stateOf, summarize } from "./liveness.js";
export type { Analysis, AnalyzeOptions, Liveness, LivenessSummary, NodeState } from "./liveness.js";
export { allSuppressions, applyDormant, directiveRoots, inlineSuppressions } from "./directives.js";
export type { DirectiveProblem, SuppressionRecord } from "./directives.js";
export { GitError, changedFiles, defaultBase, isGitRepo, mergeBase, repoRoot, revParse, snapshot } from "./git.js";
export type { ChangeStatus, ChangedFile, Snapshot } from "./git.js";
export { SEVERITY, applySuppressions, compareAnalyses, describePath, makeFinding, renameMap, scanFindings } from "./findings.js";
export type { CompareOptions, Evidence, Finding, PathStep, SuppressionOutcome } from "./findings.js";
export { check, scan } from "./check.js";
export type { CheckContext, CheckOptions, CheckResult, RevisionInfo, ScanOptions } from "./check.js";
export { dependencyFindings, dependencyReport, scanDependencyFindings } from "./dependencies.js";
export type { DependencyReport, DependencyUse } from "./dependencies.js";
export { detectSuperseded, normalizeName, scoreReplacement, similarity } from "./superseded.js";
export type { Replacement } from "./superseded.js";
export { explain, findNode } from "./explain.js";
export type { Explanation, Reference } from "./explain.js";
export { formatExplanation, formatText } from "./report/text.js";
export type { TextOptions } from "./report/text.js";
export { JSON_REPORT_VERSION, formatJson, toJsonReport } from "./report/json.js";
export { TOOL, evidenceLines, formatPath, location } from "./report/common.js";
export { MARKDOWN_MARKER, formatMarkdown } from "./report/markdown.js";
export type { MarkdownOptions } from "./report/markdown.js";
export { formatSarif, toSarif } from "./report/sarif.js";
export type { SarifOptions } from "./report/sarif.js";
export { RULES } from "./report/rules.js";

import type { CheckResult } from "./check.js";
import { formatJson } from "./report/json.js";
import { formatMarkdown } from "./report/markdown.js";
import { formatSarif } from "./report/sarif.js";
import { formatText } from "./report/text.js";

export type ReportFormat = "text" | "json" | "markdown" | "sarif";
export const REPORT_FORMATS: ReportFormat[] = ["text", "json", "markdown", "sarif"];

/** Render a result in any supported format. */
export function formatReport(result: CheckResult, format: ReportFormat, options: { color?: boolean; linkBase?: string; pathPrefix?: string } = {}): string {
  switch (format) {
    case "json":
      return formatJson(result);
    case "markdown":
      return formatMarkdown(result, { linkBase: options.linkBase });
    case "sarif":
      return formatSarif(result, { pathPrefix: options.pathPrefix });
    default:
      return formatText(result, { color: options.color });
  }
}
export { CoverageError, annotateCoverage, hitsFor, loadCoverage, parseIstanbul, parseLcov } from "./coverage.js";
export type { CoverageMap } from "./coverage.js";
export { applyCleanup, cleanupPatch, planCleanup, verifyCleanup } from "./cleanup.js";
export type { CheckRun, CleanupAction, CleanupPlan, Verification } from "./cleanup.js";
