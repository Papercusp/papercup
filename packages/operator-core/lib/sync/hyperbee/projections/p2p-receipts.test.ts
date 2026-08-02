/**
 * P-004 (p2p-work-distribution-2026-07-02) unit tests: receipt emit refusal
 * paths (SQL-free), X8 wire-row validation, the receiver-enforced responder
 * identity gate, the outbox mapper, and registry agreement.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  _testing,
  isP2pReceiptWireRow,
  type P2pReceiptWireRow,
  type P2pReceiptsProjectionOpts,
} from './p2p-receipts';
import { emitP2pReceipt, isRefusalClassReceiptKind, P2P_RECEIPT_KINDS } from '../../../p2p/receipts';
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

// EI-19333624101736074: the success-receipt kind. A delegated spawn used to be
// loud on refusal and silent on success, so a phantom honor was
// indistinguishable from "nobody picked it up".
describe("emitP2pReceipt kind='honored' (the success fact)", () => {
  it('refuses a success receipt that carries a structured refusal', async () => {
    const r = await emitP2pReceipt(
      {
        workspaceId: 'ws-1',
        potSlug: 'h',
        kind: 'honored',
        action: 'delegated-seat:spawn',
        detail: 'opened 1/1',
        refusal: { code: 'nope', detail: 'x' },
        responderGithubUserId: 1,
      },
      throwingSql,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('refusal_on_success_receipt');
  });

  it('refuses a success receipt with no detail — detail is its only payload', async () => {
    for (const detail of [undefined, '', '   ']) {
      const r = await emitP2pReceipt(
        { workspaceId: 'ws-1', potSlug: 'h', kind: 'honored', action: 'delegated-seat:spawn', detail, responderGithubUserId: 1 },
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('detail_required');
    }
  });

  it('classifies honored as NOT refusal-class, so it can never bump the M15 refused-op counters (P-413)', () => {
    expect(isRefusalClassReceiptKind('refusal')).toBe(true);
    expect(isRefusalClassReceiptKind('excused-breach')).toBe(true);
    expect(isRefusalClassReceiptKind('honored')).toBe(false);
  });
});

describe('wire-row validation (X8 taxonomy)', () => {
  it("accepts the new 'honored' kind (mig 723 widened the DB CHECK to match)", () => {
    expect(isP2pReceiptWireRow(wireRow({ kind: 'honored', refusal_code: null, missing_capability: null }))).toBe(true);
    expect(P2P_RECEIPT_KINDS).toContain('honored');
  });

  // The guard still DROPS an unknown kind — accepting an unvalidated one would
  // defeat it — but a newer peer's kind must not vanish without a word, which
  // is the same silent-drop class the 'honored' kind exists to fix.
  it('logs once when it drops a receipt whose kind is newer than this peer, then stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const future = wireRow({ kind: 'settled-in-full' });
      expect(_testing.decodeValue(future)).toBeNull();
      expect(_testing.decodeValue(future)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain('settled-in-full');
      // A MALFORMED row is not taxonomy skew and must not claim to be.
      warn.mockClear();
      expect(_testing.decodeValue(wireRow({ receipt_id: '' }))).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

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
