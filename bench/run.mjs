#!/usr/bin/env node
// Benchmark Loose Ends on a checkout: node bench/run.mjs <repo-dir> [mode] [base]
//   mode: scan (default) | check
// Prints one JSON line with timings, graph size, peak memory, and finding counts.
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { analyze, check, loadConfig, scanFindings, scanDependencyFindings, summarize } from "../packages/core/dist/index.js";

const [dir, mode = "scan", base = "HEAD~1"] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node bench/run.mjs <repo-dir> [scan|check] [base]");
  process.exit(2);
}
const root = resolve(dir);
let peak = 0;
const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const byKind = (findings) => findings.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {});

const started = performance.now();
let out;
if (mode === "check") {
  const result = check({ root, base, head: "HEAD" });
  out = {
    mode,
    base,
    changedFiles: result.changed.length,
    findings: byKind(result.findings),
    passed: result.passed,
  };
} else {
  const config = loadConfig(root);
  const t0 = performance.now();
  const analysis = analyze(config);
  const t1 = performance.now();
  const findings = [...scanFindings(analysis), ...scanDependencyFindings(analysis)];
  const s = summarize(analysis);
  out = {
    mode,
    files: analysis.build.files.length,
    nodes: analysis.graph.nodes.size,
    edges: analysis.graph.edgeCount,
    roots: analysis.roots.length,
    analyzeMs: Math.round(t1 - t0),
    liveFiles: s.files.live,
    orphanedFiles: s.files.orphaned,
    testOnlyFiles: s.files["test-only"],
    uncertainFiles: s.files.uncertain,
    unresolvedImports: analysis.graph.unresolved.length,
    findings: byKind(findings),
  };
}
clearInterval(sample);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ repo: root.split("/").pop(), totalMs: Math.round(performance.now() - started), peakRssMb: Math.round(peak / 1048576), ...out }));
