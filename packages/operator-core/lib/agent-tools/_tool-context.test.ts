/**
 * _tool-context.ts — compile-time guard for the EI-10968 fix.
 *
 * These are TYPE assertions, not runtime behavior: the whole point of
 * `PapercuspToolContext` / `PapercuspUnifiedToolContext` is that `ctx.tx<T>`
 * actually binds `T` instead of silently discarding it (see the file doc). A
 * runtime test can't observe that — a future edit that widens `tx` back to
 * `any` would still pass every runtime assertion while quietly re-opening the
 * bug. So this file is deliberately `// @ts-expect-error`-driven: it fails
 * `npm run typecheck` (not `npm test`) if the binding regresses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import type { PapercuspToolContext, PapercuspUnifiedToolContext } from './_tool-context';

interface Row {
  id: string;
  count: number;
}

const REPO_ROOT = join(import.meta.dirname, '../../../..');

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function untypedGenericCtxTxUses(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const failures: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && Boolean(node.typeArguments?.length)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'ctx'
      && node.expression.name.text === 'tx'
    ) {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !isFunctionLikeNode(owner)) owner = owner.parent;
      const ctxParam = owner && isFunctionLikeNode(owner)
        ? owner.parameters.find((param) => ts.isIdentifier(param.name) && param.name.text === 'ctx')
        : undefined;
      if (!ctxParam?.type) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${relative(REPO_ROOT, file)}:${line + 1}:${character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return failures;
}

describe('_tool-context — ctx.tx<T> actually binds T (EI-10968)', () => {
  it('rejects generic ctx.tx calls whose containing ctx parameter is untyped', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'packages/operator-core/lib/agent-tools')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages/agent-mcp/src')),
    ];
    const failures = files.flatMap(untypedGenericCtxTxUses);
    expect(failures, 'Annotate ctx with a Papercusp context alias before using ctx.tx<T>').toEqual([]);
  });

  it('PapercuspUnifiedToolContext: ctx.tx<Row[]> types the awaited result as Row[], not any', () => {
    async function _typeOnly(ctx: PapercuspUnifiedToolContext) {
      const rows = await ctx.tx!<Row[]>`SELECT 1`;
      // If `tx`'s type argument were decorative (the EI-10968 bug), `rows` would be
      // `any` and this `.map` callback param `r` would ALSO be `any` — no error. With
      // the fix, `r` is `Row`, so a bad property access is a compile error.
      const ids = rows.map((r) => r.id);
      // @ts-expect-error — `nope` is not a field of Row; this must still error under the fix.
      const _bad = rows.map((r) => r.nope);
      return { ids, _bad };
    }
    void _typeOnly;
    expect(true).toBe(true);
  });

  it('PapercuspToolContext: ctx.tx<Row[]> types the awaited result as Row[], not any', () => {
    async function _typeOnly(ctx: PapercuspToolContext) {
      const rows = await ctx.tx!<Row[]>`SELECT 1`;
      const ids = rows.map((r) => r.id);
      // @ts-expect-error — same guard as above, for the principal-gated alias.
      const _bad = rows.map((r) => r.nope);
      return { ids, _bad };
    }
    void _typeOnly;
    expect(true).toBe(true);
  });
});
