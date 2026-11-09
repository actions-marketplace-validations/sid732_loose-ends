import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import fg from "fast-glob";
import { symbolId } from "../graph.js";
import type { RootContext, RootKind, RootProvider } from "../roots.js";
import type { FrameworkName } from "../types.js";
import type { PythonProject } from "./project.js";

const TOOLING_DIR = /(^|\/)(scripts?|tools?|bin|dev|devtools|benchmarks?|bench|examples?|docs?|hack|ci|utils\/scripts)\//;
const NOT_API = /^(tests?|testing|docs?|examples?|benchmarks?|scripts?|tools?|build|dist)$/;
const CONVENTIONAL = ["main", "app", "wsgi", "asgi", "application", "server", "run", "bot", "cli", "manage", "streamlit_app", "worker"];
const CONFIG_DIR = /(^|\/)(configs?|conf|settings|experiments?)\/[^/]+\.py$/;
const TOOLING_FILES = /^(setup|noxfile|fabfile|dodo|tasks|gunicorn\.conf|gunicorn_conf|gunicorn_config|hypercorn_conf|uwsgi_conf)\.py$/;

/** Files that start Python processes: deploy configs, CI, task runners. */
const COMMAND_FILES = [
  "**/Procfile",
  "**/Procfile.*",
  "**/Dockerfile*",
  "**/*.dockerfile",
  "**/docker-compose*.y*ml",
  "**/compose*.y*ml",
  "**/app.yaml",
  "**/app.yml",
  "**/fly.toml",
  "**/render.yaml",
  "**/railway.json",
  "**/railway.toml",
  "**/nixpacks.toml",
  "**/vercel.json",
  "**/serverless.y*ml",
  "**/template.y*ml",
  "**/supervisord*.conf",
  "**/*.service",
  "**/crontab",
  "**/Makefile",
  "**/justfile",
  "**/Taskfile.y*ml",
  "**/*.sh",
  "**/tox.ini",
  "**/pyproject.toml",
  "**/package.json",
  ".github/workflows/*.y*ml",
  "**/.gitlab-ci.yml",
  "**/cloudbuild.y*ml",
  "**/azure-pipelines.y*ml",
  "**/bitbucket-pipelines.yml",
  "**/.vscode/launch.json",
  "**/.flaskenv",
];
const COMMAND_IGNORE = ["**/node_modules/**", "**/.git/**", "**/.venv/**", "**/venv/**", "**/site-packages/**", "**/dist/**", "**/build/**"];
const TOOLING_COMMAND_FILE = /(^|\/)(Makefile|justfile|Taskfile\.ya?ml|[^/]*\.sh|tox\.ini|pyproject\.toml|package\.json|\.gitlab-ci\.yml|cloudbuild\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|launch\.json)$|^\.github\//;
const SERVERS = /\b(uvicorn|gunicorn|hypercorn|daphne|granian|waitress-serve|ddtrace-run|newrelic-admin|opentelemetry-instrument|uvicorn\.run|run_simple)\b/;

