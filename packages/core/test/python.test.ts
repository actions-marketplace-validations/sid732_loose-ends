import { describe, expect, it } from "vitest";
import { analyze, check, dependencyReport, discoverPythonProjects, loadConfig, planCleanup, scan, applyCleanup, stateOf, type Analysis } from "@loose-ends/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { project, repo } from "./helpers/project.js";

const liveness = (analysis: Analysis, id: string) => stateOf(analysis, id).liveness;
const states = (root: string, ids: string[]) => {
  const analysis = analyze(loadConfig(root));
  return Object.fromEntries(ids.map((id) => [id, liveness(analysis, id)]));
};

describe("Python imports", () => {
  it("follows absolute, relative, package, and submodule imports", () => {
    const root = project({
      "main.py": "from app.api import routes\nfrom app import core\nif __name__ == '__main__':\n    routes.run(core.config.VALUE)",
      "app/__init__.py": "",
      "app/api/__init__.py": "",
      "app/api/routes.py": "from ..core.utils import slug as s\nfrom . import helpers\ndef run(v):\n    return s(helpers.fmt(v))\ndef unused():\n    pass",
      "app/api/helpers.py": "def fmt(v): return v\ndef _dead(): pass",
      "app/core/__init__.py": "from . import config",
      "app/core/config.py": "VALUE = 1\nOTHER = 2",
      "app/core/utils.py": "def slug(x): return x",
      "app/orphan.py": "def lonely(): pass",
    });
    expect(
      states(root, [
        "file:app/__init__.py",
        "file:app/api/__init__.py",
        "sym:app/api/routes.py#run",
        "sym:app/api/routes.py#unused",
        "sym:app/api/helpers.py#fmt",
        "sym:app/api/helpers.py#_dead",
        "sym:app/core/config.py#VALUE",
        "sym:app/core/config.py#OTHER",
        "sym:app/core/utils.py#slug",
        "file:app/orphan.py",
      ]),
    ).toEqual({
      "file:app/__init__.py": "live",
      "file:app/api/__init__.py": "live",
      "sym:app/api/routes.py#run": "live",
      "sym:app/api/routes.py#unused": "orphaned",
      "sym:app/api/helpers.py#fmt": "live",
      "sym:app/api/helpers.py#_dead": "orphaned",
      "sym:app/core/config.py#VALUE": "live",
      "sym:app/core/config.py#OTHER": "orphaned",
      "sym:app/core/utils.py#slug": "live",
      "file:app/orphan.py": "orphaned",
    });
  });

  it("follows `import a.b` attribute chains, re-exports from __init__, and star imports", () => {
    const root = project({
      "run.py": "import lib.tools\nfrom lib import exported\nfrom lib.stars import *\nif __name__ == '__main__':\n    lib.tools.used()\n    exported()\n    starred()",
      "lib/__init__.py": "from .impl import exported",
      "lib/impl.py": "def exported(): pass\ndef hidden(): pass",
      "lib/tools.py": "def used(): pass\ndef not_used(): pass",
      "lib/stars.py": "__all__ = ['starred']\ndef starred(): pass\ndef also(): pass",
    });
    expect(states(root, ["sym:lib/impl.py#exported", "sym:lib/impl.py#hidden", "sym:lib/tools.py#used", "sym:lib/tools.py#not_used", "sym:lib/stars.py#starred", "sym:lib/stars.py#also"])).toEqual({
      "sym:lib/impl.py#exported": "live",
      "sym:lib/impl.py#hidden": "orphaned",
      "sym:lib/tools.py#used": "live",
      "sym:lib/tools.py#not_used": "orphaned",
      "sym:lib/stars.py#starred": "live",
      "sym:lib/stars.py#also": "orphaned",
    });
  });

  it("resolves src layouts, namespace packages, and external packages", () => {
    const root = project({
      "pyproject.toml": '[project]\nname = "pkg"\ndependencies = ["requests"]\n',
      "Procfile": "web: python -m pkg.cli",
      "src/pkg/__init__.py": "",
      "src/pkg/cli.py": "import requests\nimport os\nfrom ns.part import thing\nif __name__ == '__main__':\n    thing(requests.get(os.sep))",
      "src/ns/part.py": "def thing(x): return x",
    });
    const analysis = analyze(loadConfig(root));
    expect(liveness(analysis, "sym:src/ns/part.py#thing")).toBe("live");
    expect(analysis.graph.nodes.get("dep:py:requests")?.exportedAs).toEqual([]);
    expect(analysis.graph.nodes.get("dep:py:os")?.exportedAs).toEqual(["builtin"]);
    expect(analysis.graph.unresolved).toEqual([]);
  });

  it("reports relative imports that point nowhere", () => {
    const root = project({ "pkg/__init__.py": "", "pkg/a.py": "from .missing import x\nif __name__ == '__main__': x()" });
    expect(analyze(loadConfig(root)).graph.unresolved.map((u) => u.specifier)).toEqual([".missing"]);
  });

  it("links dotted strings to modules (Django settings, server targets, exec'd files)", () => {
    const root = project({
      "manage.py": "import os\nif __name__ == '__main__':\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proj.settings')",
      "proj/__init__.py": "",
      "proj/settings.py": "INSTALLED_APPS = ['blog']\nROOT_URLCONF = 'proj.urls'\nMIDDLEWARE = ['proj.middleware.Auth']",
      "proj/urls.py": "from blog import views\nurlpatterns = [views.index]",
      "proj/middleware.py": "class Auth: pass\nclass Unused: pass",
      "blog/__init__.py": "",
      "blog/views.py": "def index(): pass",
      "train.py": "exec(open('configurator.py').read())\nfor i in range(3):\n    print(i)",
      "configurator.py": "x = 1",
    });
    expect(states(root, ["sym:proj/urls.py#urlpatterns", "sym:blog/views.py#index", "sym:proj/middleware.py#Auth", "sym:proj/middleware.py#Unused", "file:configurator.py"])).toEqual({
      "sym:proj/urls.py#urlpatterns": "live",
      "sym:blog/views.py#index": "live",
      "sym:proj/middleware.py#Auth": "live",
      "sym:proj/middleware.py#Unused": "orphaned",
      "file:configurator.py": "live",
    });
  });

  it("marks siblings uncertain when live code imports a computed module name", () => {
    const root = project({
      "app.py": "import importlib\ndef load(name):\n    return importlib.import_module(name)\nload('x')",
      "plugins/a.py": "def go(): pass",
    });
    expect(states(root, ["file:plugins/a.py"])).toEqual({ "file:plugins/a.py": "uncertain" });
  });
});

