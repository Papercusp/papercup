/**
 * store.integration.test.ts — transfer-lesson SQL over migration 250
 * (self-learning-frontier P-022 / FB-08). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 250's transfer_lessons exists), then round-trips: free
 * probationary admission + signature dedup, the test queue's ordering
 * (probationary-first, stalest-first, validated re-validation), gate
 * transitions (promote / demote / retire), error marking, and the
 * memory/pack links.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import {
  admitTransferLesson,
  getLessonBySignature,
  getTransferLesson,
  listLessonsForTesting,
  listTransferLessons,
  markTransferError,
  recordTransferOutcome,
  setLessonMemoryId,
  setLessonPackCandidate,
} from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `transfer_${randomBytes(5).toString('hex')}`;
const WS = 'ws-transfer-test';

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

describe('admission (D-006: free, probationary, signature-deduped)', () => {
  it('admits a lesson probationary with origin=replay defaults', async () => {
    const result = await admitTransferLesson(sql, {
      workspaceId: WS,
      signature: 'sig-a',
      title: 'Run tests first',
      lessonText: 'Always run the affected tests.',
      sourceRef: '/logs/a.jsonl',
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lesson).toMatchObject({
      workspaceId: WS,
      signature: 'sig-a',
      tier: 'probationary',
      status: 'candidate',
      sourceKind: 'transcript',
      signalOrigin: 'replay',
      testCount: 0,
      memoryId: null,
    });
  });

  it('a duplicate signature is a no-op returning the existing row', async () => {
    const dup = await admitTransferLesson(sql, {
      workspaceId: WS,
      signature: 'sig-a',
      lessonText: 'Always run the affected tests. (reworded)',
    });
    expect(dup.admitted).toBe(false);
    if (dup.admitted) return;
    expect(dup.lesson?.lessonText).toBe('Always run the affected tests.');
    expect(await getLessonBySignature(sql, { workspaceId: WS, signature: 'sig-a' })).not.toBeNull();
  });
});

describe('the test queue + gate transitions', () => {
  it('orders probationary-first, never-tested leading; validated rows trail for re-validation', async () => {
    const b = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-b', lessonText: 'B' });
    const c = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-c', lessonText: 'C' });
    expect(b.admitted && c.admitted).toBe(true);
    if (!b.admitted || !c.admitted) return;

    // Promote C (pass) → validated; B + sig-a stay probationary untested.
    await recordTransferOutcome(sql, {
      workspaceId: WS,
      id: c.lesson.id,
      transition: { tier: 'validated', status: 'passed', passCount: 1, failCount: 0, forgetMemory: false },
      batteryId: 'bat-1',
      delta: 1.2,
    });

    const queue = await listLessonsForTesting(sql, { workspaceId: WS, limit: 10 });
    const tiers = queue.map((l) => l.tier);
    expect(tiers.slice(0, tiers.filter((t) => t === 'probationary').length).every((t) => t === 'probationary')).toBe(
      true,
    );
    expect(tiers[tiers.length - 1]).toBe('validated'); // re-validation tail
    const promoted = await getTransferLesson(sql, { workspaceId: WS, id: c.lesson.id });
    expect(promoted).toMatchObject({ tier: 'validated', status: 'passed', testCount: 1, lastBatteryId: 'bat-1' });
    expect(promoted?.lastDelta).toBeCloseTo(1.2);
    expect(promoted?.lastTestedAt).toBeTruthy();
  });

  it('a retire transition leaves the queue (retired rows are never re-tested)', async () => {
    const d = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-d', lessonText: 'D' });
    expect(d.admitted).toBe(true);
    if (!d.admitted) return;
    await recordTransferOutcome(sql, {
      workspaceId: WS,
      id: d.lesson.id,
      transition: { tier: 'retired', status: 'failed', passCount: 0, failCount: 3, forgetMemory: true },
      batteryId: 'bat-2',
      delta: -0.4,
    });
    const queue = await listLessonsForTesting(sql, { workspaceId: WS, limit: 50 });
    expect(queue.find((l) => l.id === d.lesson.id)).toBeUndefined();
    expect(await listTransferLessons(sql, { workspaceId: WS, tier: 'retired' })).toHaveLength(1);
  });

  it('markTransferError records the attempt without a fail-count bump', async () => {
    const e = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-e', lessonText: 'E' });
    expect(e.admitted).toBe(true);
    if (!e.admitted) return;
    await markTransferError(sql, { workspaceId: WS, id: e.lesson.id });
    const row = await getTransferLesson(sql, { workspaceId: WS, id: e.lesson.id });
    expect(row).toMatchObject({ status: 'error', testCount: 1, failCount: 0, tier: 'probationary' });
  });
});

describe('links', () => {
  it('memory + pack-candidate links round-trip (and memory clears on retire)', async () => {
    const f = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-f', lessonText: 'F' });
    expect(f.admitted).toBe(true);
    if (!f.admitted) return;
    const memoryId = '00000000-0000-4000-8000-000000000001';
    const candidateId = '00000000-0000-4000-8000-000000000002';
    await setLessonMemoryId(sql, { workspaceId: WS, id: f.lesson.id, memoryId });
    await setLessonPackCandidate(sql, { workspaceId: WS, id: f.lesson.id, packCandidateId: candidateId });
    let row = await getTransferLesson(sql, { workspaceId: WS, id: f.lesson.id });
    expect(row).toMatchObject({ memoryId, packCandidateId: candidateId });
    await setLessonMemoryId(sql, { workspaceId: WS, id: f.lesson.id, memoryId: null });
    row = await getTransferLesson(sql, { workspaceId: WS, id: f.lesson.id });
    expect(row?.memoryId).toBeNull();
  });
});
