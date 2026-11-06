import { MODULE_BODY, parseDirective, shingles, type Declaration, type DeclarationKind, type Directive, type ImportRecord, type ModuleInfo, type StringRef } from "../parse.js";
import { KEYWORDS, tokenize, type LogicalLine, type Token } from "./tokenize.js";

/** Decorators that wrap or annotate a function without registering it anywhere. */
const PURE_DECORATOR =
  /^(?:(?:functools|abc|typing|typing_extensions|contextlib|dataclasses|enum|warnings|numba|jax|torch|tf)\.)?(?:property|staticmethod|classmethod|abstractmethod|abstractproperty|cached_property|lru_cache|cache|wraps|dataclass|total_ordering|contextmanager|asynccontextmanager|overload|final|override|runtime_checkable|singledispatch|singledispatchmethod|unique|deprecated|no_type_check|njit|jit|vmap|compile|no_grad|inference_mode|function)$/;
/** Bare decorator names that register the function with a framework. */
const REGISTERING_DECORATOR = /^(?:shared_task|task|periodic_task|receiver|register|hookimpl|job|on_event|listener|subscriber|handler|route|command|group|fixture|tool|activity|workflow|asset|op|flow)$/;
/** Base classes whose subclasses register themselves when defined (ORM models, app configs, commands). */
const REGISTERING_BASE = /^(?:Model|Base|DeclarativeBase|SQLModel|Document|EmbeddedDocument|AppConfig|Migration|BaseCommand|ModelAdmin|TabularInline|StackedInline|Cog|Plugin|Extension|Signal|Spider|Operator|BaseOperator|\w*TestCase)$/;
/** Calls that only build a value, so an unused assignment from them is dead. */
const PURE_CALL =
  /^(?:TypeVar|ParamSpec|TypeVarTuple|NewType|NamedTuple|namedtuple|collections\.namedtuple|TypedDict|Enum|IntEnum|StrEnum|Flag|frozenset|set|dict|list|tuple|str|int|float|bool|bytes|object|range|Path|pathlib\.Path|PurePath|PurePosixPath|re\.\w+|os\.getenv|getenv|os\.environ\.get|environ\.get|os\.path\.\w+|logging\.getLogger|getLogger|structlog\.get_logger|get_logger|field|dataclasses\.field|Field|defaultdict|OrderedDict|Counter|deque|collections\.\w+|Decimal|datetime|date|timedelta|time|timezone|datetime\.\w+|ContextVar|contextvars\.ContextVar|cast|typing\.\w+|np\.\w+|numpy\.\w+|math\.\w+|json\.loads|uuid\.\w+|struct\.Struct|threading\.Lock|threading\.RLock|asyncio\.Lock|Lock|RLock|partial|functools\.partial|itemgetter|attrgetter|operator\.\w+|string\.\w+|sorted|max|min|sum|len|zip|map|filter|enumerate|reversed|round|abs|repr|format|chr|ord|type)$/;

const DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;
const MODULE_ATTR = /^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/;
const PACKAGE_NAME = /^[a-z_][a-z0-9_]*$/;
const ANNOTATION = /^[\w.[\],|]+$/;
const PY_PATH = /^[\w./-]+\.py$/;
/** Statements that make a file look like a script: calls count 1, loops and `with` blocks count 2. */
const SCRIPT_SCORE = 3;

interface Flags {
  /** Inside `if TYPE_CHECKING:`. */
  typeOnly: boolean;
}

/** Extract imports, top-level declarations, and references from a Python module. */
export function parsePython(path: string, text: string): ModuleInfo {
  const { lines, comments, lineCount } = tokenize(text);
  const info: ModuleInfo = {
    path,
    directives: [],
    imports: [],
    declarations: [],
    localExports: [],
    bodyReferences: [],
    hasUnresolvableDynamic: false,
    commonjs: false,
    jsx: false,
    lines: lineCount,
    language: "python",
    stringRefs: [],
    mainGuard: false,
  };
  const parser = new PythonParser(info, lines);
  parser.block(0, lines.length, { typeOnly: false });
  parser.finish();
  info.directives = directives(comments, lines, info.declarations);
  info.hasUnresolvableDynamic = info.imports.some((i) => i.kind === "dynamic" && i.specifier === "");
  return info;
}

