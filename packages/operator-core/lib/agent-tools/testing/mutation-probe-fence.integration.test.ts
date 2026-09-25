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

// This is a harmless existing suite with a tiny import closure.
const SUITE = 'packages/operator-core/lib/__tests__/testing-run-source.test.ts';

async function holdProbeMarker(markerPath: string): Promise<string> {
  const coordinationDomain = await realpath(REPO_ROOT);
  const owner = `mutation-probe-fence-test:${randomUUID()}`;
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
  if (!acquired.ok) throw new Error('mutation-probe marker was not acquired');

  releaseMarker = async () => {
    const released = await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
      tryRelease(tx, { coordinationDomain, owner, lockId: acquired.lock_id }),
    );
    expect(released.released).toContain(markerPath);
  };

  const visible = await readQueue(getTxPool(), { coordinationDomain, paths: [markerPath] });
  expect(visible.active_locks).toContainEqual(expect.objectContaining({ path: markerPath, intent: 'mutation probe' }));
  return coordinationDomain;
}

it('refuses a real test-file launch whose import closure contains the probed source', async () => {
  // The suite is always in its own closure. If the fence regresses, the runner
  // executes it and this assertion fails on the ordinary run result.
  const root = await holdProbeMarker(SUITE);

  const result = await runTestFilesCore({ root, files: [SUITE] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect("hint" in result ? result.hint : undefined).toContain(SUITE);
});

it('runs a real test file whose import closure cannot observe the probed source', async () => {
  const markerPath = `packages/operator-core/lib/agent-tools/testing/.mutation-probe-${randomUUID()}.ts`;
  const root = await holdProbeMarker(markerPath);

  const result = await runTestFilesCore({ root, files: [SUITE] });

  expect(result).toMatchObject({ ok: true, files: 1 });
}, 90_000);
