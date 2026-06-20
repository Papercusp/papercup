/**
 * rekey-grant-loud-failure.test.ts — WI-280 part B.
 *
 * The owner's re-key epoch-key grant to a freshly-admitted peer
 * (grantEpochKeysToMembers, fired fire-and-forget from drainAdmissionQueue) is
 * deliberately best-effort so it never blocks merge-gated admission. But a grant
 * the K0 read-cut DEPENDS ON must not fail SILENTLY — the live C-001 witness
 * K-stage failed silently for exactly this (sodium-native .node unresolved in the
 * sidecar binary → the first deriveEpochKey/wrapKeyToMember threw, swallowed by
 * the best-effort catch).
 *
 * This pins the LOUD behavior (part B): when the admit-time grant THROWS, a
 * queryable `rekey_grant_failed` boot event is recorded (the witness +
 * diagnostics can see it) AND the peer is STILL admitted (the throw must never
 * break admission — the grant is intentionally fire-and-forget).
 *
 * The grant module is dynamically imported inside the catch; vi.mock intercepts
 * that import to force the throw (mirrors WI-280 candidate 1).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Force the admit-time epoch-key grant to THROW (sodium-native unresolved class).
// isHiveRekeyEnabled → true so the grant path is taken; grantEpochKeysToMembers
// rejects, exercising the part-B loud catch.
vi.mock('../hive-epoch-boundary-wiring', () => ({
  grantEpochKeysToMembers: vi.fn(async () => {
    throw new Error('sodium-native unresolved (test) — deriveEpochKey throw');
  }),
  isHiveRekeyEnabled: vi.fn(async () => true),
}));

// WI-280 reroute (ee7e9): the open-mode admit now funnels through upsertHiveMember, which does a
// real hive_members INSERT (getOrgPg) BEFORE the grant. The hermetic harness has no org PG, so the
// INSERT would throw and the admit would never reach the grant (where the boot-events are recorded).
// Stub getOrgPg so the INSERT echoes its params back as the RETURNING row (valid for rowToRecord),
// letting the admit reach the grant. The original test never hit getOrgPg, so this is the only call.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  const stubSql = {
    unsafe: async (_q: string, params: readonly unknown[] = []) => [
      {
        workspace_id: params[0],
        hive_home_slug: params[1],
        github_user_id: params[2],
        github_username: params[3],
        display_name: params[4] ?? null,
        avatar_url: params[5] ?? null,
        device_attestations: params[6] ?? '[]',
        revoked_pubkeys: params[7] ?? [],
        binding_status: params[8] ?? 'unverified',
      },
    ],
  };
  return {
    ...actual,
    getOrgPg: (() => ({ sql: stubSql })) as unknown as typeof actual.getOrgPg,
  };
});

import { bootHarnessSubstrate } from '../boot';
import { grantEpochKeysToMembers } from '../hive-epoch-boundary-wiring';
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
  vi.clearAllMocks();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** A VALID signed announce with a freshly-generated Ed25519 keypair. */
async function validAnnounce(logCoreKey: string): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: logCoreKey,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

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

