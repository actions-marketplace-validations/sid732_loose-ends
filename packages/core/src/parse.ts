import ts from "typescript";
import { FINDING_KINDS } from "./config.js";
import type { JavaImport, JavaType } from "./java/parse.js";

/** Pseudo-declaration name representing a module's top-level side effects. */
export const MODULE_BODY = "<module>";

export type ImportKind =
  /** `import x from "y"` and friends. */
  | "static"
  /** `import "y"` with no bindings. */
  | "side-effect"
  /** `export { a } from "y"` or `export * as ns from "y"`. */
  | "reexport"
  /** `export * from "y"`. */
  | "reexport-all"
  /** `import("y")`. */
  | "dynamic"
  /** `require("y")` or `import x = require("y")`. */
  | "require";

export interface ImportBinding {
  /** Local identifier, or the exported name for re-exports. */
  local: string;
  /** Name in the target module: an export name, `default`, or `*`. */
  imported: string;
  /** Python `import a.b`: the binding is the module with this dotted name (`a`). */
  module?: string;
}

export interface ImportRecord {
  kind: ImportKind;
  /** Literal specifier. Empty when the specifier is not statically known. */
  specifier: string;
  bindings: ImportBinding[];
  typeOnly: boolean;
  /** Declaration that contains this import, or MODULE_BODY. */
  owner: string;
  /** Whether the import executes when the module loads (not deferred inside a function). */
  atLoad: boolean;
  /** For template-literal dynamic imports, a glob like `./locales/*.json`. */
  pattern?: string;
  line: number;
}

export type DeclarationKind =
  | "function"
  | "class"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "namespace"
  | "expression";

export interface Declaration {
  /** Local name. Anonymous default exports use `default`. */
  name: string;
  kind: DeclarationKind;
  /** Names this declaration is exported under. */
  exportedAs: string[];
  /** Identifiers referenced from inside the declaration. */
  references: string[];
  /** 1-based line range of the owning statement. */
  line: number;
  endLine: number;
  /** Character offsets of the owning statement, for cleanup patches. */
  start: number;
  end: number;
  /** Number of declarations sharing the same statement, e.g. `const a = 1, b = 2`. */
  statementSize: number;
  /** Structural fingerprint: hashed shingles of normalized tokens. */
  shape: number[];
  /** Number of tokens in the declaration. */
  tokens: number;
  /** How many of those tokens are string or number literals. */
  literals?: number;
  /**
   * The initializer calls something at load time (`export const a = register({...})`),
   * so the declaration has side effects whenever its module loads.
   */
  sideEffects?: boolean;
}

export interface LocalExport {
  exported: string;
  local: string;
}

export type DirectiveAction = "entry" | "dormant" | "ignore";

/**
 * An inline comment that changes how Loose Ends treats code.
 *
 *   // loose-ends: dormant kept for the v1 webhook payload
 *   // loose-ends: ignore superseded migration runs until Q3
 *   // loose-ends-file: entry
 */
export interface Directive {
  scope: "file" | "declaration";
  action: DirectiveAction;
  /** Finding kind for `ignore`, when given. */
  kind?: string;
  /** Free text after the action. Empty when missing. */
  reason: string;
  line: number;
  /** Declarations the directive is attached to (declaration scope only). */
  symbols: string[];
}

export interface ModuleInfo {
  path: string;
  directives: Directive[];
  imports: ImportRecord[];
  declarations: Declaration[];
  /** `export { a as b }` style exports of local names. */
  localExports: LocalExport[];
  /** Identifiers referenced by top-level statements that run on load. */
  bodyReferences: string[];
  /** Whether the module contains a dynamic import or require with an unknown specifier. */
  hasUnresolvableDynamic: boolean;
  /** Uses CommonJS `module.exports` or `exports.x`. */
  commonjs: boolean;
  /** Contains JSX, which implicitly imports the JSX runtime (react/jsx-runtime by default). */
  jsx: boolean;
  /** Number of source lines. */
  lines: number;
  /** Source language. Absent for JavaScript and TypeScript. */
  language?: "python" | "java";
  /** Python: string literals that may name a module or `module:attr` (settings, task names, server commands). */
  stringRefs?: StringRef[];
  /** Python: the module runs as a script (`if __name__ == "__main__":`). */
  mainGuard?: boolean;
  /** Python: top-level code does real work (calls, loops, `with`), so the file is likely run directly. */
  script?: boolean;
  /** Python: names listed in `__all__`, when the module defines it. */
  pythonAll?: string[];
  /** Java: the `package` declaration ("" for the default package). */
  javaPackage?: string;
  /** Java: import declarations. */
  javaImports?: JavaImport[];
  /** Java: top-level types, in the same order as their declarations. */
  javaTypes?: JavaType[];
  /** Java: names of types nested inside the file's top-level types. */
  javaNested?: string[];
}

