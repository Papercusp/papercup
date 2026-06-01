/**
 * distributed-claim — P-037 wrapper tests.
 *
 * Uses fake substrate handles (injected via boot-all's test hooks)
 * to exercise every reason branch without booting Hyperbee.
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
import type {
  AutobaseHarnessHandle,
  OpEnvelope,
} from '../../sync/hyperbee/autobase-setup';
import type { BootedHarnessHandle } from '../../sync/hyperbee/boot';
import type { FeatureClaimRecord } from '../feature-claim';

function fakeView() {
  const log: OpEnvelope[] = [];
  return {
    log,
    get length() {
      return log.length;
    },
    async get(seq: number) {
      return log[seq] ?? null;
    },
    push(op: OpEnvelope) {
      log.push(op);
    },
  };
}

// STAGE-5: distributed-claim still reads the retired Autobase `base`
// (`base.base.view` + `base.base.local.key`). resolveMyPubkey prefers the
// Model B own-log key when present; these fixtures intentionally OMIT `ownLog`
// so the legacy `base.local.key` fallback is exercised. Cast through `unknown`
// because `base` is no longer a declared `BootedHarnessHandle` property — the
// Stage-5 claim rewrite retires these fixtures.
function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
  opts: { pubkey?: Buffer | null } = {},
): BootedHarnessHandle {
  const view = fakeView();
  const append = vi.fn(async (op: OpEnvelope) => {
    view.push(op);
  });
  const pubkey = opts.pubkey === undefined ? Buffer.from('aa', 'hex') : opts.pubkey;
  const base: AutobaseHarnessHandle = {
    base: {
      view,
      local: pubkey ? { key: pubkey } : undefined,
    } as unknown as AutobaseHarnessHandle['base'],
    append,
    close: vi.fn(async () => {}),
  };
  return {
    workspaceId,
    harnessSlug,
    store: {} as never,
    base,
    close: vi.fn(async () => {}),
  } as unknown as BootedHarnessHandle;
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
  it('hex-encodes the local.key buffer', () => {
    const h = fakeHandle('ws-1', 'a', { pubkey: Buffer.from([0xde, 0xad, 0xbe, 0xef]) });
    expect(resolveMyPubkey(h)).toBe('deadbeef');
  });

  it('returns null when local is missing', () => {
    const h = fakeHandle('ws-1', 'a', { pubkey: null });
    expect(resolveMyPubkey(h)).toBeNull();
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
    expect(r.won).toBe(false);
  });

  it('returns pubkey-unresolved when local key missing', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup', { pubkey: null }));
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
    });
    expect(r.reason).toBe('pubkey-unresolved');
    expect(r.won).toBe(false);
  });

  it('wins when uncontested', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 1_000_000,
    });
    expect(r.reason).toBe('attempted');
    if (r.reason === 'attempted') {
      expect(r.won).toBe(true);
      expect(r.my_pubkey).toBe('aa');
      expect(r.audit_outcome).toBe('won');
    }
  });

  it('loses when a prior claim is already in the view', async () => {
    const h = fakeHandle('ws-1', 'papercup');
    // Pre-load a competing claim from a different pubkey.
    const competitor: FeatureClaimRecord = {
      kind: 'feature_claim',
      feature_id: 'F-1',
      claimer_pubkey: '01', // lex-smaller than 'aa' so it wins on tiebreak
      claimer_github_user_id: 99,
      ts: 1_000,
      schema_version: 1,
    };
    const view = ((h as unknown as { base: { base: unknown } }).base.base as unknown as { view: { log: OpEnvelope[] } }).view;
    view.log.push({
      type: 'put',
      table: 'claims',
      hbKey: 'feature_claim/F-1/01/1000',
      value: competitor,
      schema_version: 1,
      ts: 1_000,
    });
    _setHandleForTests('ws-1', 'papercup', h);
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 2_000,
    });
    expect(r.reason).toBe('attempted');
    if (r.reason === 'attempted') {
      expect(r.won).toBe(false);
      expect(r.audit_outcome).toBe('lost');
    }
  });

  it('threads claimTable through to the adapter', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = await attemptDistributedClaim({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      claimTable: 'custom_claims',
      now_ms: 1_000_000,
    });
    expect(r.reason).toBe('attempted');
  });

  it('result carries my_pubkey on attempted', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup', {
      pubkey: Buffer.from([0x12, 0x34]),
    }));
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
