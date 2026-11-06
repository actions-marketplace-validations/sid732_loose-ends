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
| `include` / `extendInclude` | `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, `**/*.py`, `**/*.ipynb`, `**/*.java` | Source files to analyze. `include` replaces the default and `extendInclude` adds to it. |
| `exclude` / `extendExclude` | `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `*.d.ts`, `__pycache__`, `.venv`, `venv`, `.tox`, `site-packages`, `target`, `.gradle`, … | Files to ignore. The root `.gitignore` is applied as well. |
| `testPatterns` / `extendTestPatterns` | `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`, `e2e/`, `*.stories.*`, `fixtures/`, `test_*.py`, `*_test.py`, `tests.py`, `conftest.py`, `src/test/`, `src/androidTest/`, `*Test.java`, `*Tests.java`, `*IT.java` | Files that count as tests. Tests are roots, but code reachable only from tests is reported as test-only. |
| `languages` | `["javascript", "python", "java"]` | Languages to analyze. Remove one to skip its files entirely. |
| `entries` | `[]` | Extra production roots. Use these for things a runtime loads by name, such as job files or plugin modules. `path#symbol` makes just one export a root. |
| `frameworks` | `"auto"` | Which framework conventions to apply. `auto` reads each workspace package's dependencies and each Python project's requirements. Python names: `django`, `flask`, `fastapi`, `celery`, `alembic`, `airflow`, `streamlit`, `pytest`. |
| `dormant` | `[]` | Code that is unreachable on purpose. Every rule needs a `reason`. |
| `suppressions` | `[]` | Findings that have been reviewed and accepted. Every suppression needs a `reason`. `kind` limits it to one finding kind, and once `expires` passes the suppression stops working and is reported. |
| `checks` | `[]` | Commands run by `loose-ends fix --verify` and `--apply` against the cleaned-up copy. |
| `failOn` | `orphaned-addition`, `newly-orphaned`, `superseded`, `invalid-suppression` | Finding kinds that make `check` exit 1 and fail the check run. |
| `tsconfig` | nearest `tsconfig.json` / `jsconfig.json` | Path aliases (`paths`, `baseUrl`) used for resolution. |
| `coverage` | none | Runtime coverage report, used as supporting evidence. |
| `dependencies` | `true` | Analyze `dependencies` in each package.json, production requirements of each Python project, and compile-scope Maven and Gradle dependencies. |
| `ignoreDependencies` | `[]` | Globs of dependencies that are loaded implicitly (npm names, Python distribution names, or Maven `group:artifact`). |

## Inline directives

Directives go in comments (`//` in JavaScript and Java, `#` in Python). A `loose-ends:` comment applies to the declaration directly below it, and a `loose-ends-file:` comment applies to the whole file. In Python, a `loose-ends:` comment at the end of a line applies to the statement on that line.

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

```python
# loose-ends-file: entry

# loose-ends: dormant re-enabled when billing v2 ships
def export_legacy_invoices(): ...

def draft_handler(): ...  # loose-ends: ignore orphaned-addition wired up in the next PR
```

A `dormant` or `ignore` directive without a reason is reported as `invalid-suppression`, which blocks by default. Reasons are kept so that whoever revisits the code knows why it stayed.

## Roots Loose Ends finds on its own

- `main`, `module`, `browser`, `bin`, and `exports` in every workspace `package.json`. Without a workspace config, `package.json` files up to three levels down (an `app/` and a `server/` side by side) count as packages too. Library entry points make all of their exports public API.
- Files run by package scripts (`node x.js`, `tsx src/server.ts`, …). Scripts named like `test*` count as test roots, and `build`, `lint`, `db`, `seed`, and similar names count as tooling roots.
- A conventional entry (`index`, `src/index`, `src/main`, `server`, `app`) for packages that declare none.
- Next.js: App Router special files (`page`, `layout`, `route`, `loading`, `error`, `not-found`, metadata files, …), every file under `pages/`, `middleware`, `instrumentation`, and `next.config`. Only exports Next.js reads count as roots, so an extra helper exported from a page is still reported.
- Vite: `<script src>` tags in `index.html`.
- Browser extensions: scripts named in a `manifest.json` that has `manifest_version` (background, content scripts, web-accessible resources), and `<script src>` tags in the HTML pages it names (popup, options, side panel, devtools). No `package.json` is needed.
- Docusaurus config, sidebars, pages, and swizzled theme components.
- Scripts in each package's `public/` directory, which Vite, Next.js, and Create React App serve by URL.
- Storybook config, Vercel `api/` functions, Netlify functions, and tool config files (`*.config.*`, `.*rc.*`).
- Test files.

For Python:

- Files with `if __name__ == "__main__":`, `__main__.py` files, and files that run top-level code (calls, loops, `with` blocks) that no module imports.
- Entry points in `pyproject.toml` (`[project.scripts]`, `gui-scripts`, `entry-points`, Poetry `scripts` and `plugins`), `setup.py`, and `setup.cfg`.
- Packages that are built and published (a `[build-system]`, `setup.py`, or `setup.cfg`, and no Dockerfile, Procfile, `manage.py`, or similar app signal): every module whose path has no `_private` part is public API, along with its public names (or the names in `__all__`).
- Commands in Dockerfiles, Compose files, Procfiles, `.flaskenv`, Makefiles, shell scripts, GitHub workflows, `tox.ini`, `pyproject.toml`, serverless templates, and similar files: `python path/to/x.py`, `python -m pkg.mod`, `uvicorn`/`gunicorn`/`hypercorn` targets like `app.main:app`, `celery -A proj`, `flask --app`, `FLASK_APP`, and Lambda `handler:` paths.
- A conventional entry (`main.py`, `app.py`, `wsgi.py`, `asgi.py`, `manage.py`, `server.py`, `run.py`, …) in each Python project, its `src/`, and its `app/`.
- Strings that name a local module: `INSTALLED_APPS`, `ROOT_URLCONF`, middleware paths, `"app.main:app"`, `importlib.import_module("x.y")`, and `exec(open("config.py").read())`. A module named this way is read by attribute, so its public names count as used.
- Django (when it is a dependency): settings, `wsgi`/`asgi`, migrations, management commands, template tags, and `models`, `admin`, `apps`, `signals`, and `tasks` modules in app folders. Celery: `tasks.py`. Alembic: `env.py` and `versions/`. Airflow: `dags/` and `plugins/`. Streamlit: `pages/`.
- Decorators that register a function (`@app.get(...)`, `@router.post(...)`, `@receiver(...)`, `@shared_task`, any decorator called with arguments), and classes that register themselves (ORM models, `TestCase` subclasses, classes with a metaclass), keep the function or class alive whenever its module is loaded.
- Notebooks (`.ipynb`), `setup.py`, `noxfile.py`, `fabfile.py`, `docs/conf.py`, files in `config/` folders that only assign settings, and scripts in `static/` folders.

Python requirement files named for development, tests, docs, or CI (`requirements-dev.txt`, `requirements/test.txt`, …) are not checked. Neither is a fully pinned file of ten or more packages, because `pip freeze` output lists transitive packages that no code imports directly; keep direct dependencies in `pyproject.toml` or `requirements.in` to have them checked. Packages that are normally used without an import (database drivers, servers like `gunicorn`, linters, type stubs, common transitive packages) are ignored.

For Java:

- Types with a `main` method, `module-info.java`, and `package-info.java`.
- Types the framework creates: Spring stereotypes (`@Component`, `@Service`, `@RestController`, `@Configuration`, …) and other `…Component`/`…Controller`/`…Service`-style annotations, JPA entities, JAX-RS resources, CDI beans, servlets, Quarkus, Micronaut, MyBatis and MapStruct mappers, Dagger/Hilt, Room, and `@AutoService`.
- Types with members the framework calls: `@Scheduled`, `@EventListener`, `@KafkaListener`, `@Incoming`, `@Observes`, `@Bean`, `@Funq`, `@Route`, GraphQL resolvers, and JAX-RS methods.
- Subclasses of types frameworks instantiate: Spring Data repositories, Panache, servlets and filters, Android activities, services, and receivers, and `CommandLineRunner`.
- Class names in resource and build files: `META-INF/services`, `spring.factories`, Spring XML, `web.xml`, `*.properties`, Android manifests (including `.RelativeName`) and `res/` layouts, and `pom.xml`/`build.gradle` plugin settings. A package named in a `…package` or `…scan` setting makes every type in it a root.
- `Class.forName("…")` strings in Java code.
- Java types that Kotlin code imports, sees in its own package, or names in full. Kotlin is not analyzed otherwise.
- A Maven or Gradle module with no application plugin (Spring Boot, `application`, Android app, Quarkus, Micronaut, war packaging) and no `main` method is a library: its public types are API.
- Scripts in `src/main/resources/{static,public,META-INF/resources}` and `src/main/webapp`.

Java symbols are top-level types. Methods and fields are not tracked one by one. A type that another file imports counts as used even if nothing calls it, because deleting it would break compilation. Dependencies are matched to imported packages by Maven group (with a table for groups whose packages differ, like Guava). Starters, BOMs, JDBC drivers, logging back ends, and Quarkus and Micronaut extensions are ignored. Modules that contain Kotlin sources are not checked.

Run `npx loose-ends roots` to see what was found and why.