/** Roots for Python code: scripts, entry points, published APIs, commands, and framework conventions. */
export const pythonRoots: RootProvider = {
  name: "python",
  discover(ctx) {
    const pyFiles = ctx.files.filter((f) => f.endsWith(".py"));
    const notebooks = ctx.files.filter((f) => f.endsWith(".ipynb"));
    if (pyFiles.length === 0 && notebooks.length === 0) return;
    const resolver = ctx.build.resolver.python;
    const projects = resolver.projects;
    const fileSet = new Set(ctx.files);
    const pySet = new Set(pyFiles);

    for (const path of notebooks) ctx.addFile(path, { kind: "tooling", source: "notebook", reason: "Jupyter notebook" });
    // Python web apps (Django, Flask) serve scripts in static/ folders by URL from their templates.
    for (const path of ctx.files) {
      if (/(^|\/)static\/.+\.(js|mjs|cjs)$/.test(path)) ctx.addScript(path, { kind: "production", source: "static-dir", reason: "served from a static/ folder" });
    }

    for (const path of pyFiles) {
      const info = ctx.build.graph.modules.get(path);
      const name = posix.basename(path);
      if (info?.mainGuard || name === "__main__.py") {
        const kind: RootKind = TOOLING_DIR.test(path) ? "tooling" : "production";
        ctx.addFile(path, { kind, source: "__main__", reason: name === "__main__.py" ? "runs with `python -m` on its package" : 'runs as a script (`if __name__ == "__main__":`)' });
      } else if (CONFIG_DIR.test(path) && info && info.declarations.every((d) => d.kind === "variable" && !d.sideEffects)) {
        ctx.addFile(path, { kind: "tooling", source: "config", reason: "only assigns settings in a config folder (loaded by path)" }, "all");
      } else if (info?.script && !ctx.build.graph.in(`file:${path}`).some((e) => e.kind === "import")) {
        const kind: RootKind = TOOLING_DIR.test(path) ? "tooling" : "production";
        ctx.addFile(path, { kind, source: "script", reason: "runs top-level code and no module imports it, so it is run directly" });
      }
      if (TOOLING_FILES.test(name) || /(^|\/)docs?\/(source\/)?conf\.py$/.test(path)) {
        ctx.addFile(path, { kind: "tooling", source: "convention", reason: `${name} is run by Python tooling` }, "all");
      }
    }

    for (const project of projects) {
      for (const entry of project.entryPoints) {
        const [module, attr] = entry.target.split(":") as [string, string | undefined];
        const file = resolver.resolveModule(project.dir, module);
        if (!file) continue;
        const root = { kind: "production" as const, source: entry.source, reason: `entry point "${entry.target}"` };
        if (attr) {
          ctx.addFile(file, root);
          ctx.add({ ...root, node: symbolId(file, attr.split(".")[0]!) });
        } else ctx.addFile(file, root, "all");
      }
      if (project.library) libraryRoots(ctx, project, pyFiles);
      for (const base of [project.dir, join2(project.dir, "src"), join2(project.dir, "app")]) {
        for (const stem of CONVENTIONAL) {
          const file = join2(base, `${stem}.py`);
          if (fileSet.has(file)) ctx.addFile(file, { kind: "production", source: "convention", reason: `conventional entry "${stem}.py"` });
        }
      }
    }
    if (!projects.some((p) => p.dir === "")) {
      for (const stem of CONVENTIONAL) {
        if (fileSet.has(`${stem}.py`)) ctx.addFile(`${stem}.py`, { kind: "production", source: "convention", reason: `conventional entry "${stem}.py"` });
      }
    }

    commandRoots(ctx, pyFiles, pySet);
    frameworkRoots(ctx, pyFiles, projects);
  },
};

/** A published package's public modules are its API: every module whose path has no `_private` part. */
function libraryRoots(ctx: RootContext, project: PythonProject, pyFiles: string[]): void {
  const resolver = ctx.build.resolver.python;
  for (const base of [project.dir, join2(project.dir, "src"), ...project.sourceDirs.map((d) => join2(project.dir, d))]) {
    const prefix = base ? base + "/" : "";
    const packages = new Set<string>();
    for (const file of pyFiles) {
      if (!file.startsWith(prefix)) continue;
      const parts = file.slice(prefix.length).split("/");
      if (parts.length < 2 || NOT_API.test(parts[0]!)) continue;
      if (resolver.packageFile(prefix + parts[0]!)) packages.add(parts[0]!);
    }
    for (const pkg of packages) {
      for (const file of pyFiles) {
        if (!file.startsWith(`${prefix}${pkg}/`)) continue;
        const parts = file.slice(prefix.length).split("/");
        const isPrivate = parts.some((p, i) => p.startsWith("_") && !(i === parts.length - 1 && /^__(init|main)__\.py$/.test(p)));
        if (isPrivate || parts.some((p) => NOT_API.test(p))) continue;
        ctx.addFile(file, { kind: "production", source: `${project.dir ? project.dir + "/" : ""}pyproject.toml#package`, reason: `public module of the ${project.name || pkg} package` }, "all");
      }
    }
  }
}

