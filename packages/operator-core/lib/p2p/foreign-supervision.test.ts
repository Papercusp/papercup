import { describe, expect, it, vi } from 'vitest';
import {
  decideSupervision,
  superviseForeignSessions,
  windDownForeignSession,
  SUPERVISED_STATES,
  type SupervisionDeps,
} from './foreign-supervision';
import { decideWindDown } from './offer-budget';
import type { ForeignWorkspace } from './foreign-workspaces';

const NOW = 1_000_000;
const TTL = 30_000;
const ORPHAN_T = 120_000;

const healthy = {
  cancelSignalSeen: false,
  lastConfirmedAt: NOW - 1_000,
  originLastSeenAt: NOW - 1_000,
  now: NOW,
  livenessTtlMs: TTL,
  orphanAfterMs: ORPHAN_T,
};

describe('decideSupervision (pure)', () => {
  it('healthy session: null (leave it running)', () => {
    expect(decideSupervision(healthy)).toBeNull();
  });

  it('H12: an explicit cancel wins — excused breach', () => {
    const d = decideSupervision({ ...healthy, cancelSignalSeen: true });
    expect(d?.cause).toBe('cancelled');
    expect(d?.receiptKind).toBe('excused-breach');
  });

  it('H12: liveness unconfirmable past the TTL — refusal-class wind-down', () => {
    const d = decideSupervision({ ...healthy, lastConfirmedAt: NOW - TTL - 1 });
    expect(d?.cause).toBe('liveness_unconfirmable');
    expect(d?.receiptKind).toBe('refusal');
  });

  it('H13: origin never seen ⇒ fail-closed wind-down', () => {
    const d = decideSupervision({ ...healthy, originLastSeenAt: null });
    expect(d?.cause).toBe('liveness_unconfirmable');
    expect(d?.detail).toContain('H13');
  });

  it('H13: origin unreachable for > T ⇒ wind-down naming the age', () => {
    const d = decideSupervision({ ...healthy, originLastSeenAt: NOW - ORPHAN_T - 5_000 });
    expect(d?.detail).toContain('H13');
    expect(d?.detail).toContain(`${ORPHAN_T + 5_000}ms`);
  });

  it('clock skew never winds down (negative ages on both checks)', () => {
    expect(
      decideSupervision({ ...healthy, lastConfirmedAt: NOW + 10_000, originLastSeenAt: NOW + 10_000 }),
    ).toBeNull();
  });
});

const row = (over: Partial<ForeignWorkspace> = {}): ForeignWorkspace => ({
  workspaceId: 'ws-1',
  offerId: 'offer-1',
  fleetSlug: 'fleet-a',
  originGithubUserId: 42,
  executorDevice: 'dev-host',
  rootPath: '/foreign/offer-1',
  clonePath: '/foreign/offer-1/repo',
  sessionId: 'sess-9',
  executionEpoch: 7,
  state: 'active',
  parkReason: null,
  baseSha: 'abc',
  ...over,
});

function makeDeps(rows: ForeignWorkspace[], over: Partial<SupervisionDeps> = {}) {
  const receipts: any[] = [];
  const deps: SupervisionDeps = {
    listForeignWorkspaces: vi.fn(async () => rows) as any,
    setForeignWorkspaceState: vi.fn(async (_ws: string, offerId: string) =>
      row({ offerId, state: 'winding-down' }),
    ) as any,
    emitP2pReceipt: vi.fn(async (a: any) => {
      receipts.push(a);
      return { ok: true as const, receipt: {} as any };
    }) as any,
    livenessInput: vi.fn(async () => ({ cancelSignalSeen: false, lastConfirmedAt: NOW - 1_000 })),
    originLastSeenAt: vi.fn(async () => NOW - 1_000),
    ...over,
  };
  return { deps, receipts };
}

const args = {
  workspaceId: 'ws-1',
  potSlug: 'hive-h',
  responderGithubUserId: 99,
  now: NOW,
  livenessTtlMs: TTL,
  orphanAfterMs: ORPHAN_T,
};