describe("Python roots", () => {
  it("finds entry points in pyproject, setup.py, commands, and conventions", () => {
    const root = project({
      "pyproject.toml": '[project]\nname = "tool"\n[project.scripts]\ntool = "tool.cli:main"\n',
      "Dockerfile": 'FROM python\nCOPY ignored.py .\nCMD ["gunicorn", "-w", "2", "web.wsgi:application"]',
      ".github/workflows/ci.yml": "jobs:\n  x:\n    steps:\n      - run: python scripts/release.py --dry-run",
      "tool/__init__.py": "",
      "tool/cli.py": "def main(): pass\ndef other(): pass",
      "web/__init__.py": "",
      "web/wsgi.py": "application = make()\nunused = 1",
      "scripts/release.py": "def go(): pass",
      "ignored.py": "def x(): pass",
      "app.py": "import flask",
    });
    const analysis = analyze(loadConfig(root));
    const roots = analysis.roots.filter((r) => r.kind !== "test").map((r) => `${r.node} ${r.kind} ${r.source}`);
    expect(roots).toEqual(
      expect.arrayContaining([
        "sym:tool/cli.py#main production pyproject.toml#project.scripts.tool",
        "sym:web/wsgi.py#application production Dockerfile",
        "file:scripts/release.py tooling .github/workflows/ci.yml",
        "file:app.py production convention",
      ]),
    );
    expect(liveness(analysis, "sym:tool/cli.py#other")).toBe("orphaned");
    expect(liveness(analysis, "file:ignored.py")).toBe("orphaned");
  });

  it("treats a published library's public modules as its API", () => {
    const root = project({
      "pyproject.toml": '[build-system]\nrequires = ["hatchling"]\n[project]\nname = "lib"\n',
      "lib/__init__.py": "from ._core import Client\n__all__ = ['Client']",
      "lib/_core.py": "class Client: pass\ndef _helper(): pass\ndef internal(): pass",
      "lib/extras.py": "def public(): pass\ndef _private(): pass",
      "tests/test_lib.py": "from lib._core import internal\ndef test(): internal()",
    });
    expect(states(root, ["sym:lib/_core.py#Client", "sym:lib/_core.py#_helper", "sym:lib/_core.py#internal", "sym:lib/extras.py#public", "sym:lib/extras.py#_private"])).toEqual({
      "sym:lib/_core.py#Client": "live",
      "sym:lib/_core.py#_helper": "orphaned",
      "sym:lib/_core.py#internal": "test-only",
      "sym:lib/extras.py#public": "live",
      "sym:lib/extras.py#_private": "orphaned",
    });
  });

  it("knows Django, Celery, and Alembic conventions when they are dependencies", () => {
    const root = project({
      "requirements.txt": "Django>=5\ncelery\nalembic\n",
      "shop/__init__.py": "",
      "shop/apps.py": "class ShopConfig: pass",
      "shop/models.py": "class Order: pass",
      "shop/admin.py": "from .models import Order",
      "shop/migrations/0001_initial.py": "class Migration: pass",
      "shop/management/__init__.py": "",
      "shop/management/commands/sync.py": "class Command: pass",
      "shop/templatetags/money.py": "def fmt(v): return v",
      "shop/tasks.py": "def send(): pass",
      "db/env.py": "run()",
      "db/versions/abc_add.py": "def upgrade(): pass",
      "shop/unused.py": "def x(): pass",
    });
    const result = states(root, [
      "sym:shop/models.py#Order",
      "file:shop/migrations/0001_initial.py",
      "sym:shop/management/commands/sync.py#Command",
      "file:shop/management/__init__.py",
      "sym:shop/templatetags/money.py#fmt",
      "sym:shop/tasks.py#send",
      "sym:db/versions/abc_add.py#upgrade",
      "file:shop/unused.py",
    ]);
    expect(result).toEqual({
      "sym:shop/models.py#Order": "live",
      "file:shop/migrations/0001_initial.py": "live",
      "sym:shop/management/commands/sync.py#Command": "live",
      "file:shop/management/__init__.py": "live",
      "sym:shop/templatetags/money.py#fmt": "live",
      "sym:shop/tasks.py#send": "live",
      "sym:db/versions/abc_add.py#upgrade": "live",
      "file:shop/unused.py": "orphaned",
    });
  });

  it("treats pytest files, notebooks, static scripts, and top-level scripts as roots", () => {
    const root = project({
      "conftest.py": "from helpers import fixture_data",
      "helpers.py": "def fixture_data(): pass",
      "tests/test_x.py": "from lib import f\ndef test(): f()",
      "lib.py": "def f(): pass",
      "analysis.ipynb": JSON.stringify({ cells: [{ cell_type: "code", source: "from plots import draw\ndraw()" }] }),
      "plots.py": "def draw(): pass",
      "web/static/js/util.js": "function formatDate(d) { return d; }",
      "prepare.py": "import json\nwith open('x') as f:\n    data = json.load(f)\nprint(data)",
    });
    expect(states(root, ["sym:helpers.py#fixture_data", "sym:lib.py#f", "sym:plots.py#draw", "sym:web/static/js/util.js#formatDate", "file:prepare.py"])).toEqual({
      "sym:helpers.py#fixture_data": "test-only",
      "sym:lib.py#f": "test-only",
      "sym:plots.py#draw": "live",
      "sym:web/static/js/util.js#formatDate": "live",
      "file:prepare.py": "live",
    });
  });

  it("honors directives in Python comments", () => {
    const root = project({
      "main.py": "if __name__ == '__main__':\n    pass",
      "kept.py": "# loose-ends-file: dormant used by the v1 importer\ndef old(): pass",
      "plugin.py": "# loose-ends-file: entry\ndef hook(): pass",
    });
    expect(states(root, ["file:kept.py", "sym:plugin.py#hook"])).toEqual({ "file:kept.py": "dormant", "sym:plugin.py#hook": "live" });
  });

  it("can turn Python analysis off", () => {
    const root = project({ "loose-ends.config.json": { languages: ["javascript"] }, "a.py": "x = 1", "index.js": "1" });
    expect(analyze(loadConfig(root)).build.files.map((f) => f.path)).toEqual(["index.js"]);
  });
});

