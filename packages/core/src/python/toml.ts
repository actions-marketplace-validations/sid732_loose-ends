/**
 * A forgiving TOML reader for pyproject.toml and Pipfile. It supports tables,
 * arrays of tables, dotted and quoted keys, strings, arrays, and inline
 * tables. Other values are kept as raw text. Malformed input returns what was
 * read before the error.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const reader = new Reader(text);
  let table = root;
  try {
    for (;;) {
      reader.skipBlank();
      if (reader.done()) break;
      if (reader.peek() === "[") {
        const array = reader.text.startsWith("[[", reader.pos);
        reader.pos += array ? 2 : 1;
        const keys = reader.keyPath();
        reader.expect(array ? "]]" : "]");
        table = array ? appendTable(root, keys) : ensureTable(root, keys);
        continue;
      }
      const keys = reader.keyPath();
      reader.expect("=");
      const value = reader.value();
      const parent = ensureTable(table, keys.slice(0, -1));
      parent[keys[keys.length - 1]!] = value;
    }
  } catch {
    // Keep what was parsed.
  }
  return root;
}

function ensureTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let node = root;
  for (const key of keys) {
    let next = node[key];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!next || typeof next !== "object") {
      next = {};
      node[key] = next;
    }
    node = next as Record<string, unknown>;
  }
  return node;
}

function appendTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const parent = ensureTable(root, keys.slice(0, -1));
  const key = keys[keys.length - 1]!;
  const list = Array.isArray(parent[key]) ? (parent[key] as unknown[]) : [];
  parent[key] = list;
  const table = {};
  list.push(table);
  return table;
}

class Reader {
  pos = 0;
  constructor(readonly text: string) {}

  done(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos] ?? "";
  }

  /** Skip whitespace, newlines, and comments. */
  skipBlank(): void {
    while (!this.done()) {
      const ch = this.peek();
      if (ch === "#") {
        const stop = this.text.indexOf("\n", this.pos);
        this.pos = stop === -1 ? this.text.length : stop;
      } else if (/\s/.test(ch)) this.pos++;
      else break;
    }
  }

  private skipInline(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  expect(token: string): void {
    this.skipInline();
    if (!this.text.startsWith(token, this.pos)) throw new Error(`expected ${token} at ${this.pos}`);
    this.pos += token.length;
  }

  keyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipInline();
      const ch = this.peek();
      if (ch === '"' || ch === "'") keys.push(this.string());
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos, this.pos + 256));
        if (!match) throw new Error(`bad key at ${this.pos}`);
        keys.push(match[0]);
        this.pos += match[0].length;
      }
      this.skipInline();
      if (this.peek() !== ".") return keys;
      this.pos++;
    }
  }

  value(): unknown {
    this.skipInline();
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === "[") {
      this.pos++;
      const out: unknown[] = [];
      for (;;) {
        this.skipBlank();
        if (this.peek() === "]") {
          this.pos++;
          return out;
        }
        out.push(this.value());
        this.skipBlank();
        if (this.peek() === ",") this.pos++;
        else if (this.peek() !== "]") throw new Error(`bad array at ${this.pos}`);
      }
    }
    if (ch === "{") {
      this.pos++;
      const out: Record<string, unknown> = {};
      for (;;) {
        this.skipBlank();
        if (this.peek() === "}") {
          this.pos++;
          return out;
        }
        const keys = this.keyPath();
        this.expect("=");
        ensureTable(out, keys.slice(0, -1))[keys[keys.length - 1]!] = this.value();
        this.skipBlank();
        if (this.peek() === ",") this.pos++;
      }
    }
    const match = /^[^,\]}\n#]+/.exec(this.text.slice(this.pos, this.pos + 256));
    if (!match) throw new Error(`bad value at ${this.pos}`);
    this.pos += match[0].length;
    const raw = match[0].trim();
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }

  string(): string {
    const quote = this.peek();
    const triple = this.text.startsWith(quote.repeat(3), this.pos);
    const delim = triple ? quote.repeat(3) : quote;
    this.pos += delim.length;
    if (triple && this.peek() === "\n") this.pos++;
    let out = "";
    while (!this.done()) {
      if (this.text.startsWith(delim, this.pos)) {
        this.pos += delim.length;
        return out;
      }
      const ch = this.peek();
      if (ch === "\\" && quote === '"') {
        const next = this.text[this.pos + 1] ?? "";
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        this.pos += 2;
        continue;
      }
      if (ch === "\n" && !triple) throw new Error("unterminated string");
      out += ch;
      this.pos++;
    }
    return out;
  }
}
