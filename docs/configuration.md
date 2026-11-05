# Configuration

Loose Ends reads the first of these that exists in the project root:

1. `loose-ends.config.json`
2. `.loose-endsrc.json`
3. the `looseEnds` key in `package.json`

Every option is optional. Run `npx loose-ends init` to write a starter file, and add `"$schema": "https://raw.githubusercontent.com/sid732/loose-ends/main/schema/config.schema.json"` for editor completion. Unknown keys are an error, so typos fail loudly instead of being ignored.

```json
{
  "entries": ["src/jobs/*.ts", "src/events/handlers.ts#onInvoicePaid"],
  "extendExclude": ["src/generated/**"],
  "dormant": [{ "target": "src/billing/v1/**", "reason": "v1 webhooks still arrive until March" }],
  "suppressions": [
    { "target": "src/flags.ts#betaSearch", "kind": "orphaned-addition", "reason": "wired up in #412", "expires": "2026-12-31" }
  ],
  "checks": ["npm run typecheck", "npm test"],
  "coverage": "coverage/coverage-final.json"
}
```

## Options

| Option | Default | Description |
|---|---|---|
| `include` / `extendInclude` | `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | Source files to analyze. `include` replaces the default and `extendInclude` adds to it. |
| `exclude` / `extendExclude` | `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `*.d.ts`, … | Files to ignore. The root `.gitignore` is applied as well. |
| `testPatterns` / `extendTestPatterns` | `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`, `e2e/`, `*.stories.*`, `fixtures/` | Files that count as tests. Tests are roots, but code reachable only from tests is reported as test-only. |
| `entries` | `[]` | Extra production roots. Use these for things a runtime loads by name, such as job files or plugin modules. `path#symbol` makes just one export a root. |
| `frameworks` | `"auto"` | Which framework conventions to apply. `auto` reads each workspace package's dependencies. |
| `dormant` | `[]` | Code that is unreachable on purpose. Every rule needs a `reason`. |
| `suppressions` | `[]` | Findings that have been reviewed and accepted. Every suppression needs a `reason`. `kind` limits it to one finding kind, and once `expires` passes the suppression stops working and is reported. |
| `checks` | `[]` | Commands run by `loose-ends fix --verify` and `--apply` against the cleaned-up copy. |
| `failOn` | `orphaned-addition`, `newly-orphaned`, `superseded`, `invalid-suppression` | Finding kinds that make `check` exit 1 and fail the check run. |
| `tsconfig` | nearest `tsconfig.json` / `jsconfig.json` | Path aliases (`paths`, `baseUrl`) used for resolution. |
| `coverage` | none | Runtime coverage report, used as supporting evidence. |
| `dependencies` | `true` | Analyze `dependencies` in each package.json. |
| `ignoreDependencies` | `[]` | Globs of dependencies that are loaded implicitly. |

## Inline directives

Directives go in comments. A `loose-ends:` comment applies to the declaration directly below it, and a `loose-ends-file:` comment applies to the whole file.

```ts
// loose-ends-file: entry

// loose-ends: dormant re-enabled when billing v2 ships
export function exportLegacyInvoices() {}

// loose-ends: ignore orphaned-addition wired up in the next PR
export function draftHandler() {}

// loose-ends: entry
export const onMessage = () => {};
```

| Directive | Effect |
|---|---|
| `entry` | Makes the declaration (or file) a production root. |
| `dormant <reason>` | Marks unreachable code as intentionally unused. Anything reachable only through it becomes dormant too. |
| `ignore [kind] <reason>` | Suppresses findings on the declaration (or file), optionally for a single kind. |

A `dormant` or `ignore` directive without a reason is reported as `invalid-suppression`, which blocks by default. Reasons are kept so that whoever revisits the code knows why it stayed.

## Roots Loose Ends finds on its own

- `main`, `module`, `browser`, `bin`, and `exports` in every workspace `package.json`. Library entry points make all of their exports public API.
- Files run by package scripts (`node x.js`, `tsx src/server.ts`, …). Scripts named like `test*` count as test roots, and `build`, `lint`, `db`, `seed`, and similar names count as tooling roots.
- A conventional entry (`index`, `src/index`, `src/main`, `server`, `app`) for packages that declare none.
- Next.js: App Router special files (`page`, `layout`, `route`, `loading`, `error`, `not-found`, metadata files, …), every file under `pages/`, `middleware`, `instrumentation`, and `next.config`. Only exports Next.js reads count as roots, so an extra helper exported from a page is still reported.
- Vite: `<script src>` tags in `index.html`.
- Browser extensions: scripts named in a `manifest.json` that has `manifest_version` (background, content scripts, web-accessible resources), and `<script src>` tags in the HTML pages it names (popup, options, side panel, devtools). No `package.json` is needed.
- Docusaurus config, sidebars, pages, and swizzled theme components.
- Storybook config, Vercel `api/` functions, Netlify functions, and tool config files (`*.config.*`, `.*rc.*`).
- Test files.

Run `npx loose-ends roots` to see what was found and why.
