# Loose Ends

[![npm](https://img.shields.io/npm/v/loose-ends)](https://www.npmjs.com/package/loose-ends)
[![CI](https://github.com/sid732/loose-ends/actions/workflows/ci.yml/badge.svg)](https://github.com/sid732/loose-ends/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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

[bench/RESULTS.md](bench/RESULTS.md) has the results on public repositories, including about 700 Python and Java commits replayed through `check` and a sweep of 30 popular repositories.

## Install

```bash
npm install --save-dev loose-ends
```

Requires Node.js 20 or newer and git.

Python and Java projects need no `package.json`. With Node installed, run `npx loose-ends check` from the repository root.

The npm packages are published from GitHub Actions with [provenance](https://docs.npmjs.com/generating-provenance-statements), so each version links back to the commit it was built from.

## Usage

```bash
npx loose-ends check                     # working tree vs. merge base with the default branch
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

`scan` reports existing code instead of a change, so it uses `orphaned` (nothing reaches it) and `test-only` (only tests reach it), plus `unused-dependency` and `uncertain`. It exits 0 unless you pass `--fail`.

See [docs/findings.md](docs/findings.md) for what each kind means and what to do about it.

### Configuration

Every option is optional. `npx loose-ends init` writes a starter `loose-ends.config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/sid732/loose-ends/main/schema/config.schema.json",
  "entries": ["src/jobs/*.ts", "src/events/handlers.ts#onInvoicePaid"],
  "extendExclude": ["src/generated/**"],
  "languages": ["javascript", "python"],
  "failOn": ["orphaned-addition", "newly-orphaned", "superseded", "invalid-suppression"],
  "checks": ["npm run typecheck", "npm test"]
}
```

- `entries` adds roots the graph cannot see, such as files a job runner loads by name.
- `extendExclude` adds to the default excludes (`node_modules`, build output, virtualenvs, …).
- `languages` limits analysis to some of `javascript`, `python`, and `java`.
- `failOn` picks the finding kinds that fail `check`.
- `checks` are the commands `fix --verify` runs.

All options, dormant rules, and suppressions are in [docs/configuration.md](docs/configuration.md).

### Intentionally unused code

```ts
// loose-ends: dormant v1 webhooks still arrive until the March cutover
export function handleV1Webhook() {}
```

```python
# loose-ends: dormant v1 webhooks still arrive until the March cutover
def handle_v1_webhook(): ...
```

Java uses `//` like TypeScript. A `loose-ends-file:` comment applies to the whole file instead of the declaration below it.

Dormant markers and suppressions need a reason. Without one, they become findings themselves. See [docs/configuration.md](docs/configuration.md).

## In CI and on pull requests

```yaml
# .github/workflows/loose-ends.yml
name: Loose Ends
on: pull_request
permissions:
  contents: read
  pull-requests: write # for the PR comment
jobs:
  liveness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the base commit must exist locally
      - uses: sid732/loose-ends@v1
```

- **GitHub Action (no server, free on public repos):** adds inline annotations on the diff, keeps one PR comment up to date, writes the report to the job summary, and fails the job on blocking findings. It works for Python and Java repositories too, with no Node setup step.
- **GitHub App:** the same report as check runs, for people who prefer to host a server and install once across many repositories.

Inputs (`working-directory`, `fail-on`, `comment`, `sarif`, …) and App setup are in [docs/github.md](docs/github.md).

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

- **TypeScript and JavaScript:** Node.js, React, Next.js, Vite, Express, NestJS, React Router framework mode, Vue, Svelte and SvelteKit, Astro, Nuxt, VitePress, npm/yarn/pnpm workspaces, browser extensions, and common test runners.
- **Python:** packages and src layouts, relative and namespace imports, `__init__.py` re-exports and `__all__`, scripts, notebooks, pyproject/setup.py entry points, Django, Flask, FastAPI, Celery, Alembic, Airflow, Streamlit, pytest, and dependencies in `requirements*.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`, and `Pipfile`.
- **Java:** top-level classes, interfaces, enums, and records; imports, same-package and fully qualified references; `main` methods; Spring, Jakarta EE, CDI, JAX-RS, Quarkus, Micronaut, MyBatis, MapStruct, Dagger/Hilt, and Android; class names in resource files; Maven and Gradle (including version catalogs) dependencies; and Java code used from Kotlin.

A repository can mix all of them. How it works is described in [docs/architecture.md](docs/architecture.md).

### Limits

- Tracking stops at top-level declarations. An unused method inside a used class, or an unused property on a used object, is not reported.
- Code reached only through dependency injection by name, string-based plugin registries, or reflection is invisible to the graph. Add it to `entries` or mark it with `loose-ends: entry`.
- Java classes with framework annotations (`@Service`, `@Controller`, `@Entity`, …) count as entry points, so they are never reported as unused.
- Kotlin and Groovy are only scanned for the Java names they use. Their own code is not analyzed.
- Python `getattr` with a computed name and modules found through `sys.path` changes are not followed.
- Other languages are not analyzed.

## Contributing

Setup, pull request rules, and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
