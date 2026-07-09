/**
 * P-004 (p2p-work-distribution-2026-07-02) unit tests: receipt emit refusal
 * paths (SQL-free), X8 wire-row validation, the receiver-enforced responder
 * identity gate, the outbox mapper, and registry agreement.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  _testing,
  isP2pReceiptWireRow,
  type P2pReceiptWireRow,
  type P2pReceiptsProjectionOpts,
} from './p2p-receipts';
import { emitP2pReceipt } from '../../../p2p/receipts';
import { outboxRowToLocalWriteOp, CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';
import { PEER_LOG_TABLES } from '../../../harness-state/table-registry';
import { checkPeerLogConsistency } from '../../../harness-state/projection-engine';
import { REGISTERED_PROJECTION_TAGS } from './register-all';
import type { OrgSql } from '../../../work-items';

const wireRow = (over: Partial<P2pReceiptWireRow> = {}): P2pReceiptWireRow => ({
  harness_slug: 'papercup-hive',
  receipt_id: 'r-1',
  kind: 'refusal',
  offer_id: 'OF-42',
  action: 'work-offer:claim',
  refusal_code: 'capability_missing',
  missing_capability: 'work-offer',
  budget_axis: null,
  detail: "grant carries [chat]; 'work-offer' is not among them.",
  requester_kind: 'fleet',
  requester_ref: 'p2p-dist',
  requester_github_user_id: 777,
  responder_github_user_id: 12345,
  responder_device_pubkey: null,
  receipt_ts: 1_700_000_000_000,
  ...over,
});

const throwingSql = (() => {
  throw new Error('refusal paths must not touch SQL');
}) as unknown as OrgSql;

describe('emitP2pReceipt refusal paths (loud, SQL-free)', () => {
  it("refuses an unresolvable workspace (C3 — a receipt under 'default' never reaches the requester)", async () => {
    for (const ws of [null, 'default', '*']) {
      const r = await emitP2pReceipt(
        { workspaceId: ws, potSlug: 'h', kind: 'refusal', action: 'wake', refusal: { code: 'no_grant', detail: 'x' }, responderGithubUserId: 1 },
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('workspace_unresolved');
    }
  });

  it("refuses kind='refusal' without the structured refusal, and a non-numeric responder (X9)", async () => {
    const noRefusal = await emitP2pReceipt(
      { workspaceId: 'ws-1', potSlug: 'h', kind: 'refusal', action: 'wake', responderGithubUserId: 1 },
      throwingSql,
    );
    expect(noRefusal.ok).toBe(false);
    if (!noRefusal.ok) expect(noRefusal.refusal.code).toBe('refusal_required');
    const badResponder = await emitP2pReceipt(
      { workspaceId: 'ws-1', potSlug: 'h', kind: 'excused-breach', action: 'wind-down', responderGithubUserId: 0 },
      throwingSql,
    );
    expect(badResponder.ok).toBe(false);
    if (!badResponder.ok) expect(badResponder.refusal.code).toBe('invalid_responder');
  });
});

describe('wire-row validation (X8 taxonomy)', () => {
  it('accepts refusal + excused-breach; rejects unknown kinds and malformed rows', () => {
    expect(isP2pReceiptWireRow(wireRow())).toBe(true);
    expect(isP2pReceiptWireRow(wireRow({ kind: 'excused-breach' }))).toBe(true);
    const bad: unknown[] = [
      null,
      wireRow({ kind: 'oops' }),
      wireRow({ receipt_id: '' }),
      wireRow({ action: '' }),
      wireRow({ responder_github_user_id: 0 }),
      { ...wireRow(), responder_github_user_id: '12345' },
      { ...wireRow(), receipt_ts: 'now' },
    ];
    for (const b of bad) expect(isP2pReceiptWireRow(b)).toBe(false);
    expect(_testing.composeKey(wireRow())).toBe('r-1');
  });
});

describe('receiver-enforced responder identity (M6/L9)', () => {
  const gateOpts = (
    identity: number | null,
    refusals: string[],
    device: string | null = 'device-A',
  ): P2pReceiptsProjectionOpts => ({
    workspaceId: 'ws-1',
    harnessSlug: 'papercup-hive',
    potHomeSlug: 'papercup-hive',
    sql: throwingSql as unknown as postgres.Sql,
    resolveAuthorDevice: () => device,
    resolveAuthorIdentity: async () => ({ githubUserId: identity }),
    onRefusedApply: (reason) => refusals.push(reason),
  });
  const remote = { origin: 'remote' as const, authorPubkey: 'aa'.repeat(32), ts: 1, fedHlc: undefined };

  it('drops a remote receipt whose author is not the named responder (forged receipt)', async () => {
    const refusals: string[] = [];
    await _testing.writeToPg(gateOpts(99999, refusals), wireRow(), remote);
    expect(refusals).toEqual(['responder_mismatch']);
  });

  it('drops on unresolvable device/identity (fail-closed)', async () => {
    const a: string[] = [];
    await _testing.writeToPg(gateOpts(12345, a, null), wireRow(), remote);
    expect(a).toEqual(['no_author_device']);
    const b: string[] = [];
    await _testing.writeToPg(gateOpts(null, b), wireRow(), remote);
    expect(b).toEqual(['identity_unresolved']);
  });
});

describe('outbox mapper + registry agreement', () => {
  it("maps 'p2p_receipts' → tag 'p2p-receipts' with coercion; machine-local cols dropped", () => {
    const op = outboxRowToLocalWriteOp({
      table_name: 'p2p_receipts',
      op: 'put',
      key: 'r-1',
      ts: 1,
      row: { ...wireRow(), created_at: '2026-07-03T00:00:00Z', origin: 'local' } as unknown as Record<string, unknown>,
    });
    expect(op.table).toBe('p2p-receipts');
    const v = (op as { value: P2pReceiptWireRow }).value;
    expect(isP2pReceiptWireRow(v)).toBe(true);
    expect((v as unknown as Record<string, unknown>).created_at).toBeUndefined();
  });

  it('p2p_receipts is CDC-captured + peer-log + tag-registered; counters are LOCAL; drift guard green', () => {
    expect(CDC_CAPTURED_TABLES).toContain('p2p_receipts');
    expect(PEER_LOG_TABLES).toContain('p2p_receipts');
    expect(REGISTERED_PROJECTION_TAGS).toContain('p2p-receipts');
    expect(PEER_LOG_TABLES).not.toContain('p2p_refused_op_counters');
    expect(CDC_CAPTURED_TABLES).not.toContain('p2p_refused_op_counters');
    const consistency = checkPeerLogConsistency(REGISTERED_PROJECTION_TAGS);
    expect(consistency.missingProjection).toEqual([]);
    expect(consistency.orphanTag).toEqual([]);
  });
});
