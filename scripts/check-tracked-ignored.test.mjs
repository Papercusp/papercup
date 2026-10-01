import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findTrackedScratchPaths,
  isTrackedScratchPath,
} from './check-tracked-ignored.mjs';

test('detects tracked top-level scratch roots even without a matching ignore rule', () => {
  const tracked = [
    '.agent-tmp/node-compile-cache/v25/file',
    '.tmp/output.json',
    '.tmp-content-fixer/cache/file',
    '.tmp-vitest-wi1347/cache/file',
    '.tsx-tmp/output.js',
    'scratch/lockdom-run/file',
    'scratchpad/session/file',
    'scratch-preview/run/file',
  ];

  assert.deepEqual(findTrackedScratchPaths(tracked), [...tracked].sort());
});

test('detects generated Papercusp temp files and caches', () => {
  assert.equal(isTrackedScratchPath('.papercusp/node-compile-cache/v25/cache-entry'), true);
  assert.equal(isTrackedScratchPath('.papercusp/tsx-1000/output.js'), true);
  assert.equal(isTrackedScratchPath('.papercusp/tmp-registry-probe.ts'), true);
  assert.equal(isTrackedScratchPath('apps/operator/.papercusp/tsx-1000/output.js'), true);
});

test('does not flag nested product scratch paths or durable Papercusp state', () => {
  const tracked = [
    'packages/operator-core/src/scratch/parser.ts',
    'packages/operator-core/.tmp-fixture.test.ts',
    '.papercusp/reports/durable-parks/evidence.json',
    '.papercusp/state/escalations/provider-failure.md',
  ];

  assert.deepEqual(findTrackedScratchPaths(tracked), []);
});
