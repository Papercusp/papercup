/**
 * P-106 (p2p-work-distribution-2026-07-02) unit tests: the revocation reaper.
 * The plan item IS the spec — "revoking a peer/publisher reaps in-flight foreign
 * sessions + [P-102-gated] cancels unclaimed offers. Acceptance: revoke mid-run
 * → terminated + receipt." These cover the buildable-now half: the pure live-
 * session selector and the reap-orchestration (fail-close to `reaped` + refusal
 * receipt), exercised with INJECTED deps so no live Postgres is needed (matching
 * grant-store.test.ts's stubbed-sql style).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REAPABLE_STATES,
  foreignSessionMatchesRevocation,
  reapForeignSessionsForRevocation,
  type ReaperDeps,
} from './revocation-reaper';
import type { ForeignWorkspace, ForeignWorkspaceState } from './foreign-workspaces';
import type { OrgSql } from '../work-items';

const sqlStub = {} as unknown as OrgSql;

/** Build a foreign-workspace row with sensible defaults. */
function ws(partial: Partial<ForeignWorkspace> = {}): ForeignWorkspace {
  return {
    workspaceId: 'ws1',
    offerId: 'offer-A',
    fleetSlug: 'fleet-x',
    originGithubUserId: 777,
    executorDevice: 'exec-dev==',
    rootPath: '/quota/foreign/offer-A',
    clonePath: '/quota/foreign/offer-A/clone',
    sessionId: 'sess-A',
    executionEpoch: 0,
    state: 'active',
    parkReason: null,
    baseSha: null,
    ...partial,
  };
}

/** Mock deps that record calls; setForeignWorkspaceState echoes the row as `reaped`. */
function makeDeps(rows: ForeignWorkspace[], overrides: Partial<ReaperDeps> = {}) {
  const setState = vi.fn(
    async (workspaceId: string, offerId: string, state: ForeignWorkspaceState, opts: { parkReason?: string } = {}) => {
      const row = rows.find((r) => r.offerId === offerId);
      return row ? { ...row, state, parkReason: opts.parkReason ?? null } : null;
    },
  );
  const emit = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true as const, receipt: { receiptId: 'r' } as never }));
  const list = vi.fn(async () => rows);
  const deps: Partial<ReaperDeps> = {
    listForeignWorkspaces: list as unknown as ReaperDeps['listForeignWorkspaces'],
    setForeignWorkspaceState: setState as unknown as ReaperDeps['setForeignWorkspaceState'],
    emitP2pReceipt: emit as unknown as ReaperDeps['emitP2pReceipt'],
    ...overrides,
  };
  return { deps, list, setState, emit };
}

describe('REAPABLE_STATES (the live-session set)', () => {
  it('is exactly provisioning/active/winding-down — terminal states excluded', () => {
    expect([...REAPABLE_STATES]).toEqual(['provisioning', 'active', 'winding-down']);
    expect(REAPABLE_STATES).not.toContain('parked');
    expect(REAPABLE_STATES).not.toContain('reaped');
  });
});

describe('foreignSessionMatchesRevocation (pure selector)', () => {
  it('grant-revoked matches a live session of the revoked fleet', () => {
    expect(
      foreignSessionMatchesRevocation(ws({ fleetSlug: 'fleet-x', state: 'active' }), {
        kind: 'grant-revoked',
        fleetSlug: 'fleet-x',
      }),
    ).toBe(true);
  });

  it('grant-revoked does NOT match a different fleet', () => {
    expect(
      foreignSessionMatchesRevocation(ws({ fleetSlug: 'fleet-y' }), { kind: 'grant-revoked', fleetSlug: 'fleet-x' }),
    ).toBe(false);
  });

  it('grant-revoked matches provisioning + winding-down (still live), but not terminal', () => {
    for (const state of ['provisioning', 'winding-down'] as const) {
      expect(foreignSessionMatchesRevocation(ws({ state }), { kind: 'grant-revoked', fleetSlug: 'fleet-x' })).toBe(true);
    }
    for (const state of ['parked', 'reaped'] as const) {
      expect(foreignSessionMatchesRevocation(ws({ state }), { kind: 'grant-revoked', fleetSlug: 'fleet-x' })).toBe(false);
    }
  });

  it('publisher-revoked matches by origin github user id, across fleets', () => {
    expect(
      foreignSessionMatchesRevocation(ws({ originGithubUserId: 777, fleetSlug: 'anything' }), {
        kind: 'publisher-revoked',
        originGithubUserId: 777,
      }),
    ).toBe(true);
    expect(
      foreignSessionMatchesRevocation(ws({ originGithubUserId: 999 }), { kind: 'publisher-revoked', originGithubUserId: 777 }),
    ).toBe(false);
  });
});

