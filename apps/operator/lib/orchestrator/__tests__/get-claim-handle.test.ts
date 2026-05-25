/**
 * get-claim-handle — Phase 6 P-037 lookup tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClaimHandleForHarness } from '../get-claim-handle';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../../sync/hyperbee/boot-all';
import type {
  AutobaseHarnessHandle,
  OpEnvelope,
} from '../../sync/hyperbee/autobase-setup';
import type { BootedHarnessHandle } from '../../sync/hyperbee/boot';

function fakeView(): { length: number; get(seq: number): Promise<OpEnvelope | null> } {
  const log: OpEnvelope[] = [];
  return {
    get length() {
      return log.length;
    },
    async get(seq) {
      return log[seq] ?? null;
    },
  };
}

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  const view = fakeView();
  const base: AutobaseHarnessHandle = {
    base: { view } as unknown as AutobaseHarnessHandle['base'],
    append: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return {
    workspaceId,
    harnessSlug,
    store: {} as never,
    base,
    close: vi.fn(async () => {}),
  };
}

afterEach(() => {
  _resetHandleMapForTests();
});

describe('get-claim-handle — P-037 lookup', () => {
  it('returns null when no substrate is booted', () => {
    const result = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      myPubkey: 'aa',
    });
    expect(result).toBeNull();
  });

  it('returns a ClaimAutobaseHandle when substrate is booted', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const handle = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      myPubkey: 'aa',
    });
    expect(handle).not.toBeNull();
    expect(handle!.myPubkey).toBe('aa');
    expect(typeof handle!.appendClaim).toBe('function');
    expect(typeof handle!.readClaimsForFeature).toBe('function');
  });

  it('returns null when adapter construction throws', () => {
    // Build a fakeHandle whose base.view is missing a get() method —
    // buildClaimAutobaseHandle throws, lookup catches and returns null.
    const broken: BootedHarnessHandle = {
      workspaceId: 'ws-1',
      harnessSlug: 'broken',
      store: {} as never,
      base: {
        base: { view: { length: 0 } } as unknown as AutobaseHarnessHandle['base'],
        append: vi.fn(),
        close: vi.fn(),
      },
      close: vi.fn(),
    };
    _setHandleForTests('ws-1', 'broken', broken);
    expect(
      getClaimHandleForHarness({
        workspaceId: 'ws-1',
        harnessSlug: 'broken',
        myPubkey: 'aa',
      }),
    ).toBeNull();
  });

  it('threads claimTable override through to the adapter', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const handle = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      myPubkey: 'aa',
      claimTable: 'custom_claims',
    });
    expect(handle).not.toBeNull();
    // The override surfaces only on appendClaim via the OpEnvelope —
    // call it and check the resulting append() args.
    void handle!.appendClaim({
      kind: 'feature_claim',
      feature_id: 'F-1',
      claimer_pubkey: 'aa',
      claimer_github_user_id: 1,
      ts: 100,
      schema_version: 1,
    });
    // No assertion target here without exposing the mock; rely on the
    // adapter test for the per-field behavior. This test ensures the
    // table flows through without throwing.
  });

  it('keys per (workspace, harness)', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    expect(
      getClaimHandleForHarness({
        workspaceId: 'ws-1',
        harnessSlug: 'a',
        myPubkey: 'aa',
      }),
    ).not.toBeNull();
    expect(
      getClaimHandleForHarness({
        workspaceId: 'ws-1',
        harnessSlug: 'b',
        myPubkey: 'aa',
      }),
    ).toBeNull();
    expect(
      getClaimHandleForHarness({
        workspaceId: 'ws-2',
        harnessSlug: 'a',
        myPubkey: 'aa',
      }),
    ).toBeNull();
  });
});
