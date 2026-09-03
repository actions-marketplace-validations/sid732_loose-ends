import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, defaultBase, isGitRepo, snapshot } from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

describe("git helpers", () => {
  it("lists working-tree changes including untracked files", () => {
    const root = repo(
      { "src/a.ts": "a", "src/b.ts": "b", "src/c.ts": "c".repeat(200) },
      { "src/a.ts": "a2", "src/b.ts": null, "src/new.ts": "n" },
    );
    expect(changedFiles(root, "main")).toEqual([
      { status: "modified", path: "src/a.ts" },
      { status: "deleted", path: "src/b.ts" },
      { status: "added", path: "src/new.ts" },
    ]);
  });

  it("lists committed changes with renames", () => {
    const content = "export const x = 1;\n".repeat(20);
    const root = repo({ "old.ts": content }, { "old.ts": null, "new.ts": content }, { commitHead: true });
    expect(changedFiles(root, "main", "HEAD")).toEqual([{ status: "renamed", path: "new.ts", oldPath: "old.ts" }]);
  });

  it("snapshots a revision into a temp dir", () => {
    const root = repo({ "a.ts": "base" }, { "a.ts": "head", "b.ts": "new" }, { commitHead: true });
    const snap = snapshot(root, "main");
    try {
      expect(readFileSync(join(snap.root, "a.ts"), "utf8")).toBe("base");
      expect(existsSync(join(snap.root, "b.ts"))).toBe(false);
    } finally {
      snap.dispose();
    }
    expect(existsSync(snap.root)).toBe(false);
  });

  it("detects repos and default branches", () => {
    expect(isGitRepo(project({ "a.ts": "" }))).toBe(false);
    const root = repo({ "a.ts": "" });
    expect(isGitRepo(root)).toBe(true);
    expect(defaultBase(root)).toBe("main");
  });
});
