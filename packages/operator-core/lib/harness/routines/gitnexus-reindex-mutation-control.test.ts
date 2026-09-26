import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The mutation probe supplies a relocated source copy through this variable. The
 * ordinary suite reads the canonical file, so the same assertions guard CI.
 */
function subjectFunctions(names: string[]): Record<string, (...args: unknown[]) => unknown> {
  const path = process.env.PAPERCUSP_GITNEXUS_MUTATION_SUBJECT
    ?? fileURLToPath(new URL('./gitnexus-reindex-action.ts', import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && !!statement.name && names.includes(statement.name.text),
  );
  expect(declarations.map((declaration) => declaration.name?.text).sort()).toEqual([...names].sort());
  const snippet = [
    "const GITNEXUS_KNOWN_SOURCE_PATH = 'packages/operator-core/lib/work-items.ts';",
    ...declarations.map((declaration) => declaration.getText(source)),
  ].join('\n');
  const compiled = transformSync(snippet, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  runInNewContext(compiled, { module, exports: module.exports });
  return module.exports;
}

describe('GitNexus refresh negative controls on the real source body', () => {
  it('rejects a healthy-looking graph when its known source file is absent', () => {
    const { judgeCanary } = subjectFunctions(['judgeCanary', 'vectorSearchProbe']);
    const verdict = judgeCanary({
      fileCount: 1, symbolCount: 1, callEdgeCount: 1, defEdgeCount: 1,
      roundTripOk: true, knownSourceFileCount: 0, embeddings: 1, embeddingsExpected: true,
    }) as { healthy: boolean; probes: Array<{ name: string; ok: boolean }> };
    expect(verdict.healthy).toBe(false);
    expect(verdict.probes.find((probe) => probe.name === 'known-source-coverage')?.ok).toBe(false);
  });

  it('distinguishes an orphan WAL from a live writer shadow', () => {
    const { isOrphanWal } = subjectFunctions(['isOrphanWal']);
    expect(isOrphanWal(true, false, true)).toBe(true);
    expect(isOrphanWal(true, true, true)).toBe(false);
  });
});