/**
 * Notebooks run top to bottom by hand. Their code cells become one module
 * body: imports and references count, but nothing in them is reported.
 */
export function parseNotebook(path: string, text: string): ModuleInfo {
  let source = "";
  try {
    const nb = JSON.parse(text) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    for (const cell of nb.cells ?? []) {
      if (cell.cell_type !== "code") continue;
      const code = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
      // IPython magics and shell escapes are not Python.
      source += code.replace(/^\s*[%!?].*$/gm, "") + "\n\n";
    }
  } catch {
    source = "";
  }
  const info = parsePython(path, source);
  const refs = new Set(info.bodyReferences);
  for (const decl of info.declarations) for (const r of decl.references) refs.add(r);
  for (const record of info.imports) {
    record.owner = MODULE_BODY;
    record.atLoad = !record.typeOnly;
  }
  for (const ref of info.stringRefs ?? []) ref.owner = MODULE_BODY;
  info.declarations = [];
  info.directives = [];
  info.bodyReferences = [...refs].sort();
  return info;
}

class PythonParser {
  private readonly bodyRefs = new Set<string>();
  private readonly byName = new Map<string, Declaration>();
  private readonly seenStrings = new Set<string>();
  private all?: string[];
  private scriptScore = 0;

  constructor(
    private readonly info: ModuleInfo,
    private readonly lines: LogicalLine[],
  ) {}

  /** Index just past the body of the statement at `i` (lines indented deeper than it). */
  private bodyEnd(i: number, to: number): number {
    const indent = this.lines[i]!.indent;
    let k = i + 1;
    while (k < to && this.lines[k]!.indent > indent) k++;
    return k;
  }

  /** Process statements that run when the module loads. */
  block(from: number, to: number, flags: Flags): void {
    let i = from;
    while (i < to) {
      const line = this.lines[i]!;
      const first = line.tokens[0]!;
      if (first.value === "@") {
        let j = i;
        while (j < to && this.lines[j]!.tokens[0]!.value === "@" && this.lines[j]!.indent === line.indent) j++;
        if (j < to && isDefinition(this.lines[j]!)) {
          const end = this.bodyEnd(j, to);
          this.definition(i, j, end);
          i = end;
          continue;
        }
        this.simple(line, flags);
        i++;
        continue;
      }
      const end = this.bodyEnd(i, to);
      if (isDefinition(line)) {
        this.definition(i, i, end);
      } else if (isImport(line.tokens)) {
        this.imports(line.tokens, MODULE_BODY, !flags.typeOnly, flags.typeOnly, line.line);
      } else if (endsWithColon(line) || end > i + 1) {
        if (/^(for|while|with|async)$/.test(first.value)) this.scriptScore += 2;
        this.compound(line, i, end, flags);
      } else {
        this.simple(line, flags);
      }
      i = end;
    }
  }

  private compound(line: LogicalLine, i: number, end: number, flags: Flags): void {
    const colon = headerColon(line.tokens);
    const header = colon === -1 ? line.tokens : line.tokens.slice(0, colon);
    const inline = colon === -1 ? [] : line.tokens.slice(colon + 1);
    if (isMainGuard(header)) {
      this.info.mainGuard = true;
      this.scriptBody(inline, i + 1, end);
      return;
    }
    const typeOnly = flags.typeOnly || isTypeChecking(header);
    this.refs(header, this.bodyRefs, MODULE_BODY, true);
    if (inline.length) {
      if (isImport(inline)) this.imports(inline, MODULE_BODY, !typeOnly, typeOnly, line.line);
      else this.refs(inline, this.bodyRefs, MODULE_BODY, true);
    }
    if (end > i + 1) this.block(i + 1, end, { typeOnly });
  }

