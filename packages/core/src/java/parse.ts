import { parseDirective, shingles, type Declaration, type DeclarationKind, type Directive, type ImportRecord, type ModuleInfo, type StringRef } from "../parse.js";

export interface JavaToken {
  kind: "name" | "op" | "string" | "number" | "char";
  value: string;
  start: number;
  end: number;
  line: number;
}

interface JavaComment {
  text: string;
  line: number;
  start: number;
  end: number;
}

/** A top-level type in a Java file. */
export interface JavaType {
  name: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  public: boolean;
  abstract: boolean;
  /** Simple names of annotations on the type. */
  annotations: string[];
  /** Simple names of annotations on members (methods, fields). */
  memberAnnotations: string[];
  /** Names after `extends` and `implements`, as written. */
  superTypes: string[];
  /** Declares a `main` method. */
  hasMain: boolean;
}

export interface JavaImport {
  /** Qualified name as written, without `.*`. */
  name: string;
  static: boolean;
  /** `import a.b.*;` */
  wildcard: boolean;
  line: number;
}

const KEYWORDS = new Set(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var yield record sealed permits non".split(
    " ",
  ),
);
const MODIFIERS = new Set(["public", "protected", "private", "abstract", "static", "final", "sealed", "non", "-", "strictfp"]);
const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record"]);
const NAME = /[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*/uy;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)[lLfFdD]?/y;
const OPERATORS = [">>>=", "<<=", ">>=", "...", "->", "::", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="];
const FQN = /^[a-z_][\w]*(?:\.[a-z_][\w]*)*\.[A-Z][\w$]*(?:\.[A-Z][\w$]*)*$/;

export function tokenizeJava(text: string): { tokens: JavaToken[]; comments: JavaComment[]; lines: number } {
  const tokens: JavaToken[] = [];
  const comments: JavaComment[] = [];
  let pos = 0;
  let line = 1;
  const countLines = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) line++;
  };
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === "\n") {
      line++;
      pos++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f") {
      pos++;
      continue;
    }
    if (ch === "/" && text[pos + 1] === "/") {
      let stop = text.indexOf("\n", pos);
      if (stop === -1) stop = text.length;
      comments.push({ text: text.slice(pos, stop).replace(/\r$/, ""), line, start: pos, end: stop });
      pos = stop;
      continue;
    }
    if (ch === "/" && text[pos + 1] === "*") {
      let stop = text.indexOf("*/", pos + 2);
      stop = stop === -1 ? text.length : stop + 2;
      comments.push({ text: text.slice(pos, stop), line, start: pos, end: stop });
      countLines(pos, stop);
      pos = stop;
      continue;
    }
    const start = pos;
    const startLine = line;
    if (text.startsWith('"""', pos)) {
      let stop = pos + 3;
      while (stop < text.length && !text.startsWith('"""', stop)) stop += text[stop] === "\\" ? 2 : 1;
      stop = Math.min(text.length, stop + 3);
      countLines(pos, stop);
      tokens.push({ kind: "string", value: text.slice(pos, stop), start, end: stop, line: startLine });
      pos = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let stop = pos + 1;
      while (stop < text.length && text[stop] !== ch && text[stop] !== "\n") stop += text[stop] === "\\" ? 2 : 1;
      stop = Math.min(text.length, stop + 1);
      tokens.push({ kind: ch === '"' ? "string" : "char", value: text.slice(pos, stop), start, end: stop, line });
      pos = stop;
      continue;
    }
    NAME.lastIndex = pos;
    const name = NAME.exec(text);
    if (name) {
      tokens.push({ kind: "name", value: name[0], start, end: pos + name[0].length, line });
      pos += name[0].length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[pos + 1] ?? ""))) {
      NUMBER.lastIndex = pos;
      const num = NUMBER.exec(text);
      const value = num?.[0] || ch;
      tokens.push({ kind: "number", value, start, end: pos + value.length, line });
      pos += value.length;
      continue;
    }
    // `>` stays a single token so nested generics (`List<List<T>>`) close one level at a time.
    const op = ch === ">" ? ">" : OPERATORS.find((o) => text.startsWith(o, pos)) ?? ch;
    tokens.push({ kind: "op", value: op, start, end: pos + op.length, line });
    pos += op.length;
  }
  return { tokens, comments, lines: line };
}

