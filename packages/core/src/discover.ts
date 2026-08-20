import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { createMatcher } from "./paths.js";
import type { LooseEndsConfig } from "./types.js";

export interface SourceFile {
  /** POSIX path relative to the project root. */
  path: string;
  /** Absolute path on disk. */
  abs: string;
  /** Matches one of the configured test patterns. */
  isTest: boolean;
}

/**
 * Find every source file the analysis should consider. Honors include/exclude
 * globs and the root .gitignore. Output is sorted so results are deterministic.
 */
export function discoverFiles(config: LooseEndsConfig): SourceFile[] {
  const gitignore = loadGitignore(config.root);
  const isTest = createMatcher(config.testPatterns);
  const paths = fg.sync(config.include, {
    cwd: config.root,
    ignore: config.exclude,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  });
  return paths
    .filter((path) => !gitignore.ignores(path))
    .sort()
    .map((path) => ({ path, abs: join(config.root, path), isTest: isTest(path) }));
}

function loadGitignore(root: string) {
  const ig = ignore();
  const file = join(root, ".gitignore");
  if (existsSync(file)) ig.add(readFileSync(file, "utf8"));
  return ig;
}
