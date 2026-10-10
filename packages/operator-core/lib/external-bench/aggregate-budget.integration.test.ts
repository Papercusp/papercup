/** Benchmark admission reuses the governor's durable reservation ledger.
 * Real PostgreSQL proves serialization and recovery; no inference is sent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { registerLearningLoop, reserveLearningSpend, settleLearningSpend,
  listLearningSpendReservations, cycleReservationRunRef,
  type LearningReservationResourceBudget } from '../learning-governor/store';
import type { OrgSql } from './reproducibility/db';

const WS = 'benchmark-budget-private-test';
const manifest = 'a'.repeat(64);
let db: FreshPgDb;
let sql: OrgSql;
beforeAll(async () => {
  db = await createFreshPgDb('benchbudget'); sql = db.sql as unknown as OrgSql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql']) {
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n');
    await sql.unsafe(body);
  }
  await sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

const caps = (overrides: Partial<LearningReservationResourceBudget> = {}): LearningReservationResourceBudget => ({
  inputTokens: 1000, outputTokens: 1000, requestsPerArm: 50,
  armIds: ['control:t1:1', 'treatment:t1:1'], usdPerArm: 3, maxOpenUsd: 3,
  wallClockMs: 60_000, wallClockMsPerArm: 30_000, ...overrides,
});
async function setup(budget = caps(), totalUsd = 60) {
  const loopId = `benchmark:${randomUUID()}`;
  await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: totalUsd,
    enabled: true, meta: { reservationBinding: manifest, reservationResourceBudget: budget } });
  return loopId;
}
function request(loopId: string, budget = caps(), armId = budget.armIds[0], requestedUsd = 1,
  role = 'solver', resources = { inputTokens: 1, outputTokens: 1 }) {
  return { workspaceId: WS, loopId, requestedUsd, floorUsd: 0, attemptKind: 'evaluation' as const,
    note: JSON.stringify({ role }), exact: { reservationId: randomUUID(), binding: manifest,
      expectedBudgetUsd: 60, resources: { armId, ...resources }, expectedResourceBudget: budget } };
}
async function settle(input: ReturnType<typeof request>, usedUsd: number, disposition: 'used' | 'failed' | 'cancelled' = 'used') {
  return settleLearningSpend(sql, { workspaceId: WS, reservationId: input.exact.reservationId, usedUsd, disposition });
}

describe('strict benchmark aggregate reservation bounds', () => {
  it('serializes global in-flight exposure across roles and arms without partial grants', async () => {
    const budget = caps(), loop = await setup(budget);
    const results = await Promise.all(['leader', 'solver', 'reviewer', 'selector'].map((role, i) =>
      reserveLearningSpend(sql, request(loop, budget, budget.armIds[i % 2], 1, role))));
    expect(results.filter(r => r.ok)).toHaveLength(3);
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'resource-cap-exceeded' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId: loop });
    expect(rows.reduce((n, r) => n + r.reservedUsd, 0)).toBe(3);
    expect(rows.every(r => r.status === 'open')).toBe(true);
  });

  it('preserves unknown failed-call exposure after controller restart, then releases only measured usage', async () => {
    const budget = caps(), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 3, 'solver');
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    // No settle is authoritative after lost usage. A fresh client sees the open reservation.
    const client = await import('postgres');
    const fresh = client.default(db.url, { max: 1, prepare: false });
    try {
      expect(await reserveLearningSpend(fresh, request(loop, budget, budget.armIds[1], 1, 'retry')))
        .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
      expect((await settle(first, 1, 'failed')).ok).toBe(true);
      expect((await reserveLearningSpend(fresh, request(loop, budget, budget.armIds[1], 2, 'reviewer'))).ok).toBe(true);
    } finally { await fresh.end(); }
  });

  it('counts paid failed work, retries and recovered work toward the same assignment cap', async () => {
    const budget = caps({ maxOpenUsd: 60 }), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 2, 'leader');
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 2, 'failed')).ok).toBe(true);
    const retry = request(loop, budget, budget.armIds[0], 1, 'retry');
    expect((await reserveLearningSpend(sql, retry)).ok).toBe(true);
    expect((await settle(retry, 1)).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 0.000001, 'recovered')))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    expect((await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1], 3, 'selector'))).ok).toBe(true);
  });

  it('enforces the total dollar boundary across assignments', async () => {
    const budget = caps({ maxOpenUsd: 60, usdPerArm: 60 }), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 59);
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 59)).ok).toBe(true);
    expect((await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1], 1))).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 0.000001)))
      .toMatchObject({ ok: false, reason: 'insufficient-headroom' });
  });

  it('does not refund token/request bounds after a measured-zero cancellation', async () => {
    const budget = caps({ inputTokens: 1, outputTokens: 1 }), loop = await setup(budget);
    const first = request(loop, budget); expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 0, 'cancelled')).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1])))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
  });

  it.each(['wallClockMs', 'wallClockMsPerArm'] as const)('persists %s across settlement/recovery', async field => {
    const budget = caps({ wallClockMs: 60_000, wallClockMsPerArm: 60_000, [field]: 1000 }), loop = await setup(budget);
    const first = request(loop, budget); expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 0, 'cancelled')).ok).toBe(true);
    await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = now() - interval '2 seconds' WHERE id = ${first.exact.reservationId}`;
    expect(await reserveLearningSpend(sql, request(loop, budget, field === 'wallClockMs' ? budget.armIds[1] : budget.armIds[0])))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
  });

  it.each(['usdPerArm', 'maxOpenUsd', 'wallClockMs', 'wallClockMsPerArm'] as const)('rejects drift of %s instead of renewing the cap', async field => {
    const budget = caps(), loop = await setup(budget), drift = { ...budget, [field]: budget[field]! + 1 };
    expect(await reserveLearningSpend(sql, request(loop, drift))).toMatchObject({ ok: false, reason: 'stale-binding' });
    const cycle = { runId: randomUUID(), budgetUsd: 60, resources: { armId: budget.armIds[0], inputTokens: 1, outputTokens: 1 }, expectedResourceBudget: budget };
    const id = randomUUID();
    expect(cycleReservationRunRef(cycle, id)).not.toBe(cycleReservationRunRef({ ...cycle, expectedResourceBudget: drift }, id));
  });

  it.each([0, -1, NaN, Infinity, 0.0000001])('refuses invalid monetary policy %s', async usd => {
    const budget = caps({ maxOpenUsd: usd }), loop = await setup(budget);
    expect(await reserveLearningSpend(sql, request(loop, budget))).toMatchObject({ ok: false });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: loop })).toEqual([]);
  });

  it('rejects legacy or foreign-manifest history rather than giving it a zero cost', async () => {
    const budget = caps(), loop = await setup(budget), first = request(loop, budget);
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    await sql`UPDATE harness_shared.learning_spend_reservations SET run_ref = 'foreign-manifest' WHERE id = ${first.exact.reservationId}`;
    expect(await reserveLearningSpend(sql, request(loop, budget))).toMatchObject({ ok: false, reason: 'resource-accounting-incomplete' });
  });
});
