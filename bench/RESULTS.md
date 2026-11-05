# Benchmarks

Run on 2026-11-05 on an Apple M4 laptop with Node.js 25.9, against shallow clones of four public repositories. Times are wall-clock for a single run, and they varied by up to about 1.5x between runs on the same machine.

| Repo | Commit | Source files | Graph nodes / edges |
|---|---|---|---|
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | `0c9b449` | 710 | 5,349 / 29,872 |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | `8a35366` | 4,426 | 17,730 / 83,189 |
| [TryGhost/Ghost](https://github.com/TryGhost/Ghost) | `d7f3a0a` | 7,280 | 34,310 / 144,138 |
| [calcom/cal.com](https://github.com/calcom/cal.com) | `2eb48ec` | 5,025 | 20,078 / 89,460 |

## Speed and memory

| Repo | `scan` | `check` HEAD~1 | `check` HEAD~30 | Peak memory |
|---|---|---|---|---|
| excalidraw | 3.1 s | 6.4 s | 5.5 s (208 files changed) | 501 MB |
| shadcn/ui | 6.4 s | 15.2 s | 12.9 s (52 files changed) | 492 MB |
| Ghost | 10.0 s | 29.7 s | 21.1 s (251 files changed) | 794 MB |
| cal.com | 4.8 s | 16.9 s | 18.8 s (131 files changed) | 689 MB |

`check` analyzes the project twice, base and head, and extracts the base with `git archive`, so it costs roughly two scans plus the extraction. The time depends on repository size, not on how many files the change touches. A GitHub-hosted runner (4 vCPU, 16 GB) has enough headroom for all four.

## False alarms on real history

`check` was run on the last 1 and the last 30 merged commits of each repository. Those are human-reviewed changes, so blocking findings there are most likely false alarms.

| Repo | HEAD~1 | HEAD~30 |
|---|---|---|
| excalidraw | pass | pass (1 newly-test-only warning, 3 uncertain) |
| shadcn/ui | pass | pass |
| Ghost | pass (2 test-only-addition, 1 unused-dependency warnings) | pass (3 test-only-addition, 1 unused-dependency warnings) |
| cal.com | pass | pass |

Before the fixes listed below, the HEAD~30 runs on excalidraw and Ghost had 3 blocking false alarms: a load-time `register({...})` call, a `declare global` block, and a `.d.mts` file. After the fixes there are 0 blocking findings across all 8 runs.

## Catching an agent-style change

An agent-style change was applied to cal.com:

1. Copy `packages/lib/convertToNewDurationType.ts` to `convertDurationV2.ts`.
2. Switch its only caller to the copy.
3. Add an unused `formatMinutes.ts` helper.

`check` reported:

- `superseded` on the old file, citing the moved caller and 100% structural similarity,
- `orphaned-addition` on the unused helper,
- `newly-orphaned` on a constant only the old function used.

The check failed as it should.

## Whole-project scan: how many orphans are real?

`scan` reports existing unreachable files. To estimate false positives without knowing each codebase, every orphaned file's name was searched for inside import-like strings in files that Loose Ends considers live, and in non-source files. A hit means the orphan might be loaded by something the graph misses. It is an upper bound on false positives: many hits are just different files with the same name.

| Repo | Orphaned files | Mentioned by live or config files | Notes |
|---|---|---|---|
| excalidraw | 11 | 3 (27%) | The remaining hits are docs examples and a vendored file. |
| shadcn/ui | 123 | 68 (55%) | 60 of the 123 orphans are `templates/`, project scaffolding the CLI copies into new apps. Excluding `templates/**` is the right config for this repo. |
| Ghost | 435 | 32 (7%) | Mostly storage and scheduling adapters loaded by name from JSON config. That is a known limit: declare them in `entries`. |
| cal.com | 467 | 131 (28%) | Hand-checked samples were mostly real dead code with a same-named live twin (two `OnboardingCard.tsx` and two `TwoFactorAuthAPI.ts` files, for example). |

## Bugs found and fixed by this benchmark

| Problem | Seen in | Fix |
|---|---|---|
| `@/` aliases defined in a referenced tsconfig (`tsconfig.json` → `tsconfig.app.json`) were not followed | Ghost (orphans dropped from 848 to 437) | Follow tsconfig `references` |
| `@/` and `~/` Vite-style aliases without tsconfig paths | Ghost | Resolve to the package `src/` |
| `#internal` subpath imports were stripped as URL fragments | (found while fixing the above) | Keep a leading `#`, read package.json `imports` |
| Workspace packages imported through tsconfig paths counted as unused dependencies | excalidraw | Aliases carry their package name |
| Files named in tool config strings (`setupFiles`, plugin paths, `registry.json`) | excalidraw, shadcn/ui, Ghost | Become test or tooling roots |
| Docusaurus sites | excalidraw `dev-docs/` | New framework provider |
| `export const x = register({...})` counted as unused | excalidraw | Load-time calls keep a declaration live |
| `declare global {}` and `.d.mts` reported | Ghost | Ignored |
| Packages used only in config (`"extends": "@acme/tsconfig"`) | cal.com | Counted as used |

## Reproduce

```bash
npm run build
git clone --depth 40 https://github.com/calcom/cal.com /tmp/cal.com
node bench/run.mjs /tmp/cal.com scan
node bench/run.mjs /tmp/cal.com check HEAD~30
```
