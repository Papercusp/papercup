/**
 * distributed-claim — Model B Stage-5 wrapper tests.
 *
 * Uses fake substrate handles (injected via boot-all's test hooks) to
 * exercise every reason branch without booting the substrate. The claim is
 * an LWW advisory hint appended to the own log; the result is `claimed`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attemptDistributedClaim,
  resolveMyPubkey,
} from '../distributed-claim';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../../sync/hyperbee/boot-all';
import type { BootedHarnessHandle } from '../../sync/hyperbee/boot';
import { makeFakeBootedHandle } from '../../sync/hyperbee/__tests__/fake-booted-handle';
import { _testing as projection } from '../../sync/hyperbee/projections/feature-claims';

/** A fake whose own-log keyHex is empty — drives the pubkey-unresolved path. */
function handleWithNoKey(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  const fake = makeFakeBootedHandle({ workspaceId, harnessSlug, keyHex: '' });
  return fake.handle;
}

// Mock audit so tests don't try to write PG.
vi.mock('../claim-audit', () => ({
  recordClaimAttempt: vi.fn(async () => {}),
}));

afterEach(() => {
  _resetHandleMapForTests();
  vi.clearAllMocks();
});

describe('resolveMyPubkey', () => {
  it('returns the own-log key hex', () => {
    const { handle } = makeFakeBootedHandle({ keyHex: 'deadbeef' });
    expect(resolveMyPubkey(handle)).toBe('deadbeef');
  });

  it('returns null when the own-log key is empty', () => {
    expect(resolveMyPubkey(handleWithNoKey('ws-1', 'a'))).toBeNull();
  });
});

describe('attemptDistributedClaim', () => {
  it('returns substrate-not-booted when no handle in map', async () => {
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
    });
    expect(r.reason).toBe('substrate-not-booted');
    expect(r.claimed).toBe(false);
  });

  it('returns pubkey-unresolved when the own-log key is missing', async () => {
    _setHandleForTests('ws-1', 'papercup', handleWithNoKey('ws-1', 'papercup'));
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
    });
    expect(r.reason).toBe('pubkey-unresolved');
    expect(r.claimed).toBe(false);
  });

  it('appends an advisory claim to the own log and returns claimed:true', async () => {
    const fake = makeFakeBootedHandle({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      keyHex: 'aa'.repeat(32),
    });
    _setHandleForTests('ws-1', 'papercup', fake.handle);
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 1_000_000,
    });
    expect(r.reason).toBe('attempted');
    if (r.reason === 'attempted') {
      expect(r.claimed).toBe(true);
      expect(r.my_pubkey).toBe('aa'.repeat(32));
      expect(r.audit_outcome).toBe('won');
    }
    // The claim op landed on the own log + round-trips the projection.
    expect(fake.handle.ownLog.length).toBe(1);
    const op = await fake.handle.ownLog.get(0);
    expect(op?.table).toBe('claims');
    const row = projection.decodeValue(op?.value);
    expect(row).toMatchObject({
      harness_slug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      claimer_pubkey: 'aa'.repeat(32),
    });
  });

  it('result carries my_pubkey on attempted', async () => {
    _setHandleForTests(
      'ws-1',
      'papercup',
      makeFakeBootedHandle({ workspaceId: 'ws-1', harnessSlug: 'papercup', keyHex: '1234' }).handle,
    );
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 1_000_000,
    });
    expect(r.reason).toBe('attempted');
    if (r.reason === 'attempted') {
      expect(r.my_pubkey).toBe('1234');
    }
  });
});
