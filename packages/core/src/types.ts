/**
 * Shared types for the Liveness Graph engine.
 */

/** A rule that explains why a piece of code may exist without being reachable. */
export interface DormantRule {
  /** File glob or `path#symbol` target, relative to the project root. */
  target: string;
  /** Human-readable justification. Required. */
  reason: string;
}

/** A recorded decision to ignore a specific finding. */
export interface Suppression {
  /** File glob or `path#symbol` target, relative to the project root. */
  target: string;
  /** Human-readable justification. Required. */
  reason: string;
  /** Restrict the suppression to a single finding kind. */
  kind?: FindingKind;
  /** ISO date after which the suppression stops applying. */
  expires?: string;
}

export interface LooseEndsConfig {
  /** Absolute path of the project root. */
  root: string;
  /** Globs of source files to analyze. */
  include: string[];
  /** Globs excluded from analysis. */
  exclude: string[];
  /** Extra production entry points (globs or `path#symbol`). */
  entries: string[];
  /** Globs that identify test and development-only files. */
  testPatterns: string[];
  /** Frameworks to detect roots for. `auto` inspects package.json. */
  frameworks: "auto" | FrameworkName[];
  /** Code that is intentionally unreachable. */
  dormant: DormantRule[];
  /** Findings that have been reviewed and accepted. */
  suppressions: Suppression[];
  /** Commands used to verify cleanup patches, e.g. `npm test`. */
  checks: string[];
  /** Finding kinds that make `check` exit non-zero. */
  failOn: FindingKind[];
  /** Path to a tsconfig used for path aliases, relative to root. */
  tsconfig?: string;
  /** Path to a coverage report (istanbul JSON or lcov), relative to root. */
  coverage?: string;
  /** Whether package.json dependencies are analyzed. */
  dependencies: boolean;
  /** Dependencies that are used implicitly (plugins, peer requirements, CLIs). */
  ignoreDependencies: string[];
  /** Where the config was loaded from, if anywhere. */
  source?: string;
}

export type FrameworkName = "node" | "next" | "react" | "express" | "vite" | "jest" | "vitest" | "storybook";

export type FindingKind =
  /** Code added in this change that no production root reaches. */
  | "orphaned-addition"
  /** Code added in this change reachable only from tests. */
  | "test-only-addition"
  /** Existing code that was live before the change and is not live after it. */
  | "newly-orphaned"
  /** Existing code that is now reachable only from tests. */
  | "newly-test-only"
  /** An implementation that appears to have been replaced but not removed. */
  | "superseded"
  /** A package dependency no live code imports. */
  | "unused-dependency"
  /** Code whose liveness depends on dynamic behavior the graph cannot follow. */
  | "uncertain"
  /** A suppression or dormant marker that is missing a reason or has expired. */
  | "invalid-suppression"
  /** Whole-project scan: code no root reaches (existing debt, not tied to a change). */
  | "orphaned"
  /** Whole-project scan: production code reachable only from tests. */
  | "test-only";

export type Severity = "error" | "warning" | "info";
