import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MARKDOWN_MARKER, check, formatMarkdown, formatSarif, formatText, type CheckResult, type Finding, type FindingKind } from "@loose-ends/core";

export interface ActionEnv {
  [key: string]: string | undefined;
}

export interface ActionIO {
  /** Stdout of the step. Workflow commands such as ::error:: go here. */
  log: (line: string) => void;
  fetch: typeof fetch;
}

export interface ActionOutcome {
  exitCode: number;
  result?: CheckResult;
  commented?: "created" | "updated" | "skipped" | "failed";
}

/** Read an action input the way the runner exposes it: INPUT_<NAME> with the name upper-cased. */
export function input(env: ActionEnv, name: string, fallback = ""): string {
  const value = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/** Escape data and properties for GitHub workflow commands. */
export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

const COMMAND = { error: "error", warning: "warning", info: "notice" } as const;

/** One `::error file=…,line=…::message` line per unsuppressed finding with a location. */
export function annotations(result: CheckResult, pathPrefix: string): string[] {
  return result.findings
    .filter((f) => f.file && !f.suppressed)
    .map((f) => {
      const props = [`file=${escapeProperty(pathPrefix + f.file)}`, `line=${f.line ?? 1}`];
      if (f.endLine && f.endLine !== f.line) props.push(`endLine=${f.endLine}`);
      props.push(`title=${escapeProperty(`Loose Ends: ${f.kind}${result.failing.includes(f) ? " (blocking)" : ""}`)}`);
      return `::${COMMAND[f.severity]} ${props.join(",")}::${escapeData(annotationText(f))}`;
    });
}

function annotationText(f: Finding): string {
  const extra: string[] = [];
  if (f.evidence.brokenEdge) extra.push(`edge removed: ${f.evidence.brokenEdge.from} → ${f.evidence.brokenEdge.to}`);
  if (f.evidence.related?.length) extra.push(`related: ${f.evidence.related.join(", ")}`);
  return [f.message, ...extra].join("\n");
}

function setOutput(env: ActionEnv, name: string, value: string) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

interface PullRequestPayload {
  pull_request?: { number: number; base: { sha: string; ref?: string }; head: { sha: string; ref?: string; repo?: { full_name?: string } } };
  repository?: { full_name?: string };
}

function readEvent(env: ActionEnv): PullRequestPayload {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as PullRequestPayload;
  } catch {
    return {};
  }
}

/** Create or update the single Loose Ends comment on a pull request. */
export async function upsertComment(
  io: ActionIO,
  options: { api: string; repo: string; issue: number; token: string; body: string; create: boolean },
): Promise<"created" | "updated" | "skipped"> {
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "loose-ends-action",
  };
  const base = `${options.api}/repos/${options.repo}`;
  let existing: number | undefined;
  for (let page = 1; page <= 10 && existing === undefined; page++) {
    const res = await io.fetch(`${base}/issues/${options.issue}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`listing comments failed: HTTP ${res.status}`);
    const comments = (await res.json()) as Array<{ id: number; body?: string }>;
    existing = comments.find((c) => c.body?.includes(MARKDOWN_MARKER))?.id;
    if (comments.length < 100) break;
  }
  if (existing !== undefined) {
    const res = await io.fetch(`${base}/issues/comments/${existing}`, { method: "PATCH", headers, body: JSON.stringify({ body: options.body }) });
    if (!res.ok) throw new Error(`updating comment failed: HTTP ${res.status}`);
    return "updated";
  }
  if (!options.create) return "skipped";
  const res = await io.fetch(`${base}/issues/${options.issue}/comments`, { method: "POST", headers, body: JSON.stringify({ body: options.body }) });
  if (!res.ok) throw new Error(`creating comment failed: HTTP ${res.status}`);
  return "created";
}

/** The whole action: check, report, annotate, comment, set outputs. */
export async function runAction(env: ActionEnv, io: ActionIO): Promise<ActionOutcome> {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const workingDirectory = input(env, "working-directory", ".");
  const root = isAbsolute(workingDirectory) ? workingDirectory : resolve(workspace, workingDirectory);
  const rel = relative(workspace, root).split(sep).join("/");
  const pathPrefix = rel && !rel.startsWith("..") ? `${rel}/` : "";
  const event = readEvent(env);
  const pr = event.pull_request;
  const base = input(env, "base") || pr?.base.sha || undefined;
  const failOn = input(env, "fail-on")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean) as FindingKind[];
  const commentMode = input(env, "comment", "on-findings");
  const sarifPath = input(env, "sarif");
  const shouldFail = input(env, "fail", "true") !== "false";

  let result: CheckResult;
  try {
    result = check({ root, base, config: failOn.length ? { failOn } : undefined });
  } catch (error) {
    io.log(`::error title=Loose Ends could not run::${escapeData((error as Error).message)}`);
    if (/merge base|unknown revision|bad object|not a valid/i.test((error as Error).message)) {
      io.log("::notice::The base commit is missing. Use actions/checkout with fetch-depth: 0.");
    }
    return { exitCode: 2 };
  }

  if (pr) {
    // On pull_request events the checkout is GitHub's temporary merge commit. Label the comparison
    // with the branch names and the PR head commit, which is what reviewers recognize.
    if (result.base && pr.base.ref && !input(env, "base")) result.base = { ...result.base, ref: pr.base.ref };
    result.head = { ref: pr.head.ref ? `#${pr.number} (${pr.head.ref})` : `#${pr.number}`, commit: pr.head.sha };
  }
  io.log(formatText(result).trimEnd());
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = env.GITHUB_REPOSITORY;
  const sha = pr?.head.sha ?? env.GITHUB_SHA;
  const linkBase = repo && sha ? `${server}/${repo}/blob/${sha}/${pathPrefix}` : undefined;
  const markdown = formatMarkdown(result, { linkBase });

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + "\n");
  if (input(env, "annotations", "true") !== "false") for (const line of annotations(result, pathPrefix)) io.log(line);
  if (sarifPath) writeFileSync(resolve(workspace, sarifPath), formatSarif(result, { pathPrefix }));

  let commented: ActionOutcome["commented"] = "skipped";
  const token = input(env, "github-token");
  if (pr && repo && token && commentMode !== "never") {
    const hasFindings = result.findings.some((f) => !f.suppressed);
    try {
      commented = await upsertComment(io, {
        api: env.GITHUB_API_URL ?? "https://api.github.com",
        repo,
        issue: pr.number,
        token,
        body: markdown,
        create: commentMode === "always" || hasFindings,
      });
    } catch (error) {
      commented = "failed";
      const fromFork = pr.head.repo?.full_name && event.repository?.full_name && pr.head.repo.full_name !== event.repository.full_name;
      io.log(
        `::warning title=Loose Ends could not comment::${escapeData(
          `${(error as Error).message}${fromFork ? ". Pull requests from forks get a read-only token, so no comment is posted. Annotations and the check result still apply." : ". Grant pull-requests: write to the job to enable the comment."}`,
        )}`,
      );
    }
  }

  setOutput(env, "passed", String(result.passed));
  setOutput(env, "findings", String(result.findings.filter((f) => !f.suppressed).length));
  setOutput(env, "blocking", String(result.failing.length));
  if (sarifPath) setOutput(env, "sarif", sarifPath);
  return { exitCode: result.passed || !shouldFail ? 0 : 1, result, commented };
}
