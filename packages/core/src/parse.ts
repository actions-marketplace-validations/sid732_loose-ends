import ts from "typescript";
import { FINDING_KINDS } from "./config.js";

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
  /** Number of source lines. */
  lines: number;
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
        for (const d of info.declarations.slice(before)) d.statementSize = countDeclarators(statement);
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
        const match = DIRECTIVE.exec(cleaned);
        if (!match) continue;
        const scope = match[1] || !anchor.statement ? "file" : "declaration";
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
        const reason = rest.replace(/^[-:\u2013\u2014]\s*/, "").trim();
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
