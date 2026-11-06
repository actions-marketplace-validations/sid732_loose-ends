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

`check` analyzes the project twice, base and head, and writes the base to a temp directory, so it costs roughly two scans plus the extraction. The time depends on repository size, not on how many files the change touches. A GitHub-hosted runner (4 vCPU, 16 GB) has enough headroom for all four.

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

## A Python-heavy repo with a browser extension

A private repo with 315 Python files, 7 JavaScript files (a Chrome extension and two tests), and about 850 MB of generated JSON, PDF, and LaTeX output.

- `scan` first reported all 4 extension scripts as orphaned, because they are loaded by `manifest.json` and `<script>` tags in HTML pages. A web extension provider now reads both. The one remaining orphan is a minified bundle saved as research data, which nothing loads.
- `check` took 43–62 s, almost all of it extracting the base revision: `git archive` wrote every tracked file, including thousands of PDFs. The snapshot now skips binaries, documents, and files far from JS/TS code. On this repo the snapshot dropped from 6.7 s to 1.0 s and cleanup from 5 s to 25 ms. On shadcn/ui, `check` HEAD~30 went from 17.8 s to 16.1 s and peak memory from 605 MB to 452 MB, with identical findings on all four public repos. The old snapshot also held the whole archive in memory with a 1 GB cap, so repos above that size would have failed.

The Python files in this repo are now analyzed too; see below.

## Python

Run on 2026-11-06 against shallow clones of six public Python repositories. `scan` takes 60–360 ms on each.