describe("Python dependencies", () => {
  it("reads requirements, pyproject, and setup.py, and skips dev and frozen files", () => {
    const frozen = Array.from({ length: 12 }, (_, i) => `pkg${i}==1.0`).join("\n");
    const root = project({
      "requirements.txt": "requests\nPyYAML\n",
      "requirements-dev.txt": "pytest\n",
      "svc/pyproject.toml": '[project]\nname = "svc"\ndependencies = ["httpx>=0.27"]\n[project.scripts]\nsvc = "svc.main:run"\n',
      "svc/setup.py": "setup(name='svc', install_requires=['click'], entry_points={'console_scripts': ['svc2 = svc.main:other']})",
      "frozen/requirements.txt": frozen,
      "frozen/main.py": "",
    });
    const projects = discoverPythonProjects(root).map((p) => ({ dir: p.dir, manifests: p.manifests.map((m) => `${m.path}: ${m.dependencies.map((d) => d.name).join(",")}`), entries: p.entryPoints.map((e) => e.target) }));
    expect(projects).toEqual([
      { dir: "", manifests: ["requirements.txt: requests,PyYAML"], entries: [] },
      { dir: "frozen", manifests: [], entries: [] },
      { dir: "svc", manifests: ["svc/pyproject.toml: httpx", "svc/setup.py: click"], entries: ["svc.main:run", "svc.main:other"] },
    ]);
  });

  it("classifies use through import names, commands, settings strings, and implicit packages", () => {
    const root = project({
      "requirements.txt": ["PyYAML", "beautifulsoup4", "unused-thing", "gunicorn", "alembic", "django-cors-headers", "psycopg2-binary", "pytest-mock", "custom-plugin", "Pillow"].join("\n"),
      "loose-ends.config.json": { ignoreDependencies: ["custom-plugin"] },
      "Procfile": "release: alembic upgrade head\nweb: gunicorn app:app",
      "app.py": "import yaml\nfrom bs4 import BeautifulSoup\nINSTALLED = ['corsheaders']\napp = make(yaml, BeautifulSoup, INSTALLED)",
      "tests/test_img.py": "from PIL import Image",
    });
    const uses = Object.fromEntries(dependencyReport(analyze(loadConfig(root))).map((r) => [r.name, r.use]));
    expect(uses).toEqual({
      PyYAML: "live",
      beautifulsoup4: "live",
      "unused-thing": "unused",
      gunicorn: "ignored",
      alembic: "script",
      "django-cors-headers": "config",
      "psycopg2-binary": "ignored",
      "pytest-mock": "ignored",
      "custom-plugin": "ignored",
      Pillow: "test-only",
    });
  });
});

