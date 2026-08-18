import { describe, it, expect } from 'vitest';

// TEMPORARY PROBE (EI-20349773342925327) — deleted at the end of the probe run.
// FILE A: reproduces capture-core.ts:1383/1391/1403 exactly — floating (un-awaited)
// dynamic imports of COLD, HEAVY module graphs, fired in the last test so they are
// still resolving when this file's environment tears down. The targets are the real
// ones from capture-core, incl. the cache chain named in the gate's error text.
describe('aa teardown poison source', () => {
  it('fires floating dynamic imports and returns immediately', () => {
    process.stderr.write('\n[POISON-PROBE] file A firing floating imports\n');
    void import('../../system-health/compute')
      .then(() => process.stderr.write('[POISON-PROBE] A: system-health/compute RESOLVED\n'))
      .catch((e) => process.stderr.write(`[POISON-PROBE] A: system-health/compute REJECTED: ${e?.message}\n`));
    void import('../../sync-sse')
      .then(() => process.stderr.write('[POISON-PROBE] A: sync-sse RESOLVED\n'))
      .catch((e) => process.stderr.write(`[POISON-PROBE] A: sync-sse REJECTED: ${e?.message}\n`));
    void import('../../calibration/capture')
      .then(() => process.stderr.write('[POISON-PROBE] A: calibration/capture RESOLVED\n'))
      .catch((e) => process.stderr.write(`[POISON-PROBE] A: calibration/capture REJECTED: ${e?.message}\n`));
    expect(true).toBe(true);
  });
});
