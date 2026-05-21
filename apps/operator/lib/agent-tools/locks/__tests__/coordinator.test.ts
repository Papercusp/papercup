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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  const coordinationDomain = nextWs();
  const coordinator = new SuLocksCoordinator({ coordinationDomain });
  return {
    coordinator,
    cleanup: async () => {
      // Fresh workspace per test means no cross-test bleed; nothing
      // to clean.
    },
  };
});

// ────────────────────────────────────────────────────────────────────
// file-locking #11 — heartbeat regression coverage.
// The shared conformance suite does NOT exercise heartbeat; that gap
// let SuLocksCoordinator.heartbeat ship calling tryHeartbeat with the
// wrong (object) argument shape and reading a nonexistent `.ok` field
// — a method that always returned {ok:false,expired:true} at runtime.
// These cases lock the corrected behaviour in.
// ────────────────────────────────────────────────────────────────────
describe('SuLocksCoordinator.heartbeat (file-locking #11 regression)', () => {
  it('extends a held claim and returns ok with a later expiry', async () => {
    const coordinator = new SuLocksCoordinator({ coordinationDomain: nextWs() });
    const acq = await coordinator.acquire('hb-owner', ['hb/file.ts'], {
      ttlMs: 60_000,
    });
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const hb = await coordinator.heartbeat(acq.claim, 120_000);
    expect(hb.ok).toBe(true);
    if (!hb.ok) return;
    expect(hb.claim.expiresAt).toBeInstanceOf(Date);
    // 120s TTL from now must land later than the original 60s TTL.
    expect(hb.claim.expiresAt!.getTime()).toBeGreaterThan(
      acq.claim.expiresAt!.getTime(),
    );
  });

  it('returns {ok:false, expired:true} for an unknown claim', async () => {
    const coordinator = new SuLocksCoordinator({ coordinationDomain: nextWs() });
    const hb = await coordinator.heartbeat(
      {
        claimId: '00000000-0000-0000-0000-000000000000',
        owner: 'nobody',
        paths: [],
        expiresAt: null,
      },
      60_000,
    );
    expect(hb.ok).toBe(false);
  });
});
