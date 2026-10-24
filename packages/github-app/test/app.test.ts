import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKDOWN_MARKER } from "@loose-ends/core";
import { clonePullRequest, handlePullRequest, limiter, readSettings, type GitHubClient, type PullRequestEvent } from "@loose-ends/github-app";
import { git, project, repo, writeFiles } from "../../core/test/helpers/project.js";

const base = {
  "package.json": { name: "app", main: "index.ts" },
  "index.ts": `import { a } from "./a";\na();`,
  "a.ts": `export function a() {}`,
};

/** Publish a repo with a PR ref into a local "server" directory laid out like github.com. */
function serve(head: Record<string, string | object | null>, extraBase: Record<string, string | object> = {}) {
  const root = repo({ ...base, ...extraBase }, head, { commitHead: true });
  const server = project({});
  mkdirSync(join(server, "acme"), { recursive: true });
  git(server, "clone", "-q", "--bare", root, join(server, "acme", "web.git"));
  const headSha = git(root, "rev-parse", "HEAD").trim();
  const baseSha = git(root, "rev-parse", "main").trim();
  git(join(server, "acme", "web.git"), "update-ref", "refs/pull/7/head", headSha);
  return { server, headSha, baseSha };
}

function event(baseSha: string, headSha: string, action = "opened"): PullRequestEvent {
  return {
    action,
    number: 7,
    repository: { name: "web", owner: { login: "acme" }, html_url: "https://github.com/acme/web" },
    pull_request: { head: { sha: headSha }, base: { sha: baseSha, ref: "main" } },
  };
}

function fakeOctokit(comments: Array<{ id: number; body: string }> = []) {
  const calls: Array<{ route: string; params: Record<string, any> }> = [];
  const client: GitHubClient = {
    async request(route, params = {}) {
      calls.push({ route, params });
      if (route.startsWith("POST /repos/{owner}/{repo}/check-runs")) return { data: { id: 99 } };
      if (route.startsWith("GET")) return { data: comments };
      return { data: {} };
    },
  };
  return { client, calls };
}

describe("clonePullRequest", () => {
  it("checks out the PR head with the base commit available", () => {
    const { server, headSha, baseSha } = serve({ "b.ts": "export const b = 1;" });
    const checkout = clonePullRequest({ owner: "acme", repo: "web", pullNumber: 7, baseSha, headSha, token: "t0k3n", serverUrl: server });
    try {
      expect(existsSync(join(checkout.dir, "b.ts"))).toBe(true);
      expect(git(checkout.dir, "cat-file", "-t", baseSha).trim()).toBe("commit");
      expect(git(checkout.dir, "remote", "get-url", "origin")).not.toContain("t0k3n");
    } finally {
      checkout.dispose();
    }
  });
});

describe("handlePullRequest", () => {
  it("fails the check run, annotates, and comments when blocking findings exist", async () => {
    const { server, headSha, baseSha } = serve({ "b.ts": "export const b = 1;" });
    const { client, calls } = fakeOctokit();
    await handlePullRequest(client, event(baseSha, headSha), { token: async () => "x", serverUrl: server });

    expect(calls[0]).toMatchObject({ route: "POST /repos/{owner}/{repo}/check-runs", params: { name: "Loose Ends", head_sha: headSha, status: "in_progress" } });
    const done = calls.find((c) => c.route.startsWith("PATCH /repos/{owner}/{repo}/check-runs"))!;
    expect(done.params).toMatchObject({ check_run_id: 99, status: "completed", conclusion: "failure" });
    expect(done.params.output.title).toBe("1 blocking loose end");
    expect(done.params.output.annotations).toEqual([
      expect.objectContaining({ path: "b.ts", start_line: 1, annotation_level: "failure", title: "Loose Ends: orphaned-addition" }),
    ]);
    expect(done.params.output.summary).toContain(`https://github.com/acme/web/blob/${headSha}/b.ts#L1`);
    const comment = calls.find((c) => c.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments")!;
    expect(comment.params.body).toContain(MARKDOWN_MARKER);
  });

  it("passes clean changes and updates an existing comment instead of posting", async () => {
    const { server, headSha, baseSha } = serve({ "a.ts": "export function a() { return 1; }" });
    const { client, calls } = fakeOctokit([{ id: 5, body: `${MARKDOWN_MARKER}\nold` }]);
    await handlePullRequest(client, event(baseSha, headSha, "synchronize"), { token: async () => "x", serverUrl: server });
    const done = calls.find((c) => c.route.startsWith("PATCH /repos/{owner}/{repo}/check-runs"))!;
    expect(done.params.conclusion).toBe("success");
    expect(calls.some((c) => c.route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}" && c.params.comment_id === 5)).toBe(true);
    expect(calls.some((c) => c.route.startsWith("POST /repos/{owner}/{repo}/issues"))).toBe(false);
  });

  it("honors repo settings for projects, merge blocking, and comments", async () => {
    const settings = { ".github/loose-ends.json": { projects: ["."], blockMerges: false, comment: "never", checkName: "Liveness" } };
    const { server, headSha, baseSha } = serve({ "b.ts": "export const b = 1;", ...settings });
    const { client, calls } = fakeOctokit();
    await handlePullRequest(client, event(baseSha, headSha), { token: async () => "x", serverUrl: server });
    expect(calls[0]!.params.name).toBe("Liveness");
    expect(calls.find((c) => c.route.startsWith("PATCH"))!.params.conclusion).toBe("success");
    expect(calls.some((c) => c.route.includes("comments"))).toBe(false);
  });

  it("reports a neutral check when analysis cannot run", async () => {
    const { client, calls } = fakeOctokit();
    await handlePullRequest(client, event("a".repeat(40), "b".repeat(40)), {
      token: async () => "x",
      clone: () => {
        throw new Error("clone exploded");
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({ route: "POST /repos/{owner}/{repo}/check-runs", params: expect.objectContaining({ conclusion: "neutral" }) }),
    ]);
    expect(calls[0]!.params.output.summary).toContain("clone exploded");
  });

  it("ignores unrelated actions", async () => {
    const { client, calls } = fakeOctokit();
    await handlePullRequest(client, event("a", "b", "labeled"), { token: async () => "x" });
    expect(calls).toEqual([]);
  });
});

describe("helpers", () => {
  it("validates settings", () => {
    const dir = project({});
    writeFiles(dir, { ".github/loose-ends.json": { projects: ["../escape"], comment: "sometimes" } });
    const { settings, warnings } = readSettings(dir);
    expect(settings.projects).toEqual(["."]);
    expect(warnings).toHaveLength(2);
  });

  it("limits concurrency", async () => {
    const limit = limiter(1);
    const order: string[] = [];
    const task = (name: string, ms: number) => limit(async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
    });
    await Promise.all([task("a", 20), task("b", 1)]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });
});
