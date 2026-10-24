import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Per-repository app settings, read from `.github/loose-ends.json` on the PR head. */
export interface RepoSettings {
  /** Project roots inside the repository, e.g. ["."] or ["apps/web", "packages/api"]. */
  projects: string[];
  /** Report a failing check when blocking findings exist. Make the check required to block merges. */
  blockMerges: boolean;
  /** When to post the sticky PR comment. */
  comment: "always" | "on-findings" | "never";
  /** Name of the check run. */
  checkName: string;
}

export const DEFAULT_SETTINGS: RepoSettings = {
  projects: ["."],
  blockMerges: true,
  comment: "on-findings",
  checkName: "Loose Ends",
};

export function readSettings(repoDir: string): { settings: RepoSettings; warnings: string[] } {
  const file = join(repoDir, ".github", "loose-ends.json");
  const warnings: string[] = [];
  if (!existsSync(file)) return { settings: { ...DEFAULT_SETTINGS }, warnings };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { settings: { ...DEFAULT_SETTINGS }, warnings: [`.github/loose-ends.json is not valid JSON (${(error as Error).message}); using defaults`] };
  }
  const settings = { ...DEFAULT_SETTINGS };
  if (Array.isArray(raw.projects) && raw.projects.every((p) => typeof p === "string" && !p.includes(".."))) settings.projects = raw.projects as string[];
  else if (raw.projects !== undefined) warnings.push('"projects" must be an array of relative paths');
  if (typeof raw.blockMerges === "boolean") settings.blockMerges = raw.blockMerges;
  else if (raw.blockMerges !== undefined) warnings.push('"blockMerges" must be a boolean');
  if (raw.comment === "always" || raw.comment === "on-findings" || raw.comment === "never") settings.comment = raw.comment;
  else if (raw.comment !== undefined) warnings.push('"comment" must be "always", "on-findings", or "never"');
  if (typeof raw.checkName === "string" && raw.checkName.trim()) settings.checkName = raw.checkName.trim();
  return { settings, warnings };
}
