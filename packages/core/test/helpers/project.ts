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
