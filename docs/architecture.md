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
2. **Parse** (`parse.ts`, `python/parse.ts`, `java/parse.ts`): the TypeScript parser reads TS and JS, a small Python tokenizer reads `.py` files and notebook code cells, and a Java tokenizer reads `.java` files (package, imports, top-level types with their annotations, supertypes, and `main` methods). For each module it records imports (static, side-effect, re-export, `export *`, dynamic, `require`; for Python `import`, `from … import`, star imports, and `importlib`), top-level declarations with the identifiers they reference (dotted chains like `mod.func` in Python), top-level statements that run on load, inline directives, and a structural fingerprint of each declaration. Python modules also record strings that look like module paths.
3. **Resolve** (`resolve.ts`, `python/resolve.ts`): specifiers map to files (relative paths, `.js`→`.ts`, directory indexes, tsconfig `paths`, workspace packages via `exports`/`main`, with build output mapped back to source), to external packages, or to assets. Python imports resolve from the importing file's package root, each Python project and its `src/`, and parent directories; standard library modules and unknown top-level names are external.
4. **Graph** (`graph.ts`): nodes are module bodies (`file:`), top-level symbols (`sym:`), and dependencies (`dep:`). Edges:
   - `import`: loading a module runs the module it imports.
   - `reference`: a declaration or module body uses a symbol.
   - `contains`: a symbol exists only if its module loads.
   - `reexport`: a barrel alias points at the original.
   - `dynamic`: a literal `import()` or `require()`, owned by the declaration that contains it.
   - `pattern`: a template-literal import. Followed only for `uncertain`.
   - `dependency`: code uses a package.

   Java types are linked by `java/link.ts`, which indexes every top-level type by its fully qualified name and resolves simple names the way javac does: single-type imports, the file's package, then on-demand imports. When several modules declare the same name, the one closest to the referencing file wins.

   Python modules are linked by `python/link.ts`: a module imports its parent packages' `__init__.py`, `from pkg import name` finds a declaration, a re-exported import, a submodule, or a star import, and `import a.b` followed by `a.b.func()` reaches `func` alone.
5. **Roots** (`roots.ts`, `frameworks.ts`, `directives.ts`, `python/roots.ts`, `java/roots.ts`): providers add production, tooling, and test roots from manifests, scripts, config, framework conventions, deploy and CI commands, and directives.
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
- Calls through dependency injection, string-based plugin registries, or reflection are invisible to the graph. Use `entries` or a `loose-ends: entry` comment for those.
- Python: `getattr` with a computed name, modules loaded from `sys.path` changes or `PYTHONPATH`, and commands that only appear in a README are not followed. Python code in other projects that imports this one is not seen, so a package counts as a published library (public API kept) only when it is built with `[build-system]`, `setup.py`, or `setup.cfg` and shows no app signal.
- Java: methods and fields are not tracked, reflection beyond `Class.forName` literals is not followed, and Kotlin and Groovy code is only scanned for the Java names it uses.
- Other languages are not analyzed.
