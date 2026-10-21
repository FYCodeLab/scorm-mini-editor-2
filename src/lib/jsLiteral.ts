/**
 * Minimal, position-aware parser for JavaScript literal values
 * (objects, arrays, strings, numbers, booleans, null).
 * It does NOT evaluate code. Template literals and function calls are
 * treated as opaque spans and are never offered as editable strings.
 * Every string node records the offsets of its *content* (inside the quotes)
 * so an edit can replace exactly that literal, in place, without touching
 * surrounding code, scoring keys or logic.
 */
export type JsNode =
  | { kind: "string"; value: string; start: number; end: number; quote: "'" | '"' }
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "boolean"; value: boolean; start: number; end: number }
  | { kind: "null"; start: number; end: number }
  | { kind: "opaque"; start: number; end: number }
  | { kind: "array"; items: JsNode[]; start: number; end: number }
  | { kind: "object"; entries: { key: string; keyNode: JsNode | null; value: JsNode }[]; start: number; end: number };

export class JsLiteralParser {
  private pos = 0;
  private input: string;
  constructor(input: string) { this.input = input; }

  private skipWs() {
    for (;;) {
      while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) this.pos++;
      if (this.input.startsWith("//", this.pos)) {
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") this.pos++;
        continue;
      }
      if (this.input.startsWith("/*", this.pos)) {
        const end = this.input.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? this.input.length : end + 2;
        continue;
      }
      break;
    }
  }

  private peek() { return this.input[this.pos]; }

  parseValue(): JsNode {
    this.skipWs();
    const start = this.pos;
    const ch = this.peek();
    if (ch === "'" || ch === '"') return this.parseString();
    if (ch === "[") return this.parseArray();
    if (ch === "{") return this.parseObject();
    if (ch === "`") return this.parseTemplate();
    if (/[0-9-]/.test(ch)) {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.pos));
      if (m) { this.pos += m[0].length; return { kind: "number", value: Number(m[0]), start, end: this.pos }; }
    }
    if (this.input.startsWith("true", this.pos)) { this.pos += 4; return { kind: "boolean", value: true, start, end: this.pos }; }
    if (this.input.startsWith("false", this.pos)) { this.pos += 5; return { kind: "boolean", value: false, start, end: this.pos }; }
    if (this.input.startsWith("null", this.pos)) { this.pos += 4; return { kind: "null", start, end: this.pos }; }
    // Anything else (identifier, call, expression): opaque span until , } ] or ;
    let depth = 0;
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === "," || c === ";")) break;
      this.pos++;
    }
    return { kind: "opaque", start, end: this.pos };
  }

  parseString(): JsNode {
    const quote = this.input[this.pos] as "'" | '"';
    this.pos++;
    const start = this.pos;
    let value = "";
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c === "\\") {
        const n = this.input[this.pos + 1];
        const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
        if (n === "u" && this.input[this.pos + 2] === "{") {
          const close = this.input.indexOf("}", this.pos + 3);
          value += String.fromCodePoint(parseInt(this.input.slice(this.pos + 3, close), 16));
          this.pos = close + 1;
        } else if (n === "u") {
          value += String.fromCharCode(parseInt(this.input.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else if (n !== undefined && n in map) { value += map[n]; this.pos += 2; }
        else if (n !== undefined) { value += n; this.pos += 2; }
        else this.pos++;
        continue;
      }
      if (c === quote) { const end = this.pos; this.pos++; return { kind: "string", value, start, end, quote }; }
      if (c === "\n") break;
      value += c; this.pos++;
    }
    return { kind: "string", value, start, end: this.pos, quote };
  }

  private parseTemplate(): JsNode {
    const start = this.pos;
    this.pos++;
    let depth = 0;
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c === "\\") { this.pos += 2; continue; }
      if (c === "`" && depth === 0) { this.pos++; break; }
      if (c === "$" && this.input[this.pos + 1] === "{") { depth++; this.pos += 2; continue; }
      if (c === "}" && depth > 0) depth--;
      this.pos++;
    }
    return { kind: "opaque", start, end: this.pos };
  }

  private parseArray(): JsNode {
    const start = this.pos; this.pos++;
    const items: JsNode[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === "]") { this.pos++; break; }
      if (this.pos >= this.input.length) break;
      const before = this.pos;
      items.push(this.parseValue());
      if (this.pos === before) this.pos++; // Never loop without progress.
      this.skipWs();
      if (this.peek() === ",") this.pos++;
    }
    return { kind: "array", items, start, end: this.pos };
  }

  private parseObject(): JsNode {
    const start = this.pos; this.pos++;
    const entries: { key: string; keyNode: JsNode | null; value: JsNode }[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === "}") { this.pos++; break; }
      if (this.pos >= this.input.length) break;
      let keyNode: JsNode | null = null;
      let key = "";
      const ch = this.peek();
      const beforeKey = this.pos;
      if (ch === "'" || ch === '"') { const n = this.parseString(); keyNode = n; key = n.kind === "string" ? n.value : ""; }
      else {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.input.slice(this.pos));
        if (m) { key = m[0]; this.pos += m[0].length; }
        else if (/[0-9-]/.test(ch)) { const n = this.parseValue(); keyNode = n; key = n.kind === "number" ? String(n.value) : ""; }
        else { this.pos++; continue; } // Skip a stray separator instead of looping forever.
      }
      if (this.pos === beforeKey) { this.pos++; continue; }
      this.skipWs();
      if (this.peek() === ":") this.pos++;
      const value = this.parseValue();
      entries.push({ key, keyNode, value });
      this.skipWs();
      if (this.peek() === ",") this.pos++;
    }
    return { kind: "object", entries, start, end: this.pos };
  }
}

/** Find `const NAME = <literal>` in source and parse the literal. Returns null if absent/unparseable. */
export function findConstLiteral(source: string, name: string): { node: JsNode; valueStart: number } | null {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
  const m = re.exec(source);
  if (!m) return null;
  const parser = new JsLiteralParser(source.slice(m.index + m[0].length));
  // Parser positions are relative to the sliced string; shift them back.
  const node = parser.parseValue();
  const shift = m.index + m[0].length;
  const shiftNode = (n: JsNode): JsNode => {
    if (n.kind === "array") return { ...n, start: n.start + shift, end: n.end + shift, items: n.items.map(shiftNode) };
    if (n.kind === "object") return { ...n, start: n.start + shift, end: n.end + shift, entries: n.entries.map((e) => ({ ...e, value: shiftNode(e.value), keyNode: e.keyNode ? shiftNode(e.keyNode) : null })) };
    return { ...n, start: n.start + shift, end: n.end + shift } as JsNode;
  };
  return { node: shiftNode(node), valueStart: shift };
}

export function getField(obj: JsNode, key: string): JsNode | undefined {
  if (obj.kind !== "object") return undefined;
  return obj.entries.find((e) => e.key === key)?.value;
}

export function str(node: JsNode | undefined): string | null {
  return node && node.kind === "string" ? node.value : null;
}