describe("Python check", () => {
  const base = {
    "main.py": "from svc import handlers\nif __name__ == '__main__':\n    handlers.handle()",
    "svc/__init__.py": "",
    "svc/handlers.py": "from .fmt import render\ndef handle():\n    return render(1)",
    "svc/fmt.py": "def render(value):\n    text = str(value)\n    text = text.strip().lower()\n    parts = text.split(',')\n    return ','.join(p for p in parts if p)",
  };

  it("passes a change that wires new code in and fails one that leaves it out", () => {
    const wired = repo(base, {
      "svc/extra.py": "def helper(): return 2",
      "svc/handlers.py": "from .fmt import render\nfrom .extra import helper\ndef handle():\n    return render(helper())",
    });
    expect(check({ root: wired, base: "HEAD" }).passed).toBe(true);

    const loose = repo(base, { "svc/extra.py": "def helper(): return 2", "svc/handlers.py": base["svc/handlers.py"] + "\ndef new_unused(): pass" });
    const result = check({ root: loose, base: "HEAD" });
    expect(result.passed).toBe(false);
    expect(result.findings.map((f) => `${f.kind} ${f.target}`).sort()).toEqual(["orphaned-addition svc/extra.py", "orphaned-addition svc/handlers.py#new_unused"]);
  });

  it("reports superseded Python code and new unused requirements", () => {
    const root = repo(
      { ...base, "requirements.txt": "requests\n" },
      {
        "requirements.txt": "requests\nnumpy\n",
        "svc/fmt_v2.py": "def render_v2(value):\n    text = str(value)\n    text = text.strip().lower()\n    parts = text.split(',')\n    return ','.join(p for p in parts if p)",
        "svc/handlers.py": "from .fmt_v2 import render_v2\ndef handle():\n    return render_v2(1)",
      },
    );
    const result = check({ root, base: "HEAD" });
    const kinds = result.findings.map((f) => `${f.kind} ${f.target}`).sort();
    expect(kinds).toContain("superseded svc/fmt.py");
    expect(kinds).toContain("unused-dependency requirements.txt#dependencies.numpy");
    expect(kinds).not.toContain("unused-dependency requirements.txt#dependencies.requests");
  });

  it("does not call data tables or migrations duplicates", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `"w${i}"`).join(", ");
    const root = repo(
      { "main.py": "from data import A\nif __name__ == '__main__': print(A)", "data.py": `A = {${words(30)}}` },
      { "data.py": `A = {${words(30)}}\nB = {${words(31)}}`, "main.py": "from data import A, B\nif __name__ == '__main__': print(A, B)" },
    );
    expect(check({ root, base: "HEAD" }).findings.map((f) => f.kind)).toEqual([]);
  });

  it("scans without git", () => {
    const root = project({ "main.py": "if __name__ == '__main__': pass", "dead.py": "x = 1" });
    expect(scan({ root }).findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["orphaned dead.py"]);
  });
});

describe("Python cleanup", () => {
  it("removes dead functions with their comments and decorators", () => {
    const root = project({
      "main.py": "from lib import used\nif __name__ == '__main__':\n    used()",
      "lib.py": ["import os", "", "", "def used():", "    return os.sep", "", "", "# Old formatter, kept around.", "@functools.lru_cache", "def dead(x):", "    return x", "", "", "VALUE = 1", ""].join("\n"),
    });
    const result = scan({ root });
    const analysis = analyze(loadConfig(root));
    const plan = planCleanup(analysis, result.findings);
    expect(plan.actions.map((a) => (a.type === "remove-declaration" ? a.symbol : a.path))).toEqual(["dead", "VALUE"]);
    applyCleanup(root, plan);
    expect(readFileSync(join(root, "lib.py"), "utf8")).toBe("import os\n\n\ndef used():\n    return os.sep\n");
  });
});