  /** `if __name__ == "__main__":` runs only as a script: everything in it is module body. */
  private scriptBody(inline: Token[], from: number, to: number): void {
    if (inline.length) this.refs(inline, this.bodyRefs, MODULE_BODY, true);
    for (let k = from; k < to; k++) {
      const tokens = this.lines[k]!.tokens;
      if (isImport(tokens)) this.imports(tokens, MODULE_BODY, true, false, this.lines[k]!.line);
      else this.refs(tokens, this.bodyRefs, MODULE_BODY, true);
    }
  }

  /** `def`, `async def`, or `class`, with its decorators (lines `from`..`header`) and body. */
  private definition(from: number, header: number, end: number): void {
    const head = this.lines[header]!.tokens;
    const at = head[0]!.value === "async" ? 1 : 0;
    const keyword = head[at]!.value;
    const name = head[at + 1]?.kind === "name" ? head[at + 1]!.value : undefined;
    if (!name) {
      for (let k = from; k < end; k++) this.refs(this.lines[k]!.tokens, this.bodyRefs, MODULE_BODY, true);
      return;
    }
    const refs = new Set<string>();
    const all: Token[] = [];
    let sideEffects = false;
    for (let k = from; k < end; k++) {
      const tokens = this.lines[k]!.tokens;
      all.push(...tokens);
      if (k > header && isImport(tokens)) {
        this.imports(tokens, name, keyword === "class", false, this.lines[k]!.line);
        continue;
      }
      if (k < header) sideEffects ||= registersDecorator(tokens);
      this.refs(tokens, refs, name, k <= header || keyword === "class");
    }
    if (keyword === "class") sideEffects ||= registersClass(head.slice(at + 2));
    // Module-level `__getattr__` and `__dir__` (PEP 562) are called by Python itself.
    if (/^__\w+__$/.test(name)) sideEffects = true;
    refs.delete(name);
    const first = this.lines[from]!;
    const last = this.lines[end - 1]!;
    this.declare(name, keyword === "class" ? "class" : "function", first.start, last.end, first.line, last.endLine, refs, all, sideEffects, 1);
  }

  private simple(line: LogicalLine, flags: Flags): void {
    const tokens = line.tokens;
    // `type Alias = ...` (Python 3.12)
    if (tokens[0]!.value === "type" && tokens[1]?.kind === "name" && (tokens[2]?.value === "=" || tokens[2]?.value === "[")) {
      const refs = new Set<string>();
      this.refs(tokens.slice(2), refs, tokens[1].value, true);
      this.declare(tokens[1].value, "type", line.start, line.end, line.line, line.endLine, refs, tokens, false, 1);
      return;
    }
    if (isAllAssignment(tokens)) {
      this.all ??= [];
      for (const t of tokens) if (t.kind === "string" && t.body !== undefined && /^\w+$/.test(t.body)) this.all.push(t.body);
      return;
    }
    const targets = assignmentTargets(tokens);
    if (!targets) {
      if (tokens.some((t) => t.value === "(") && tokens[0]!.kind === "name" && !KEYWORDS.has(tokens[0]!.value)) this.scriptScore++;
      this.refs(tokens, this.bodyRefs, MODULE_BODY, true);
      return;
    }
    const { names, annotation, value } = targets;
    const declared = names.filter((n) => !/^__\w+__$/.test(n));
    if (declared.length === 0) {
      this.refs([...annotation, ...value], this.bodyRefs, MODULE_BODY, true);
      return;
    }
    const refs = new Set<string>();
    this.refs([...annotation, ...value], refs, declared[0]!, true);
    const sideEffects = callsAtLoad(value);
    for (const name of declared) {
      const own = new Set(refs);
      own.delete(name);
      this.declare(name, flags.typeOnly ? "type" : "variable", line.start, line.end, line.line, line.endLine, own, tokens, sideEffects, declared.length);
    }
  }

