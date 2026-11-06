import { describe, expect, it } from "vitest";
import { importNames, parseNotebook, parsePython, parseRequirements, parseToml, requirementName, tokenizePython } from "@loose-ends/core";

const decl = (text: string, name: string) => parsePython("m.py", text).declarations.find((d) => d.name === name);

describe("Python tokenizer", () => {
  it("groups physical lines into logical lines with indentation", () => {
    const { lines } = tokenizePython("x = (1,\n     2)\nif x:\n    y = 'a\\'b'\\\n        + \"\"\"c\nd\"\"\"\nz = 3; w = 4\n");
    expect(lines.map((l) => [l.indent, l.line, l.endLine, l.tokens.map((t) => t.value).join(" ")])).toEqual([
      [0, 1, 2, "x = ( 1 , 2 )"],
      [0, 3, 3, "if x :"],
      [4, 4, 6, "y = 'a\\'b' + \"\"\"c\nd\"\"\""],
      [0, 7, 7, "z = 3"],
      [0, 7, 7, "w = 4"],
    ]);
  });

  it("reads f-string replacement fields and keeps comments", () => {
    const { lines, comments } = tokenizePython('s = f"{a} {{b}} {c(d[\'k\'])!r:>{width}}"  # trailing\n# own line\n');
    expect(lines[0]!.tokens[2]!.fields).toEqual(["a", "c(d['k'])!r:>{width}"]);
    expect(comments.map((c) => [c.text, c.own])).toEqual([
      ["# trailing", false],
      ["# own line", true],
    ]);
  });
});

describe("parsePython", () => {
  it("reads imports, including relative, aliased, star, lazy, and TYPE_CHECKING ones", () => {
    const info = parsePython(
      "pkg/m.py",
      [
        "from __future__ import annotations",
        "import os, a.b.c, x.y as z",
        "from .sibling import (helper as h,",
        "    other)",
        "from .. import parent",
        "from .star import *",
        "from typing import TYPE_CHECKING",
        "if TYPE_CHECKING:",
        "    from models import User",
        "def f():",
        "    import json",
        "    return json",
      ].join("\n"),
    );
    expect(info.imports.map((i) => [i.kind, i.specifier, i.bindings.map((b) => `${b.local}=${b.imported}${b.module ? `@${b.module}` : ""}`).join(","), i.owner, i.atLoad, i.typeOnly])).toEqual([
      ["static", "os", "os=*@os", "<module>", true, false],
      ["static", "a.b.c", "a=*@a", "<module>", true, false],
      ["static", "x.y", "z=*@x.y", "<module>", true, false],
      ["static", ".sibling", "h=helper,other=other", "<module>", true, false],
      ["static", "..", "parent=parent", "<module>", true, false],
      ["reexport-all", ".star", "", "<module>", true, false],
      ["static", "typing", "TYPE_CHECKING=TYPE_CHECKING", "<module>", true, false],
      ["static", "models", "User=User", "<module>", false, true],
      ["static", "json", "json=*@json", "f", false, false],
    ]);
  });

  it("declares functions, classes, and assignments with their references", () => {
    const info = parsePython(
      "m.py",
      [
        '"""Docstring with Words."""',
        "CONSTANT: Final[int] = compute()",
        "a, b = 1, 2",
        "x = y = other.value",
        "f = lambda q=1: q",
        "__version__ = '1'",
        "self_ref.attr = 3",
        "type Alias = list[Item]",
        "",
        "@app.get('/')",
        "async def handler(req: 'Request', *, key=DEFAULT) -> dict:",
        "    return helper(req, key=value)",
        "",
        "class Model(Base):",
        "    field = Column()",
      ].join("\n"),
    );
    expect(info.declarations.map((d) => `${d.name}:${d.kind}:${d.statementSize}:${d.sideEffects ? "fx" : ""}:${d.references.join(",")}`)).toEqual([
      "CONSTANT:variable:1:fx:Final,compute,int",
      "a:variable:2::",
      "b:variable:2::",
      "x:variable:2::other.value",
      "y:variable:2::other.value",
      "f:variable:1::q",
      "Alias:type:1::Item,list",
      "handler:function:1:fx:DEFAULT,Request,app.get,dict,helper,req,value",
      "Model:class:1:fx:Base,Column,field",
    ]);
    expect(info.bodyReferences).toEqual(["self_ref.attr"]);
    expect(decl("@app.get('/')\nasync def handler(): pass", "handler")!.line).toBe(1);
  });

  it("separates registering decorators and base classes from wrappers", () => {
    const fx = (text: string, name: string) => !!decl(text, name)?.sideEffects;
    expect(fx("@login_required\ndef v(): pass", "v")).toBe(false);
    expect(fx("@functools.lru_cache(maxsize=1)\ndef v(): pass", "v")).toBe(false);
    expect(fx("@dataclass(frozen=True)\nclass C: pass", "C")).toBe(false);
    expect(fx("@router.post('/x')\ndef v(): pass", "v")).toBe(true);
    expect(fx("@stat('Commits')\ndef v(): pass", "v")).toBe(true);
    expect(fx("@shared_task\ndef v(): pass", "v")).toBe(true);
    expect(fx("class M(models.Model): pass", "M")).toBe(true);
    expect(fx("class T(unittest.TestCase): pass", "T")).toBe(true);
    expect(fx("class P(BaseModel): pass", "P")).toBe(false);
    expect(fx("def __getattr__(name): pass", "__getattr__")).toBe(true);
    expect(fx("logger = logging.getLogger(__name__)", "logger")).toBe(false);
    expect(fx("app = FastAPI()", "app")).toBe(true);
  });

  it("uses __all__ for public names, and underscores otherwise", () => {
    expect(parsePython("m.py", "def a(): pass\ndef _b(): pass").declarations.map((d) => d.exportedAs)).toEqual([["a"], []]);
    const info = parsePython("m.py", "__all__ = ['b']\ndef a(): pass\ndef b(): pass");
    expect(info.declarations.map((d) => d.exportedAs)).toEqual([[], ["b"]]);
    expect(info.pythonAll).toEqual(["b"]);
  });

  it("records strings that may name modules, and forward references", () => {
    const info = parsePython(
      "settings.py",
      ['INSTALLED_APPS = ["blog", "django.contrib.admin"]', 'ROOT = "proj.urls:app"', "def f(x: 'Item') -> 'list[Other]':", "    exec(open('cfg.py').read())", "    return 'a sentence. With Words'"].join("\n"),
    );
    expect(info.stringRefs!.map((s) => `${s.owner}:${s.value}`)).toEqual(["INSTALLED_APPS:blog", "INSTALLED_APPS:django.contrib.admin", "ROOT:proj.urls:app", "f:cfg.py"]);
    expect(info.declarations.find((d) => d.name === "f")!.references).toEqual(expect.arrayContaining(["Item", "Other", "list"]));
    expect(info.declarations.find((d) => d.name === "f")!.references).not.toContain("With");
  });

  it("records importlib calls as dynamic imports", () => {
    const info = parsePython("m.py", "def load(name):\n    importlib.import_module('plugins.a')\n    return importlib.import_module(name)");
    expect(info.imports.map((i) => [i.kind, i.specifier, i.owner, i.atLoad])).toEqual([
      ["dynamic", "plugins.a", "load", false],
      ["dynamic", "", "load", false],
    ]);
    expect(info.hasUnresolvableDynamic).toBe(true);
  });

  it("treats the __main__ block as module body and flags scripts", () => {
    const guarded = parsePython("m.py", "def main(): pass\nif __name__ == '__main__':\n    args = parse()\n    main()");
    expect(guarded.mainGuard).toBe(true);
    expect(guarded.declarations.map((d) => d.name)).toEqual(["main"]);
    expect(guarded.bodyReferences).toEqual(["args", "main", "parse"]);
    expect(parsePython("m.py", "import x\nfor i in range(3):\n    x.run(i)").script).toBe(true);
    expect(parsePython("m.py", "import x\nload_dotenv()\nVALUE = 1").script).toBeUndefined();
  });

  it("reads directives on the next statement, trailing comments, and the file", () => {
    const info = parsePython(
      "m.py",
      ["# loose-ends-file: entry", "", "# loose-ends: dormant kept for v1 clients", "@decorator", "def old(): pass", "", "def other(): pass  # loose-ends: ignore orphaned reviewed"].join("\n"),
    );
    expect(info.directives.map((d) => [d.scope, d.action, d.kind ?? "", d.reason, d.symbols.join(",")])).toEqual([
      ["file", "entry", "", "", ""],
      ["declaration", "dormant", "", "kept for v1 clients", "old"],
      ["declaration", "ignore", "orphaned", "reviewed", "other"],
    ]);
  });

  it("folds notebook cells into one module body", () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Title"] },
        { cell_type: "code", source: ["%matplotlib inline\n", "from lib.plots import draw\n", "def local():\n", "    return draw()\n"] },
        { cell_type: "code", source: "!pip install x\nlocal()" },
      ],
    });
    const info = parseNotebook("a.ipynb", nb);
    expect(info.declarations).toEqual([]);
    expect(info.imports.map((i) => [i.specifier, i.owner])).toEqual([["lib.plots", "<module>"]]);
    expect(info.bodyReferences).toEqual(["draw", "local"]);
  });
});

