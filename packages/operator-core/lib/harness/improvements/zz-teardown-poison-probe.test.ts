import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// TEMPORARY PROBE (EI-20349773342925327) — deleted at the end of the probe run.
// FILE B: trivial and FAST so it sorts after file A in the shared fork.
// If these tests RUN, file A's post-teardown floating imports merely emit a
// mis-attributed error (SPURIOUS). If this file reports "(0 test)" or fails to
// load, the fork is genuinely POISONED.
describe('zz teardown poison probe', () => {
  it('runs at all', () => {
    process.stderr.write('\n[POISON-PROBE] file B test body EXECUTED\n');
    expect(join('a', 'b')).toBe('a/b');
  });

  it('can still dynamically import a cold module after A tore down', async () => {
    const m = await import('../../cache/instance');
    process.stderr.write(
      `[POISON-PROBE] file B post-hoc import of cache/instance OK, keys=${Object.keys(m).length}\n`,
    );
    expect(typeof m).toBe('object');
  });
});
