import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  analyze,
  discoverPackages,
  detectFrameworks,
  explain,
  formatExplanation,
  label,
  loadConfig,
  CONFIG_FILES,
  type RootKind,
} from "@loose-ends/core";
import type { Command } from "commander";
import { emit, type CliIO } from "../io.js";
import { UsageError } from "./check.js";

export function registerInspect(program: Command, io: CliIO, setExit: (code: number) => void): void {
  program
    .command("explain")
    .description("show why a file, symbol, or dependency is live, test-only, or orphaned")
    .argument("<target>", "path, path#symbol, or package name")
    .argument("[dir]", "project root", ".")
    .option("-f, --format <format>", "text or json", "text")
    .option("--color", "force colored output")
    .option("--no-color", "disable colored output")
    .action((target: string, dir: string, flags: { format: string; color?: boolean }) => {
      const analysis = analyze(loadConfig(resolve(io.cwd, dir)));
      const explanation = explain(analysis, target);
      if (!explanation) {
        io.stderr(`loose-ends: "${target}" is not a known file, symbol, or dependency\n`);
        setExit(2);
        return;
      }
      if (flags.format === "json") emit(io, JSON.stringify(explanation, null, 2) + "\n");
      else if (flags.format === "text") emit(io, formatExplanation(explanation, { color: flags.color ?? io.color }));
      else throw new UsageError(`unknown format "${flags.format}" (expected text or json)`);
      setExit(0);
    });

  program
    .command("roots")
    .description("list the entry points Loose Ends discovered")
    .argument("[dir]", "project root", ".")
    .option("-f, --format <format>", "text or json", "text")
    .option("-k, --kind <kind>", "only production, tooling, or test roots")
    .option("--symbols", "include exported symbols that are roots, not just files")
    .action((dir: string, flags: { format: string; kind?: string; symbols?: boolean }) => {
      if (flags.kind && !["production", "tooling", "test"].includes(flags.kind)) throw new UsageError(`unknown root kind "${flags.kind}"`);
      const analysis = analyze(loadConfig(resolve(io.cwd, dir)));
      const roots = analysis.roots
        .filter((r) => !flags.kind || r.kind === (flags.kind as RootKind))
        .filter((r) => flags.symbols || r.node.startsWith("file:"))
        .map((r) => ({ target: label(analysis.graph.nodes.get(r.node), r.node), kind: r.kind, source: r.source, reason: r.reason }));
      if (flags.format === "json") {
        emit(io, JSON.stringify(roots, null, 2) + "\n");
      } else if (flags.format === "text") {
        if (roots.length === 0) io.stdout("No roots found. Add `entries` to loose-ends.config.json.\n");
        const width = Math.min(60, Math.max(0, ...roots.map((r) => r.target.length)));
        for (const r of roots) io.stdout(`${r.target.padEnd(width)}  ${r.kind.padEnd(10)}  ${r.reason}\n`);
      } else {
        throw new UsageError(`unknown format "${flags.format}" (expected text or json)`);
      }
      setExit(0);
    });

  program
    .command("init")
    .description("write a starter loose-ends.config.json")
    .argument("[dir]", "project root", ".")
    .option("--force", "overwrite an existing config")
    .action((dir: string, flags: { force?: boolean }) => {
      const root = resolve(io.cwd, dir);
      const existing = CONFIG_FILES.map((f) => join(root, f)).find((f) => existsSync(f));
      if (existing && !flags.force) throw new UsageError(`${existing} already exists (use --force to overwrite)`);
      const { frameworks, ...config } = starterConfig(root);
      const path = join(root, "loose-ends.config.json");
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
      io.stdout(`Wrote ${path}\n`);
      io.stdout(`Detected frameworks: ${frameworks.join(", ") || "none (plain Node.js)"}\n`);
      io.stdout("Next: run `loose-ends roots` to review entry points, then `loose-ends check` on a branch.\n");
      setExit(0);
    });
}

function starterConfig(root: string) {
  const packages = discoverPackages(root);
  const frameworks = new Set<string>();
  for (const pkg of packages) for (const f of detectFrameworks(pkg)) if (f !== "node") frameworks.add(f);
  const scripts = packages.find((p) => p.dir === "")?.manifest.scripts ?? {};
  const checks = ["typecheck", "build", "test"].filter((s) => s in scripts).map((s) => `npm run ${s}`);
  const config = loadConfig(root);
  return {
    $schema: "https://raw.githubusercontent.com/sid732/loose-ends/main/schema/config.schema.json",
    entries: [] as string[],
    dormant: [] as Array<{ target: string; reason: string }>,
    suppressions: [] as Array<{ target: string; reason: string }>,
    checks,
    failOn: config.failOn,
    frameworks: [...frameworks].sort(),
  };
}
