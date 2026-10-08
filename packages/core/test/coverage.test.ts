import { describe, expect, it } from "vitest";
import { hitsFor, parseIstanbul, parseLcov, scan } from "@loose-ends/core";
import { project } from "./helpers/project.js";

describe("coverage parsing", () => {
  it("reads lcov line and function hits", () => {
    const map = parseLcov("/repo", "SF:src/a.ts\nFN:3,run\nFNDA:4,run\nDA:3,4\nDA:4,0\nend_of_record\nSF:/repo/src/b.ts\nDA:1,0\nend_of_record\n");
    expect(hitsFor(map, "src/a.ts", 3, 4)).toBe(4);
    expect(hitsFor(map, "src/a.ts", 4, 4)).toBe(0);
    expect(hitsFor(map, "src/b.ts")).toBe(0);
    expect(hitsFor(map, "src/c.ts")).toBeUndefined();
  });

  it("reads istanbul JSON", () => {
    const map = parseIstanbul(
      "/repo",
      JSON.stringify({
        "/repo/src/a.ts": {
          path: "/repo/src/a.ts",
          statementMap: { "0": { start: { line: 2 }, end: { line: 3 } } },
          s: { "0": 7 },
          fnMap: { "0": { decl: { start: { line: 1 } } } },
          f: { "0": 2 },
        },
      }),
    );
    expect([...map.get("src/a.ts")!.entries()]).toEqual([
      [2, 7],
      [3, 7],
      [1, 2],
    ]);
  });
});

describe("coverage evidence", () => {
  it("annotates findings with runtime hits without changing their kind", () => {
    const root = project({
      "package.json": { name: "app", main: "index.ts" },
      "index.ts": "export const x = 1;",
      "plugin.ts": "export function activate() {\n  return 1;\n}",
      "coverage/lcov.info": "SF:plugin.ts\nDA:1,3\nDA:2,3\nend_of_record\n",
    });
    const result = scan({ root, config: { coverage: "coverage/lcov.info" } });
    const finding = result.findings.find((f) => f.target === "plugin.ts")!;
    expect(finding.kind).toBe("orphaned");
    expect(finding.evidence.coverage).toEqual({ hits: 3, source: "coverage/lcov.info" });
    expect(finding.evidence.note).toMatch(/executed during the coverage run/);
  });
});
