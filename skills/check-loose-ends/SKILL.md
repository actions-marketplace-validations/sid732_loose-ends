---
name: check-loose-ends
description: Check that code you added or changed is reachable from a real entry point before you finish. Use after editing TypeScript or JavaScript, before committing, or when asked whether a change left dead, orphaned, or duplicate code.
---

# Check for loose ends

Loose Ends builds a reachability graph from the project's entry points (package exports, bins, scripts, Next.js routes, config entries) and compares the change against its base branch. The graph decides what is dead. Do not overrule it based on how the code looks.

## When to run

- Before you report a coding task as done.
- After a refactor, rename, or "v2" rewrite.
- When the user asks whether anything is unused.

## How to run

Use the MCP tool if it is available:

- `check_changes` with no arguments checks the working tree against the base branch.

Otherwise run the CLI from the project root:

```bash
npx loose-ends check --format json
```

Exit code 0 means pass, 1 means blocking findings, 2 means the tool could not run (read stderr).

## What to do with each finding

| Kind | Meaning | What to do |
|---|---|---|
| `orphaned-addition` | You added code nothing reaches. | Wire it into the code path you meant to change, or delete it. |
| `newly-orphaned` | Your change cut the last path to existing code. | If you replaced it, delete it. If not, restore the edge shown in `brokenEdge`. |
| `superseded` | You wrote a replacement and left the old one. | Delete the old implementation listed in `target`. |
| `duplicate` | You re-implemented something that already exists. | Use the existing code in `related` and remove your copy. |
| `test-only-addition` | Only tests use the new code. | Call it from production code, or move it into the test helpers. |
| `unused-dependency` | A dependency nothing imports. | Remove it from package.json, or move it to devDependencies if only tests use it. |
| `uncertain` | Reachability depends on a dynamic import. | Tell the user. Do not delete it. |
| `invalid-suppression` | A suppression or dormant marker is broken. | Ask the user for the missing reason. |

Use `explain` (MCP) or `npx loose-ends explain <path#symbol>` to see the path from a root, or the top of an unreachable subgraph.

## Rules

- Do not add `loose-ends: dormant`, `loose-ends: ignore`, or config suppressions yourself. Those need a reason from the user. Ask.
- Do not add a file to `entries` just to make a finding go away. Only do it when a framework or runtime really loads that file and the graph cannot see it, and say so to the user.
- Re-run the check after fixing. Report the final result, including anything you left for the user.
