import type { FindingKind } from "../types.js";

/** One-line descriptions of each finding kind, used by SARIF and docs. */
export const RULES: Record<FindingKind, { title: string; description: string }> = {
  "orphaned-addition": {
    title: "Added code is unreachable",
    description: "Code added in this change is not reachable from any production entry point.",
  },
  "test-only-addition": {
    title: "Added code is only used by tests",
    description: "Code added in this change is reachable only from test files.",
  },
  "newly-orphaned": {
    title: "Change orphaned existing code",
    description: "Code that was reachable before this change is no longer reachable from any entry point.",
  },
  "newly-test-only": {
    title: "Change left existing code used only by tests",
    description: "Code that production used before this change is now reachable only from tests.",
  },
  superseded: {
    title: "Replaced implementation was not removed",
    description: "Code that this change replaced with a new implementation is still present.",
  },
  duplicate: {
    title: "Added code duplicates a live implementation",
    description: "Code added in this change is structurally near-identical to existing live code.",
  },
  "unused-dependency": {
    title: "Dependency is unused",
    description: "A production dependency is not imported by any live code or run by any script.",
  },
  uncertain: {
    title: "Liveness depends on dynamic behavior",
    description: "Code may only be reachable through dynamic imports the graph cannot resolve.",
  },
  "invalid-suppression": {
    title: "Suppression or dormant marker is invalid",
    description: "A suppression or dormant marker is missing a reason, has expired, or matches nothing.",
  },
  orphaned: {
    title: "Code is unreachable",
    description: "Code is not reachable from any production entry point.",
  },
  "test-only": {
    title: "Code is only used by tests",
    description: "Production code is reachable only from test files.",
  },
};
