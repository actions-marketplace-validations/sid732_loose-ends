import { resolve } from "node:path";
import {
  VERSION,
  analyze,
  check,
  cleanupPatch,
  explain,
  formatExplanation,
  formatText,
  label,
  loadConfig,
  planCleanup,
  scan,
  toJsonReport,
  verifyCleanup,
  type CheckResult,
} from "@loose-ends/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ServerOptions {
  /** Default project root when a tool call does not pass one. */
  root?: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const rootArg = z.string().optional().describe("Project root. Defaults to the server's working directory.");

/** Compact view of a result for agents: findings with the evidence needed to act on them. */
function compact(result: CheckResult) {
  const report = toJsonReport(result);
  return {
    passed: report.passed,
    mode: report.mode,
    base: report.base,
    head: report.head,
    blocking: result.failing.length,
    findings: report.findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      blocking: f.failing,
      target: f.target,
      location: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined,
      message: f.message,
      evidence: f.evidence,
      suppressed: f.suppressed,
    })),
  };
}

function ok(...texts: string[]): ToolResult {
  return { content: texts.map((text) => ({ type: "text" as const, text })) };
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: `loose-ends error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
}

export function createServer(options: ServerOptions = {}): McpServer {
  const defaultRoot = resolve(options.root ?? process.env.LOOSE_ENDS_ROOT ?? process.cwd());
  const rootOf = (root?: string) => (root ? resolve(defaultRoot, root) : defaultRoot);

  const server = new McpServer(
    { name: "loose-ends", version: VERSION },
    {
      instructions:
        "Loose Ends checks whether code you added or changed is reachable from a real entry point. " +
        "Run check_changes before you finish a task. Blocking findings mean you left orphaned, superseded, or unconnected code: " +
        "wire it in, delete it, or ask the user whether it should be marked dormant. Never mark code dormant or suppress a finding on your own. " +
        "Use explain to see why something is or is not reachable.",
    },
  );

  server.registerTool(
    "check_changes",
    {
      title: "Check changes for loose ends",
      description:
        "Compare the working tree (or a head ref) with its base branch. Reports added code nothing reaches, code the change orphaned, replaced implementations that were not removed, and unused dependencies.",
      inputSchema: {
        root: rootArg,
        base: z.string().optional().describe("Base revision. Defaults to the merge base with origin/HEAD, main, or master."),
        head: z.string().optional().describe("Head revision. Defaults to the working tree, including uncommitted changes."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ root, base, head }) => {
      try {
        const result = check({ root: rootOf(root), base, head });
        return ok(formatText(result), JSON.stringify(compact(result), null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "scan_project",
    {
      title: "Scan project for unreachable code",
      description: "Report every unreachable file, symbol, and dependency in the project, independent of any change. Use it to understand existing debt, not to judge a change.",
      inputSchema: { root: rootArg, limit: z.number().int().positive().max(500).optional().describe("Maximum findings to return (default 100).") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ root, limit }) => {
      try {
        const result = scan({ root: rootOf(root) });
        const view = compact(result);
        const max = limit ?? 100;
        const truncated = view.findings.length > max;
        view.findings = view.findings.slice(0, max);
        return ok(JSON.stringify({ ...view, truncated, total: result.findings.length }, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "explain",
    {
      title: "Explain liveness",
      description: "Explain why a file, symbol (path#name), or dependency is live, test-only, uncertain, dormant, or orphaned, including the path from its root and what references it.",
      inputSchema: { target: z.string().describe("A path like src/a.ts, a symbol like src/a.ts#run, or a package name."), root: rootArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ target, root }) => {
      try {
        const analysis = analyze(loadConfig(rootOf(root)));
        const e = explain(analysis, target);
        if (!e) return fail(new Error(`"${target}" is not a known file, symbol, or dependency`));
        return ok(formatExplanation(e), JSON.stringify(e, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_roots",
    {
      title: "List entry points",
      description: "List the entry points (package exports, bins, scripts, framework routes, config entries, tests) that liveness is measured from.",
      inputSchema: { root: rootArg, kind: z.enum(["production", "tooling", "test"]).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ root, kind }) => {
      try {
        const analysis = analyze(loadConfig(rootOf(root)));
        const roots = analysis.roots
          .filter((r) => r.node.startsWith("file:") && (!kind || r.kind === kind))
          .map((r) => ({ target: label(analysis.graph.nodes.get(r.node), r.node), kind: r.kind, source: r.source, reason: r.reason }));
        return ok(JSON.stringify(roots, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "plan_cleanup",
    {
      title: "Plan cleanup",
      description:
        "Build a removal plan for blocking loose ends and return it as a unified diff. With verify=true the plan is applied in a scratch copy and the project's configured checks run there. Never modifies the working tree: apply the patch yourself after reviewing it.",
      inputSchema: {
        root: rootArg,
        base: z.string().optional(),
        scope: z.enum(["change", "project"]).optional().describe("change (default) cleans up this change; project cleans up everything."),
        verify: z.boolean().optional().describe("Run the configured checks against the cleaned-up copy."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ root, base, scope, verify }) => {
      try {
        const dir = rootOf(root);
        const result = scope === "project" ? scan({ root: dir, keepAnalyses: true }) : check({ root: dir, base, keepAnalyses: true });
        const plan = planCleanup(result.analyses!.head, result.findings);
        if (plan.actions.length === 0) return ok(JSON.stringify({ actions: [], skipped: plan.skipped }, null, 2));
        if (verify) {
          const v = verifyCleanup(dir, plan, result.config.checks);
          const summary = { actions: plan.actions, skipped: plan.skipped, verified: v.passed, checks: v.checks, configuredChecks: result.config.checks.length };
          return ok(JSON.stringify(summary, null, 2), v.patch);
        }
        const { patch } = cleanupPatch(dir, plan);
        return ok(JSON.stringify({ actions: plan.actions, skipped: plan.skipped, verified: false }, null, 2), patch);
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
