import { relative, sep } from "node:path";
import picomatch from "picomatch";

/** Convert an absolute path to a POSIX path relative to root. */
export function toRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export type Matcher = (path: string) => boolean;

/** Build a glob matcher. An empty pattern list matches nothing. */
export function createMatcher(patterns: readonly string[]): Matcher {
  if (patterns.length === 0) return () => false;
  const match = picomatch(patterns as string[], { dot: true });
  return (path) => match(path);
}

/**
 * Split a target like `src/a.ts#helper` into its file glob and symbol name.
 * Targets without `#` refer to whole files.
 */
export function parseTarget(target: string): { file: string; symbol?: string } {
  const index = target.lastIndexOf("#");
  if (index <= 0) return { file: target };
  return { file: target.slice(0, index), symbol: target.slice(index + 1) || undefined };
}

/** Whether a target string covers a file, or a symbol inside it. */
export function targetMatches(target: string, file: string, symbol?: string): boolean {
  const parsed = parseTarget(target);
  if (!createMatcher([parsed.file])(file)) return false;
  if (parsed.symbol === undefined) return true;
  return parsed.symbol === symbol;
}
