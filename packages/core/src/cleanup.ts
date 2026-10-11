import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Finding } from "./findings.js";
import { fileId, symbolId } from "./graph.js";
import type { Analysis } from "./liveness.js";

export type CleanupAction =
  | { type: "delete-file"; path: string; finding: string }
  | { type: "remove-declaration"; path: string; symbol: string; start: number; end: number; line: number; finding: string };

export interface CleanupPlan {
  actions: CleanupAction[];
  skipped: Array<{ target: string; reason: string }>;
}

const REMOVABLE = new Set(["orphaned-addition", "newly-orphaned", "superseded", "orphaned"]);

/**
 * Turn findings into deletions. Only unsuppressed, deterministic findings are
 * used. Anything that would leave a dangling import or a partial statement is
 * skipped with a reason, not guessed at.
 */
export function planCleanup(analysis: Analysis, findings: Finding[]): CleanupPlan {
  const plan: CleanupPlan = { actions: [], skipped: [] };
  const candidates = findings.filter((f) => REMOVABLE.has(f.kind) && !f.suppressed && f.file);
  const deletedFiles = new Set(candidates.filter((f) => !f.symbol).map((f) => f.file!));

  for (const f of candidates) {
    const file = f.file!;
    if (!analysis.graph.modules.has(file)) {
      plan.skipped.push({ target: f.target, reason: "file is not part of the analyzed tree" });
      continue;
    }
    if (!f.symbol) {
      const importers = importersOf(analysis, file, undefined).filter((p) => !deletedFiles.has(p));
      if (importers.length) {
        plan.skipped.push({ target: f.target, reason: `still imported (without being used) by ${importers.join(", ")}` });
        deletedFiles.delete(file);
        continue;
      }
      plan.actions.push({ type: "delete-file", path: file, finding: f.id });
      continue;
    }
    if (deletedFiles.has(file)) continue;
    const node = analysis.graph.nodes.get(symbolId(file, f.symbol));
    const decl = node?.declaration;
    if (!decl) {
      plan.skipped.push({ target: f.target, reason: "re-export alias; edit the export list by hand" });
      continue;
    }
    if (decl.statementSize > 1) {
      plan.skipped.push({ target: f.target, reason: "declared together with other names in one statement" });
      continue;
    }
    const info = analysis.graph.modules.get(file)!;
    if (info.localExports.some((e) => e.local === decl.name)) {
      plan.skipped.push({ target: f.target, reason: "also listed in an `export { }` clause" });
      continue;
    }
    const importers = decl.exportedAs.flatMap((name) => importersOf(analysis, file, name)).filter((p) => !deletedFiles.has(p));
    if (importers.length) {
      plan.skipped.push({ target: f.target, reason: `still imported (without being used) by ${[...new Set(importers)].join(", ")}` });
      continue;
    }
    plan.actions.push({ type: "remove-declaration", path: file, symbol: decl.name, start: decl.start, end: decl.end, line: decl.line, finding: f.id });
  }
  return plan;
}

/** Files with an import of `file` (or of `name` from it). */
function importersOf(analysis: Analysis, file: string, name: string | undefined): string[] {
  const out = new Set<string>();
  for (const edge of analysis.graph.in(fileId(file))) {
    if (edge.kind === "contains") continue;
    const from = analysis.graph.nodes.get(edge.from)?.file;
    if (!from || from === file) continue;
    if (name === undefined) {
      out.add(from);
      continue;
    }
    const info = analysis.graph.modules.get(from);
    const imports = info?.imports.some((r) => r.bindings.some((b) => b.imported === name)) ?? false;
    if (imports) out.add(from);
  }
  return [...out].sort();
}

/** Apply a plan to a directory. Returns the files that were touched. */
export function applyCleanup(root: string, plan: CleanupPlan): string[] {
  const touched = new Set<string>();
  const removals = new Map<string, Array<{ start: number; end: number }>>();
  for (const action of plan.actions) {
    if (action.type === "delete-file") {
      const abs = join(root, action.path);
      if (existsSync(abs)) unlinkSync(abs);
      touched.add(action.path);
    } else {
      const list = removals.get(action.path) ?? [];
      list.push({ start: action.start, end: action.end });
      removals.set(action.path, list);
    }
  }
  for (const [path, ranges] of removals) {
    const abs = join(root, path);
    if (!existsSync(abs)) continue;
    let text = readFileSync(abs, "utf8");
    for (const { start, end } of ranges.sort((a, b) => b.start - a.start)) {
      const lineStart = removeLeadingComments(text, start);
      let stop = end;
      while (stop < text.length && (text[stop] === " " || text[stop] === "\t")) stop++;
      if (text[stop] === "\r") stop++;
      if (text[stop] === "\n") stop++;
      if (text[stop] === "\n" && (lineStart === 0 || text[lineStart - 1] === "\n") && (lineStart < 2 || text[lineStart - 2] === "\n")) stop++;
      text = text.slice(0, lineStart) + text.slice(stop);
    }
    // Removing a declaration can leave stacked or trailing blank lines behind.
    text = text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
    writeFileSync(abs, text);
    touched.add(path);
  }
  return [...touched].sort();
}

