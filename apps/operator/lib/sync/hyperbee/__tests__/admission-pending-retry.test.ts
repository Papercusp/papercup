/**
 * admission-pending-retry.test.ts — boot pending-retry loop (D-006).
 *
 * Verifies that a peer whose channel-2 file hasn't propagated yet ('pending')
 * is NOT admitted on the first announce, but IS admitted after the retry timer
 * fires and `verifyBinding` flips to 'verified'. Also verifies that a peer
 * that conclusively fails ('fail') after a 'pending' is never admitted.
 *
 * Uses a real bootHarnessSubstrate with:
 *   - `verifyBindingOverride` that starts 'pending' then flips to 'verified'.
 *   - `mergePollMs: 0` (no background merge timer).
 *   - A small `pendingRetryMs` (e.g. 20ms) so the retry fires quickly.
 *
 * The test polls the admitted-set (bounded) to assert that the peer eventually
 * lands there without requiring timers/sleeps longer than a few hundred ms.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate } from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair. */
async function validAnnounce(logCoreKey: string): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    log_core_key: logCoreKey,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

/** Poll fn() until truthy or timeoutMs elapses. */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

describe('boot pending-retry loop (D-006)', () => {
  it(
    "a 'pending' peer is NOT admitted on first announce, IS admitted after retry flips to 'verified'",
    async () => {
      // Binding starts 'pending', flips to 'verified' on the second call.
      let callCount = 0;
      const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => {
        callCount++;
        return callCount === 1 ? 'pending' : 'verified';
      };

      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpDir('mb-pend-retry-'),
        workspaceId: 'ws-pend-1',
        harnessSlug: 'pend-1',
        mergePollMs: 0,
        pendingRetryMs: 20, // fast retry for test
        verifyBindingOverride,
      });
      cleanups.push(() => handle.close());

      const logCoreKey = 'aa'.repeat(32);
      const frame = await validAnnounce(logCoreKey);

      // First announce: binding returns 'pending' → NOT admitted.
      const decision = await handle.onAnnounce(frame);
      expect(decision).toEqual({ admit: false, reason: 'pending' });
      expect(handle.admitted.has(logCoreKey)).toBe(false);

      // Verify the announce_pending boot-history event was recorded.
      const pendingEvents = listBootHistory({
        workspaceId: 'ws-pend-1',
        harnessSlug: 'pend-1',
        kinds: ['announce_pending'],
        limit: 5,
      });
      expect(pendingEvents.length).toBeGreaterThan(0);

      // The retry timer fires (pendingRetryMs=20ms). Once it runs, the binding
      // flips to 'verified' and the peer is admitted. Poll with a generous timeout.
      const admitted = await pollUntil(
        () => handle.admitted.has(logCoreKey),
        { timeoutMs: 2000, intervalMs: 30 },
      );
      expect(admitted, 'peer should be admitted after pending-retry').toBeTruthy();
      expect(handle.admitted.has(logCoreKey)).toBe(true);

      // Verify the announce_admitted boot-history event was recorded.
      const admittedEvents = listBootHistory({
        workspaceId: 'ws-pend-1',
        harnessSlug: 'pend-1',
        kinds: ['announce_admitted'],
        limit: 5,
      });
      expect(admittedEvents.length).toBeGreaterThan(0);
    },
    5000,
  );

  it(
    "a 'fail' peer (after initial 'pending') is never admitted",
    async () => {
      // Binding starts 'pending', then flips to 'fail' on retry.
      let callCount = 0;
      const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => {
        callCount++;
        return callCount === 1 ? 'pending' : 'fail';
      };

      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpDir('mb-pend-fail-'),
        workspaceId: 'ws-pend-2',
        harnessSlug: 'pend-2',
        mergePollMs: 0,
        pendingRetryMs: 20,
        verifyBindingOverride,
      });
      cleanups.push(() => handle.close());

      const logCoreKey = 'bb'.repeat(32);
      const frame = await validAnnounce(logCoreKey);

      // First announce: 'pending' → not admitted.
      const decision = await handle.onAnnounce(frame);
      expect(decision).toEqual({ admit: false, reason: 'pending' });
      expect(handle.admitted.has(logCoreKey)).toBe(false);

      // Wait for the retry to fire and conclusively fail.
      await new Promise((r) => setTimeout(r, 200));

      // Peer was definitively rejected — announced_rejected should be recorded.
      const rejectedEvents = listBootHistory({
        workspaceId: 'ws-pend-2',
        harnessSlug: 'pend-2',
        kinds: ['announce_rejected'],
        limit: 5,
      });
      expect(rejectedEvents.length).toBeGreaterThan(0);

      // Never admitted.
      expect(handle.admitted.has(logCoreKey)).toBe(false);
      // Only own log in admitted set.
      expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    },
    3000,
  );

  it(
    'revocation removes a pending peer — it is never retried',
    async () => {
      // Always returns 'pending' — the peer would never flip, but revocation
      // should remove it from the pending set before any retry admits it.
      const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => 'pending';

      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpDir('mb-pend-revoke-'),
        workspaceId: 'ws-pend-3',
        harnessSlug: 'pend-3',
        mergePollMs: 0,
        pendingRetryMs: 50,
        verifyBindingOverride,
      });
      cleanups.push(() => handle.close());

      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
        .subarray(-32)
        .toString('base64');
      const logCoreKey = 'cc'.repeat(32);
      const frame = await buildAnnounce(
        { device_pubkey: rawPub, github_user_id: 99, github_login: 'carol', log_core_key: logCoreKey },
        async (bytes) => nodeSign(null, bytes, privateKey),
      );

      // Announce lands as pending.
      await handle.onAnnounce(frame);
      expect(handle.admitted.has(logCoreKey)).toBe(false);

      // Revoke the peer. This should drop it from the pending set.
      await handle.revoke(rawPub);

      // Wait longer than the retry interval — the peer should NOT be admitted
      // even though verifyBinding would return 'pending' (not 'verified').
      await new Promise((r) => setTimeout(r, 300));

      // Not admitted after revocation + retry window.
      expect(handle.admitted.has(logCoreKey)).toBe(false);
      // Only own log remains.
      expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    },
    3000,
  );
});