/** Scripts and modules started by deploy configs, CI, Makefiles, and shell scripts. */
function commandRoots(ctx: RootContext, pyFiles: string[], pySet: Set<string>): void {
  const resolver = ctx.build.resolver.python;
  const sources = fg.sync(COMMAND_FILES, { cwd: ctx.config.root, ignore: COMMAND_IGNORE, onlyFiles: true, dot: true, deep: 5 });
  for (const source of sources.sort()) {
    let text: string;
    try {
      text = readFileSync(join(ctx.config.root, source), "utf8");
    } catch {
      continue;
    }
    if (text.length > 512 * 1024) continue;
    const dir = posix.dirname(source) === "." ? "" : posix.dirname(source);
    const kind: RootKind = TOOLING_COMMAND_FILE.test(source) ? "tooling" : "production";
    const add = (file: string, reason: string, attr?: string) => {
      ctx.addFile(file, { kind, source, reason });
      if (attr) ctx.add({ kind, source, reason, node: symbolId(file, attr) });
    };
    const findModule = (dotted: string) => resolver.resolveModule(dir, dotted) ?? bySuffix(pyFiles, dotted.replace(/\./g, "/") + ".py") ?? bySuffix(pyFiles, dotted.replace(/\./g, "/") + "/__init__.py");
    const findPath = (raw: string) => {
      const rel = raw.replace(/^\.\//, "").replace(/^\/(app|code|src|usr\/src\/app|workspace|opt\/\w+)\//, "");
      for (const candidate of [posix.normalize(join2(dir, rel)), rel]) if (pySet.has(candidate)) return candidate;
      return rel.includes("/") ? bySuffix(pyFiles, rel) : undefined;
    };

    for (const rawLine of text.split(/\r?\n/)) {
      if (/^\s*(COPY|ADD)\s/i.test(rawLine)) continue;
      const line = rawLine.replace(/["'[\],]/g, " ");
      for (const m of line.matchAll(/(?:^|[\s=/])([\w./-]+\.py)\b/g)) {
        const file = findPath(m[1]!);
        if (file) add(file, `run by ${source}`);
      }
      for (const m of line.matchAll(/\b(?:python[\d.]*|uv\s+run|poetry\s+run\s+python|pipenv\s+run\s+python)\s+(?:-[A-Za-z]+\s+)*-m\s+([\w.]+)/g)) {
        const file = findModule(m[1]!);
        if (file) add(file, `\`python -m ${m[1]}\` in ${source}`);
      }
      if (SERVERS.test(line)) {
        for (const m of line.matchAll(/(?:^|\s)([A-Za-z_][\w.]*):([A-Za-z_]\w*)(?:\(\))?(?=\s|$)/g)) {
          const file = findModule(m[1]!);
          if (file) add(file, `server app "${m[1]}:${m[2]}" in ${source}`, m[2]);
        }
      }
      for (const m of line.matchAll(/\bcelery\b.*?(?:-A|--app)[\s=]+([\w.]+)(?::(\w+))?/g)) {
        const file = findModule(m[1]!);
        if (!file) continue;
        add(file, `Celery app "${m[1]}" in ${source}`, m[2]);
        const conventional = file.endsWith("__init__.py") ? resolver.lookup(posix.dirname(file), ["celery"]) : undefined;
        if (conventional) add(conventional, `Celery app "${m[1]}" in ${source}`);
      }
      for (const m of line.matchAll(/(?:--app[\s=]+|FLASK_APP\s*[=:]\s*)([\w./]+?)(?::(\w+))?(?:\(\))?(?=\s|$)/g)) {
        const target = m[1]!;
        const file = target.endsWith(".py") ? findPath(target) : findModule(target);
        if (file) add(file, `app "${target}" in ${source}`, m[2]);
      }
      for (const m of line.matchAll(/\b[Hh]andler:\s+([\w./-]+)\.(\w+)/g)) {
        const file = findPath(`${m[1]}.py`) ?? findModule(m[1]!.replace(/\//g, "."));
        if (file) add(file, `handler "${m[1]}.${m[2]}" in ${source}`, m[2]);
      }
    }
  }
}

function frameworkRoots(ctx: RootContext, pyFiles: string[], projects: PythonProject[]): void {
  const active = activeFrameworks(ctx, projects);
  const add = (file: string, kind: RootKind, source: string, reason: string) => ctx.addFile(file, { kind, source, reason }, "all");

  if (active.has("django")) {
    const appDirs = new Set<string>();
    for (const file of pyFiles) {
      const name = posix.basename(file);
      if (name === "apps.py" || name === "models.py") appDirs.add(posix.dirname(file));
    }
    for (const file of pyFiles) {
      const dir = posix.dirname(file);
      const name = posix.basename(file);
      if (name === "settings.py" || /(^|\/)settings\/[^/]+\.py$/.test(file)) add(file, "production", "django", "Django settings module");
      else if (name === "wsgi.py" || name === "asgi.py" || name === "routing.py") add(file, "production", "django", `Django ${name.replace(".py", "").toUpperCase()} entry`);
      else if (/(^|\/)migrations\/[^/]+\.py$/.test(file)) add(file, "tooling", "django", "Django migration");
      else if (/(^|\/)management\/commands\/[^/]+\.py$/.test(file)) add(file, "production", "django", "Django management command");
      else if (/(^|\/)templatetags\/[^/]+\.py$/.test(file)) add(file, "production", "django", "Django template tags");
      else if (appDirs.has(dir) && /^(models|admin|apps|signals|receivers|translation|checks|tasks)\.py$/.test(name)) add(file, "production", "django", `Django loads ${name} from installed apps`);
      else if (/(^|\/)models\/[^/]+\.py$/.test(file) && appDirs.has(posix.dirname(dir))) add(file, "production", "django", "Django models package");
    }
  }
  if (active.has("celery")) {
    for (const file of pyFiles) {
      if (/(^|\/)tasks\.py$/.test(file) || /(^|\/)tasks\/[^/]+\.py$/.test(file)) add(file, "production", "celery", "Celery autodiscovers tasks modules");
    }
  }
  if (active.has("alembic")) {
    const envDirs = new Set(pyFiles.filter((f) => posix.basename(f) === "env.py").map((f) => posix.dirname(f)));
    for (const file of pyFiles) {
      if (posix.basename(file) === "env.py" && envDirs.has(posix.dirname(file))) add(file, "tooling", "alembic", "Alembic environment");
      else if (envDirs.has(posix.dirname(posix.dirname(file))) && posix.basename(posix.dirname(file)) === "versions") add(file, "tooling", "alembic", "Alembic migration");
    }
  }
  if (active.has("airflow")) {
    for (const file of pyFiles) if (/(^|\/)(dags|plugins)\//.test(file)) add(file, "production", "airflow", "Airflow loads DAG and plugin folders");
  }
  if (active.has("streamlit")) {
    for (const file of pyFiles) if (/(^|\/)pages\/[^/]+\.py$/.test(file)) add(file, "production", "streamlit", "Streamlit multipage app page");
  }
}

/** Frameworks in use, from Python dependencies and imports (or from config). */
function activeFrameworks(ctx: RootContext, projects: PythonProject[]): Set<FrameworkName> {
  if (ctx.config.frameworks !== "auto") return new Set(ctx.config.frameworks);
  const names = new Set<string>();
  for (const p of projects) for (const m of p.manifests) for (const d of m.dependencies) names.add(d.name.toLowerCase().replace(/[-_.]+/g, "-"));
  for (const node of ctx.build.graph.nodes.values()) if (node.kind === "dependency" && node.id.startsWith("dep:py:")) names.add(node.name!.toLowerCase());
  const out = new Set<FrameworkName>();
  if (names.has("django")) out.add("django");
  if (names.has("celery")) out.add("celery");
  if (names.has("alembic") || names.has("flask-migrate")) out.add("alembic");
  if (names.has("airflow") || names.has("apache-airflow")) out.add("airflow");
  if (names.has("streamlit")) out.add("streamlit");
  return out;
}

function bySuffix(files: string[], suffix: string): string | undefined {
  return files.find((f) => f === suffix || f.endsWith("/" + suffix));
}

function join2(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}
