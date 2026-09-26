/**
 * store.integration.test.ts — learning-governor SQL over migration 244
 * (self-learning-frontier P-003 / FB-01). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 244's learning_governor_loops / learning_spend_events exist),
 * then round-trips: register/upsert semantics (preserve vs overwrite),
 * recordLearningSpend accumulate modes, governorCheck against live rows
 * (the spend-until-exhausted lifecycle), and the ledger reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { summarizeLearningSpend } from './core';
import {
  deleteLearningLoop,
  getLearningLoop,
  getLearningSpendPositions,
  governorCheck,
  listLearningLoops,
  listLearningSpendEvents,
  listLearningSpendReservations,
  recordLearningSpend,
  registerLearningLoop,
  reserveLearningSpend,
  settleLearningSpend,
  sumOpenReservedUsd,
} from './store';
import { setPotLearningScope } from '../learning/pot-gate/store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `lgov_${randomBytes(5).toString('hex')}`;
const WS = 'ws-gov-test';

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
  // Budget is MEASURED, not guessed (2026-09-04): on this box getTestPg() returns
  // in ~1.2s and provisionGymDatabase() takes ~165s, because it re-applies all 934
  // migrations serially into a fresh database on EVERY run. Against the family's
  // customary 180_000 that leaves ~8% headroom, so ordinary fleet load tips the hook
  // over and Vitest cancels — reporting `Hook timed out` with 26 assertions COLLECTED
  // BUT NOT RUN, which reads like a red suite while actually producing no evidence
  // either way. 180_000 also exactly equals TESTCONTAINER_START_LOCK_TIMEOUT_MS, whose
  // contract asks callers to leave headroom so the lock's own diagnostic can surface
  // instead of being cancelled first. The provisioning COST is the real defect and is
  // tracked separately (template-database reuse via the existing getOrBuildTemplate);
  // this budget just stops that cost from silently masquerading as a P-005 failure.
}, 420_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  // Best-effort: the reused test container is shared across vitest processes
  // on the dev box — a concurrent suite's teardown can stop it first (404).
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

describe('exact manifest-bound reservations', () => {
  const binding = 'a'.repeat(64);
  const register = async (budgetUsd = 10) => {
    const loopId = `exact:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd,
      meta: { reservationBinding: binding } });
    return loopId;
  };
  const request = (loopId: string, requestedUsd: number, reservationId = randomUUID(), expectedBudgetUsd = 10) => ({
    workspaceId: WS, loopId, requestedUsd, floorUsd: 0,
    exact: { reservationId, binding, expectedBudgetUsd },
  });

  it('grants only one of two simultaneous requests that cannot both fit in full', async () => {
    const loopId = await register();
    const results = await Promise.all([reserveLearningSpend(sql, request(loopId, 6)),
      reserveLearningSpend(sql, request(loopId, 6))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'insufficient-headroom' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestedUsd: 6, reservedUsd: 6, status: 'open' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(6);
  });

  it('refuses concurrent and settled replays instead of returning an old grant', async () => {
    const loopId = await register();
    const input = request(loopId, 1);
    const results = await Promise.all([reserveLearningSpend(sql, input), reserveLearningSpend(sql, input)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'already-reserved' });
    const [row] = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(row!.runRef).toBe(`manifest:${binding}/attempt:${input.exact.reservationId}`);
    await settleLearningSpend(sql, { workspaceId: WS, reservationId: row!.id, disposition: 'used', usedUsd: 1 });
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'already-reserved' });
  });

  it('uses the existing global UUID key to prevent reuse across registration locks', async () => {
    const loops = await Promise.all([register(), register()]);
    const reservationId = randomUUID();
    const results = await Promise.all(loops.map(loop => reserveLearningSpend(sql, request(loop, 1, reservationId))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'already-reserved' });
  });

  it('fails closed for missing/stale bindings, cap changes, disabled loops and legacy bypass', async () => {
    const loopId = await register();
    expect(await reserveLearningSpend(sql, { ...request(loopId, 1), exact: undefined }))
      .toMatchObject({ ok: false, reason: 'binding-required' });
    expect(await reserveLearningSpend(sql, { ...request(loopId, 1), exact: {
      ...request(loopId, 1).exact, binding: 'b'.repeat(64) } })).toMatchObject({ ok: false, reason: 'stale-binding' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 9 });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'stale-binding' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 10, enabled: false });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'disabled' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, enabled: true, budgetKind: 'per-cycle' });
    expect(await reserveLearningSpend(sql, request(loopId, 1)))
      .toMatchObject({ ok: false, reason: 'unsupported-budget-kind' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', meta: {} });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'stale-binding' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it('uses exact microdollar headroom and refuses sub-microdollar input', async () => {
    const loopId = await register(0.3);
    expect((await reserveLearningSpend(sql, request(loopId, 0.1, randomUUID(), 0.3))).ok).toBe(true);
    expect((await reserveLearningSpend(sql, request(loopId, 0.2, randomUUID(), 0.3))).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loopId, 0.000001, randomUUID(), 0.3)))
      .toMatchObject({ ok: false, reason: 'insufficient-headroom' });
    expect(await reserveLearningSpend(sql, request(loopId, 0.0000001, randomUUID(), 0.3)))
      .toMatchObject({ ok: false, reason: 'invalid-exact-request' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(0.3);
  });

  it('requires a transaction-capable connection before reading or granting', async () => {
    const input = request('does-not-exist', 1);
    expect(await reserveLearningSpend({} as postgres.Sql, input))
      .toMatchObject({ ok: false, reason: 'transaction-required' });
  });
});

describe('registry — register/get/list', () => {
  it('registers a loop with defaults and reads it back', async () => {
    const reg = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:replay' });
    expect(reg).toMatchObject({
      workspaceId: WS,
      loopId: 'frontier:replay',
      displayName: 'frontier:replay',
      budgetKind: 'lifetime',
      budgetUsd: null,
      spentUsd: 0,
      priority: 100,
      enabled: true,
      enforcement: 'governor',
    });
    expect(reg.registeredAt).toBeGreaterThan(0);
    const got = await getLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:replay' });
    expect(got?.displayName).toBe('frontier:replay');
  });

  it('upsert preserves omitted fields and registered_at; explicit fields overwrite', async () => {
    const first = await registerLearningLoop(sql, {
      workspaceId: WS,
      loopId: 'gym:alpha',
      displayName: 'Gym autoloop (alpha)',
      budgetUsd: 20,
      spentUsd: 2,
      priority: 50,
      enforcement: 'native',
    });
    const second = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha', budgetUsd: 30 });
    expect(second.budgetUsd).toBe(30);
    expect(second.spentUsd).toBe(2); // omitted ⇒ preserved
    expect(second.displayName).toBe('Gym autoloop (alpha)');
    expect(second.priority).toBe(50);
    expect(second.enforcement).toBe('native');
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it('budgetUsd null CLEARS the cap; undefined preserves it', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner', budgetUsd: 5 });
    const preserved = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner' });
    expect(preserved.budgetUsd).toBe(5);
    const cleared = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner', budgetUsd: null });
    expect(cleared.budgetUsd).toBeNull();
  });

  it('lists the workspace registry in priority order', async () => {
    const loops = await listLearningLoops(sql, { workspaceId: WS });
    expect(loops.length).toBeGreaterThanOrEqual(3);
    const priorities = loops.map((l) => l.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(loops.some((l) => l.loopId === 'gym:alpha')).toBe(true);
  });

  it('deleteLearningLoop drops the registration (P-021 dissolve teardown) and is idempotent', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed', budgetUsd: 5 });
    expect(await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).not.toBeNull();
    expect(await deleteLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toEqual({ deleted: true });
    expect(await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toBeNull();
    // A second delete (or a never-registered loop) is a no-op, not an error.
    expect(await deleteLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toEqual({ deleted: false });
  });
});

describe('spend ledger — recordLearningSpend + events', () => {
  it('accumulate:true bumps the registration spent atomically with the event', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'scout:alpha', budgetKind: 'per-cycle', budgetUsd: 1 });
    const ev = await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'scout:alpha',
      costUsd: 0.4,
      runRef: 'scout-1',
      note: 'scout ideation cycle',
    });
    expect(ev.costUsd).toBe(0.4);
    expect(ev.signalOrigin).toBe('organic');
    const reg = await getLearningLoop(sql, { workspaceId: WS, loopId: 'scout:alpha' });
    expect(reg?.spentUsd).toBe(0.4);
  });

  it('accumulate:false ledgers the event without touching the registration (gym mirror mode)', async () => {
    const before = await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'gym:alpha',
      costUsd: 1.25,
      runRef: 'gym-cycle:alpha',
      accumulate: false,
    });
    const after = await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    expect(after?.spentUsd).toBe(before?.spentUsd);
    const events = await listLearningSpendEvents(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ costUsd: 1.25, runRef: 'gym-cycle:alpha' });
  });

  it('rejects a negative/NaN cost', async () => {
    await expect(
      recordLearningSpend(sql, { workspaceId: WS, loopId: 'scout:alpha', costUsd: -1 }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      recordLearningSpend(sql, { workspaceId: WS, loopId: 'scout:alpha', costUsd: Number.NaN }),
    ).rejects.toThrow(/non-negative/);
  });

  it('carries non-organic provenance (P-002/D-002 vocabulary) and rejects junk origins via the CHECK', async () => {
    const ev = await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'frontier:replay',
      costUsd: 0.1,
      signalOrigin: 'replay',
      accumulate: false,
    });
    expect(ev.signalOrigin).toBe('replay');
    await expect(
      recordLearningSpend(sql, {
        workspaceId: WS,
        loopId: 'frontier:replay',
        costUsd: 0.1,
        // @ts-expect-error — junk origin must die at the DB CHECK too
        signalOrigin: 'synthetic',
      }),
    ).rejects.toThrow();
  });

  it('lists workspace-wide events newest-first with the loop filter', async () => {
    const all = await listLearningSpendEvents(sql, { workspaceId: WS });
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    const scoped = await listLearningSpendEvents(sql, { workspaceId: WS, loopId: 'scout:alpha' });
    expect(scoped.every((e) => e.loopId === 'scout:alpha')).toBe(true);
  });
});

describe('governorCheck — the unattended-refusal lifecycle on live rows', () => {
  it('unregistered ⇒ refuse', async () => {
    expect(await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:nope' })).toEqual({
      allow: false,
      reason: 'unregistered',
      remainingUsd: null,
    });
  });

  it('registered but unbudgeted ⇒ refuse (frontier:replay has no cap yet)', async () => {
    const v = await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:replay' });
    expect(v.reason).toBe('unbudgeted');
  });

  it('budgeted ⇒ allow; spend past the floor ⇒ exhausted', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:ekg', budgetUsd: 2 });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).allow).toBe(true);
    await recordLearningSpend(sql, { workspaceId: WS, loopId: 'frontier:ekg', costUsd: 1.8 });
    const v = await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' });
    expect(v).toEqual({ allow: false, reason: 'exhausted', remainingUsd: expect.closeTo(0.2, 6) });
  });

  it('disabled ⇒ refuse', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:ekg', enabled: false });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).reason).toBe('disabled');
  });
});

describe('governorCheck — the per-pot master switch (learning-pot-scope-gate D-001)', () => {
  const POT = 'gated-pot';
  const LOOP = 'frontier:in-a-pot';

  it('allows a healthy loop while its pot has no scope row (fail-open, R-5)', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: LOOP, potSlug: POT, budgetUsd: 5 });
    // Control for the two assertions below: without it, a gate that refused
    // everything would look identical to a gate that works.
    expect((await governorCheck(sql, { workspaceId: WS, loopId: LOOP })).allow).toBe(true);
  });

  it('refuses with pot-disabled once the pot is switched off — through the real relation', async () => {
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: false, setBy: 'su-test' });
    const v = await governorCheck(sql, { workspaceId: WS, loopId: LOOP });
    expect(v.reason).toBe('pot-disabled');
    expect(v.allow).toBe(false);
  });

  it('leaves the loop\'s OWN registration untouched, so switching the pot back on restores it', async () => {
    // The lane never learns it was gated: `enabled` is still true and its
    // budget is intact, which is why the restore needs no bookkeeping.
    const reg = await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP });
    expect(reg?.enabled).toBe(true);
    expect(reg?.budgetUsd).toBe(5);

    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: true, setBy: 'su-test' });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: LOOP })).allow).toBe(true);
  });

  it('does not gate a POT-LESS loop, whatever the scope table holds', async () => {
    // frontier:ekg carries no pot_slug; a disabled row for some other pot must
    // not reach it, or the gate would silently widen to every legacy loop.
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: false, setBy: 'su-test' });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).reason).toBe('disabled');
  });
});

describe('the one visible number (P-003 verification)', () => {
  it('summarize over the live registry rolls every registrant into one total', async () => {
    const loops = await listLearningLoops(sql, { workspaceId: WS });
    const s = summarizeLearningSpend(loops);
    expect(s.loopCount).toBe(loops.length);
    // scout:alpha accumulated 0.4, frontier:ekg 1.8; gym mirror spend stays on its own row value.
    expect(s.totalSpentUsd).toBeCloseTo(loops.reduce((a, l) => a + l.spentUsd, 0), 6);
    expect(s.unbudgetedLoopIds).toContain('frontier:miner');
  });
});

/* ── reservation + settlement (P-005), migration 1116 ────────────────────── */

