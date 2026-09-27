import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ unsafe: vi.fn() }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: (...args: unknown[]) => db.unsafe(...args) } }),
}));

import {
  issuePilotParticipantBindingReceipt,
  issuePilotParticipantDispatchReceipt,
  persistPilotParticipantBindingReceipt,
  persistPilotParticipantDispatchReceipt,
  validatePilotParticipantReceiptCohort,
  type PilotParticipantBindingReceipt,
  type PilotParticipantDispatchReceipt,
} from './pilot-participant-receipts';

const claimVersion = '2026-08-27T07:20:00.000Z';

function binding(
  receiptId: string,
  itemId: string,
  ownerId: string,
  sessionId: string,
  role: PilotParticipantBindingReceipt['role'],
  version = claimVersion,
  at = 100,
): PilotParticipantBindingReceipt {
  return { receiptId, itemId, ownerId, sessionId, role, claimVersion: version, bindingIssuedAtMs: at };
}

function dispatch(
  receiptId: string,
  source: PilotParticipantBindingReceipt,
  at = source.bindingIssuedAtMs,
): PilotParticipantDispatchReceipt {
  return {
    receiptId,
    bindingReceiptId: source.receiptId,
    itemId: source.itemId,
    ownerId: source.ownerId,
    sessionId: source.sessionId,
    role: source.role,
    dispatchedAtMs: at,
  };
}

beforeEach(() => db.unsafe.mockReset());

describe('pilot participant receipt authority', () => {
  it('server-issues ids/times and never lets dispatch predate binding', () => {
    const b = issuePilotParticipantBindingReceipt(
      { itemId: 'WI-1', ownerId: 'su-1', sessionId: 'session-1', role: 'solo', claimVersion },
      () => 200,
      () => 'binding-1',
    );
    const d = issuePilotParticipantDispatchReceipt(b, () => 150, () => 'dispatch-1');

    expect(b).toMatchObject({ receiptId: 'binding-1', bindingIssuedAtMs: 200 });
    expect(d).toMatchObject({ receiptId: 'dispatch-1', bindingReceiptId: 'binding-1', dispatchedAtMs: 200 });
  });

  it('accepts canonical solo and director+implementer role shapes', () => {
    const solo = binding('b-solo', 'WI-SOLO', 'su-solo', 'session-solo', 'solo');
    const director = binding('b-director', 'WI-PAIR', 'su-director', 'session-director', 'director',
      '2026-08-27T07:19:00.000Z');
    const implementer = binding('b-implementer', 'WI-PAIR', 'su-implementer', 'session-implementer', 'implementer');
    const validation = validatePilotParticipantReceiptCohort([
      {
        id: 'WI-SOLO', expectedOwnerId: 'su-solo', expectedClaimVersion: claimVersion,
        payload: { pilotBindingReceipts: [solo], pilotDispatchReceipts: [dispatch('d-solo', solo)] },
      },
      {
        id: 'WI-PAIR', expectedOwnerId: 'su-implementer', expectedClaimVersion: claimVersion,
        payload: {
          pilotBindingReceipts: [director, implementer],
          pilotDispatchReceipts: [dispatch('d-director', director), dispatch('d-implementer', implementer)],
        },
      },
    ]);

    expect(validation).toEqual(expect.objectContaining({ ok: true, errors: [] }));
    expect(validation.participantsByItem['WI-PAIR'].map((entry) => entry.role)).toEqual([
      'director', 'implementer',
    ]);
  });

  it('rejects cross-item owner/session reuse and non-canonical dispatch linkage', () => {
    const first = binding('b-1', 'WI-1', 'su-reused', 'session-reused', 'solo');
    const second = binding('b-2', 'WI-2', 'su-reused', 'session-reused', 'solo');
    const badDispatch = { ...dispatch('d-2', second, 50), sessionId: 'session-forged' };
    const validation = validatePilotParticipantReceiptCohort([
      {
        id: 'WI-1', expectedOwnerId: 'su-reused', expectedClaimVersion: claimVersion,
        payload: { pilotBindingReceipts: [first], pilotDispatchReceipts: [dispatch('d-1', first)] },
      },
      {
        id: 'WI-2', expectedOwnerId: 'su-reused', expectedClaimVersion: claimVersion,
        payload: { pilotBindingReceipts: [second], pilotDispatchReceipts: [badDispatch] },
      },
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toMatch(/ownerId .* re-used|sessionId .* re-used/);
    expect(validation.errors.join('\n')).toMatch(/does not match|predates/);
  });
});

describe('pilot receipt PG CAS', () => {
  it('appends a binding only under the exact run-owned taken_by+taken_at claim', async () => {
    db.unsafe
      .mockResolvedValueOnce([{ session_id: 'session-1' }])
      .mockResolvedValueOnce([{ feature_id: 'WI-1' }]);

    const receipt = await persistPilotParticipantBindingReceipt({
      workspaceId: 'ws-1', harnessSlug: 'papercusp', itemId: 'WI-1', ownerId: 'su-1',
      claimVersion, role: 'solo',
    });

    expect(receipt).toMatchObject({ itemId: 'WI-1', ownerId: 'su-1', sessionId: 'session-1' });
    const [query, params] = db.unsafe.mock.calls[1];
    expect(query).toMatch(/taken_by = \$4.*date_trunc\('milliseconds', taken_at\) = \$5::timestamptz/s);
    expect(params.slice(0, 5)).toEqual(['ws-1', 'papercusp', 'WI-1', 'su-1', claimVersion]);
  });

  it('fails loudly when the binding claimVersion CAS no longer matches', async () => {
    db.unsafe.mockResolvedValueOnce([{ session_id: 'session-1' }]).mockResolvedValueOnce([]);

    await expect(persistPilotParticipantBindingReceipt({
      workspaceId: 'ws-1', harnessSlug: 'papercusp', itemId: 'WI-1', ownerId: 'su-1',
      claimVersion, role: 'solo',
    })).rejects.toThrow(/CAS refused/);
  });

  it('links dispatch to the stored binding and re-CASes its claimVersion', async () => {
    const source = binding('binding-1', 'WI-1', 'su-1', 'session-1', 'director');
    db.unsafe
      .mockResolvedValueOnce([{ session_id: 'session-1' }])
      .mockResolvedValueOnce([{ payload: { pilotBindingReceipts: [source] } }])
      .mockResolvedValueOnce([{ feature_id: 'WI-1' }]);

    const receipt = await persistPilotParticipantDispatchReceipt({
      workspaceId: 'ws-1', harnessSlug: 'papercusp', itemId: 'WI-1',
      bindingReceiptId: 'binding-1', ownerId: 'su-1',
    });

    expect(receipt).toMatchObject({ bindingReceiptId: 'binding-1', sessionId: 'session-1', role: 'director' });
    const [query, params] = db.unsafe.mock.calls[2];
    expect(query).toMatch(/taken_by = \$4.*date_trunc\('milliseconds', taken_at\) = \$5::timestamptz.*receipt->>'receiptId' = \$6/s);
    expect(params.slice(0, 6)).toEqual([
      'ws-1', 'papercusp', 'WI-1', 'su-1', claimVersion, 'binding-1',
    ]);
  });
});
