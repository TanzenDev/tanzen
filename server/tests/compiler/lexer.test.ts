import { describe, it, expect } from "bun:test";
import { lex, LexError } from "../../src/compiler/lexer.ts";

describe("lexer", () => {
  it("tokenizes keywords", () => {
    const tokens = lex("workflow step parallel gate output params for in when manual webhook");
    const kinds = tokens.slice(0, -1).map(t => t.value);
    expect(kinds).toEqual([
      "workflow", "step", "parallel", "gate", "output",
      "params", "for", "in", "when", "manual", "webhook",
    ]);
    // All should be IDENT kind (keywords share IDENT kind)
    tokens.slice(0, -1).forEach(t => expect(t.kind).toBe("IDENT"));
  });

  it("tokenizes string literals", () => {
    const tokens = lex('"hello world"');
    expect(tokens[0]).toMatchObject({ kind: "STRING", value: "hello world" });
  });

  it("tokenizes number literals", () => {
    const tokens = lex("42 0 100");
    expect(tokens[0]).toMatchObject({ kind: "NUMBER", value: "42" });
    expect(tokens[1]).toMatchObject({ kind: "NUMBER", value: "0" });
  });

  it("tokenizes duration literals", () => {
    const tokens = lex("72h 30m 7d 60s");
    expect(tokens[0]).toMatchObject({ kind: "DURATION", value: "72h" });
    expect(tokens[1]).toMatchObject({ kind: "DURATION", value: "30m" });
    expect(tokens[2]).toMatchObject({ kind: "DURATION", value: "7d" });
    expect(tokens[3]).toMatchObject({ kind: "DURATION", value: "60s" });
  });

  it("tokenizes punctuation", () => {
    const tokens = lex("{ } [ ] ( ) : , . @ =");
    const kinds = tokens.slice(0, -1).map(t => t.kind);
    expect(kinds).toEqual([
      "LBRACE", "RBRACE", "LBRACKET", "RBRACKET",
      "LPAREN", "RPAREN", "COLON", "COMMA", "DOT", "AT", "EQUALS",
    ]);
  });

  it("tokenizes DOLLAR_BRACE", () => {
    const tokens = lex("${");
    expect(tokens[0]).toMatchObject({ kind: "DOLLAR_BRACE", value: "${" });
  });

  it("handles kebab-case identifiers", () => {
    const tokens = lex("document-parser my-agent-v2");
    expect(tokens[0]).toMatchObject({ kind: "IDENT", value: "document-parser" });
    expect(tokens[1]).toMatchObject({ kind: "IDENT", value: "my-agent-v2" });
  });

  it("skips line comments", () => {
    const tokens = lex("foo // this is a comment\nbar");
    const values = tokens.slice(0, -1).map(t => t.value);
    expect(values).toEqual(["foo", "bar"]);
  });

  it("skips block comments", () => {
    const tokens = lex("foo /* this is a block comment */ bar");
    const values = tokens.slice(0, -1).map(t => t.value);
    expect(values).toEqual(["foo", "bar"]);
  });

  it("tracks line and column numbers", () => {
    const tokens = lex("foo\nbar");
    expect(tokens[0]).toMatchObject({ line: 1, col: 1 });
    expect(tokens[1]).toMatchObject({ line: 2, col: 1 });
  });

  it("ends with EOF", () => {
    const tokens = lex("foo");
    expect(tokens[tokens.length - 1]!.kind).toBe("EOF");
  });

  it("throws LexError on unterminated string", () => {
    expect(() => lex('"unterminated')).toThrow(LexError);
  });

  it("throws LexError on unexpected character", () => {
    expect(() => lex("foo # bar")).toThrow(LexError);
  });

  it("tokenizes dotted references correctly", () => {
    // DOT is a separate token; the parser assembles refs
    const tokens = lex("run.input");
    expect(tokens[0]).toMatchObject({ kind: "IDENT", value: "run" });
    expect(tokens[1]).toMatchObject({ kind: "DOT" });
    expect(tokens[2]).toMatchObject({ kind: "IDENT", value: "input" });
  });
});