export interface StringRef {
  value: string;
  /** Declaration that contains the string, or MODULE_BODY. */
  owner: string;
  line: number;
}

export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return ts.ScriptKind.TS;
  if (path.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.JSX;
}

export function createSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
}

/** Extract imports, exports, top-level declarations, and references from a module. */
export function parseModule(path: string, text: string): ModuleInfo {
  const sf = createSource(path, text);
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
    lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
  };
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const endLineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.end).line + 1;
  const bodyRefs = new Set<string>();

  const addDeclaration = (
    statement: ts.Statement,
    names: string[],
    kind: DeclarationKind,
    exported: boolean,
    isDefault: boolean,
    scope: ts.Node | undefined,
  ) => {
    const references = new Set<string>();
    if (scope) {
      collectReferences(scope, references);
      collectCalls(scope, names[0] ?? MODULE_BODY, info, lineOf);
    }
    for (const name of names) {
      references.delete(name);
      info.declarations.push({
        name,
        kind,
        exportedAs: exported ? [isDefault ? "default" : name] : [],
        references: [...references].sort(),
        line: lineOf(statement),
        endLine: endLineOf(statement),
        start: statement.getStart(sf),
        end: statement.end,
        statementSize: names.length,
        ...fingerprint(sf.text.slice(statement.getStart(sf), statement.end), sf.languageVariant),
      });
    }
  };

  for (const statement of sf.statements) {
    const mods = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const declared = ts.canHaveModifiers(statement) && mods.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

    if (ts.isImportDeclaration(statement)) {
      info.imports.push(importFromDeclaration(statement, lineOf(statement)));
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const ref = statement.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) {
        info.imports.push({
          kind: "require",
          specifier: ref.expression.text,
          bindings: [{ local: statement.name.text, imported: "*" }],
          typeOnly: statement.isTypeOnly,
          owner: MODULE_BODY,
          atLoad: true,
          line: lineOf(statement),
        });
      } else {
        addDeclaration(statement, [statement.name.text], "variable", exported, false, ref);
      }
    } else if (ts.isExportDeclaration(statement)) {
      handleExportDeclaration(statement, info, lineOf(statement));
    } else if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        info.localExports.push({ exported: "default", local: statement.expression.text });
      } else {
        addDeclaration(statement, ["default"], "expression", true, true, statement.expression);
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      if (!statement.body && !declared) continue; // overload signature
      addDeclaration(statement, [statement.name?.text ?? "default"], "function", exported, isDefault, statement);
    } else if (ts.isClassDeclaration(statement)) {
      addDeclaration(statement, [statement.name?.text ?? "default"], "class", exported, isDefault, statement);
    } else if (ts.isInterfaceDeclaration(statement)) {
      addDeclaration(statement, [statement.name.text], "interface", exported, isDefault, statement);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      addDeclaration(statement, [statement.name.text], "type", exported, false, statement);
    } else if (ts.isEnumDeclaration(statement)) {
      addDeclaration(statement, [statement.name.text], "enum", exported, false, statement);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === "global") {
      // `declare global { ... }` augments the global scope; it applies whenever the file is part of the program.
      collectReferences(statement, bodyRefs);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      addDeclaration(statement, [statement.name.text], "namespace", exported, false, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const names = bindingNames(decl.name);
        if (names.length === 0) continue;
        const req = decl.initializer && !exported ? requireCall(decl.initializer) : undefined;
        if (req !== undefined) {
          info.imports.push({
            kind: "require",
            specifier: req,
            bindings: requireBindings(decl.name),
            typeOnly: false,
            owner: MODULE_BODY,
            atLoad: true,
            line: lineOf(statement),
          });
          continue;
        }
        const scope = decl.initializer ?? decl.type;
        const before = info.declarations.length;
        addDeclaration(statement, names, "variable", exported, false, scope ? decl : undefined);
        const sideEffects = !!decl.initializer && callsAtLoad(decl.initializer);
        for (const d of info.declarations.slice(before)) {
          d.statementSize = countDeclarators(statement);
          if (sideEffects) d.sideEffects = true;
        }
      }
    } else {
      collectReferences(statement, bodyRefs);
      collectCalls(statement, MODULE_BODY, info, lineOf);
      if (isCommonJsExport(statement)) info.commonjs = true;
    }
  }

  // Exported names declared separately: `function a() {}; export { a as b }`.
  for (const exp of info.localExports) {
    const decl = info.declarations.find((d) => d.name === exp.local);
    if (decl && !decl.exportedAs.includes(exp.exported)) decl.exportedAs.push(exp.exported);
  }
  info.directives = collectDirectives(sf, text, info.declarations);
  info.jsx = sf.languageVariant === ts.LanguageVariant.JSX && containsJsx(sf);
  info.bodyReferences = [...bodyRefs].sort();
  info.hasUnresolvableDynamic = info.imports.some((i) => (i.kind === "dynamic" || i.kind === "require") && i.specifier === "");
  return info;
}

