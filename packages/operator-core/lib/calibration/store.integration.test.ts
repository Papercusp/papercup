/**
 * store.integration.test.ts — calibration-markets SQL over migration 253
 * (self-learning-frontier P-041 / FB-13). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 253's calibration_predictions exists), then round-trips:
 * insert + the one-open-bet-per-lane conflict, the matured scan, resolution
 * vs voiding (voided rows never scored), origin partitioning (D-002), and the
 * per-persona Brier aggregation the ranker feature + calibration:summary read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import {
  bouncedFixCounts,
  calibrationScores,
  insertPrediction,
  listMaturedUnresolved,
  openBetCounts,
  openBetsForSubjects,
  resolvePrediction,
  voidPrediction,
  type InsertPredictionInput,
} from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `calib_${randomBytes(5).toString('hex')}`;
const WS = 'ws-calib-test';

const PAST = '2026-06-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';
const NOW = '2026-06-12T00:00:00.000Z';

function bet(over: Partial<InsertPredictionInput> = {}): InsertPredictionInput {
  return {
    workspaceId: WS,
    predictor: 'su-a',
    domain: 'fix-survival',
    subjectKind: 'improvement',
    subjectId: 'EI-1',
    claim: 'fix survives',
    probability: 0.8,
    stated: false,
    origin: 'organic',
    horizonTs: PAST,
    ...over,
  };
}

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

describe('insert — the one-open-bet-per-lane rule', () => {
  it('inserts, then no-ops a second open bet on the same lane', async () => {
    const first = await insertPrediction(sql, bet());
    expect(first.created).toBe(true);
    const dup = await insertPrediction(sql, bet({ probability: 0.3 }));
    expect(dup).toEqual({ created: false, id: null });
  });

  it('a different predictor/domain/subject is its own lane', async () => {
    expect((await insertPrediction(sql, bet({ predictor: 'su-b' }))).created).toBe(true);
    expect((await insertPrediction(sql, bet({ domain: 'flake-recurrence', watchdogKey: 'flake:x' }))).created).toBe(true);
    expect((await insertPrediction(sql, bet({ subjectId: 'EI-2' }))).created).toBe(true);
  });
});

describe('maturity + resolution lifecycle', () => {
  it('lists only matured open bets, oldest horizon first', async () => {
    await insertPrediction(sql, bet({ predictor: 'su-fresh', subjectId: 'EI-3', horizonTs: FUTURE }));
    const matured = await listMaturedUnresolved(sql, { workspaceId: WS, nowIso: NOW });
    expect(matured.length).toBeGreaterThanOrEqual(4);
    expect(matured.every((m) => m.horizonTs <= Date.parse(NOW))).toBe(true);
    expect(matured.some((m) => m.subjectId === 'EI-3')).toBe(false);
  });

  it('resolution flips an OPEN row exactly once; the lane reopens for new bets', async () => {
    const matured = await listMaturedUnresolved(sql, { workspaceId: WS, nowIso: NOW });
    const target = matured.find((m) => m.predictor === 'su-a' && m.domain === 'fix-survival')!;
    expect(await resolvePrediction(sql, { id: target.id, outcome: false, note: 're-captured', nowIso: NOW })).toBe(true);
    expect(await resolvePrediction(sql, { id: target.id, outcome: true, nowIso: NOW })).toBe(false);
    // The partial-unique lane is freed by resolution — a new bet records.
    expect((await insertPrediction(sql, bet({ probability: 0.6 }))).created).toBe(true);
  });

  it('voiding closes a row with NULL outcome', async () => {
    const matured = await listMaturedUnresolved(sql, { workspaceId: WS, nowIso: NOW });
    const target = matured.find((m) => m.predictor === 'su-b')!;
    expect(await voidPrediction(sql, { id: target.id, note: 'subject vanished', nowIso: NOW })).toBe(true);
    const stillOpen = await listMaturedUnresolved(sql, { workspaceId: WS, nowIso: NOW });
    expect(stillOpen.some((m) => m.id === target.id)).toBe(false);
  });
});

describe('reads the feature + summary consume', () => {
  it('openBetsForSubjects / openBetCounts are organic-only by default (D-002)', async () => {
    await insertPrediction(
      sql,
      bet({ predictor: 'red-queen', subjectId: 'EI-1', origin: 'drill', domain: 'flake-recurrence', watchdogKey: 'flake:drill' }),
    );
    const open = await openBetsForSubjects(sql, { workspaceId: WS, subjectIds: ['EI-1', 'EI-2'] });
    expect(open.every((b) => b.origin === 'organic')).toBe(true);
    const counts = await openBetCounts(sql, { workspaceId: WS });
    const total = counts.reduce((s, c) => s + c.open, 0);
    const withDrill = await openBetsForSubjects(sql, {
      workspaceId: WS,
      subjectIds: ['EI-1', 'EI-2'],
      origins: ['organic', 'drill'],
    });
    expect(withDrill.length).toBeGreaterThan(open.length);
    expect(total).toBeGreaterThan(0);
  });

  it('bouncedFixCounts counts only FAILED fix-survival rows', async () => {
    const bounced = await bouncedFixCounts(sql, { workspaceId: WS, subjectIds: ['EI-1', 'EI-2'] });
    expect(bounced.get('EI-1')).toBe(1); // the outcome:false resolution above
    expect(bounced.has('EI-2')).toBe(false);
  });

  it('calibrationScores aggregates scored rows only, weight attached', async () => {
    // su-a has exactly one scored bet: p=0.8, outcome=false → brier 0.64.
    const scores = await calibrationScores(sql, { workspaceId: WS, predictor: 'su-a' });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ predictor: 'su-a', domain: 'fix-survival', n: 1, baseRate: 0 });
    expect(scores[0].brier).toBeCloseTo(0.64, 10);
    expect(scores[0].weight).toBeGreaterThan(0.4); // shrunk toward neutral on n=1
    expect(scores[0].weight).toBeLessThan(0.5);
    // The voided su-b row and the drill row never enter scoring.
    expect(await calibrationScores(sql, { workspaceId: WS, predictor: 'su-b' })).toHaveLength(0);
    expect(await calibrationScores(sql, { workspaceId: WS, predictor: 'red-queen' })).toHaveLength(0);
  });
});
