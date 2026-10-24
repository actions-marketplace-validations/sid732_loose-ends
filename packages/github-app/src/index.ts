import { App } from "@octokit/app";
import { handlePullRequest, HANDLED_ACTIONS, type GitHubClient, type PullRequestEvent } from "./handler.js";

export { handlePullRequest, HANDLED_ACTIONS } from "./handler.js";
export type { GitHubClient, HandlerDeps, PullRequestEvent } from "./handler.js";
export { buildOutput, annotationsFor } from "./report.js";
export type { Annotation, CheckOutput, ProjectResult } from "./report.js";
export { DEFAULT_SETTINGS, readSettings } from "./settings.js";
export type { RepoSettings } from "./settings.js";
export { clonePullRequest } from "./workspace.js";

export interface AppConfig {
  appId: string | number;
  privateKey: string;
  webhookSecret: string;
  /** Maximum pull requests analyzed at once. */
  concurrency?: number;
  log?: (message: string) => void;
}

/** A tiny FIFO limiter so a burst of pushes does not clone dozens of repos at once. */
export function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createApp(config: AppConfig): App {
  const app = new App({ appId: config.appId, privateKey: config.privateKey, webhooks: { secret: config.webhookSecret } });
  const limit = limiter(config.concurrency ?? 2);
  const log = config.log ?? ((m: string) => console.log(m));
  const latest = new Map<string, string>();

  app.webhooks.on("pull_request", async ({ octokit, payload }) => {
    const event = payload as unknown as PullRequestEvent;
    if (!HANDLED_ACTIONS.has(event.action)) return;
    const key = `${event.repository.owner.login}/${event.repository.name}#${event.number}`;
    latest.set(key, event.pull_request.head.sha);
    await limit(async () => {
      // Skip stale queued runs when newer commits were pushed meanwhile.
      if (latest.get(key) !== event.pull_request.head.sha) return;
      await handlePullRequest(octokit as unknown as GitHubClient, event, {
        log,
        token: async () => ((await (octokit as unknown as { auth: (o: object) => Promise<{ token: string }> }).auth({ type: "installation" })).token),
      });
    });
  });
  app.webhooks.onError((error) => log(`webhook error: ${error.message}`));
  return app;
}