function importFromDeclaration(node: ts.ImportDeclaration, line: number): ImportRecord {
  const specifier = ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
  const clause = node.importClause;
  if (!clause) {
    return { kind: "side-effect", specifier, bindings: [], typeOnly: false, owner: MODULE_BODY, atLoad: true, line };
  }
  const bindings: ImportBinding[] = [];
  if (clause.name) bindings.push({ local: clause.name.text, imported: "default" });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.push({ local: named.name.text, imported: "*" });
  if (named && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      bindings.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text });
    }
  }
  const typeOnly =
    clause.isTypeOnly ||
    (!!named && ts.isNamedImports(named) && !clause.name && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
  return { kind: "static", specifier, bindings, typeOnly, owner: MODULE_BODY, atLoad: !typeOnly, line };
}

function handleExportDeclaration(node: ts.ExportDeclaration, info: ModuleInfo, line: number) {
  const clause = node.exportClause;
  if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const specifier = node.moduleSpecifier.text;
    if (!clause) {
      info.imports.push({ kind: "reexport-all", specifier, bindings: [], typeOnly: node.isTypeOnly, owner: MODULE_BODY, atLoad: !node.isTypeOnly, line });
      return;
    }
    const bindings: ImportBinding[] = ts.isNamespaceExport(clause)
      ? [{ local: clause.name.text, imported: "*" }]
      : clause.elements.map((el) => ({ local: el.name.text, imported: (el.propertyName ?? el.name).text }));
    info.imports.push({ kind: "reexport", specifier, bindings, typeOnly: node.isTypeOnly, owner: MODULE_BODY, atLoad: !node.isTypeOnly, line });
    return;
  }
  if (clause && ts.isNamedExports(clause)) {
    for (const el of clause.elements) {
      info.localExports.push({ exported: el.name.text, local: (el.propertyName ?? el.name).text });
    }
  }
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    out.push(...bindingNames(el.name));
  }
  return out;
}

function countDeclarators(statement: ts.VariableStatement): number {
  return statement.declarationList.declarations.reduce((n, d) => n + bindingNames(d.name).length, 0);
}

function requireCall(expr: ts.Expression): string | undefined {
  let node = expr;
  while (ts.isPropertyAccessExpression(node)) node = node.expression;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  ) {
    return (node.arguments[0] as ts.StringLiteral).text;
  }
  return undefined;
}

function requireBindings(name: ts.BindingName): ImportBinding[] {
  if (ts.isIdentifier(name)) return [{ local: name.text, imported: "*" }];
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((el) => {
      if (!ts.isIdentifier(el.name)) return [];
      const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      return [{ local: el.name.text, imported }];
    });
  }
  return [];
}

function isCommonJsExport(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
  const left = statement.expression.left.getText();
  return left === "module.exports" || left.startsWith("module.exports.") || left.startsWith("exports.");
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/** Record `import()` and `require()` calls found anywhere under `root`. */
function collectCalls(root: ts.Node, owner: string, info: ModuleInfo, lineOf: (n: ts.Node) => number) {
  const visit = (node: ts.Node, deferred: boolean) => {
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
      if (isImport || isRequire) {
        const arg = node.arguments[0];
        const record: ImportRecord = {
          kind: isImport ? "dynamic" : "require",
          specifier: "",
          bindings: [{ local: "", imported: "*" }],
          typeOnly: false,
          owner,
          atLoad: !deferred,
          line: lineOf(node),
        };
        if (arg && ts.isStringLiteralLike(arg)) record.specifier = arg.text;
        else if (arg && ts.isTemplateExpression(arg)) record.pattern = templatePattern(arg);
        info.imports.push(record);
      }
    }
    ts.forEachChild(node, (child) => visit(child, deferred || FUNCTION_LIKE.has(child.kind)));
  };
  visit(root, FUNCTION_LIKE.has(root.kind));
}

/** Turn `./locales/${lang}.json` into `./locales/*.json`. */
function templatePattern(node: ts.TemplateExpression): string | undefined {
  let out = node.head.text;
  for (const span of node.templateSpans) out += "*" + span.literal.text;
  return out.startsWith(".") ? out : undefined;
}

/**
 * Collect identifiers that may refer to top-level names. This is deliberately
 * approximate: it ignores shadowing, which can only make code look more live.
 */
