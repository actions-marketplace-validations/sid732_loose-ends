/**
 * A small Python tokenizer. It produces the tokens Loose Ends needs (names,
 * operators, strings, numbers) grouped into logical lines with their
 * indentation, and keeps comments for directives. It does not validate syntax.
 */

export type TokenKind = "name" | "op" | "string" | "number";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  /** 1-based line. */
  line: number;
  /** Bracket depth before this token. */
  depth: number;
  /** For f-strings: the source of each `{...}` replacement field. */
  fields?: string[];
  /** For strings: the decoded body (no prefix or quotes, escapes left as written). */
  body?: string;
}

export interface LogicalLine {
  tokens: Token[];
  /** Indentation width of the first physical line. */
  indent: number;
  line: number;
  endLine: number;
  start: number;
  end: number;
}

export interface Comment {
  text: string;
  line: number;
  start: number;
  /** The comment is alone on its line. */
  own: boolean;
}

export interface Tokenized {
  lines: LogicalLine[];
  comments: Comment[];
  lineCount: number;
}

const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y;
const OPERATORS = ["**=", "//=", ">>=", "<<=", "...", "->", ":=", "==", "!=", "<=", ">=", "**", "//", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@="];
const STRING_PREFIX = /^(?:[rRbBuUfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;

export function tokenize(text: string): Tokenized {
  const lines: LogicalLine[] = [];
  const comments: Comment[] = [];
  let pos = 0;
  let line = 1;
  let depth = 0;
  let current: Token[] = [];
  let indent = 0;
  let atLineStart = true;
  let lineHasCode = false;

  const finish = () => {
    if (current.length) {
      const first = current[0]!;
      const last = current[current.length - 1]!;
      let endLine = first.line;
      for (let i = first.start; i < last.end; i++) if (text.charCodeAt(i) === 10) endLine++;
      lines.push({ tokens: current, indent, line: first.line, endLine, start: first.start, end: last.end });
    }
    current = [];
    depth = 0;
  };

  while (pos < text.length) {
    if (atLineStart && depth === 0 && current.length === 0) {
      let width = 0;
      while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\f")) {
        width = text[pos] === "\t" ? (Math.floor(width / 8) + 1) * 8 : text[pos] === "\f" ? 0 : width + 1;
        pos++;
      }
      indent = width;
      atLineStart = false;
      lineHasCode = false;
      continue;
    }
    const ch = text[pos]!;
    if (ch === "\n" || ch === "\r") {
      pos += ch === "\r" && text[pos + 1] === "\n" ? 2 : 1;
      line++;
      if (depth === 0) finish();
      atLineStart = true;
      lineHasCode = false;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\f") {
      pos++;
      continue;
    }
    if (ch === "#") {
      let stop = text.indexOf("\n", pos);
      if (stop === -1) stop = text.length;
      const body = text.slice(pos, stop).replace(/\r$/, "");
      comments.push({ text: body, line, start: pos, own: !lineHasCode && current.length === 0 });
      pos = stop;
      continue;
    }
    if (ch === "\\" && (text[pos + 1] === "\n" || text[pos + 1] === "\r")) {
      pos += text[pos + 1] === "\r" && text[pos + 2] === "\n" ? 3 : 2;
      line++;
      continue;
    }
    lineHasCode = true;

    NAME.lastIndex = pos;
    const name = NAME.exec(text);
    if (name) {
      const word = name[0];
      const quote = text[pos + word.length];
      if ((quote === '"' || quote === "'") && STRING_PREFIX.test(word)) {
        const tok = readString(text, pos, pos + word.length, word, line, depth);
        current.push(tok.token);
        line += tok.newlines;
        pos = tok.token.end;
        continue;
      }
      current.push({ kind: "name", value: word, start: pos, end: pos + word.length, line, depth });
      pos += word.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const tok = readString(text, pos, pos, "", line, depth);
      current.push(tok.token);
      line += tok.newlines;
      pos = tok.token.end;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[pos + 1] ?? ""))) {
      NUMBER.lastIndex = pos;
      const num = NUMBER.exec(text);
      const value = num && num[0] ? num[0] : ch;
      current.push({ kind: "number", value, start: pos, end: pos + value.length, line, depth });
      pos += value.length;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, pos)) ?? ch;
    if (op === "(" || op === "[" || op === "{") {
      current.push({ kind: "op", value: op, start: pos, end: pos + 1, line, depth });
      depth++;
      pos++;
      continue;
    }
    if (op === ")" || op === "]" || op === "}") {
      depth = Math.max(0, depth - 1);
      current.push({ kind: "op", value: op, start: pos, end: pos + 1, line, depth });
      pos++;
      continue;
    }
    if (op === ";" && depth === 0) {
      // `a = 1; b = 2` is two statements on one line.
      const keepIndent = indent;
      finish();
      indent = keepIndent;
      pos++;
      continue;
    }
    current.push({ kind: "op", value: op, start: pos, end: pos + op.length, line, depth });
    pos += op.length;
  }
  finish();
  return { lines, comments, lineCount: line };
}

function readString(text: string, start: number, quotePos: number, prefix: string, line: number, depth: number): { token: Token; newlines: number } {
  const quote = text[quotePos]!;
  const triple = text.startsWith(quote.repeat(3), quotePos);
  const delim = triple ? quote.repeat(3) : quote;
  const formatted = /[fFtT]/.test(prefix);
  let pos = quotePos + delim.length;
  const bodyStart = pos;
  const fields: string[] = [];
  let newlines = 0;
  let bodyEnd = text.length;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === "\\") {
      // Even in raw strings a backslash keeps the next quote from closing the string.
      if (text[pos + 1] === "\n") newlines++;
      pos += 2;
      continue;
    }
    if (text.startsWith(delim, pos)) {
      bodyEnd = pos;
      pos += delim.length;
      break;
    }
    if (ch === "\n") {
      newlines++;
      if (!triple) {
        // Unterminated single-quoted string: stop at the line end.
        bodyEnd = pos;
        break;
      }
    }
    if (formatted && ch === "{") {
      if (text[pos + 1] === "{") {
        pos += 2;
        continue;
      }
      const field = readField(text, pos + 1, delim);
      fields.push(text.slice(pos + 1, field.end));
      newlines += field.newlines;
      pos = field.end + 1;
      continue;
    }
    pos++;
  }
  const end = Math.min(pos, text.length);
  return {
    token: { kind: "string", value: text.slice(start, end), start, end, line, depth, fields: fields.length ? fields : undefined, body: text.slice(bodyStart, bodyEnd) },
    newlines,
  };
}

/** Find the `}` that closes an f-string replacement field, skipping nested brackets and strings. */
function readField(text: string, pos: number, delim: string): { end: number; newlines: number } {
  let depth = 0;
  let newlines = 0;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === "\n") newlines++;
    if (text.startsWith(delim, pos) && delim.length === 1) return { end: pos, newlines };
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, pos + 1);
      if (close === -1) return { end: text.length, newlines };
      pos = close + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") {
      if (depth === 0) return { end: pos, newlines };
      depth--;
    }
    pos++;
  }
  return { end: text.length, newlines };
}

export const KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
