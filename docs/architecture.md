# Architecture

Loose Ends is a deterministic reachability engine. The same input always produces the same findings, and no model or heuristic decides that code is dead. An LLM may explain findings or propose patches through the MCP server and skills, but the graph makes the decision.

```
packages/
  core/        Liveness Graph engine (library)
  cli/         `loose-ends` command
  mcp/         MCP server for coding agents
  github-app/  Webhook server: check runs, annotations, sticky comment
skills/        Agent instructions (SKILL.md)
action.yml     Composite GitHub Action
```

## Pipeline

1. **Discover** (`discover.ts`): source files from include/exclude globs and `.gitignore`, with test files flagged.
2. **Parse** (`parse.ts`): the TypeScript parser reads TS and JS. For each module it records imports (static, side-effect, re-export, `export *`, dynamic, `require`), top-level declarations with the identifiers they reference, top-level statements that run on load, inline directives, and a structural fingerprint of each declaration.
3. **Resolve** (`resolve.ts`): specifiers map to files (relative paths, `.js`→`.ts`, directory indexes, tsconfig `paths`, workspace packages via `exports`/`main`, with build output mapped back to source), to external packages, or to assets.
4. **Graph** (`graph.ts`): nodes are module bodies (`file:`), top-level symbols (`sym:`), and dependencies (`dep:`). Edges:
   - `import`: loading a module runs the module it imports.
   - `reference`: a declaration or module body uses a symbol.
   - `contains`: a symbol exists only if its module loads.
   - `reexport`: a barrel alias points at the original.
   - `dynamic`: a literal `import()` or `require()`, owned by the declaration that contains it.
   - `pattern`: a template-literal import. Followed only for `uncertain`.
   - `dependency`: code uses a package.
5. **Roots** (`roots.ts`, `frameworks.ts`, `directives.ts`): providers add production, tooling, and test roots from manifests, scripts, config, framework conventions, and directives.
6. **Classify** (`liveness.ts`): a breadth-first walk from production and tooling roots marks nodes `live`, and a second walk from test roots marks `test-only`. Pattern targets, and siblings of computed imports, become `uncertain`. Everything else is `orphaned` unless a dormant rule covers it. Each reached node remembers the edge it was reached through, so a path can be rebuilt.
7. **Compare** (`findings.ts`, `check.ts`): the base revision (merge base, written to a temp directory with `git cat-file`, skipping binaries, documents, and data files far from code) and the head (a ref or the working tree) are analyzed with the same config. Renames are mapped, and findings describe only the transitions this change caused.
8. **Refine**: dependency usage (`dependencies.ts`), replacement and duplicate detection (`superseded.ts`), suppressions, and coverage evidence (`coverage.ts`).
9. **Report** (`report/`): text, JSON, markdown, and SARIF.
10. **Clean up** (`cleanup.ts`): turn findings into deletions, apply them in a scratch copy, run the configured checks, and return a patch.

## Design choices

- **Bias toward live.** Reference collection ignores shadowing, namespace imports keep every export alive, and CommonJS modules export everything. When the engine is wrong, it is wrong in the direction of keeping code, because a false "dead" costs more than a missed one.
- **Change-scoped by default.** Rule 1 (added code must be reachable) and rule 2 (a change must not orphan existing code) only look at what the change did. Existing debt never blocks a PR.
- **Every finding carries its evidence.** A finding includes the path that reaches the code, or the edge that broke, or the top of the unreachable subgraph. If there is no evidence, there is no finding.
- **Reasons are mandatory.** Dormant markers and suppressions without a reason are findings themselves.
- **No silent deletion.** Cleanup returns a patch. `--apply` writes it only after the project's own checks pass on a copy.

## Limits

- Symbol granularity is the top-level declaration. Class members and object properties are not tracked separately.
- Calls through dependency injection, string-based plugin registries, or reflection are invisible to the graph. Use `entries` or `// loose-ends: entry` for those.
- Only TypeScript and JavaScript are analyzed so far.
