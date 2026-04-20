// =============================================================================
// Tanzen DSL Compiler — Lexer
// Converts DSL source text into a flat token stream with line/column tracking.
// =============================================================================

export type TokenKind =
  // Literals
  | "STRING"      // "hello"
  | "NUMBER"      // 42
  | "DURATION"    // 72h, 30m, 7d, 60s
  | "IDENT"       // identifier or keyword
  // Punctuation
  | "LBRACE"      // {
  | "RBRACE"      // }
  | "LBRACKET"    // [
  | "RBRACKET"    // ]
  | "LPAREN"      // (
  | "RPAREN"      // )
  | "COLON"       // :
  | "COMMA"       // ,
  | "DOT"         // .
  | "AT"          // @
  | "EQUALS"      // =
  | "DOLLAR_BRACE" // ${
  // Special
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "workflow", "step", "task", "parallel", "gate", "output", "script",
  "params", "for", "in", "when", "manual", "webhook",
  "string", "number", "boolean",
]);

export class LexError extends Error {
  constructor(public line: number, public col: number, msg: string) {
    super(msg);
  }
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  function advance(): string {
    const ch = source[pos++]!;
    if (ch === "\n") { line++; col = 1; } else { col++; }
    return ch;
  }

  function peek(offset = 0): string {
    return source[pos + offset] ?? "";
  }

  function match(s: string): boolean {
    if (source.startsWith(s, pos)) {
      for (let i = 0; i < s.length; i++) advance();
      return true;
    }
    return false;
  }

  while (pos < source.length) {
    // Skip whitespace
    if (/\s/.test(peek())) { advance(); continue; }

    // Skip line comments
    if (peek() === "/" && peek(1) === "/") {
      while (pos < source.length && peek() !== "\n") advance();
      continue;
    }

    // Skip block comments
    if (peek() === "/" && peek(1) === "*") {
      advance(); advance();
      while (pos < source.length) {
        if (peek() === "*" && peek(1) === "/") { advance(); advance(); break; }
        advance();
      }
      continue;
    }

    const tokLine = line;
    const tokCol = col;

    // Template expression start: ${
    if (peek() === "$" && peek(1) === "{") {
      advance(); advance();
      tokens.push({ kind: "DOLLAR_BRACE", value: "${", line: tokLine, col: tokCol });
      continue;
    }

    // String literal
    if (peek() === '"') {
      advance(); // consume opening quote
      let value = "";
      while (pos < source.length && peek() !== '"') {
        if (peek() === "\n") throw new LexError(line, col, "Unterminated string literal");
        value += advance();
      }
      if (pos >= source.length) throw new LexError(tokLine, tokCol, "Unterminated string literal");
      advance(); // consume closing quote
      tokens.push({ kind: "STRING", value, line: tokLine, col: tokCol });
      continue;
    }

    // Number or Duration: digits optionally followed by h/m/s/d
    if (/[0-9]/.test(peek())) {
      let raw = "";
      while (/[0-9]/.test(peek())) raw += advance();
      if (/[hmsd]/.test(peek())) {
        raw += advance();
        tokens.push({ kind: "DURATION", value: raw, line: tokLine, col: tokCol });
      } else {
        tokens.push({ kind: "NUMBER", value: raw, line: tokLine, col: tokCol });
      }
      continue;
    }

    // Identifier or keyword: starts with letter or underscore, may contain - (kebab for agent names)
    if (/[a-zA-Z_]/.test(peek())) {
      let name = "";
      while (/[a-zA-Z0-9_-]/.test(peek())) name += advance();
      tokens.push({ kind: "IDENT", value: name, line: tokLine, col: tokCol });
      continue;
    }

    // Single-character tokens
    const single: Record<string, TokenKind> = {
      "{": "LBRACE", "}": "RBRACE",
      "[": "LBRACKET", "]": "RBRACKET",
      "(": "LPAREN", ")": "RPAREN",
      ":": "COLON", ",": "COMMA",
      ".": "DOT", "@": "AT", "=": "EQUALS",
    };
    const ch = peek();
    if (ch in single) {
      advance();
      tokens.push({ kind: single[ch]!, value: ch, line: tokLine, col: tokCol });
      continue;
    }

    throw new LexError(tokLine, tokCol, `Unexpected character: '${ch}'`);
  }

  tokens.push({ kind: "EOF", value: "", line, col });
  return tokens;
}