/** Extract the package, imports, and top-level types of a Java file, with the names each type references. */
export function parseJava(path: string, text: string): ModuleInfo {
  const { tokens, comments, lines } = tokenizeJava(text);
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
    lines,
    language: "java",
    stringRefs: [],
    javaPackage: "",
    javaImports: [],
    javaTypes: [],
    javaNested: [],
  };
  const nested = new Set<string>();
  let i = 0;
  let declStart = -1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === "name" && t.value === "package" && declStart === -1) {
      const { name, next } = qualified(tokens, i + 1);
      info.javaPackage = name;
      i = skipTo(tokens, next, ";") + 1;
      continue;
    }
    if (t.kind === "name" && t.value === "import" && declStart === -1) {
      let j = i + 1;
      const isStatic = tokens[j]?.value === "static";
      if (isStatic) j++;
      const { name, next } = qualified(tokens, j);
      const wildcard = tokens[next]?.value === "." && tokens[next + 1]?.value === "*";
      info.javaImports!.push({ name, static: isStatic, wildcard, line: t.line });
      const simple = name.split(".").pop()!;
      const record: ImportRecord = {
        kind: "static",
        specifier: name,
        bindings: wildcard ? [] : [{ local: simple, imported: simple }],
        typeOnly: false,
        owner: "<module>",
        atLoad: false,
        line: t.line,
      };
      info.imports.push(record);
      i = skipTo(tokens, next, ";") + 1;
      continue;
    }
    if (t.kind === "name" && (t.value === "module" || (t.value === "open" && tokens[i + 1]?.value === "module")) && declStart === -1) {
      // module-info.java
      break;
    }
    if (t.value === "@" && tokens[i + 1]?.value !== "interface") {
      if (declStart === -1) declStart = i;
      i = skipAnnotation(tokens, i);
      continue;
    }
    if (t.kind === "name" && MODIFIERS.has(t.value)) {
      if (declStart === -1) declStart = i;
      i++;
      continue;
    }
    if (t.value === "-" && declStart !== -1) {
      i++;
      continue;
    }
    const isAnnotationType = t.value === "@" && tokens[i + 1]?.value === "interface";
    if ((t.kind === "name" && TYPE_KEYWORDS.has(t.value) && tokens[i + 1]?.kind === "name") || isAnnotationType) {
      const start = declStart === -1 ? i : declStart;
      const keywordAt = isAnnotationType ? i + 1 : i;
      const nameTok = tokens[keywordAt + 1]!;
      const open = skipTo(tokens, keywordAt + 2, "{");
      const close = matchBrace(tokens, open);
      const type = describeType(tokens, start, isAnnotationType ? i : keywordAt, keywordAt, open, close, isAnnotationType ? "annotation" : (t.value as JavaType["kind"]));
      for (let k = open + 1; k < close; k++) {
        const tk = tokens[k]!;
        if (tk.kind === "name" && TYPE_KEYWORDS.has(tk.value) && tokens[k + 1]?.kind === "name" && tokens[k - 1]?.value !== ".") nested.add(tokens[k + 1]!.value);
      }
      const refs = references(tokens, start, close + 1, nameTok.value, info);
      refs.delete(nameTok.value);
      const decl: Declaration = {
        name: nameTok.value,
        kind: declarationKind(type.kind),
        exportedAs: [nameTok.value],
        references: [...refs].sort(),
        line: tokens[start]!.line,
        endLine: lineOfEnd(text, tokens[close] ?? tokens[tokens.length - 1]!),
        start: tokens[start]!.start,
        end: (tokens[close] ?? tokens[tokens.length - 1]!).end,
        statementSize: 1,
        ...shingles(tokens.slice(start, close + 1).map((x) => (x.kind === "name" ? (KEYWORDS.has(x.value) ? x.value : "$i") : x.kind === "op" ? x.value : "$l"))),
      };
      if (!info.declarations.some((d) => d.name === decl.name)) {
        info.declarations.push(decl);
        info.javaTypes!.push(type);
      }
      declStart = -1;
      i = close + 1;
      continue;
    }
    // Anything else at the top level (stray `;`, Java 21 implicit class members) is skipped.
    declStart = -1;
    if (t.value === "{") {
      i = matchBrace(tokens, i) + 1;
      continue;
    }
    i++;
  }
  info.javaNested = [...nested];
  info.directives = directives(tokens, comments, info.declarations);
  return info;
}

function declarationKind(kind: JavaType["kind"]): DeclarationKind {
  if (kind === "interface" || kind === "annotation") return "interface";
  if (kind === "enum") return "enum";
  return "class";
}

