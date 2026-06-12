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
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { summarizeLearningSpend } from './core';
import {
  getLearningLoop,
  governorCheck,
  listLearningLoops,
  listLearningSpendEvents,
  recordLearningSpend,
  registerLearningLoop,
} from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `lgov_${randomBytes(5).toString('hex')}`;
const WS = 'ws-gov-test';

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

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
