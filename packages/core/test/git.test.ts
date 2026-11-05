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

  it("leaves binaries, documents, and data far from code out of snapshots", () => {
    const root = repo({
      "web/src/a.ts": "export {};",
      "web/src/data.json": "{}",
      "web/package.json": { name: "web" },
      "tsconfig.base.json": "{}",
      "output/run-1/result.json": "{}",
      "output/run-1/report.pdf": "%PDF",
      "web/src/logo.png": "png",
      "web/src/paper.pdf": "%PDF",
    });
    const snap = snapshot(root, "main");
    try {
      for (const kept of ["web/src/a.ts", "web/src/data.json", "web/package.json", "tsconfig.base.json", "web/src/logo.png"]) expect(existsSync(join(snap.root, kept)), kept).toBe(true);
      for (const skipped of ["output/run-1/result.json", "output/run-1/report.pdf", "web/src/paper.pdf"]) expect(existsSync(join(snap.root, skipped)), skipped).toBe(false);
    } finally {
      snap.dispose();
    }
  });

  it("detects repos and default branches", () => {
    expect(isGitRepo(project({ "a.ts": "" }))).toBe(false);
    const root = repo({ "a.ts": "" });
    expect(isGitRepo(root)).toBe(true);
    expect(defaultBase(root)).toBe("main");
  });
});