  private declare(name: string, kind: DeclarationKind, start: number, end: number, line: number, endLine: number, refs: Set<string>, tokens: Token[], sideEffects: boolean, size: number): void {
    const existing = this.byName.get(name);
    if (existing) {
      // Redefinition (`try: from x import f` / `except: def f()`, or a later override): merge, and keep cleanup away from it.
      existing.references = [...new Set([...existing.references, ...refs])].sort();
      existing.statementSize = Math.max(2, existing.statementSize);
      if (sideEffects) existing.sideEffects = true;
      return;
    }
    const decl: Declaration = {
      name,
      kind,
      exportedAs: [],
      references: [...refs].sort(),
      line,
      endLine,
      start,
      end,
      statementSize: size,
      ...fingerprintTokens(tokens),
    };
    if (sideEffects) decl.sideEffects = true;
    this.byName.set(name, decl);
    this.info.declarations.push(decl);
  }

  private imports(tokens: Token[], owner: string, atLoad: boolean, typeOnly: boolean, line: number): void {
    for (const record of parseImport(tokens, owner, atLoad, typeOnly, line)) this.info.imports.push(record);
  }

  /** Collect names (and dotted chains like `mod.attr`) referenced by tokens. */
  private refs(tokens: Token[], out: Set<string>, owner: string, atLoad: boolean): void {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind === "string") {
        this.stringRef(t, out, owner);
        continue;
      }
      if (t.kind !== "name" || KEYWORDS.has(t.value)) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (prev?.value === ".") continue;
      if (prev?.kind === "name" && (prev.value === "def" || prev.value === "class")) continue;
      if (t.depth > 0 && next?.value === "=" && (prev?.value === "(" || prev?.value === ",")) continue; // keyword argument
      let chain = t.value;
      let j = i;
      while (tokens[j + 1]?.value === "." && tokens[j + 2]?.kind === "name") {
        chain += "." + tokens[j + 2]!.value;
        j += 2;
      }
      out.add(chain);
      if (/(^|\.)(import_module|__import__)$/.test(chain) && tokens[j + 1]?.value === "(") {
        const arg = tokens[j + 2];
        const literal = arg?.kind === "string" && !arg.fields && (tokens[j + 3]?.value === ")" || tokens[j + 3]?.value === ",");
        this.info.imports.push({
          kind: "dynamic",
          specifier: literal ? arg.body ?? "" : "",
          bindings: [{ local: "", imported: "*" }],
          typeOnly: false,
          owner,
          atLoad,
          line: t.line,
        });
      }
    }
  }

  private stringRef(t: Token, out: Set<string>, owner: string): void {
    for (const field of t.fields ?? []) {
      for (const line of tokenize(field).lines) this.refs(line.tokens, out, owner, true);
    }
    const body = t.body;
    if (body === undefined || t.fields || body.length > 200) return;
    if ((DOTTED.test(body) || MODULE_ATTR.test(body) || PACKAGE_NAME.test(body) || PY_PATH.test(body)) && !this.seenStrings.has(`${owner}\0${body}`)) {
      this.seenStrings.add(`${owner}\0${body}`);
      this.info.stringRefs!.push({ value: body, owner, line: t.line });
    }
    // Forward references in annotations: "Model", "list[Item]".
    const compact = body.replace(/\s*([,|])\s*/g, "$1");
    if (ANNOTATION.test(compact) && !/\s/.test(compact) && (/^[A-Z]/.test(compact) || compact.includes("["))) {
      for (const m of compact.matchAll(/[A-Za-z_]\w*(?:\.\w+)*/g)) if (!KEYWORDS.has(m[0])) out.add(m[0]);
    }
  }

  finish(): void {
    const all = this.all;
    for (const decl of this.info.declarations) {
      const isPublic = all ? all.includes(decl.name) : !decl.name.startsWith("_");
      decl.exportedAs = isPublic ? [decl.name] : [];
    }
    this.info.bodyReferences = [...this.bodyRefs].sort();
    if (all) this.info.pythonAll = all;
    if (this.scriptScore >= SCRIPT_SCORE) this.info.script = true;
  }
}

function isDefinition(line: LogicalLine): boolean {
  const t = line.tokens;
  if (t[0]!.value === "def" || t[0]!.value === "class") return t[1]?.kind === "name";
  return t[0]!.value === "async" && t[1]?.value === "def" && t[2]?.kind === "name";
}