/** Extend a removal back over JSDoc/line comments attached to the declaration. */
function removeLeadingComments(text: string, start: number): number {
  let pos = start;
  for (;;) {
    let lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    if (text.slice(lineStart, pos).trim() !== "") return pos;
    if (lineStart === 0) return 0;
    const prevEnd = lineStart - 1;
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    const prev = text.slice(prevStart, prevEnd).trim();
    if (prev.startsWith("//") || prev.endsWith("*/") || prev.startsWith("*")) {
      if (prev.endsWith("*/") && !prev.startsWith("/*")) {
        const open = text.lastIndexOf("/*", prevEnd);
        if (open === -1) return lineStart;
        lineStart = text.lastIndexOf("\n", open - 1) + 1;
        pos = lineStart;
        continue;
      }
      pos = prevStart;
      continue;
    }
    return lineStart;
  }
}

export interface CheckRun {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Last lines of combined output. */
  output: string;
}

export interface Verification {
  passed: boolean;
  checks: CheckRun[];
  /** Unified diff of the cleanup, relative to the project root. */
  patch: string;
  touched: string[];
}

const SKIP_COPY = new Set(["node_modules", ".git", ".next", ".turbo", "coverage", ".cache"]);

/**
 * Apply the plan to a scratch copy of the project, run the configured checks
 * there, and return a patch. The working tree is never modified.
 */
export function verifyCleanup(root: string, plan: CleanupPlan, checks: string[], options: { timeoutMs?: number } = {}): Verification {
  const sandbox = mkdtempSync(join(tmpdir(), "loose-ends-verify-"));
  const copy = join(sandbox, basename(root));
  try {
    cpSync(root, copy, { recursive: true, filter: (src) => !SKIP_COPY.has(basename(src)) || src === root });
    linkNodeModules(root, copy);
    const touched = applyCleanup(copy, plan);
    const patch = diff(root, copy, touched);
    const runs: CheckRun[] = [];
    for (const command of checks) {
      const started = Date.now();
      const result = spawnSync(command, { cwd: copy, shell: true, encoding: "utf8", timeout: options.timeoutMs ?? 10 * 60_000, env: { ...process.env, CI: "1" } });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd().split("\n").slice(-40).join("\n");
      runs.push({ command, exitCode: result.status ?? 1, durationMs: Date.now() - started, output });
      if (result.status !== 0) break;
    }
    return { passed: runs.every((r) => r.exitCode === 0), checks: runs, patch, touched };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Produce the cleanup patch without running checks. */
export function cleanupPatch(root: string, plan: CleanupPlan): { patch: string; touched: string[] } {
  const result = verifyCleanup(root, plan, []);
  return { patch: result.patch, touched: result.touched };
}

/** Symlink every node_modules directory (root and workspace packages) into the copy. */
function linkNodeModules(root: string, copy: string, rel = "", depth = 0): void {
  const dir = join(root, rel);
  if (depth > 4 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name === "node_modules") {
      if (existsSync(join(copy, dirname(child)))) symlinkSync(join(root, child), join(copy, child), "dir");
      continue;
    }
    if (SKIP_COPY.has(entry.name) || entry.name.startsWith(".")) continue;
    linkNodeModules(root, copy, child, depth + 1);
  }
}

function diff(root: string, copy: string, touched: string[]): string {
  const parts: string[] = [];
  for (const path of touched) {
    const before = join(root, path);
    const after = join(copy, path);
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", before, existsSync(after) ? after : "/dev/null"], { encoding: "utf8" });
    const text = (result.stdout ?? "")
      .split(before)
      .join(`/${path}`)
      .split(after)
      .join(`/${path}`)
      .replace(/^diff --git a\/+(\S+) b\/+\S+$/m, `diff --git a/${path} b/${path}`)
      .replace(/^--- a\/+.*$/m, `--- a/${path}`)
      .replace(/^\+\+\+ b\/+.*$/m, `+++ b/${path}`)
      .replace(/^diff --git a\/(.+) b\/dev\/null$/m, `diff --git a/${path} b/${path}`);
    if (text) parts.push(text.endsWith("\n") ? text : text + "\n");
  }
  return parts.join("");
}
