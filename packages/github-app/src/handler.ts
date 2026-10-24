import { join } from "node:path";
import { MARKDOWN_MARKER, check, type CheckResult } from "@loose-ends/core";
import { buildOutput, type ProjectResult } from "./report.js";
import { readSettings } from "./settings.js";
import { clonePullRequest, type Checkout, type CloneRequest } from "./workspace.js";

/** The slice of Octokit the handler uses. Makes the handler easy to test. */
export interface GitHubClient {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>;
}

export interface PullRequestEvent {
  action: string;
  number: number;
  repository: { name: string; owner: { login: string }; html_url: string };
  pull_request: {
    draft?: boolean;
    head: { sha: string };
    base: { sha: string; ref: string };
  };
}

export interface HandlerDeps {
  clone?: (req: CloneRequest) => Checkout;
  check?: (options: { root: string; base: string; head: string }) => CheckResult;
  token: () => Promise<string>;
  log?: (message: string) => void;
  serverUrl?: string;
}

export const HANDLED_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/** Run Loose Ends for one pull request and report a check run and sticky comment. */
export async function handlePullRequest(octokit: GitHubClient, event: PullRequestEvent, deps: HandlerDeps): Promise<void> {
  if (!HANDLED_ACTIONS.has(event.action)) return;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const pr = event.pull_request;
  const log = deps.log ?? (() => {});
  const clone = deps.clone ?? clonePullRequest;
  const runCheck = deps.check ?? ((o) => check(o));

  let checkout: Checkout | undefined;
  let checkRunId: number | undefined;
  let checkName = "Loose Ends";
  try {
    checkout = clone({ owner, repo, pullNumber: event.number, baseSha: pr.base.sha, headSha: pr.head.sha, token: await deps.token(), serverUrl: deps.serverUrl });
    const { settings, warnings } = readSettings(checkout.dir);
    checkName = settings.checkName;
    const created = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: pr.head.sha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    checkRunId = created.data.id;

    const results: ProjectResult[] = [];
    for (const project of settings.projects) {
      try {
        results.push({ project, result: runCheck({ root: join(checkout.dir, project), base: pr.base.sha, head: pr.head.sha }) });
      } catch (error) {
        log(`${owner}/${repo}#${event.number} ${project}: ${(error as Error).message}`);
        results.push({ project, error: (error as Error).message });
      }
    }
    const output = buildOutput(results, settings, { linkBase: `${event.repository.html_url}/blob/${pr.head.sha}/` }, warnings);

    // The checks API accepts at most 50 annotations per request.
    const batches: (typeof output.annotations)[] = [];
    for (let i = 0; i < output.annotations.length; i += 50) batches.push(output.annotations.slice(i, i + 50));
    if (batches.length === 0) batches.push([]);
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner,
        repo,
        check_run_id: checkRunId,
        ...(last ? { status: "completed", conclusion: output.conclusion, completed_at: new Date().toISOString() } : {}),
        output: { title: output.title, summary: output.summary, annotations: batches[i] },
      });
    }

    if (settings.comment !== "never") {
      await upsertComment(octokit, owner, repo, event.number, output.comment, settings.comment === "always" || output.findings > 0);
    }
    log(`${owner}/${repo}#${event.number}: ${output.title}`);
  } catch (error) {
    log(`${owner}/${repo}#${event.number} failed: ${(error as Error).message}`);
    const output = { title: "Analysis failed", summary: `Loose Ends could not analyze this pull request.\n\n\`\`\`\n${(error as Error).message}\n\`\`\`` };
    if (checkRunId !== undefined) {
      await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner,
        repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: "neutral",
        output,
      });
    } else {
      await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name: checkName,
        head_sha: pr.head.sha,
        status: "completed",
        conclusion: "neutral",
        output,
      });
    }
  } finally {
    checkout?.dispose();
  }
}

/** Update the existing Loose Ends comment, or create one when there is something to say. */
async function upsertComment(octokit: GitHubClient, owner: string, repo: string, issue: number, body: string, create: boolean): Promise<void> {
  let existing: { id: number } | undefined;
  for (let page = 1; page <= 10 && !existing; page++) {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: issue, per_page: 100, page });
    existing = (data as Array<{ id: number; body?: string }>).find((c) => c.body?.includes(MARKDOWN_MARKER));
    if ((data as unknown[]).length < 100) break;
  }
  if (existing) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { owner, repo, comment_id: existing.id, body });
  } else if (create) {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: issue, body });
  }
}