| Repo | Commit | Python files | Python findings from `scan` | Checked by hand |
|---|---|---|---|---|
| [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) | `aabb901` | 43 | 1 test-only | `crud.create_item` is only called from tests. |
| [django/djangoproject.com](https://github.com/django/djangoproject.com) | `9f69c93` | 266 | 3 orphaned, 4 unused dependencies | `SIMPLE_SEARCH_OPERATORS`, `fundraising/exceptions.py`, and `StripeTextInput` have no users. `babel`, `python-dateutil`, and `pydata-sphinx-theme` are not imported anywhere; `pillow` is only imported by test code. |
| [miguelgrinberg/microblog](https://github.com/miguelgrinberg/microblog) | `a975ef6` | 34 | none | |
| [pallets/flask](https://github.com/pallets/flask) | `49943b5` | 83 | 3 orphaned | `_make_timedelta` in `app.py` (a leftover copy of the one in `sansio/app.py`) and `_path_is_ancestor` in `cli.py` have no callers. `examples/celery/make_celery.py` is started by a command in the example's README, which is not read. |
| [encode/httpx](https://github.com/encode/httpx) | `b5addb6` | 60 | 1 orphaned | `URLTypes` in the private `_types.py`, kept on purpose for users who import it from there. |
| [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT) | `3adf61e` | 15 | 2 orphaned | `decode` in a data prep script and `unoptimized_model` in `train.py` are never used. |

`check` was run on every commit that touched Python in the cloned history: 249 commits across the six repositories, all passing with no blocking findings. The non-blocking warnings were: dependencies added without an import (the four above, when they were added), a Sphinx extension that moved to being loaded through `PYTHONPATH`, and one near-identical Flask form class.

Two private repositories were also checked: a Django app with scrapers and a browser extension (about 300 Python files, `scan` in 0.9 s), and a small evaluation package. `scan` reported 34 orphaned items; 15 were checked by hand and none has a caller. Replaying 46 commits failed 4, each for code that is still unused today: two unused loggers, an unused constant, and a function that a new one replaced.

### Bugs found and fixed while testing on Python repos

| Problem | Seen in | Fix |
|---|---|---|
| Scripts run as `python train.py` with no `__main__` guard were reported dead | nanoGPT | Files that run top-level calls, loops, or `with` blocks and that no module imports are scripts |
| `exec(open("configurator.py").read())` and `config/*.py` passed on the command line | nanoGPT | Strings naming a `.py` file link to it; files in `config/` that only assign settings are roots |
| `pip freeze` output listed transitive packages as unused | microblog | Fully pinned requirement files are not checked |
| `FLASK_APP=microblog.py` in `.flaskenv` | microblog | `.flaskenv` is read like other command files |
| URL confs and host confs named only by string (`ROOT_HOSTCONF = "djangoproject.hosts"`) | djangoproject.com | A module named by string is read by attribute, so its public names count |
| `@stat("Commits")` registers the function in a list | djangoproject.com | A decorator called with arguments registers the function |
| Classic `<script>` files in `static/` define globals for each other | djangoproject.com | Every top-level declaration in such a script is a root |
| Distribution names that differ from import names (`django-money` → `djmoney`, `sorl-thumbnail` → `sorl`) | djangoproject.com | A larger mapping table |
| Module-level `__getattr__` (PEP 562) | flask | Dunder functions are called by Python |
| `from ._api import *` in a library's `__init__.py` | httpx | Star imports re-export the target's `__all__` |
| React Email templates in `emails/` (JavaScript) | full-stack-fastapi-template | New framework provider |
| Lists of strings reported as duplicates of other lists | private repo | Declarations that are mostly literals are not compared |

## Java

Run on 2026-11-06 against clones of six public Java repositories. `scan` takes 0.1–1.5 s on each, including 2,042 files in 1.5 s.

| Repo | Commit | Java files | Findings from `scan` | Checked by hand |
|---|---|---|---|---|
| [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic) | `500158f` | 50 | none | |
| [gothinkster/spring-boot-realworld-example-app](https://github.com/gothinkster/spring-boot-realworld-example-app) | `ee17e31` | 116 | none | |
| [square/javapoet](https://github.com/square/javapoet) | `b9017a9` | 39 | none | A library: its public types are API. |
| [quarkusio/quarkus-quickstarts](https://github.com/quarkusio/quarkus-quickstarts) | `81a5844` | 649 | 1 orphaned | `QuoteDeserializer` in the Kafka producer is never used. |
| [TeamNewPipe/NewPipe](https://github.com/TeamNewPipe/NewPipe) | `f42fe70` | 293 (and 293 Kotlin) | none | |
| [iluwatar/java-design-patterns](https://github.com/iluwatar/java-design-patterns) | `4cabb20` | 2,042 | 1 orphaned, 13 test-only, 2 unused dependencies | `ProductCatalogService` has no users, the 13 test-only types are only used by tests, `swing-layout` is never imported, and `system-lambda` is a compile dependency only tests use. |

`check` was run on every commit that touched Java, build files, or resources in the cloned history: 445 commits. One failed, and it was right: a NewPipe commit replaced `FocusAwareSeekBar` in the player layout, which left the class unused until a later commit subclassed it. The warnings were near-identical classes (small DTOs, and code copied from one quickstart into another) and two classes a new pattern added that only its tests used.

The agent-style change from the cal.com test, applied to spring-petclinic (copy `PetValidator` to `PetValidatorV2`, switch `PetController` to it, add an unused `NameFormatter`), failed with `superseded` on `PetValidator`, citing the moved caller and 100% structural similarity, and `orphaned-addition` on `NameFormatter`.

### Bugs found and fixed while testing on Java repos

| Problem | Seen in | Fix |
|---|---|---|
| Modules that repeat the same fully qualified class names resolved to the first one found | quarkus-quickstarts | Keep every candidate and pick the one closest to the referencing file |
| Netflix DGS (`@DgsComponent`) and similar framework annotations | spring-boot-realworld-example-app | Annotations named like `…Component`, `…Controller`, `…Service`, `…Repository` are framework roots |
| MyBatis type handlers registered by package (`mybatis.type-handlers-package=…`) | spring-boot-realworld-example-app | A package in a `…package` or `…scan` setting roots its types |
| Classes whose framework entry is a method (`@Funq`, `@Route`, `@Incoming`, `@Observes`) | quarkus-quickstarts | Member annotations make the type a root |
| Custom views and fragments named in Android `res/` XML | NewPipe | `res/**/*.xml` is read for class names |
| Java classes used only from Kotlin | NewPipe | Kotlin imports, same-package names, and fully qualified names count |
| JS scripts run by GitHub workflows (`require('./.github/workflows/x.js')`) | NewPipe, shadcn/ui, Ghost | New provider; files in `paths:` filters are not roots |
| `javax.xml.bind` treated as part of the JDK | java-design-patterns | It left the JDK in Java 11 |

## Reproduce

```bash
npm run build
git clone --depth 40 https://github.com/calcom/cal.com /tmp/cal.com
node bench/run.mjs /tmp/cal.com scan
node bench/run.mjs /tmp/cal.com check HEAD~30
git clone --depth 200 https://github.com/django/djangoproject.com /tmp/djangoproject.com
node bench/run.mjs /tmp/djangoproject.com scan
git clone --depth 120 https://github.com/iluwatar/java-design-patterns /tmp/java-design-patterns
node bench/run.mjs /tmp/java-design-patterns scan
```