export function collectReferences(root: ts.Node, out: Set<string>): void {
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (!isNonReferenceIdentifier(node)) out.add(node.text);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      out.add(node.name.text);
      if (node.objectAssignmentInitializer) visit(node.objectAssignmentInitializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function isNonReferenceIdentifier(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isQualifiedName(parent) && parent.right === id) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === id) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === id) return true;
  if (ts.isPropertySignature(parent) && parent.name === id) return true;
  if (ts.isMethodSignature(parent) && parent.name === id) return true;
  if (ts.isGetAccessor(parent) && parent.name === id) return true;
  if (ts.isSetAccessor(parent) && parent.name === id) return true;
  if (ts.isEnumMember(parent) && parent.name === id) return true;
  if (ts.isJsxAttribute(parent) && parent.name === id) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return true;
  if (ts.isParameter(parent) && parent.name === id) return true;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === id) return true;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === id
  ) {
    return true;
  }
  return false;
}

const DIRECTIVE = /loose-ends(-file)?:\s*(entry|dormant|ignore)\b(.*)/;

/** Parse the text of one comment line as a directive. */
export function parseDirective(text: string): { file: boolean; action: DirectiveAction; kind?: string; reason: string } | undefined {
  const match = DIRECTIVE.exec(text);
  if (!match) return undefined;
  const action = match[2] as DirectiveAction;
  let rest = (match[3] ?? "").trim();
  let kind: string | undefined;
  if (action === "ignore") {
    const first = rest.split(/\s+/)[0] ?? "";
    if ((FINDING_KINDS as readonly string[]).includes(first)) {
      kind = first;
      rest = rest.slice(first.length).trim();
    }
  }
  return { file: !!match[1], action, kind, reason: rest.replace(/^[-:\u2013\u2014]\s*/, "").trim() };
}

function collectDirectives(sf: ts.SourceFile, text: string, declarations: Declaration[]): Directive[] {
  const out: Directive[] = [];
  const seen = new Set<number>();
  const anchors: Array<{ pos: number; statement?: ts.Statement }> = sf.statements.map((statement) => ({ pos: statement.getFullStart(), statement }));
  anchors.push({ pos: sf.endOfFileToken.getFullStart() });
  for (const anchor of anchors) {
    const ranges = ts.getLeadingCommentRanges(text, anchor.pos) ?? [];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = text.slice(range.pos, range.end);
      for (const rawLine of comment.split(/\r?\n/)) {
        const cleaned = rawLine.replace(/^\s*(\/\/+|\/\*+|\*+)/, "").replace(/\*+\/\s*$/, "");
        const parsed = parseDirective(cleaned);
        if (!parsed) continue;
        const scope = parsed.file || !anchor.statement ? "file" : "declaration";
        const { action, kind, reason } = parsed;
        const symbols =
          scope === "declaration" && anchor.statement
            ? declarations.filter((d) => d.start === anchor.statement!.getStart(sf)).map((d) => d.name)
            : [];
        out.push({ scope, action, kind, reason, line: sf.getLineAndCharacterOfPosition(range.pos).line + 1, symbols });
      }
    }
  }
  return out;
}

const SHINGLE = 4;

/**
 * Normalize a declaration's tokens (identifiers and literals collapse to
 * placeholders) and hash overlapping 4-token windows. Two implementations of
 * the same logic share most shingles even after renames.
 */
export function fingerprint(text: string, variant: ts.LanguageVariant = ts.LanguageVariant.Standard): { shape: number[]; tokens: number; literals: number } {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, text);
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier) tokens.push("$i");
    else if (
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NumericLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.BigIntLiteral
    )
      tokens.push("$l");
    else tokens.push(String(kind));
  }
  return shingles(tokens);
}

/** Hash overlapping windows of normalized tokens into a structural fingerprint. */
export function shingles(tokens: string[]): { shape: number[]; tokens: number; literals: number } {
  const shape = new Set<number>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) shape.add(fnv(tokens.slice(i, i + SHINGLE).join(" ")));
  if (tokens.length > 0 && tokens.length < SHINGLE) shape.add(fnv(tokens.join(" ")));
  return { shape: [...shape].sort((a, b) => a - b), tokens: tokens.length, literals: tokens.filter((t) => t === "$l").length };
}

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, containsJsx) ?? false;
}

/** Whether an initializer's outermost expression is a call (`register({...})`, `new Map()`, tagged templates). */
function callsAtLoad(expr: ts.Expression): boolean {
  let node: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) {
      node = node.expression;
      continue;
    }
    break;
  }
  if (ts.isCallExpression(node)) {
    // Pure wrappers that only build values do not need to run for their side effects.
    const callee = node.expression.getText();
    return !/^(Object\.freeze|Symbol|String|Number|Boolean|BigInt|Array\.from|Object\.fromEntries|Object\.assign|z\.|v\.|t\.|Type\.)/.test(callee) && !/^(memo|forwardRef|React\.memo|React\.forwardRef|lazy|React\.lazy|createContext|React\.createContext|styled)\b/.test(callee);
  }
  return ts.isNewExpression(node);
}