describe("Python manifests", () => {
  it("parses the TOML that pyproject files use", () => {
    const doc = parseToml(
      [
        "# comment",
        "[project]",
        'name = "demo"',
        "dependencies = [",
        '  "requests[socks]>=2", # inline comment',
        "  'PyYAML',",
        "]",
        'scripts = { demo = "demo.cli:main" }',
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'django = { version = "5", extras = ["argon2"] }',
        '"quoted.key" = true',
        "[[tool.items]]",
        "a = 1",
        "[[tool.items]]",
        'b = """multi',
        'line"""',
      ].join("\n"),
    );
    expect(doc).toEqual({
      project: { name: "demo", dependencies: ["requests[socks]>=2", "PyYAML"], scripts: { demo: "demo.cli:main" } },
      tool: {
        poetry: { dependencies: { python: "^3.11", django: { version: "5", extras: ["argon2"] }, "quoted.key": true } },
        items: [{ a: "1" }, { b: "multi\nline" }],
      },
    });
  });

  it("reads requirement names", () => {
    expect(parseRequirements("# c\nrequests>=2  # pinned\n-r base.txt\n-e .\nDjango==5.0\nfoo[bar] ; python_version>'3'\ngit+https://x/y.git#egg=pkg\n").map((d) => [d.name, d.line, d.pinned])).toEqual([
      ["requests", 2, false],
      ["Django", 5, true],
      ["foo", 6, false],
      ["pkg", 7, false],
    ]);
    expect(requirementName("uvicorn[standard]>=0.30")).toBe("uvicorn");
  });

  it("maps distributions to import names", () => {
    expect(importNames("beautifulsoup4")).toContain("bs4");
    expect(importNames("PyYAML")).toContain("yaml");
    expect(importNames("python-dotenv")).toContain("dotenv");
    expect(importNames("Flask-Cors")).toContain("flask_cors");
    expect(importNames("google-cloud-storage")).toContain("google");
    expect(importNames("some_package")).toContain("some_package");
  });
});
