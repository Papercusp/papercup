import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { REPO_ROOT } from '../docs/_repo-paths';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { ensureBootstrap, getTxPool, readQueue, tryAcquire, tryRelease } from '../locks/su-lock-store';
import { runTestFilesCore } from './run';

let releaseMarker: (() => Promise<void>) | undefined;

afterEach(async () => {
  await releaseMarker?.();
  releaseMarker = undefined;
});

it('refuses a real test-file launch while a mutation-probe marker is active', async () => {
  const coordinationDomain = await realpath(REPO_ROOT);
  const owner = `mutation-probe-fence-test:${randomUUID()}`;
  const markerPath = `packages/operator-core/lib/agent-tools/testing/.mutation-probe-${randomUUID()}.ts`;
  await ensureBootstrap();
  const acquired = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
    tryAcquire(tx, {
      coordinationDomain,
      owner,
      ownerLabel: 'mutation-probe-fence-test',
      paths: [markerPath],
      intent: 'mutation probe',
      ttlSec: 120,
    }),
  );
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) return;

  releaseMarker = async () => {
    const released = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
      tryRelease(tx, { coordinationDomain, owner, lockId: acquired.lock_id }),
    );
    expect(released.released).toContain(markerPath);
  };

  const visible = await readQueue(getTxPool(), { coordinationDomain, paths: [markerPath] });
  expect(visible.active_locks).toContainEqual(expect.objectContaining({ path: markerPath, intent: 'mutation probe' }));

  // This is a harmless existing suite. If the lock fence regresses, the runner
  // executes it and this assertion fails on the ordinary run result.
  const result = await runTestFilesCore({
    root: coordinationDomain,
    files: ['packages/operator-core/lib/__tests__/testing-run-source.test.ts'],
  });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect("hint" in result ? result.hint : undefined).toContain(markerPath);
});
