import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARKDOWN_MARKER } from "@loose-ends/core";
import { annotations, escapeData, runAction, type ActionEnv } from "@loose-ends/action";
import { git, project, repo } from "../../core/test/helpers/project.js";

const base = {
  "package.json": { name: "app", main: "src/index.ts" },
  "src/index.ts": `import { a } from "./a";\na();`,
  "src/a.ts": `export function a() {}`,
};

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Simulate what the runner provides for a pull_request event. */
function actionEnv(root: string, inputs: Record<string, string> = {}, extra: ActionEnv = {}): ActionEnv {
  const scratch = project({});
  const eventPath = join(scratch, "event.json");
  const baseSha = git(root, "rev-parse", "main").trim();
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: { number: 12, base: { sha: baseSha }, head: { sha: "abc123", repo: { full_name: "acme/web" } } },
      repository: { full_name: "acme/web" },
    }),
  );
  const env: ActionEnv = {
    GITHUB_WORKSPACE: root,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_STEP_SUMMARY: join(scratch, "summary.md"),
    GITHUB_OUTPUT: join(scratch, "output.txt"),
    "INPUT_GITHUB-TOKEN": "t0ken",
    ...extra,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  writeFileSync(env.GITHUB_STEP_SUMMARY!, "");
  writeFileSync(env.GITHUB_OUTPUT!, "");
  return env;
}

function fakeFetch(existing: Array<{ id: number; body: string }> = [], status = 200) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body as string | undefined });
    const data = (init?.method ?? "GET") === "GET" ? existing : { id: 1 };
    return new Response(JSON.stringify(data), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("runAction", () => {
  it("fails, annotates, writes the summary and outputs, and posts one comment", async () => {
    const root = repo(base, { "src/b.ts": "export const b = 1;\n" });
    const env = actionEnv(root, { sarif: "le.sarif" });
    const lines: string[] = [];
    const { impl, calls } = fakeFetch();
    const outcome = await runAction(env, { log: (l) => lines.push(l), fetch: impl });

    expect(outcome.exitCode).toBe(1);
    expect(lines).toContain("::error file=src/b.ts,line=1,title=Loose Ends%3A orphaned-addition (blocking)::File added in this change is not reachable from any entry point.");
    expect(readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("## ❌ Loose Ends: 1 new loose end");
    expect(readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("https://github.com/acme/web/blob/abc123/src/b.ts#L1");
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("passed=false\nfindings=1\nblocking=1\nsarif=le.sarif\n");
    expect(JSON.parse(readFileSync(join(root, "le.sarif"), "utf8")).version).toBe("2.1.0");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.test/repos/acme/web/issues/12/comments?per_page=100&page=1",
      "POST https://api.github.test/repos/acme/web/issues/12/comments",
    ]);
    expect(JSON.parse(calls[1]!.body!).body).toContain(MARKDOWN_MARKER);
    expect(outcome.commented).toBe("created");
  });

  it("passes clean changes, updates an existing comment, and never posts a new one", async () => {
    const root = repo(base, { "src/a.ts": "export function a() { return 1; }" });
    const { impl, calls } = fakeFetch([{ id: 77, body: `${MARKDOWN_MARKER}\nold` }]);
    const outcome = await runAction(actionEnv(root), { log: () => {}, fetch: impl });
    expect(outcome.exitCode).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.test/repos/acme/web/issues/12/comments?per_page=100&page=1",
      "PATCH https://api.github.test/repos/acme/web/issues/comments/77",
    ]);

    const fresh = fakeFetch();
    await runAction(actionEnv(root), { log: () => {}, fetch: fresh.impl });
    expect(fresh.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("warns instead of failing when the token cannot comment", async () => {
    const root = repo(base, { "src/b.ts": "export const b = 1;\n" });
    const lines: string[] = [];
    const { impl } = fakeFetch([], 403);
    const outcome = await runAction(actionEnv(root), { log: (l) => lines.push(l), fetch: impl });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.commented).toBe("failed");
    expect(lines.find((l) => l.startsWith("::warning title=Loose Ends could not comment"))).toContain("pull-requests: write");
  });

  it("honors fail, fail-on, comment, annotations, and working-directory inputs", async () => {
    const root = repo({ "apps/web/package.json": base["package.json"], "apps/web/src/index.ts": base["src/index.ts"], "apps/web/src/a.ts": base["src/a.ts"] }, {
      "apps/web/src/b.ts": "export const b = 1;\n",
    });
    const lines: string[] = [];
    const { impl, calls } = fakeFetch();
    const outcome = await runAction(actionEnv(root, { "working-directory": "apps/web", fail: "false", comment: "never", "fail-on": "superseded" }), {
      log: (l) => lines.push(l),
      fetch: impl,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.passed).toBe(true);
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.startsWith("::warning file=apps/web/src/b.ts,line=1"))).toBe(false);
    expect(lines.some((l) => l.startsWith("::error file=apps/web/src/b.ts,line=1,title=Loose Ends%3A orphaned-addition::"))).toBe(true);

    const quiet: string[] = [];
    await runAction(actionEnv(root, { "working-directory": "apps/web", annotations: "false", comment: "never" }), { log: (l) => quiet.push(l), fetch: impl });
    expect(quiet.some((l) => l.startsWith("::"))).toBe(false);
  });

  it("explains a shallow checkout when the base commit is missing", async () => {
    const root = repo(base);
    const lines: string[] = [];
    const outcome = await runAction(actionEnv(root, { base: "0".repeat(40) }), { log: (l) => lines.push(l), fetch: fakeFetch().impl });
    expect(outcome.exitCode).toBe(2);
    expect(lines.join("\n")).toContain("fetch-depth: 0");
  });
});

describe("workflow command helpers", () => {
  it("escapes data and properties", () => {
    expect(escapeData("50% done\nnext")).toBe("50%25 done%0Anext");
  });

  it("skips suppressed findings", () => {
    const result = { findings: [{ file: "a.ts", line: 1, suppressed: { reason: "r", origin: "o" }, severity: "error", kind: "orphaned-addition", message: "m", evidence: {} }], failing: [] };
    expect(annotations(result as never, "")).toEqual([]);
  });
});

describe("bundled action", () => {
  it("runs action/index.mjs end to end against a fake GitHub API", async () => {
    const bundle = fileURLToPath(new URL("../../../action/index.mjs", import.meta.url));
    const root = repo(base, { "src/b.ts": "export const b = 1;\n" });
    const requests: Call[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: req.method!, url: req.url!, body });
        res.setHeader("content-type", "application/json");
        res.end(req.method === "GET" ? "[]" : '{"id":1}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const env = actionEnv(root, {}, { GITHUB_API_URL: `http://127.0.0.1:${port}` });
      // The fake API runs in this process, so the bundle must run asynchronously.
      const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const p = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolveRun({ status, stdout, stderr }));
      });
      expect(child.stderr).toBe("");
      expect(child.status).toBe(1);
      expect(child.stdout).toContain("::error file=src/b.ts,line=1");
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /repos/acme/web/issues/12/comments?per_page=100&page=1", "POST /repos/acme/web/issues/12/comments"]);
      expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toContain("passed=false");
    } finally {
      server.close();
    }
  });
});
