/**
 * P-413 (p2p-public-release-remaining-lanes-2026-07-16, Phase 3 attestation +
 * trust-closure re-verify): `bumpRefusedOpCounter` recurrence guard.
 *
 * D-001 ships v1 with foreign-work spawn LIVE and NO sandbox/containment — the
 * trust layer IS the safety boundary, and `p2p_refused_op_counters` is the
 * ONLY artifact proving it actually refused something. Every call site across
 * the codebase (the p2p-receipts / p2p-peer-grants federation identity gates,
 * boot.ts's scoped-announce refusal, the foreign-op guard, emitP2pReceipt)
 * treats the bump as best-effort and swallows a rejection — correct, since a
 * bookkeeping failure must never block or mask the refusal itself. But that
 * meant a PG failure INSIDE the bump was previously a fully SILENT no-op: the
 * op was refused, yet the one piece of evidence that it was refused could
 * vanish with no trace anywhere. This guards the fix: the bump must (a) never
 * throw to its caller, and (b) log loudly on failure, so a persistent
 * counter-write failure stays diagnosable instead of silently disappearing.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { bumpRefusedOpCounter } from './receipts';
import type { OrgSql } from '../work-items';

const sqlCalls = (fn: (...args: unknown[]) => unknown): OrgSql => fn as unknown as OrgSql;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bumpRefusedOpCounter (M15 trust-layer evidence counter)', () => {
  it('issues the upsert with the given workspace/pot/reason on success', async () => {
    const calls: unknown[][] = [];
    const okSql = sqlCalls((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([]);
    });
    await bumpRefusedOpCounter({ workspaceId: 'ws-1', potSlug: 'hive-a', reason: 'receipt-apply:responder_mismatch' }, okSql);
    expect(calls).toHaveLength(1);
    // Tagged-template call: (strings, ...values) — the values array carries
    // our three args in source order.
    const [, ...values] = calls[0]!;
    expect(values).toEqual(['ws-1', 'hive-a', 'receipt-apply:responder_mismatch']);
  });

  it('NEVER throws when the underlying write fails (never blocks/masks the refusal it is counting)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boomSql = sqlCalls(() => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(
      bumpRefusedOpCounter({ workspaceId: 'ws-1', potSlug: 'hive-a', reason: 'receipt-apply:identity_unresolved' }, boomSql),
    ).resolves.toBeUndefined();
  });

  it('logs loudly (not a silent no-op) when the write fails, naming workspace/pot/reason for diagnosis', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boomSql = sqlCalls(() => {
      throw new Error('relation "p2p_refused_op_counters" does not exist');
    });
    await bumpRefusedOpCounter({ workspaceId: 'ws-9', potSlug: 'hive-z', reason: 'grant-apply:no_author_device' }, boomSql);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = errSpy.mock.calls[0]!;
    expect(String(msg)).toContain('ws-9');
    expect(String(msg)).toContain('hive-z');
    expect(String(msg)).toContain('grant-apply:no_author_device');
    expect(String(msg)).toMatch(/refused-op-counter/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('a rejected (not thrown) write is swallowed identically', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejectingSql = sqlCalls(() => Promise.reject(new Error('lock_timeout')));
    await expect(
      bumpRefusedOpCounter({ workspaceId: 'ws-1', potSlug: 'hive-a', reason: 'deny:role_envelope' }, rejectingSql),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
