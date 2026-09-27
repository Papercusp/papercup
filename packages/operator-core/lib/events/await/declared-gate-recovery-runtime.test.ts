/**
 * Runtime wiring for the declared-gate recovery contract
 * (plan declared-gate-recovery-contract-2026-09-21): the evidence reader shared
 * by events:status and the await sweeper, and the sweeper hook that turns a
 * timed-out wait on an ANNOUNCED key into an exact next verb + one idempotent
 * escalation per generation — while every other timed-out wait keeps the
 * generic timeout wake (fail-open).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  findAnnouncementsForKey: vi.fn(),
  probeKeyFireEvidence: vi.fn(),
}));
vi.mock('./store', () => store);
vi.mock('./installed-events', () => ({ readInstalledUnitEvents: vi.fn(async () => []) }));

import {
  annotateTimedOutAnnouncedAwaits,
  defaultDeclaredGateRecoveryDeps,
  gatherDeclaredGateEvidence,
  probeCatalogMembership,
  probeFireHistory,
  toDeclaredGateAnnouncement,
} from './declared-gate-recovery-runtime';
import type { DeclaredGateEvidenceInput, DeclaredGateRecoveryDeps } from './declared-gate-recovery';
import type { AwaitRow } from './types';

function row(over: Partial<AwaitRow> = {}): AwaitRow {
  return {
    id: 7,
    workspaceId: 'ws-test',
    subscriberId: 'su-declarer',
    eventKey: 'gate:invented:key',
    policy: 'announce',
    note: null,
    wakeHandle: null,
    timeoutBehavior: 'wake',
    expiresTs: null,
    createdAt: '2026-09-27T00:00:00.000Z',
    firedAt: null,
    firedReason: null,
    cancelledAt: null,
    cancelReason: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: 'global',
    scopeRef: null,
    causalGeneration: 2,
    supersededAt: null,
    expectedCondition: null,
    ...over,
  } as AwaitRow;
}

const noFires = { prefix: 'gate:invented', exact: false, distinctKeys: 0, fires: 0, lastFiredAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  store.probeKeyFireEvidence.mockResolvedValue(noFires);
  store.findAnnouncementsForKey.mockResolvedValue([]);
});

describe('evidence reader', () => {
  it('maps a declaration row through the ONE state/expected-verdict derivation events:status uses', () => {
    const fired = row({ firedAt: 't', firedReason: 'event', expectedCondition: { kind: 'sha', sha: 'ABC' }, firedPayload: { sha: 'abc' } });
    expect(toDeclaredGateAnnouncement(fired)).toMatchObject({ id: 7, generation: 2, state: 'fired', expectedVerdict: 'matched' });
    expect(toDeclaredGateAnnouncement(row({ supersededAt: 't' })).state).toBe('superseded');
  });

  it('catalog membership recognises a catalogued family and misses an invented key', async () => {
    await expect(probeCatalogMembership('work-item:done:WI-1')).resolves.toMatchObject({ status: 'measured', value: { member: true } });
    await expect(probeCatalogMembership('gate:invented:key')).resolves.toMatchObject({ status: 'measured', value: { member: false } });
  });

  it('fire history counts only an EARLIER generation’s real event fire', async () => {
    const history = [
      row({ id: 7, causalGeneration: 2 }),
      row({ id: 6, causalGeneration: 1, firedAt: 't', firedReason: 'event', supersededAt: 't2' }),
    ];
    await expect(probeFireHistory(row(), history)).resolves.toEqual({
      status: 'measured',
      value: { exactFired: false, familyFires: 0, priorGenerationFired: true, lastFiredAt: null },
    });
    const expiredOnly = [row({ id: 6, causalGeneration: 1, firedAt: 't', firedReason: 'expired' })];
    await expect(probeFireHistory(row(), expiredOnly)).resolves.toMatchObject({ value: { priorGenerationFired: false } });
  });

  it('an unreadable fire latch is UNAVAILABLE, not zero fires', async () => {
    store.probeKeyFireEvidence.mockRejectedValueOnce(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await probeFireHistory(row(), []);
    warn.mockRestore();
    expect(r).toMatchObject({ status: 'unavailable' });
  });

  it('gather composes the probes and honours a pre-resolved ownership', async () => {
    const evidence = await gatherDeclaredGateEvidence(row(), {
      ownership: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: [] } },
      history: [row()],
      nowMs: 1,
    });
    expect(evidence).toMatchObject({
      announcement: { id: 7, eventKey: 'gate:invented:key', generation: 2, state: 'declared' },
      currentGeneration: 2,
      catalog: { status: 'measured', value: { member: false } },
      fireHistory: { status: 'measured', value: { exactFired: false, familyFires: 0 } },
      ownership: { status: 'measured' },
      producer: null,
      checkedAtMs: 1,
    });
  });
});

describe('annotateTimedOutAnnouncedAwaits — the sweeper hook', () => {
  const waiter = (id: number, eventKey = 'gate:invented:key') =>
    row({ id, policy: 'wake', subscriberId: `su-waiter-${id}`, eventKey, causalGeneration: null });

  function neverFireableEvidence(declaration: AwaitRow): DeclaredGateEvidenceInput {
    return {
      announcement: toDeclaredGateAnnouncement(declaration),
      currentGeneration: declaration.causalGeneration ?? null,
      catalog: { status: 'measured', value: { member: false, nearMiss: [] } },
      fireHistory: { status: 'measured', value: { exactFired: false, familyFires: 0, priorGenerationFired: false, lastFiredAt: null } },
      ownership: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: [] } },
      producer: null,
      checkedAtMs: 1,
    };
  }

  function bridge(): DeclaredGateRecoveryDeps & { upsertCondition: ReturnType<typeof vi.fn> } {
    return {
      readCurrentDeclaration: vi.fn(async () => ({ generation: 2, state: 'declared' as const })),
      upsertCondition: vi.fn(async () => ({ id: 'WI-1', created: true })),
      wakeOwner: vi.fn(async () => ({ queued: 1 })),
    };
  }

  it('annotates every waiter on an announced key, evaluates and acts ONCE per key', async () => {
    const declaration = row();
    const deps = bridge();
    const gather = vi.fn(async (d: AwaitRow) => neverFireableEvidence(d));
    const out = await annotateTimedOutAnnouncedAwaits([waiter(101), waiter(102)], {
      findCurrentDeclaration: async () => declaration,
      gather,
      bridgeDeps: () => deps,
    });
    expect([...out.keys()]).toEqual([101, 102]);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(deps.upsertCondition).toHaveBeenCalledTimes(1);
    expect(out.get(101)).toMatchObject({
      event: 'gate:invented:key',
      announcement_id: 7,
      generation: 2,
      classification: 'never-fireable',
      next_verb: { verb: 'events:cancel', args: { announcement_id: 7, expected_generation: 2 } },
      action: { action: 'advisory-recorded', workItemId: 'WI-1' },
    });
    expect(String(out.get(101)?.rule)).toMatch(/timeout stays a timeout/);
    expect(out.get(102)).toBe(out.get(101));
  });

  it('keys with no announcement, and pattern keys, are left to the generic timeout wake', async () => {
    const find = vi.fn(async () => null);
    const out = await annotateTimedOutAnnouncedAwaits([waiter(1, 'plain:key'), waiter(2, 'release:green:*')], {
      findCurrentDeclaration: find,
    });
    expect(out.size).toBe(0);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('plain:key');
  });

  it('fail-open: an evaluation failure leaves that key generic without affecting others', async () => {
    const deps = bridge();
    const out = await annotateTimedOutAnnouncedAwaits([waiter(1, 'gate:a'), waiter(2, 'gate:b')], {
      findCurrentDeclaration: async (key) => row({ eventKey: key }),
      gather: async (d) => {
        if (d.eventKey === 'gate:a') throw new Error('boom');
        return neverFireableEvidence(d);
      },
      bridgeDeps: () => deps,
    });
    expect(out.has(1)).toBe(false);
    expect(out.get(2)).toMatchObject({ classification: 'never-fireable' });
  });

  it('a bridge failure still hands the waiter its classification and next verb', async () => {
    const deps = bridge();
    deps.upsertCondition.mockRejectedValueOnce(new Error('unique index timeout'));
    const out = await annotateTimedOutAnnouncedAwaits([waiter(1)], {
      findCurrentDeclaration: async () => row(),
      gather: async (d) => neverFireableEvidence(d),
      bridgeDeps: () => deps,
    });
    expect(out.get(1)).toMatchObject({
      classification: 'never-fireable',
      next_verb: { verb: 'events:cancel' },
      action: { action: 'none', detail: expect.stringMatching(/bridge failed/) },
    });
  });

  it('the production CAS read reports the key’s current declaration state', async () => {
    store.findAnnouncementsForKey.mockResolvedValueOnce([row({ causalGeneration: 5, cancelledAt: 't' })]);
    await expect(defaultDeclaredGateRecoveryDeps(row()).readCurrentDeclaration('gate:invented:key')).resolves.toEqual({
      generation: 5,
      state: 'cancelled',
    });
    expect(store.findAnnouncementsForKey).toHaveBeenCalledWith('gate:invented:key', { includeCancelled: true });
  });
});
