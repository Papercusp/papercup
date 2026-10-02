/**
 * no-eager-execfile-promisify-guard.test.ts — the eager-execFile-promisify CI
 * guard's detection predicate (EI-10161).
 *
 * The guard (`scripts/check-no-eager-execfile-promisify.mjs`) runs green on the
 * clean tree (its BASELINE grandfathers pre-existing sites). This locks the
 * direction EI-10161 actually asks for — that it FLAGS a NEW module-scope eager
 * `const x = promisify(execFile)` while NOT flagging an already-lazy (function-body)
 * promisify call, a differently-named promisify target, or a prose mention.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { usesEagerExecFilePromisify } from '../../../../scripts/check-no-eager-execfile-promisify.mjs';

describe('no-eager-execfile-promisify guard predicate (EI-10161)', () => {
  it('FLAGS a module-scope `const x = promisify(execFile)`', () => {
    expect(usesEagerExecFilePromisify("const execFileP = promisify(execFile);")).toBe(true);
  });

  it('FLAGS the execFileCb-aliased-import variant', () => {
    expect(usesEagerExecFilePromisify("const execFileP = promisify(execFileCb);")).toBe(true);
  });

  it('FLAGS an exported module-scope binding', () => {
    expect(usesEagerExecFilePromisify("export const pexec = promisify(execFile);")).toBe(true);
  });

  it('does NOT flag the lazy memoized wrapper WI-10005282 applied to 14 files', () => {
    const lazy = [
      'let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;',
      'const execFileAsync = ((...args: unknown[]) =>',
      '  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;',
    ].join('\n');
    expect(usesEagerExecFilePromisify(lazy, 'x.ts')).toBe(false);
  });

  it('still FLAGS a column-0 eager call alongside other code (the raw pre-filter must not hide it)', () => {
    const eager = ["import { promisify } from 'node:util';", 'const execFileP = promisify(execFile);'].join('\n');
    expect(usesEagerExecFilePromisify(eager, 'x.ts')).toBe(true);
  });

  it('does NOT flag a lazy (function-body, indented) promisify call', () => {
    const lazy = [
      'let cached = null;',
      'function execFileP(...args) {',
      '  if (!cached) cached = promisify(execFile);',
      '  return cached(...args);',
      '}',
    ].join('\n');
    expect(usesEagerExecFilePromisify(lazy)).toBe(false);
  });

  it('does NOT flag an unrelated module-scope promisify target (e.g. fs)', () => {
    expect(usesEagerExecFilePromisify('const readFileP = promisify(readFileCb);')).toBe(false);
  });

  it('does NOT flag a mention only in a comment (comments are stripped)', () => {
    const codeWithComment = [
      '// do NOT do `const execFileP = promisify(execFile)` at module scope here',
      '/** see the lazy execFileP wrapper below instead */',
      'function ok() { return null; }',
    ].join('\n');
    expect(usesEagerExecFilePromisify(codeWithComment)).toBe(false);
  });
});
