import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** Write a throwaway project to disk. Keys are relative paths. */
export function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), "loose-ends-"));
  created.push(root);
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string | object>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

import { execFileSync } from "node:child_process";

/** Run git in a test repo with a fixed identity. */
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

/** Create a repo with `base` committed on main, then apply `head` changes (null deletes). */
export function repo(base: Record<string, string | object>, head: Record<string, string | object | null> = {}, options: { commitHead?: boolean } = {}): string {
  const root = project(base);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  for (const [path, content] of Object.entries(head)) {
    if (content === null) rmSync(join(root, path), { force: true });
    else writeFiles(root, { [path]: content });
  }
  if (options.commitHead) {
    git(root, "checkout", "-q", "-b", "feature");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "head");
  }
  return root;
}
