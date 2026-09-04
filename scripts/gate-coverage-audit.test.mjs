import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoverageReport,
  discoverWorkspaces,
  parseDiffScopePatterns,
  parseGitmodules,
  parseTypecheckInvocations,
} from './gate-coverage-audit.mjs';

test('parseGitmodules returns every declared path once, in stable order', () => {
  assert.deepEqual(
    parseGitmodules('[submodule "a"]\n\tpath = libs/a\n[submodule "b"]\n path = apps/b\n[submodule "dup"]\n path = libs/a\n'),
    ['apps/b', 'libs/a'],
  );
});

test('parseTypecheckInvocations ignores prose and finds executable typecheck legs', () => {
  const source = `
    // npm run lint:tsc:fake is only documentation
    const a = checkNpmScript(tree, "lint:tsc");
    await exec("npm", ["run", "lint:tsc:operator"]);
  `;
  assert.deepEqual(parseTypecheckInvocations(source), ['lint:tsc', 'lint:tsc:operator']);
});

test('parseDiffScopePatterns extracts only the gate roots', () => {
  assert.deepEqual(
    parseDiffScopePatterns('apps/* packages/* libs/generic/* scripts/*.ts file.startsWith("packages/operator-core/")'),
    ['apps/**', 'libs/generic/**', 'packages/**', 'packages/operator-core/**', 'scripts/**'],
  );
});

test('coverage report unions workspace packages with submodules and exposes set differences', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-coverage-audit-'));
  try {
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
    mkdirSync(join(root, 'libs', 'vendor'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@fixture/web' }));
    writeFileSync(join(root, 'apps', 'operator', 'package.json'), JSON.stringify({ name: '@fixture/operator' }));
    const gate = [
      'const x = checkNpmScript(tree, "lint:tsc:operator");',
      'const y = checkNpmScript(tree, "lint:tsc");',
      'apps/* packages/* libs/generic/* scripts/*.ts',
      'file.startsWith("packages/operator-core/")',
    ].join('\n');
    mkdirSync(join(root, 'apps', 'operator', 'lib', 'release'), { recursive: true });
    writeFileSync(join(root, 'apps', 'operator', 'lib', 'release', 'green-checkpoint.ts'), gate);
    const report = buildCoverageReport({
      root,
      gitmodulesText: '[submodule "vendor"]\n\tpath = libs/vendor\n',
    });
    assert.deepEqual(report.entries.map((entry) => entry.path), ['apps/operator', 'apps/web', 'libs/vendor']);
    assert.equal(report.entries.find((entry) => entry.path === 'apps/operator').typechecked, true);
    assert.equal(report.entries.find((entry) => entry.path === 'apps/web').typechecked, false);
    assert.equal(report.entries.find((entry) => entry.path === 'libs/vendor').is_submodule, true);
    assert.deepEqual(report.coverageMap['libs/vendor'], {
      typechecked: false,
      diff_visible: false,
      is_submodule: true,
    });
    assert.deepEqual(report.uncovered, [
      { path: 'apps/web', missing: ['typecheck'] },
      { path: 'libs/vendor', missing: ['typecheck', 'diff'] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverWorkspaces excludes generated and dependency trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-coverage-workspaces-'));
  try {
    mkdirSync(join(root, 'apps', 'web', 'node_modules', 'nested'), { recursive: true });
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}');
    writeFileSync(join(root, 'apps', 'web', 'node_modules', 'nested', 'package.json'), '{}');
    writeFileSync(join(root, 'apps', 'web', 'dist', 'package.json'), '{}');
    assert.deepEqual(discoverWorkspaces(root).map((workspace) => workspace.path), ['apps/web']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
