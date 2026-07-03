/**
 * P-001 (p2p-work-distribution-2026-07-02) projection + wiring unit tests:
 *
 *  - wire-row validation (defensive decode — a malformed/forged shape never
 *    reaches writeToPg),
 *  - the RECEIVER-ENFORCED identity gate (M6/L9): a remote op whose verified
 *    author device does not attest to the row's grantor is dropped BEFORE any
 *    SQL touch, with the M15 counter hook fired,
 *  - the outbox mapper (table_name → tableTag + to_jsonb coercion),
 *  - registry ↔ producer ↔ projection agreement (the EI-382 / C3 class at the
 *    TS layer: CDC_CAPTURED_TABLES, PEER_LOG_TABLES and
 *    REGISTERED_PROJECTION_TAGS all know the table).
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  _testing,
  isP2pPeerGrantWireRow,
  type P2pPeerGrantWireRow,
  type P2pPeerGrantsProjectionOpts,
} from './p2p-peer-grants';
import { outboxRowToLocalWriteOp, CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';
import { PEER_LOG_TABLES } from '../../../harness-state/table-registry';
import { REGISTERED_PROJECTION_TAGS } from './register-all';

const wireRow = (over: Partial<P2pPeerGrantWireRow> = {}): P2pPeerGrantWireRow => ({
  harness_slug: 'papercup-hive',
  grantor_github_user_id: 12345,
  grantor_login: 'avi',
  grantee_kind: 'fleet',
  grantee_ref: 'p2p-dist',
  capabilities: ['chat', 'steer'],
  preset: 'collaborator',
  status: 'active',
  grantor_epoch: 0,
  wake_rate_cap_per_hour: null,
  excluded_device_pubkeys: [],
  note: null,
  ...over,
});

/** sql stub that fails the test if the projection touches PG. */
const throwingSql = (() => {
  throw new Error('a refused apply must not touch SQL');
}) as unknown as postgres.Sql;

describe('wire-row validation', () => {
  it('accepts the canonical row', () => {
    expect(isP2pPeerGrantWireRow(wireRow())).toBe(true);
    expect(_testing.decodeValue(wireRow())).not.toBeNull();
  });

  it('rejects malformed / forged shapes', () => {
    const bad: unknown[] = [
      null,
      {},
      wireRow({ harness_slug: '' }),
      wireRow({ grantor_github_user_id: 0 }),
      wireRow({ grantor_github_user_id: 1.5 }),
      { ...wireRow(), grantor_github_user_id: '12345' }, // string id — X9 numeric only
      { ...wireRow(), grantee_kind: 'user' },
      wireRow({ grantee_ref: '' }),
      { ...wireRow(), capabilities: 'chat' },
      { ...wireRow(), capabilities: ['chat', 7] },
      { ...wireRow(), status: 'paused' },
      wireRow({ grantor_epoch: -1 }),
      { ...wireRow(), excluded_device_pubkeys: [null] },
    ];
    for (const b of bad) expect(isP2pPeerGrantWireRow(b)).toBe(false);
  });

  it('composeKey mirrors the generated grant_fed_key column (mig 463)', () => {
    expect(_testing.composeKey(wireRow())).toBe('12345:fleet:p2p-dist');
  });
});

