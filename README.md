# Loose Ends

Graph-powered liveness checks for AI-written code.

> Every change should lead somewhere.

Coding agents write code fast, and they leave things behind: a helper that is never called, a `UserServiceV2` sitting next to the `UserService` it replaced, a route that was unregistered while its handler stayed. Loose Ends checks every change before merge and reports, with evidence, whether the code it added or touched is still reachable from a real entry point.

```
$ npx loose-ends check
Loose Ends · check main (dc9af08) → working tree
4 files changed

✖ error   orphaned-addition  src/lib/pagination.ts:1
  File added in this change is not reachable from any entry point.
  Import it from live code, add it to `entries`, or mark it with `// loose-ends-file: dormant <reason>`.

✖ error   superseded  src/services/users.ts:1
  src/services/users.ts appears to have been replaced by src/services/users-v2.ts#listUsersV2 but was not removed: its callers now use the new code (src/routes/users.ts); the names match; 100% structural similarity. Delete it, or mark it dormant with a reason.
  edge removed: src/routes/users.ts → src/services/users.ts
  was reached via: src/server.ts → src/routes/index.ts → src/routes/users.ts → src/services/users.ts
  root: entry point "src/server.ts" of express-api-example
  related: src/services/users-v2.ts#listUsersV2

Summary: 2 errors, 0 warnings, 0 info
Files: 6 live, 0 test-only, 2 orphaned, 0 uncertain, 0 dormant
Result: fail (2 findings in failOn: orphaned-addition, superseded)
```

That is the [express-api example](examples/express-api) after an agent-style change: a `v2` service was added and wired in, the original was left behind, and an unused pagination helper was added.

## What it checks

1. **Added code must be reachable** from a recognized product entry point.
2. **Changes must not orphan existing code** by removing the edges that kept it alive.
3. **Replaced implementations must be removed** or explicitly justified.

Loose Ends builds a Liveness Graph of TypeScript, JavaScript, Python, and Java code: imports, exports, re-exports, references between top-level declarations, dynamic imports, and package dependencies. It finds roots in package manifests, scripts, framework conventions (Next.js routes, Vite entries, browser extension manifests, serverless functions, tool configs, Django apps, pyproject entry points, server commands in Dockerfiles and Procfiles, Spring and Jakarta annotations, Android manifests and layouts), config, and tests. It analyzes the base and head revisions and reports only what the change did. Existing dead code never blocks a pull request.

It is **not** an LLM guessing whether code looks unused, a general code reviewer, a formatter, or a security scanner. It does not claim that unobserved code is safe to delete, and it never deletes anything without deterministic evidence and a passing verification run.

## Install

```bash
npm install --save-dev loose-ends
```

Requires Node.js 20 or newer and git.

## Usage

```bash
npx loose-ends check                     # working tree vs. merge base with main
npx loose-ends check --base origin/main --head HEAD
npx loose-ends check --format markdown   # also: json, sarif
npx loose-ends scan                      # whole-project report of existing debt
npx loose-ends explain src/lib/format.ts#formatUser
npx loose-ends roots                     # what counts as an entry point, and why
npx loose-ends fix --verify --patch cleanup.diff
npx loose-ends init                      # starter loose-ends.config.json
```

`check` exits with 0 on pass, 1 on blocking findings, and 2 when it could not run.

### Findings

| Kind | Severity | Meaning |
|---|---|---|
| `orphaned-addition` | error | Added code that no production root reaches. |
| `newly-orphaned` | error | Code that was live before the change and is not live after it. |
| `superseded` | error | A replaced implementation that was not removed. |
| `invalid-suppression` | error | A suppression or dormant marker that has no reason, has expired, or matches nothing. |
| `test-only-addition` | warning | Added code that only tests reach. |
| `newly-test-only` | warning | Production stopped using this code, and only tests still do. |
| `duplicate` | warning | Added code that is near-identical to an existing live implementation. |
| `unused-dependency` | warning | A dependency that no live code imports. |
| `uncertain` | info | Reachability depends on a dynamic import the graph cannot resolve. |

See [docs/findings.md](docs/findings.md) for what each kind means and what to do about it.

### Intentionally unused code

```ts
// loose-ends: dormant v1 webhooks still arrive until the March cutover
export function handleV1Webhook() {}
```

```python
# loose-ends: dormant v1 webhooks still arrive until the March cutover
def handle_v1_webhook(): ...
```

Dormant markers and suppressions need a reason. Without one, they become findings themselves. See [docs/configuration.md](docs/configuration.md).

## In CI and on pull requests

- **GitHub Action (no server, free on public repos):** `uses: sid732/loose-ends@v1` adds inline annotations on the diff, keeps one PR comment up to date, writes the report to the job summary, and fails the job on blocking findings.
- **GitHub App:** the same report as check runs, for people who prefer to host a server and install once across many repositories.

Setup for both is in [docs/github.md](docs/github.md).

## For coding agents

- **MCP server:** `npx -y @loose-ends/mcp` exposes `check_changes`, `scan_project`, `explain`, `list_roots`, and `plan_cleanup`. All of them are read-only.
- **Skills:** [skills/](skills) has two short `SKILL.md` files that tell an agent when to run the check and how to respond to each finding.

```json
{ "mcpServers": { "loose-ends": { "command": "npx", "args": ["-y", "@loose-ends/mcp"] } } }
```

## Cleanup

```bash
npx loose-ends fix --verify --patch cleanup.diff
```

`fix` turns blocking findings into file deletions and declaration removals and applies them to a scratch copy of the project. Then it runs your configured `checks` (`npm test`, `npm run build`, …) there and writes a patch. Anything that would leave a dangling import is skipped, with the reason listed. `--apply` writes the change to your tree, and only after verification passes.

## Coverage as evidence

```bash
npx loose-ends check --coverage coverage/coverage-final.json
```

Runtime hit counts from istanbul or lcov reports are attached to findings. Coverage never overrides the graph. It explains it: code the graph considers unreachable that still ran points to a loader the graph cannot see.

## Scope

- **TypeScript and JavaScript:** Node.js, React, Next.js, Vite, Express, npm/yarn/pnpm workspaces, browser extensions, and common test runners.
- **Python:** packages and src layouts, relative and namespace imports, `__init__.py` re-exports and `__all__`, scripts, notebooks, pyproject/setup.py entry points, Django, Flask, FastAPI, Celery, Alembic, Airflow, Streamlit, pytest, and dependencies in `requirements*.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`, and `Pipfile`.
- **Java:** top-level classes, interfaces, enums, and records; imports, same-package and fully qualified references; `main` methods; Spring, Jakarta EE, CDI, JAX-RS, Quarkus, Micronaut, MyBatis, MapStruct, Dagger/Hilt, and Android; class names in resource files; Maven and Gradle (including version catalogs) dependencies; and Java code used from Kotlin.

A repository can mix all of them. How it works is described in [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