describe('reapForeignSessionsForRevocation (orchestration)', () => {
  const base = { hiveSlug: 'my-hive', responderGithubUserId: 42 };

  it('reaps exactly the live sessions the grant revocation covers + emits a receipt each', async () => {
    const rows = [
      ws({ offerId: 'A', fleetSlug: 'fleet-x', state: 'active', originGithubUserId: 777 }),
      ws({ offerId: 'B', fleetSlug: 'fleet-y', state: 'active' }), // different fleet — spared
      ws({ offerId: 'C', fleetSlug: 'fleet-x', state: 'provisioning', originGithubUserId: 888 }),
      ws({ offerId: 'D', fleetSlug: 'fleet-x', state: 'reaped' }), // already terminal — idempotent skip
    ];
    const { deps, setState, emit } = makeDeps(rows);
    const res = await reapForeignSessionsForRevocation(
      { ...base, workspaceId: 'ws1', trigger: { kind: 'grant-revoked', fleetSlug: 'fleet-x' } },
      sqlStub,
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reaped.map((r) => r.offerId).sort()).toEqual(['A', 'C']);
    expect(res.receiptsEmitted).toBe(2);
    expect(res.receiptFailures).toBe(0);

    // fail-close: transitioned to 'reaped' with a revocation park_reason
    expect(setState).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenCalledWith('ws1', 'A', 'reaped', { parkReason: 'revocation:grant-revoked' }, sqlStub);

    // receipt shape: refusal / code grant-revoked / action work-offer:reap / threaded offer + origin
    expect(emit).toHaveBeenCalledTimes(2);
    const firstArgs = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstArgs).toMatchObject({
      kind: 'refusal',
      action: 'work-offer:reap',
      offerId: 'A',
      responderGithubUserId: 42,
      requester: { ref: 'fleet-x', githubUserId: 777 },
    });
    expect((firstArgs.refusal as { code: string }).code).toBe('grant-revoked');
  });

  it('publisher revocation reaps by origin user across fleets', async () => {
    const rows = [
      ws({ offerId: 'A', fleetSlug: 'fleet-x', originGithubUserId: 777 }),
      ws({ offerId: 'B', fleetSlug: 'fleet-z', originGithubUserId: 777 }),
      ws({ offerId: 'C', fleetSlug: 'fleet-x', originGithubUserId: 111 }), // other publisher — spared
    ];
    const { deps } = makeDeps(rows);
    const res = await reapForeignSessionsForRevocation(
      { ...base, workspaceId: 'ws1', trigger: { kind: 'publisher-revoked', originGithubUserId: 777 } },
      sqlStub,
      deps,
    );
    expect(res.ok && res.reaped.map((r) => r.offerId).sort()).toEqual(['A', 'B']);
  });

  it('refuses loudly on an unresolvable workspace WITHOUT touching the registry', async () => {
    const { deps, list, setState } = makeDeps([ws()]);
    const res = await reapForeignSessionsForRevocation(
      { ...base, workspaceId: null, trigger: { kind: 'grant-revoked', fleetSlug: 'fleet-x' } },
      sqlStub,
      deps,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.code).toBe('workspace_unresolved');
    expect(list).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it('refuses without a hive slug (receipts are hive-scoped)', async () => {
    const { deps, list } = makeDeps([ws()]);
    const res = await reapForeignSessionsForRevocation(
      { workspaceId: 'ws1', hiveSlug: '  ', responderGithubUserId: 42, trigger: { kind: 'grant-revoked', fleetSlug: 'fleet-x' } },
      sqlStub,
      deps,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.code).toBe('hive_required');
    expect(list).not.toHaveBeenCalled();
  });

  it('counts a receipt failure but still reaps the session and continues the sweep', async () => {
    const rows = [
      ws({ offerId: 'A', fleetSlug: 'fleet-x' }),
      ws({ offerId: 'B', fleetSlug: 'fleet-x' }),
    ];
    const emit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, refusal: { code: 'boom', detail: 'x' } })
      .mockResolvedValueOnce({ ok: true, receipt: {} });
    const { deps, setState } = makeDeps(rows, {
      emitP2pReceipt: emit as unknown as ReaperDeps['emitP2pReceipt'],
    });
    const res = await reapForeignSessionsForRevocation(
      { ...base, workspaceId: 'ws1', trigger: { kind: 'grant-revoked', fleetSlug: 'fleet-x' } },
      sqlStub,
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reaped).toHaveLength(2); // both reaped
    expect(setState).toHaveBeenCalledTimes(2);
    expect(res.receiptsEmitted).toBe(1);
    expect(res.receiptFailures).toBe(1);
  });

  it('is a clean no-op when nothing matches', async () => {
    const { deps, setState, emit } = makeDeps([ws({ fleetSlug: 'fleet-y' })]);
    const res = await reapForeignSessionsForRevocation(
      { ...base, workspaceId: 'ws1', trigger: { kind: 'grant-revoked', fleetSlug: 'fleet-x' } },
      sqlStub,
      deps,
    );
    expect(res.ok && res.reaped).toHaveLength(0);
    expect(setState).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
