import { resolve } from "node:path";
import { applyCleanup, check, planCleanup, scan, verifyCleanup, type CheckResult } from "@loose-ends/core";
import type { Command } from "commander";
import { emit, type CliIO } from "../io.js";

interface FixFlags {
  base?: string;
  scan?: boolean;
  verify?: boolean;
  apply?: boolean;
  patch?: string;
  check?: string[];
}

export function registerFix(program: Command, io: CliIO, setExit: (code: number) => void): void {
  program
    .command("fix")
    .description("plan removal of loose ends, verify it with your checks, and optionally apply it")
    .argument("[dir]", "project root", ".")
    .option("-b, --base <ref>", "base revision for change mode")
    .option("--scan", "plan cleanup for the whole project instead of just this change")
    .option("--verify", "apply the plan in a scratch copy and run the configured checks")
    .option("--apply", "write the cleanup to the working tree (runs --verify first when checks exist)")
    .option("--patch <file>", "write the cleanup as a unified diff")
    .option("-c, --check <command...>", "check commands to run instead of config `checks`")
    .action((dir: string, flags: FixFlags) => {
      const root = resolve(io.cwd, dir);
      const result: CheckResult = flags.scan ? scan({ root, keepAnalyses: true }) : check({ root, base: flags.base, keepAnalyses: true });
      const plan = planCleanup(result.analyses!.head, result.findings);
      const checks = flags.check ?? result.config.checks;

      if (plan.actions.length === 0) {
        io.stdout(result.findings.length ? "Nothing can be removed automatically.\n" : "No loose ends to clean up.\n");
      } else {
        io.stdout(`Cleanup plan (${plan.actions.length} change${plan.actions.length === 1 ? "" : "s"}):\n`);
        for (const a of plan.actions) {
          io.stdout(a.type === "delete-file" ? `  delete  ${a.path}\n` : `  remove  ${a.path}#${a.symbol} (line ${a.line})\n`);
        }
      }
      if (plan.skipped.length) {
        io.stdout(`\nLeft for manual review (${plan.skipped.length}):\n`);
        for (const s of plan.skipped) io.stdout(`  ${s.target}: ${s.reason}\n`);
      }
      if (plan.actions.length === 0) {
        setExit(0);
        return;
      }

      const shouldVerify = flags.verify || (flags.apply && checks.length > 0);
      const verification = verifyCleanup(root, plan, shouldVerify ? checks : []);
      if (flags.patch) {
        emit(io, verification.patch, flags.patch);
        if (flags.patch !== "-") io.stdout(`\nPatch written to ${flags.patch}\n`);
      }

      if (shouldVerify) {
        if (checks.length === 0) io.stdout("\nNo checks configured. Add `checks` to loose-ends.config.json or pass --check.\n");
        for (const run of verification.checks) {
          io.stdout(`\n${run.exitCode === 0 ? "✔" : "✖"} ${run.command} (${(run.durationMs / 1000).toFixed(1)}s)\n`);
          if (run.exitCode !== 0 && run.output) io.stdout(run.output.replace(/^/gm, "    ") + "\n");
        }
        if (!verification.passed) {
          io.stderr("\nVerification failed. The working tree was not changed.\n");
          setExit(1);
          return;
        }
        if (checks.length) io.stdout("\nVerification passed.\n");
      }

      if (flags.apply) {
        if (checks.length === 0) io.stderr("warning: applying without verification; no checks are configured\n");
        const touched = applyCleanup(root, plan);
        io.stdout(`\nApplied cleanup to ${touched.length} file${touched.length === 1 ? "" : "s"}. Review with \`git diff\`.\n`);
      } else if (!flags.patch) {
        io.stdout("\nDry run. Use --patch <file> to save the diff, --verify to run checks, or --apply to write it.\n");
      }
      setExit(0);
    });
}
