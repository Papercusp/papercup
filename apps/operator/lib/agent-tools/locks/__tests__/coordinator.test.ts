/**
 * Conformance tests for SuLocksCoordinator (file-locking #11).
 * Delegates contract assertions to @papercusp/file-claim/conformance;
 * the SAME 11 generic cases run against both the in-process
 * FileLockQueueCoordinator (orchestrator pkg) and the PG-backed
 * SuLocksCoordinator (here). The interface alignment is real iff
 * both adapters pass the same suite.
 *
 * Setup mirrors su-lock-store.test.ts: real embedded PG, unique
 * workspace per test, ensureBootstrap once.
 */
import { afterAll, beforeAll } from 'vitest';
import { describeConformance } from '@papercusp/file-claim/conformance';
import { SuLocksCoordinator } from '../coordinator';
import { ensureBootstrap, _resetForTests } from '../su-lock-store';

const SUITE_PREFIX = `vitest-coord-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
let nextN = 0;
function nextWs(): string {
  return `${SUITE_PREFIX}-${nextN++}`;
}

beforeAll(async () => {
  await ensureBootstrap();
});

afterAll(async () => {
  await _resetForTests();
});

describeConformance('SuLocksCoordinator', async () => {
  const workspaceId = nextWs();
  const coordinator = new SuLocksCoordinator({ workspaceId });
  return {
    coordinator,
    cleanup: async () => {
      // Fresh workspace per test means no cross-test bleed; nothing
      // to clean.
    },
  };
});
