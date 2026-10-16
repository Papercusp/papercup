import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { preflightSyncLintPrivateCompiler } from '../../test/sync-lint-private-compiler';

// Phase-only preflight: same compiler, argv wrapper and diagnostic parser as
// the private PG journey. No PG, source census, filing, wake or runtime boot.
it('P037 compiler preflight measures the seeded error and its repair without private PG', async () => {
  const receipt = await preflightSyncLintPrivateCompiler(resolve(import.meta.dirname, '../../../..'));
  expect(receipt).toMatchObject({ red: { outcome: 'nonzero-exit', exitCode: 2 },
    green: { outcome: 'completed', exitCode: 0 }, privatePgAllocated: false });
  console.info('SYNC_LINT_COMPILER_PREFLIGHT ' + JSON.stringify(receipt));
}, 30_000);
