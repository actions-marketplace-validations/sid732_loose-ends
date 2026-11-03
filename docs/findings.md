# Findings

Each finding has a kind, a severity, a target (`path` or `path#symbol`), and evidence. Kinds in `failOn` block the change.

In `check` mode, Loose Ends reports only what the change did. Code that was already unreachable before the change is not reported, so the tool can be adopted on a messy codebase without a cleanup first. Run `scan` to see existing debt.

## orphaned-addition

**error, blocks by default.** The change added a file or declaration that no production root reaches.

Usually this is a helper that was written but never called, a component that is never rendered, or a v2 module that nothing imports yet. Wire it in, delete it, or, if something loads it by name, add it to `entries`.

## newly-orphaned

**error, blocks by default.** Code that was reachable before the change no longer is.

Evidence includes the path that used to reach it and the `brokenEdge`, meaning the import or reference the change removed. If you meant to drop the feature, delete the code. If you did not, restore the edge.

## superseded

**error, blocks by default.** The change orphaned some code and also added live code that looks like its replacement. Three signals feed into this:

- callers of the old code now reference the new code,
- the names match once version markers (`V2`, `new`, `legacy`, …) are removed,
- the normalized token structure is similar.

Delete the old implementation, or mark it `dormant` with a reason if it has to stay for a while.

## duplicate

**warning.** The change added a function or class that is at least 90% structurally identical to an existing live one. Reuse the existing code instead.

## test-only-addition

**warning.** The change added code that only tests reach. Either the production call site is missing, or the code is a test helper and belongs with the tests.

## newly-test-only

**warning.** Production used to reach this code, and after the change only tests do. This usually means the code was replaced and its tests were left behind.

## unused-dependency

**warning.** A production dependency in a `package.json` is not imported by live code in that package and not run by any of its scripts. In `check` mode this covers dependencies the change added and dependencies it stopped using. Dependencies used only by tests should move to `devDependencies`.

## uncertain

**info.** Reachability depends on something the graph cannot follow exactly: a template-literal import such as ``import(`./locales/${lang}.ts`)``, or an import with a computed specifier. Loose Ends does not call this code dead. If a coverage report is configured, it adds whether the code actually ran.

## invalid-suppression

**error, blocks by default.** A suppression or dormant marker is missing its reason, has expired, or matches no code.

## orphaned, test-only

Reported only by `scan`. These are the whole-project counterparts of the change-based kinds above.

## Evidence fields

| Field | Meaning |
|---|---|
| `before` / `after` | Liveness in the base and head revisions. |
| `path` | Root-first chain of nodes and edges that reaches (or reached) the code. |
| `root` | Why the starting node is a root. |
| `brokenEdge` | The first edge on the old path that is gone, or whose source is no longer live. |
| `referencedBy` | Unreachable code that still references the target. |
| `related` | For `superseded` and `duplicate`, the other implementation. |
| `similarity` | Replacement or duplicate score, from 0 to 1. |
| `coverage` | Runtime hit count from the configured coverage report. |
