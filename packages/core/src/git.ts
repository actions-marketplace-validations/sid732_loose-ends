import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

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

/** Files the analysis never reads. Skipping them keeps snapshots of document- or media-heavy repos small. */
const SKIP_IN_SNAPSHOT =
  /\.(pdf|docx?|xlsx?|pptx?|odt|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|mp[34]|m4a|mov|avi|mkv|webm|wav|flac|ogg|psd|ai|sketch|fig|sqlite3?|db|parquet|pkl|npy|npz|h5|onnx|pt|ckpt|safetensors|woff2?|ttf|otf|eot|tex|aux|log)$/i;
/** Blobs above this size are skipped; config files above it are not read anyway. */
const MAX_SNAPSHOT_BLOB = 8 * 1024 * 1024;
/** Source files the analysis parses. */
const SOURCE_FILE = /\.([cm]?[jt]sx?|mdx|vue|svelte|astro)$/i;
/** Files that anchor a JS/TS project directory. */
const PROJECT_ANCHOR = /(^|\/)(package\.json|manifest\.json)$/;
/** Config files kept wherever they are (tsconfig chains can point anywhere). */
const CONFIG_FILE = /(^|\/)(package\.json|[jt]sconfig[\w.-]*\.json|\.[\w.-]*rc(\.\w+)?|[\w.-]+\.config\.\w+|loose-ends\.config\.json|vercel\.json|netlify\.toml|\.gitignore)$/;
/** Upper bound on bytes requested from one `git cat-file --batch` call. */
const BATCH_BYTES = 128 * 1024 * 1024;

/**
 * Write the tree of `ref` to a temporary directory, skipping binaries,
 * documents, and very large files. Returns the project root inside it,
 * matching `projectRoot`'s place in the repo.
 */
export function snapshot(projectRoot: string, ref: string): Snapshot {
  const top = repoRoot(projectRoot);
  const commit = revParse(top, ref);
  if (!commit) throw new GitError(`unknown revision "${ref}"`);
  const prefix = projectPrefix(top, projectRoot);
  const dir = mkdtempSync(join(tmpdir(), "loose-ends-snapshot-"));
  try {
    const blobs: Array<{ sha: string; size: number; path: string }> = [];
    for (const entry of git(top, ["ls-tree", "-r", "-z", "--long", "--full-tree", commit]).split("\0")) {
      // <mode> SP <type> SP <sha> SP+ <size> TAB <path>
      const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.+)$/s.exec(entry);
      if (!match || match[2] !== "blob" || match[1] === "120000") continue;
      const size = Number(match[4]);
      const path = match[5]!;
      if (size > MAX_SNAPSHOT_BLOB || SKIP_IN_SNAPSHOT.test(path)) continue;
      blobs.push({ sha: match[3]!, size, path });
    }
    // Non-source files (JSON data, HTML pages, assets) only matter next to JS/TS code.
    // Skipping the rest keeps snapshots of data-heavy repos fast.
    const codeDirs = new Set<string>();
    for (const b of blobs) if (SOURCE_FILE.test(b.path) || PROJECT_ANCHOR.test(b.path)) codeDirs.add(parentDir(b.path));
    const near = new Map<string, boolean>();
    const isNear = (dir: string) => {
      let value = near.get(dir);
      if (value === undefined) near.set(dir, (value = nearCode(codeDirs, dir)));
      return value;
    };
    const kept = blobs.filter((b) => SOURCE_FILE.test(b.path) || CONFIG_FILE.test(b.path) || isNear(parentDir(b.path)));
    blobs.length = 0;
    blobs.push(...kept);
    for (let start = 0; start < blobs.length; ) {
      let end = start;
      let bytes = 0;
      while (end < blobs.length && (end === start || bytes + blobs[end]!.size <= BATCH_BYTES)) bytes += blobs[end++]!.size;
      writeBlobs(top, dir, blobs.slice(start, end), bytes);
      start = end;
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const root = join(dir, prefix);
  mkdirSync(root, { recursive: true });
  return { root, commit, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** True when `dir`, its parent, or one of its subdirectories (two levels down) holds code. */
function nearCode(codeDirs: Set<string>, dir: string): boolean {
  if (codeDirs.has(dir) || codeDirs.has(parentDir(dir))) return true;
  for (const code of codeDirs) {
    if (dir === "" ? code !== "" && code.split("/").length <= 2 : code.startsWith(dir + "/") && code.split("/").length - dir.split("/").length <= 2) return true;
  }
  return false;
}

function writeBlobs(top: string, dir: string, blobs: Array<{ sha: string; size: number; path: string }>, bytes: number): void {
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: top,
    input: blobs.map((b) => b.sha).join("\n") + "\n",
    maxBuffer: bytes + blobs.length * 128 + 1024,
  });
  if (result.error) throw new GitError(`git cat-file failed: ${result.error.message}`);
  if (result.status !== 0) throw new GitError(`git cat-file: ${result.stderr.toString().trim() || `exit ${result.status}`}`);
  const out = result.stdout;
  let offset = 0;
  for (const blob of blobs) {
    const newline = out.indexOf(10, offset);
    const header = out.subarray(offset, newline).toString();
    const size = Number(header.split(" ")[2]);
    if (!header.startsWith(blob.sha) || !Number.isFinite(size)) throw new GitError(`unexpected git cat-file output: ${header}`);
    const target = join(dir, blob.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
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