describe('spend reservation + settlement — every attempt closes', () => {
  const LOOP = 'frontier:reserve-test';

  beforeAll(async () => {
    await registerLearningLoop(sql, {
      workspaceId: WS,
      loopId: LOOP,
      budgetKind: 'lifetime',
      budgetUsd: 10,
    });
  });

  it('opens an attempt, and the reservation is immediately visible as unsettled', async () => {
    const res = await reserveLearningSpend(sql, {
      workspaceId: WS,
      loopId: LOOP,
      attemptKind: 'proposer',
      requestedUsd: 2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation).toMatchObject({ reservedUsd: 2, usedUsd: 0, status: 'open' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: LOOP })).toBeCloseTo(2, 6);

    // Settling releases it from the open pool and charges the real cost.
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.5,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation).toMatchObject({ status: 'settled', usedUsd: 0.5 });
    expect(settled.releasedUsd).toBeCloseTo(1.5, 6);
    expect(settled.event?.costUsd).toBeCloseTo(0.5, 6);
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: LOOP })).toBeCloseTo(0, 6);
    // The charge accumulated onto the registration, as recordLearningSpend does.
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd).toBeCloseTo(0.5, 6);
  });

  it('a CANCELLED attempt closes with no charge and no spend event', async () => {
    const before = (await listLearningSpendEvents(sql, { workspaceId: WS, loopId: LOOP })).length;
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'cancelled',
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation.status).toBe('cancelled');
    expect(settled.event).toBeNull();
    // The reservation row IS the record that the attempt happened and cost
    // nothing — exactly what the `costUsd > 0` guards used to drop.
    expect((await listLearningSpendEvents(sql, { workspaceId: WS, loopId: LOOP })).length).toBe(before);
    const cancelled = await listLearningSpendReservations(sql, {
      workspaceId: WS,
      loopId: LOOP,
      status: 'cancelled',
    });
    expect(cancelled.map((r) => r.id)).toContain(res.reservation.id);
  });

  it('a FAILED attempt still charges what it burned before throwing', async () => {
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    if (!res.ok) throw new Error('reservation refused');
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'failed',
      usedUsd: 0.25,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation).toMatchObject({ status: 'failed', usedUsd: 0.25 });
    // The charge is linked back to the attempt that made it.
    expect(settled.event?.costUsd).toBeCloseTo(0.25, 6);
  });

  it('settling twice is refused rather than double-charging', async () => {
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    if (!res.ok) throw new Error('reservation refused');
    const spentBefore = (await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd;
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.3,
    });
    const again = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.3,
    });
    expect(again).toMatchObject({ ok: false, reason: 'already-settled' });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd).toBeCloseTo(
      spentBefore + 0.3,
      6,
    );
  });

  it('governorCheck counts OPEN reservations as spend — the concurrency guarantee', async () => {
    const loopId = 'frontier:concurrency-test';
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 4 });
    const before = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(before).toMatchObject({ allow: true });
    expect(before.remainingUsd).toBeCloseTo(4, 6);

    // One attempt in flight takes the budget down to the floor: the gate now
    // refuses a SECOND attempt even though nothing has been charged yet.
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 4 });
    if (!res.ok) throw new Error('reservation refused');
    expect(res.reservation.reservedUsd).toBeCloseTo(3.5, 6); // 4 − 0.5 floor
    const during = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(during).toMatchObject({ allow: false, reason: 'exhausted' });
    const second = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 1 });
    expect(second).toMatchObject({ ok: false, reason: 'no-headroom' });

    // Settling for less than reserved returns the remainder to headroom.
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.5,
    });
    const after = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(after).toMatchObject({ allow: true });
    expect(after.remainingUsd).toBeCloseTo(3.5, 6);
  });

  it('refuses fail-closed on an unbudgeted loop', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:no-budget', budgetUsd: null });
    expect(
      await reserveLearningSpend(sql, {
        workspaceId: WS,
        loopId: 'frontier:no-budget',
        requestedUsd: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'unbudgeted', headroomUsd: null });
  });

  it('exposes requested, reserved, used and unsettled SEPARATELY', async () => {
    const loopId = 'frontier:positions-test';
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 20 });
    const done = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 5 });
    if (!done.ok) throw new Error('reservation refused');
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: done.reservation.id,
      disposition: 'used',
      usedUsd: 2,
    });
    const open = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 3 });
    if (!open.ok) throw new Error('reservation refused');

    const { positions, spend } = await getLearningSpendPositions(sql, { workspaceId: WS, loopId });
    expect(positions).toMatchObject({
      requestedUsd: 8,
      reservedUsd: 8,
      usedUsd: 2,
      unsettledUsd: 3,
      openAttempts: 1,
    });
    // The same four numbers, in the shape a learning contract embeds.
    expect(spend).toMatchObject({ requestedUsd: 8, reservedUsd: 8, usedUsd: 2, unsettledUsd: 3 });
    expect(spend.settledAt).toBeUndefined(); // work still in flight ⇒ not settled
  });
});
