import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CloneRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  token: string;
  /** Override for tests and GitHub Enterprise. */
  serverUrl?: string;
}

export interface Checkout {
  dir: string;
  dispose(): void;
}

function git(cwd: string, args: string[], token?: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").replaceAll(token ?? "\0", "***").trim();
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

/**
 * Blobless clone of the repository with the PR head checked out and the base
 * commit available locally. Works for pull requests from forks.
 */
export function clonePullRequest(req: CloneRequest): Checkout {
  const dir = mkdtempSync(join(tmpdir(), "loose-ends-pr-"));
  const server = req.serverUrl ?? "https://github.com";
  const url = server.startsWith("http")
    ? server.replace("://", `://x-access-token:${req.token}@`) + `/${req.owner}/${req.repo}.git`
    : `${server}/${req.owner}/${req.repo}.git`;
  try {
    git(dir, ["init", "-q"], req.token);
    git(dir, ["remote", "add", "origin", url], req.token);
    git(dir, ["fetch", "-q", "--filter=blob:none", "origin", req.baseSha, `+refs/pull/${req.pullNumber}/head:refs/remotes/origin/pr`], req.token);
    git(dir, ["checkout", "-q", "--detach", req.headSha], req.token);
    // Keep the token out of anything that might read the repo config later.
    git(dir, ["remote", "set-url", "origin", `${server}/${req.owner}/${req.repo}.git`], req.token);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