function isImport(tokens: Token[]): boolean {
  const first = tokens[0];
  if (!first || first.kind !== "name") return false;
  if (first.value === "import") return true;
  return first.value === "from" && tokens.some((t) => t.kind === "name" && t.value === "import" && t.depth === 0);
}

function endsWithColon(line: LogicalLine): boolean {
  const first = line.tokens[0]!;
  return first.kind === "name" && /^(if|elif|else|for|while|try|except|finally|with|async|match|case)$/.test(first.value) && headerColon(line.tokens) !== -1;
}

/** Index of the `:` that ends a compound statement header. */
function headerColon(tokens: Token[]): number {
  let lambdas = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.depth !== 0) continue;
    if (t.kind === "name" && t.value === "lambda") lambdas++;
    if (t.value === ":") {
      if (lambdas > 0) {
        lambdas--;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function isMainGuard(header: Token[]): boolean {
  const text = header.map((t) => (t.kind === "string" ? (t.body ?? "") : t.value)).join(" ");
  return /^if (__name__ == __main__|__main__ == __name__)$/.test(text);
}

function isTypeChecking(header: Token[]): boolean {
  const text = header.map((t) => t.value).join("");
  return /^if(typing\.|t\.)?TYPE_CHECKING$/.test(text);
}

function isAllAssignment(tokens: Token[]): boolean {
  return tokens[0]?.value === "__all__" && (tokens[1]?.value === "=" || tokens[1]?.value === "+=" || tokens[1]?.value === ":" || (tokens[1]?.value === "." && tokens[2]?.value === "extend"));
}

/** Names bound by `a = ...`, `a, b = ...`, `a: T = ...`, or `a = b = ...`; undefined for other statements. */
function assignmentTargets(tokens: Token[]): { names: string[]; annotation: Token[]; value: Token[] } | undefined {
  const eq: number[] = [];
  let colon = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.depth !== 0) continue;
    if (t.kind === "name" && t.value === "lambda") break; // `f = lambda x=1: x`
    if (t.kind !== "op") continue;
    if (t.value === "=") eq.push(i);
    else if (t.value === ":" && eq.length === 0 && colon === -1) colon = i;
  }
  if (eq.length === 0) return undefined;
  const names: string[] = [];
  let start = 0;
  for (const index of eq) {
    const target = tokens.slice(start, colon !== -1 && start === 0 ? colon : index);
    if (!target.length) return undefined;
    for (let i = 0; i < target.length; i++) {
      const t = target[i]!;
      if (t.kind === "name") {
        if (KEYWORDS.has(t.value)) return undefined;
        const next = target[i + 1];
        if (next && (next.value === "." || next.value === "[" || next.value === "(")) return undefined;
        names.push(t.value);
      } else if (!(t.kind === "op" && /^[,()[\]*]$/.test(t.value))) return undefined;
    }
    start = index + 1;
  }
  const annotation = colon !== -1 ? tokens.slice(colon + 1, eq[0]) : [];
  return { names, annotation, value: tokens.slice(eq[eq.length - 1]! + 1) };
}

function callsAtLoad(value: Token[]): boolean {
  let i = 0;
  while (value[i]?.value === "await" || value[i]?.value === "(") i++;
  let callee = "";
  while (value[i]?.kind === "name") {
    callee += value[i]!.value;
    if (value[i + 1]?.value !== ".") break;
    callee += ".";
    i += 2;
  }
  if (!callee || value[i + 1]?.value !== "(") return false;
  return !PURE_CALL.test(callee);
}

/**
 * Whether a decorator line registers the function somewhere (`@app.get("/")`,
 * `@receiver(post_save)`, `@stat("Commits")`) rather than only wrapping it
 * (`@login_required`, `@lru_cache`).
 */
function registersDecorator(tokens: Token[]): boolean {
  let callee = "";
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "name" || t.value === ".") callee += t.value;
    else break;
  }
  if (!callee || PURE_DECORATOR.test(callee)) return false;
  return callee.includes(".") || REGISTERING_DECORATOR.test(callee) || tokens[i]?.value === "(";
}

