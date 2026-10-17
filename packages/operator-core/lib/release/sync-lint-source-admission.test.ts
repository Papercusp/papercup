import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectVerifierInputClosure, qualifySyncLintProofInputs, syncLintProofRoots } from '../../../../scripts/qualify-sync-lint-proof.mjs';
import { validateVerifierInputs } from '../../../../scripts/source-preview.mjs';
import { git, makeSuperproject, write } from '../source-preview.fixture';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
const testPath = 'packages/core/proof.test.ts';
const runtimePath = 'libs/papercusp/runtime.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'p037-source-admission-')); owned.push(dir);
  const { repo } = makeSuperproject(dir);
  const sub = join(repo, 'libs/papercusp');
  write(sub, 'package.json', JSON.stringify({ name: '@papercusp/core', type: 'module',
    exports: { '.': { types: './index.d.ts', import: './import.mjs', require: './index.mjs', default: './index.mjs' } } }));
  write(sub, 'index.d.ts', 'export declare const value: number;\n');
  write(sub, 'index.mjs', "export { value } from './runtime.mjs';\n");
  write(sub, 'import.mjs', "export { value } from './runtime.mjs'; import './import-only.mjs';\n");
  write(sub, 'import-only.mjs', 'export const importOnly = true;\n');
  write(sub, 'runtime.mjs', "export const value = 1; import('./cycle.mjs');\n");
  write(sub, 'cycle.mjs', "import './runtime.mjs';\n");
  git(sub, ['add', '.']); git(sub, ['commit', '-qm', 'runtime entry and transitive cycle']);
  write(repo, testPath, "import './entry';\n");
  write(repo, 'packages/core/entry.ts', "export { value } from '@papercusp/core';\n");
  write(repo, 'node_modules/@papercusp/.keep', '');
  symlinkSync(sub, join(repo, 'node_modules/@papercusp/core'), 'dir');
  git(repo, ['add', testPath, 'packages/core/entry.ts', 'libs/papercusp']);
  git(repo, ['commit', '-qm', 'proof and pinned runtime']);
  return { repo, sub };
}

describe('P037 maintained source admission', () => {
  it('walks transitive workspace runtime exports, declarations, dynamic literals and cycles', async () => {
    const { repo } = fixture();
    const receipt = await qualifySyncLintProofInputs({ repo, roots: [testPath] });
    expect(receipt).toMatchObject({ qualification: 'qualified', unresolved: [], workingDrift: [], refusal: null });
    expect(receipt.paths).toEqual(expect.arrayContaining([testPath, 'packages/core/entry.ts',
      'libs/papercusp/index.d.ts', 'libs/papercusp/index.mjs', runtimePath, 'libs/papercusp/cycle.mjs',
      'libs/papercusp/import.mjs', 'libs/papercusp/import-only.mjs',
      'libs/papercusp/package.json', 'package-lock.json']));
    expect(new Set(receipt.paths).size).toBe(receipt.paths.length);
  });

  it('refuses dirty runtime even when the named test is clean and rejects nested HEAD beyond the parent pin', async () => {
    const { repo, sub } = fixture();
    write(sub, 'runtime.mjs', 'export const value = 2;\n');
    const head = git(repo, ['rev-parse', 'HEAD']);
    await expect(validateVerifierInputs({ repo, ref: head, inputs: [testPath] })).resolves.toMatchObject({ sha: head });
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dirty tested-input mismatch: ' + runtimePath) });
    git(sub, ['add', 'runtime.mjs']); git(sub, ['commit', '-qm', 'nested runtime advances without parent pin']);
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dirty tested-input mismatch: ' + runtimePath) });
  });

  it('refuses an unresolved local edge instead of qualifying an incomplete population', async () => {
    const { repo } = fixture();
    write(repo, 'packages/core/entry.ts', "import './missing-runtime';\n");
    git(repo, ['add', 'packages/core/entry.ts']); git(repo, ['commit', '-qm', 'unresolvable input']);
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', unresolved: [{ from: 'packages/core/entry.ts', spec: './missing-runtime' }],
      refusal: expect.stringContaining('unresolved local imports') });
  });

  it('includes the observed tooldef runtime and the real Vitest setup boundary from maintained roots', () => {
    const repo = resolve(import.meta.dirname, '../../../..');
    const roots = syncLintProofRoots(repo);
    const closure = collectVerifierInputClosure(repo, roots);
    expect(closure.paths).toEqual(expect.arrayContaining([
      'libs/generic/tooldef/src/code-orchestration/run-script.ts',
      'libs/generic/tooldef/src/code-orchestration/tool-facade.ts',
      'libs/generic/tooldef/package.json',
      'packages/operator-core/lib/detached-imports/setup-vitest.ts',
      'scripts/lib/task-cgroup-limits.mjs', 'scripts/lib/task-cgroup-limits.d.mts',
    ]));
    expect(closure.unresolved).toEqual([]);
  }, 30_000);
});