describe('superviseForeignSessions', () => {
  it('cancelled offer → guarded winding-down transition + excused-breach receipt', async () => {
    const { deps, receipts } = makeDeps([row()], {
      livenessInput: vi.fn(async () => ({ cancelSignalSeen: true, lastConfirmedAt: NOW - 1_000 })),
    });
    const res = await superviseForeignSessions(args, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.woundDown).toEqual([
      { offerId: 'offer-1', fleetSlug: 'fleet-a', cause: 'cancelled', receiptKind: 'excused-breach' },
    ]);
    const setCall = (deps.setForeignWorkspaceState as any).mock.calls[0];
    expect(setCall[2]).toBe('winding-down');
    expect(setCall[3].fromStates).toEqual(SUPERVISED_STATES);
    expect(receipts[0].kind).toBe('excused-breach');
    expect(receipts[0].action).toBe('work-offer:wind-down');
    expect(receipts[0].offerId).toBe('offer-1');
  });

  it('healthy sessions are left alone; winding-down/parked rows are not swept', async () => {
    const { deps } = makeDeps([row(), row({ offerId: 'o2', state: 'winding-down' }), row({ offerId: 'o3', state: 'parked' })]);
    const res = await superviseForeignSessions(args, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.swept).toBe(1); // only the 'active' row
    expect(res.woundDown).toHaveLength(0);
    expect(deps.setForeignWorkspaceState).not.toHaveBeenCalled();
  });

  it('an unreadable liveness input fails CLOSED for that session (H12)', async () => {
    const { deps, receipts } = makeDeps([row()], {
      livenessInput: vi.fn(async () => {
        throw new Error('coord unreachable');
      }),
    });
    const res = await superviseForeignSessions(args, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.woundDown[0]?.cause).toBe('liveness_unconfirmable');
    expect(receipts[0].refusal.detail).toContain('coord unreachable');
  });

  it('C3: unresolvable workspace partition refuses the whole sweep', async () => {
    const { deps } = makeDeps([row()]);
    const res = await superviseForeignSessions({ ...args, workspaceId: '*' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('workspace_unresolved');
    expect(deps.listForeignWorkspaces).not.toHaveBeenCalled();
  });
});

describe('windDownForeignSession', () => {
  const wdArgs = {
    workspaceId: 'ws-1',
    potSlug: 'hive-h',
    responderGithubUserId: 99,
    offerId: 'offer-1',
    fleetSlug: 'fleet-a',
    originGithubUserId: 42,
  };

  it('P-107 exhaustion path: transition + refusal receipt carrying the axis', async () => {
    const { deps, receipts } = makeDeps([]);
    const res = await windDownForeignSession(
      { ...wdArgs, decision: decideWindDown('budget_exhausted', { axis: 'remote' }) },
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.transitioned).toBe(true);
    expect(res.receiptEmitted).toBe(true);
    expect(receipts[0].kind).toBe('refusal');
    expect(receipts[0].budgetAxis).toBe('remote');
    expect(receipts[0].refusal.code).toBe('budget_exhausted');
  });

  it('raced to terminal: no transition, NO receipt (idempotent, no double-emit)', async () => {
    const { deps, receipts } = makeDeps([], {
      setForeignWorkspaceState: vi.fn(async () => null) as any,
    });
    const res = await windDownForeignSession({ ...wdArgs, decision: decideWindDown('cancelled') }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.transitioned).toBe(false);
    expect(receipts).toHaveLength(0);
  });

  it('a receipt failure never un-transitions the row', async () => {
    const { deps } = makeDeps([], {
      emitP2pReceipt: vi.fn(async () => {
        throw new Error('pg down');
      }) as any,
    });
    const res = await windDownForeignSession({ ...wdArgs, decision: decideWindDown('cancelled') }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.transitioned).toBe(true);
    expect(res.receiptEmitted).toBe(false);
  });
});