function registersClass(rest: Token[]): boolean {
  if (rest[0]?.value !== "(") return false;
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.depth === 0) break;
    if (t.kind !== "name") continue;
    if (t.value === "metaclass" && rest[i + 1]?.value === "=") return true;
    if (REGISTERING_BASE.test(t.value) && rest[i + 1]?.value !== ".") return true;
  }
  return false;
}

/** `import a.b as c, d` and `from .x import (y as z, w)`. */
export function parseImport(tokens: Token[], owner: string, atLoad: boolean, typeOnly: boolean, line: number): ImportRecord[] {
  const out: ImportRecord[] = [];
  const base = { typeOnly, owner, atLoad, line };
  if (tokens[0]!.value === "import") {
    for (const item of splitItems(tokens.slice(1))) {
      const { dotted, alias } = item;
      if (!dotted) continue;
      const local = alias ?? dotted.split(".")[0]!;
      out.push({ ...base, kind: "static", specifier: dotted, bindings: [{ local, imported: "*", module: alias ? dotted : local }] });
    }
    return out;
  }
  let i = 1;
  let specifier = "";
  while (i < tokens.length && !(tokens[i]!.kind === "name" && tokens[i]!.value === "import")) {
    specifier += tokens[i]!.value;
    i++;
  }
  if (specifier === "__future__" || i >= tokens.length) return out;
  const rest = tokens.slice(i + 1).filter((t) => t.value !== "(" && t.value !== ")");
  if (rest.length === 1 && rest[0]!.value === "*") {
    out.push({ ...base, kind: "reexport-all", specifier, bindings: [] });
    return out;
  }
  const bindings = splitItems(rest)
    .filter((item) => item.dotted)
    .map((item) => ({ local: item.alias ?? item.dotted, imported: item.dotted }));
  if (bindings.length) out.push({ ...base, kind: "static", specifier, bindings });
  return out;
}

function splitItems(tokens: Token[]): Array<{ dotted: string; alias?: string }> {
  const out: Array<{ dotted: string; alias?: string }> = [];
  let dotted = "";
  let alias: string | undefined;
  let inAlias = false;
  const flush = () => {
    if (dotted) out.push({ dotted, alias });
    dotted = "";
    alias = undefined;
    inAlias = false;
  };
  for (const t of tokens) {
    if (t.value === ",") flush();
    else if (t.kind === "name" && t.value === "as") inAlias = true;
    else if (inAlias) alias = t.value;
    else if (t.kind === "name" || t.value === ".") dotted += t.value;
  }
  flush();
  return out;
}

function fingerprintTokens(tokens: Token[]): { shape: number[]; tokens: number; literals: number } {
  return shingles(tokens.map((t) => (t.kind === "name" ? (KEYWORDS.has(t.value) ? t.value : "$i") : t.kind === "op" ? t.value : "$l")));
}

/** `# loose-ends: ...` comments. Own-line comments attach to the next top-level statement; trailing ones to their own. */
function directives(comments: Array<{ text: string; line: number; own: boolean }>, lines: LogicalLine[], declarations: Declaration[]): Directive[] {
  const out: Directive[] = [];
  for (const comment of comments) {
    const parsed = parseDirective(comment.text.replace(/^#+/, ""));
    if (!parsed) continue;
    let statement: LogicalLine | undefined;
    if (comment.own) {
      const candidate = lines.find((l) => l.line > comment.line);
      if (candidate && candidate.indent === 0) statement = candidate;
      else if (candidate && !parsed.file) continue;
    } else {
      const containing = lines.find((l) => l.line <= comment.line && l.endLine >= comment.line);
      if (containing && containing.indent === 0) statement = containing;
      else if (!parsed.file) continue;
    }
    const scope = parsed.file || !statement ? "file" : "declaration";
    const symbols = scope === "declaration" && statement ? declarations.filter((d) => d.start === statement!.start).map((d) => d.name) : [];
    out.push({ scope, action: parsed.action, kind: parsed.kind, reason: parsed.reason, line: comment.line, symbols });
  }
  return out;
}

export type { StringRef };
