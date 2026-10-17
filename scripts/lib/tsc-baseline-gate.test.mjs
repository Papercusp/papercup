import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  formatUncoveredFilesBanner,
  suggestTypecheckGate,
} from './tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('mixed-file typecheck routing offers an owning command for packages/backup files', () => {
    const suggestion = suggestTypecheckGate(ROOT, 'packages/backup/src/hook.test.ts');
    assert.equal(suggestion?.workspaceDir, 'packages/backup');
    assert.equal(suggestion?.command, 'npm run --workspace packages/backup typecheck');

    const banner = formatUncoveredFilesBanner({
      label: 'operator-core',
      uncovered: ['packages/backup/src/hook.test.ts'],
      suggestions: new Map([['packages/backup/src/hook.test.ts', suggestion]]),
      fatal: false,
    });
    assert.match(banner.join('\n'), /npm run --workspace packages\/backup typecheck/);
    assert.match(banner.join('\n'), /packages\/backup\/src\/hook\.test\.ts/);
});
