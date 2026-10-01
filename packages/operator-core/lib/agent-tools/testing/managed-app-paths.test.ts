import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInRequestScope, runWithWorkspace } from '../../workspace-als';
import { validateCriterionCheckPaths } from '../../rubrics-criterion-checks';
import { checkoutRootForPath, groupTestFilesByCheckout, normalizeTestFilePaths } from './run';

describe('portable managed app test evidence', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'managed-app-tests-'));
  const workspaces = join(fixture, 'workspaces');
  const ambient = join(fixture, 'operator');
  const app = join(workspaces, 'one', '.papercusp', 'apps', 'phone-app');
  const testFile = join(app, 'tests', 'call.test.ts');
  const portable = '.papercusp/apps/phone-app/tests/call.test.ts';
  const previousRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;

  beforeAll(() => {
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaces;
    for (const root of [ambient, app]) {
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: [] }));
    }
    writeFileSync(testFile, 'export {};\n');
    writeFileSync(join(ambient, 'tests', 'operator.test.ts'), 'export {};\n');
    const outside = join(fixture, 'outside.test.ts');
    writeFileSync(outside, 'export {};\n');
    symlinkSync(outside, join(app, 'tests', 'escape.test.ts'));
    symlinkSync(ambient, join(workspaces, 'one', '.papercusp', 'apps', 'escape-app'), 'dir');
    const pointer = join(workspaces, 'one', '.papercusp', 'apps', 'phone-checkpoint');
    mkdirSync(join(pointer, 'tests'), { recursive: true });
    writeFileSync(join(pointer, '.git'), 'gitdir: /tmp/checkpoint\n');
    writeFileSync(join(pointer, 'package.json'), JSON.stringify({ workspaces: [] }));
    writeFileSync(join(pointer, 'tests', 'call.test.ts'), 'export {};\n');
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = previousRoot;
    rmSync(fixture, { recursive: true, force: true });
  });

  it('resolves the portable citation to its managed app checkout', () => {
    expect(runWithWorkspace('one', () => normalizeTestFilePaths([portable], ambient)))
      .toEqual({ ok: true, files: [testFile] });
    expect(checkoutRootForPath(testFile)).toBe(app);
  });

  it('retains separate operator and app execution roots in a mixed request', () => {
    const result = runWithWorkspace('one', () =>
      normalizeTestFilePaths(['tests/operator.test.ts', portable], ambient));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected ambiguity');
    expect(groupTestFilesByCheckout(result.files, ambient)).toEqual([
      { root: ambient, files: ['tests/operator.test.ts'] },
      { root: app, files: [testFile] },
    ]);
  });

  it('makes a portable structured rubric check gradeable', () => {
    const result = runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [portable] } },
    ], { root: ambient }));
    expect(result.ok).toBe(true);
    expect(result.normalizedByKey.call).toEqual([testFile]);
  });

  it('keeps absolute paths forbidden in persistent rubric checks', () => {
    expect(runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [testFile] } },
    ], { root: ambient })).ok).toBe(false);
  });

  it('cannot resolve another workspace through the process-global registry', () => {
    expect(runWithWorkspace('two', () => normalizeTestFilePaths([portable], ambient)))
      .toEqual({ ok: true, files: [portable] });
    expect(runInRequestScope(() => normalizeTestFilePaths([portable], ambient)))
      .toEqual({ ok: true, files: [portable] });
  });

  it.each([
    '.papercusp/apps/phone-app/../phone-app/tests/call.test.ts',
    '.papercusp/apps/phone-app/tests/escape.test.ts',
    '.papercusp/apps/escape-app/tests/operator.test.ts',
    '.papercusp/apps/phone-checkpoint/tests/call.test.ts',
  ])('refuses unsafe or noncanonical app evidence %s', (path) => {
    expect(runWithWorkspace('one', () => normalizeTestFilePaths([path], ambient)))
      .toEqual({ ok: true, files: [path] });
    expect(runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [path] } },
    ], { root: ambient })).ok).toBe(false);
  });
});
