// =============================================================================
// Tanzen DSL Compiler — Public API
// =============================================================================

import { lex, LexError } from "./lexer.ts";
import { parse, ParseError } from "./parser.ts";
import { analyze } from "./semantic.ts";
import { emit } from "./emitter.ts";
import type { CompileResult, CompileError } from "./types.ts";
import type { ScriptRegistry } from "./semantic.ts";

export { lex, parse, analyze, emit };
export type { CompileResult, CompileError, ScriptRegistry };

export function compile(source: string, scriptRegistry?: ScriptRegistry): CompileResult {
  // Lex
  let tokens;
  try {
    tokens = lex(source);
  } catch (e) {
    if (e instanceof LexError) {
      return {
        ok: false,
        errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }],
      };
    }
    throw e;
  }

  // Parse
  let ast;
  try {
    ast = parse(tokens);
  } catch (e) {
    if (e instanceof ParseError) {
      return {
        ok: false,
        errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }],
      };
    }
    throw e;
  }

  // Semantic analysis
  const errors = analyze(ast, scriptRegistry);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Emit IR
  const ir = emit(ast, scriptRegistry);
  return { ok: true, ir };
}