describe('WI-280 part B — re-key admit-grant failure is LOUD, not swallowed', () => {
  it(
    'records a rekey_grant_failed boot event when the grant throws, and still admits the peer',
    async () => {
      // Mirror the known-working admit path: 'pending' on first verify, 'verified'
      // on the retry, so the pending-retry timer drains + admits the peer (which
      // fires the fire-and-forget epoch-key grant — mocked to throw).
      let callCount = 0;
      const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => {
        callCount++;
        return callCount === 1 ? 'pending' : 'verified';
      };

      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpDir('mb-rekey-loud-'),
        workspaceId: 'ws-rekey-loud',
        harnessSlug: 'rekey-loud',
        mergePollMs: 0,
        pendingRetryMs: 20,
        loadRevokedOverride: async () => new Set(),
        verifyBindingOverride,
      });
      cleanups.push(() => handle.close());

      // part B ALSO logs the throw loudly via console.error (the stack), in
      // addition to the boot event. vitest-fail-on-console would fail on it, so
      // spy it (suppress + assert) — the loud log is the intended behavior.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const logCoreKey = 'cc'.repeat(32);
      const frame = await validAnnounce(logCoreKey);

      // First announce: 'pending' → not admitted yet.
      const decision = await handle.onAnnounce(frame);
      expect(decision).toEqual({ admit: false, reason: 'pending' });

      // Retry flips to 'verified' → peer admitted. The grant throw must NOT break
      // admission (it is fire-and-forget).
      const admitted = await pollUntil(
        () => handle.admitted.has(logCoreKey),
        { timeoutMs: 2000, intervalMs: 30 },
      );
      expect(admitted, 'peer admitted despite the grant throw').toBeTruthy();

      // The grant failure is LOUD — a queryable rekey_grant_failed boot event.
      // The grant is async fire-and-forget, so poll for the event.
      const loud = await pollUntil(
        () =>
          listBootHistory({
            workspaceId: 'ws-rekey-loud',
            harnessSlug: 'rekey-loud',
            kinds: ['rekey_grant_failed'],
            limit: 5,
          }).length > 0,
        { timeoutMs: 2000, intervalMs: 30 },
      );
      expect(loud, 'rekey_grant_failed boot event recorded (not silently swallowed)').toBeTruthy();

      const events = listBootHistory({
        workspaceId: 'ws-rekey-loud',
        harnessSlug: 'rekey-loud',
        kinds: ['rekey_grant_failed'],
        limit: 5,
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].message).toContain('grantEpochKeysToMembers on upsertHiveMember failed');

      // The loud console.error (with the stack) also fired — the failure is no
      // longer message-only / swallowed.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('grantEpochKeysToMembers on upsertHiveMember failed'),
      );
    },
    5000,
  );

  it(
    'records a rekey_grant_skipped boot event (with the reason) when the grant SILENTLY returns {applied:false}, and still admits the peer',
    async () => {
      // The NON-THROW 0-keys path — the actual WI-280 root (line 164 'flag-disabled').
      // The grant returns {applied:false, reason} WITHOUT throwing, so part B's throw
      // catch never sees it; the admit call-site emits rekey_grant_skipped so a 0-keys
      // run NAMES the cause instead of silently minting nothing.
      vi.mocked(grantEpochKeysToMembers).mockImplementationOnce(async () => ({
        applied: false,
        reason: 'flag-disabled',
      }));

      let callCount = 0;
      const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => {
        callCount++;
        return callCount === 1 ? 'pending' : 'verified';
      };

      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpDir('mb-rekey-skip-'),
        workspaceId: 'ws-rekey-skip',
        harnessSlug: 'rekey-skip',
        mergePollMs: 0,
        pendingRetryMs: 20,
        loadRevokedOverride: async () => new Set(),
        verifyBindingOverride,
      });
      cleanups.push(() => handle.close());

      const logCoreKey = 'dd'.repeat(32);
      const frame = await validAnnounce(logCoreKey);

      const decision = await handle.onAnnounce(frame);
      expect(decision).toEqual({ admit: false, reason: 'pending' });

      const admitted = await pollUntil(
        () => handle.admitted.has(logCoreKey),
        { timeoutMs: 2000, intervalMs: 30 },
      );
      expect(admitted, 'peer admitted despite the silent grant skip').toBeTruthy();

      // The silent skip is NAMED — a queryable rekey_grant_skipped event carrying the reason.
      const named = await pollUntil(
        () =>
          listBootHistory({
            workspaceId: 'ws-rekey-skip',
            harnessSlug: 'rekey-skip',
            kinds: ['rekey_grant_skipped'],
            limit: 5,
          }).length > 0,
        { timeoutMs: 2000, intervalMs: 30 },
      );
      expect(named, 'rekey_grant_skipped boot event recorded (the silent 0-keys path is named)').toBeTruthy();

      const events = listBootHistory({
        workspaceId: 'ws-rekey-skip',
        harnessSlug: 'rekey-skip',
        kinds: ['rekey_grant_skipped'],
        limit: 5,
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].message).toContain('flag-disabled'); // the WHICH-return reason is surfaced
    },
    5000,
  );
});