function describeType(tokens: JavaToken[], start: number, headerEnd: number, keywordAt: number, open: number, close: number, kind: JavaType["kind"]): JavaType {
  const annotations: string[] = [];
  let isPublic = false;
  let isAbstract = false;
  for (let k = start; k < headerEnd; k++) {
    const tk = tokens[k]!;
    if (tk.value === "@") {
      const { name } = qualified(tokens, k + 1);
      annotations.push(name.split(".").pop()!);
      k = skipAnnotation(tokens, k) - 1;
      continue;
    }
    if (tk.value === "public") isPublic = true;
    if (tk.value === "abstract") isAbstract = true;
  }
  const superTypes: string[] = [];
  let inSupers = false;
  let generic = 0;
  for (let k = keywordAt + 2; k < open; k++) {
    const tk = tokens[k]!;
    if (tk.value === "<") generic++;
    else if (tk.value === ">") generic--;
    else if (tk.value === "extends" || tk.value === "implements") inSupers = true;
    else if (tk.value === "permits") inSupers = false;
    else if (inSupers && generic === 0 && tk.kind === "name" && tokens[k - 1]?.value !== ".") superTypes.push(qualified(tokens, k).name);
  }
  const memberAnnotations = new Set<string>();
  let hasMain = false;
  let depth = 0;
  for (let k = open; k <= close && k < tokens.length; k++) {
    const tk = tokens[k]!;
    if (tk.value === "{") depth++;
    else if (tk.value === "}") depth--;
    else if (tk.value === "@" && tokens[k + 1]?.kind === "name" && tokens[k + 1]!.value !== "interface") memberAnnotations.add(qualified(tokens, k + 1).name.split(".").pop()!);
    else if (depth === 1 && tk.value === "main" && tokens[k - 1]?.value === "void" && tokens[k + 1]?.value === "(") hasMain = true;
  }
  return { name: tokens[keywordAt + 1]!.value, kind, public: isPublic, abstract: isAbstract, annotations, memberAnnotations: [...memberAnnotations], superTypes, hasMain };
}

/** Names and qualified chains (`Foo`, `Outer.Inner`, `com.acme.Util`) used in a token range. */
function references(tokens: JavaToken[], from: number, to: number, owner: string, info: ModuleInfo): Set<string> {
  const out = new Set<string>();
  const seenStrings = new Set<string>();
  for (let k = from; k < to && k < tokens.length; k++) {
    const tk = tokens[k]!;
    if (tk.kind === "string") {
      const body = tk.value.replace(/^"+|"+$/g, "");
      if (FQN.test(body) && !seenStrings.has(body)) {
        seenStrings.add(body);
        info.stringRefs!.push({ value: body, owner, line: tk.line } satisfies StringRef);
      }
      continue;
    }
    if (tk.kind !== "name" || KEYWORDS.has(tk.value)) continue;
    if (tokens[k - 1]?.value === ".") continue;
    let chain = tk.value;
    let j = k;
    while (tokens[j + 1]?.value === "." && tokens[j + 2]?.kind === "name") {
      chain += "." + tokens[j + 2]!.value;
      j += 2;
    }
    out.add(chain);
  }
  return out;
}

function qualified(tokens: JavaToken[], at: number): { name: string; next: number } {
  let name = "";
  let k = at;
  while (tokens[k]?.kind === "name") {
    name += tokens[k]!.value;
    if (tokens[k + 1]?.value === "." && tokens[k + 2]?.kind === "name") {
      name += ".";
      k += 2;
    } else {
      k++;
      break;
    }
  }
  return { name, next: k };
}

function skipTo(tokens: JavaToken[], from: number, value: string): number {
  let k = from;
  while (k < tokens.length && tokens[k]!.value !== value) k++;
  return k;
}

function matchBrace(tokens: JavaToken[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (tokens[k]!.value === "{") depth++;
    else if (tokens[k]!.value === "}" && --depth === 0) return k;
  }
  return tokens.length - 1;
}

/** Index just past `@Name` or `@Name(...)`. */
function skipAnnotation(tokens: JavaToken[], at: number): number {
  const { next } = qualified(tokens, at + 1);
  if (tokens[next]?.value !== "(") return next;
  let depth = 0;
  for (let k = next; k < tokens.length; k++) {
    if (tokens[k]!.value === "(") depth++;
    else if (tokens[k]!.value === ")" && --depth === 0) return k + 1;
  }
  return tokens.length;
}

function lineOfEnd(text: string, token: JavaToken): number {
  let line = token.line;
  for (let k = token.start; k < token.end; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** `// loose-ends: ...` comments directly above a top-level type, or `loose-ends-file:` anywhere. */
function directives(tokens: JavaToken[], comments: JavaComment[], declarations: Declaration[]): Directive[] {
  const out: Directive[] = [];
  for (const comment of comments) {
    for (const rawLine of comment.text.split(/\r?\n/)) {
      const cleaned = rawLine.replace(/^\s*(\/\/+|\/\*+|\*+)/, "").replace(/\*+\/\s*$/, "");
      const parsed = parseDirective(cleaned);
      if (!parsed) continue;
      const next = tokens.find((t) => t.start >= comment.end);
      const decl = next ? declarations.find((d) => d.start === next.start) : undefined;
      if (!parsed.file && !decl) continue;
      const scope = parsed.file || !decl ? "file" : "declaration";
      out.push({ scope, action: parsed.action, kind: parsed.kind, reason: parsed.reason, line: comment.line, symbols: scope === "declaration" ? [decl!.name] : [] });
    }
  }
  return out;
}