describe('receiver-enforced identity gate (M6/L9, fail-closed)', () => {
  const gateOpts = (
    identity: number | null | 'throw',
    refusals: Array<{ reason: string }>,
    device: string | null = 'device-A',
  ): P2pPeerGrantsProjectionOpts => ({
    workspaceId: 'ws-1',
    harnessSlug: 'papercup-hive',
    hiveHomeSlug: 'papercup-hive',
    sql: throwingSql,
    resolveAuthorDevice: () => device,
    resolveAuthorIdentity: async () => {
      if (identity === 'throw') throw new Error('membership lookup down');
      return { githubUserId: identity };
    },
    onRefusedApply: (reason) => refusals.push({ reason }),
  });
  const remote = { origin: 'remote' as const, authorPubkey: 'aa'.repeat(32), ts: 1, fedHlc: undefined };

  it('drops a remote op whose author attests to a DIFFERENT user than the named grantor', async () => {
    const refusals: Array<{ reason: string }> = [];
    await _testing.writeToPg(gateOpts(99999, refusals), wireRow(), remote);
    expect(refusals).toEqual([{ reason: 'grantor_mismatch' }]);
  });

  it('drops a remote op with no resolvable author device (fail-closed)', async () => {
    const refusals: Array<{ reason: string }> = [];
    await _testing.writeToPg(gateOpts(12345, refusals, null), wireRow(), remote);
    expect(refusals).toEqual([{ reason: 'no_author_device' }]);
  });

  it('drops a remote op when identity resolution errors (fail-closed, never fail-open)', async () => {
    const refusals: Array<{ reason: string }> = [];
    await _testing.writeToPg(gateOpts('throw', refusals), wireRow(), remote);
    expect(refusals).toEqual([{ reason: 'identity_unresolved' }]);
  });

  it('drops an op for a different hive slug silently (projection demux, not a refusal)', async () => {
    const refusals: Array<{ reason: string }> = [];
    await _testing.writeToPg(gateOpts(12345, refusals), wireRow({ harness_slug: 'other-hive' }), remote);
    expect(refusals).toEqual([]);
  });
});

describe('outbox mapper (drain side)', () => {
  it("maps table_name 'p2p_peer_grants' to tableTag 'p2p-peer-grants' with to_jsonb coercion", () => {
    const op = outboxRowToLocalWriteOp({
      table_name: 'p2p_peer_grants',
      op: 'put',
      key: '12345:fleet:p2p-dist',
      ts: 1_700_000_000_000,
      row: {
        harness_slug: 'papercup-hive',
        grantor_github_user_id: 12345, // BIGINT → number under to_jsonb
        grantor_login: 'avi',
        grantee_kind: 'fleet',
        grantee_ref: 'p2p-dist',
        capabilities: ['chat'],
        preset: null,
        status: 'active',
        grantor_epoch: 2,
        wake_rate_cap_per_hour: 30,
        excluded_device_pubkeys: ['bb'.repeat(32)],
        note: 'starter',
        // machine-local columns the mapper must NOT federate:
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
        origin: 'local',
      },
    });
    expect(op.type).toBe('put');
    expect(op.table).toBe('p2p-peer-grants');
    expect(op.hbKey).toBe('12345:fleet:p2p-dist');
    const v = (op as { value: P2pPeerGrantWireRow }).value;
    expect(isP2pPeerGrantWireRow(v)).toBe(true);
    expect(v.grantor_epoch).toBe(2);
    expect(v.wake_rate_cap_per_hour).toBe(30);
    expect((v as unknown as Record<string, unknown>).created_at).toBeUndefined();
  });

  it('a del op carries only the key', () => {
    const op = outboxRowToLocalWriteOp({
      table_name: 'p2p_peer_grants',
      op: 'del',
      key: '12345:fleet:p2p-dist',
      ts: 1,
      row: null,
    });
    expect(op.type).toBe('del');
    expect(op.table).toBe('p2p-peer-grants');
  });
});

describe('registry ↔ producer ↔ projection agreement (EI-382 / C3 class)', () => {
  it('p2p_peer_grants is CDC-captured, peer-log-classified, and its projection tag is registered', () => {
    expect(CDC_CAPTURED_TABLES).toContain('p2p_peer_grants');
    expect(PEER_LOG_TABLES).toContain('p2p_peer_grants');
    expect(REGISTERED_PROJECTION_TAGS).toContain('p2p-peer-grants');
  });

  it('p2p_grantor_epochs (X6 receiver state) is deliberately NOT federated', () => {
    expect(PEER_LOG_TABLES).not.toContain('p2p_grantor_epochs');
    expect(CDC_CAPTURED_TABLES).not.toContain('p2p_grantor_epochs');
  });
});
