---
name: clean-up-loose-ends
description: Remove orphaned or superseded code found by Loose Ends, verified by the project's own build and tests. Use when the user asks to clean up dead code from a change or across the project.
---

# Clean up loose ends

Cleanup only removes what the graph proves unreachable, and only after the project's checks pass on the cleaned-up copy.

## Steps

1. Get the plan and patch without touching the working tree:
   - MCP: `plan_cleanup` with `verify: true` (add `scope: "project"` for the whole repo).
   - CLI: `npx loose-ends fix --verify --patch loose-ends.diff` (add `--scan` for the whole repo).
2. Read the plan. Anything under "skipped" needs a manual edit. Each entry says why it was skipped.
3. If verification failed, do not apply the patch. Show the failing check output to the user. The usual cause is code loaded in a way the graph cannot see.
4. If verification passed, apply the patch with `git apply loose-ends.diff`, or run `npx loose-ends fix --apply`, which re-runs the checks first.
5. Run `npx loose-ends check` again and report what was removed and what is left.

## Rules

- When no `checks` are configured, nothing has been verified. Say so and ask before applying.
- Never delete `uncertain` or `dormant` code.
- Keep the cleanup in its own commit so it is easy to review and revert.
