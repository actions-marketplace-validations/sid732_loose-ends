import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function git(cwd: string, args: string[], input?: Buffer): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new GitError(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new GitError(`git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

export function isGitRepo(dir: string): boolean {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" }).stdout?.trim() === "true";
}

export function repoRoot(dir: string): string {
  return resolve(git(dir, ["rev-parse", "--show-toplevel"]).trim());
}

export function revParse(dir: string, ref: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function mergeBase(dir: string, a: string, b: string): string {
  return git(dir, ["merge-base", a, b]).trim();
}

/** Pick a sensible base branch: origin/HEAD, then main/master locally or on origin. */
export function defaultBase(dir: string): string | undefined {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: dir, encoding: "utf8" });
  const candidates = [head.status === 0 ? head.stdout.trim() : "", "origin/main", "main", "origin/master", "master"].filter(Boolean);
  return candidates.find((ref) => revParse(dir, ref));
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  status: ChangeStatus;
  /** Path relative to the project root, POSIX. */
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
}

/**
 * Files changed between `base` and `head`. When `head` is omitted, compares
 * against the working tree, including untracked files.
 */
export function changedFiles(projectRoot: string, base: string, head?: string): ChangedFile[] {
  const top = repoRoot(projectRoot);
  const prefix = projectPrefix(top, projectRoot);
  const args = ["diff", "--name-status", "-M", "--no-color", "-z", base];
  if (head) args.push(head);
  args.push("--", prefix || ".");
  const raw = git(top, args).split("\0").filter(Boolean);
  const out: ChangedFile[] = [];
  for (let i = 0; i < raw.length; ) {
    const code = raw[i++]!;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = raw[i++]!;
      const path = raw[i++]!;
      out.push({ status: letter === "R" ? "renamed" : "added", path: strip(prefix, path), oldPath: letter === "R" ? strip(prefix, oldPath) : undefined });
    } else {
      const path = raw[i++]!;
      const status: ChangeStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      out.push({ status, path: strip(prefix, path) });
    }
  }
  if (!head) {
    const untracked = git(top, ["ls-files", "--others", "--exclude-standard", "-z", "--", prefix || "."]).split("\0").filter(Boolean);
    for (const path of untracked) out.push({ status: "added", path: strip(prefix, path) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface Snapshot {
  /** Project root inside the snapshot. */
  root: string;
  /** Commit the snapshot was taken from. */
  commit: string;
  dispose(): void;
}

/**
 * Write the tree of `ref` to a temporary directory with `git archive`.
 * Returns the project root inside it, matching `projectRoot`'s place in the repo.
 */
export function snapshot(projectRoot: string, ref: string): Snapshot {
  const top = repoRoot(projectRoot);
  const commit = revParse(top, ref);
  if (!commit) throw new GitError(`unknown revision "${ref}"`);
  const prefix = projectPrefix(top, projectRoot);
  const dir = mkdtempSync(join(tmpdir(), "loose-ends-snapshot-"));
  try {
    const tar = execFileSync("git", ["archive", "--format=tar", commit], { cwd: top, maxBuffer: 1024 * 1024 * 1024 });
    const extract = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: tar });
    if (extract.status !== 0) throw new GitError(`could not extract ${ref}: ${extract.stderr?.toString().trim()}`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const root = join(dir, prefix);
  mkdirSync(root, { recursive: true });
  return { root, commit, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Path of the project inside its repository, with symlinks (e.g. /var -> /private/var) resolved. */
function projectPrefix(top: string, projectRoot: string): string {
  return toPosix(relative(realpathSync(top), realpathSync(resolve(projectRoot))));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function strip(prefix: string, path: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : path;
}
