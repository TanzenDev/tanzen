// =============================================================================
// Tanzen DSL Compiler — Public API
// =============================================================================

import { lex, LexError } from "./lexer.ts";
import { parse, parseBundle, ParseError } from "./parser.ts";
import { analyze, analyzeBundle } from "./semantic.ts";
import { emit, emitBundle } from "./emitter.ts";
import type { CompileResult, CompileError, BundleCompileResult } from "./types.ts";
import type { ScriptRegistry } from "./semantic.ts";

export { lex, parse, parseBundle, analyze, analyzeBundle, emit, emitBundle };
export type { CompileResult, CompileError, BundleCompileResult, ScriptRegistry };

export function compile(source: string, scriptRegistry?: ScriptRegistry): CompileResult {
  let tokens;
  try {
    tokens = lex(source);
  } catch (e) {
    if (e instanceof LexError) {
      return { ok: false, errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }] };
    }
    throw e;
  }

  let ast;
  try {
    ast = parse(tokens);
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }] };
    }
    throw e;
  }

  const errors = analyze(ast, scriptRegistry);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, ir: emit(ast, scriptRegistry) };
}

export function compileBundle(source: string, scriptRegistry?: ScriptRegistry): BundleCompileResult {
  let tokens;
  try {
    tokens = lex(source);
  } catch (e) {
    if (e instanceof LexError) {
      return { ok: false, errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }] };
    }
    throw e;
  }

  let bundle;
  try {
    bundle = parseBundle(tokens);
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, errors: [{ line: e.line, column: e.col, message: e.message, severity: "error" }] };
    }
    throw e;
  }

  const errors = analyzeBundle(bundle, scriptRegistry);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, bundle: emitBundle(bundle, scriptRegistry) };
}
