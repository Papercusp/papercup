/**
 * fleet-ekg.integration.test.ts — the EKG's SQL legs over migration 251
 * (self-learning-frontier P-030 / FB-10), against a real provisioned DB
 * (provisionGymDatabase applies 000-baseline + every pending migration, so
 * fleet_ekg_sessions / fleet_ekg_shifts and agent_activity all exist).
 *
 * Round-trips: agent_activity → session grouping (readSessionEvents, incl.
 * the '*' workspace scope and the phase='post' filter); vector upsert
 * idempotence; cohort range reads; shift-row dedup on (workspace, feature,
 * window_date) with notified_at surviving the re-scan; the notify stamp; and
 * the panel snapshot read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import type { DriftResult, AttributedFinding } from './drift';
import { embedSession } from './features';
import {
  markShiftsNotified,
  persistSessionVectors,
  persistShiftRows,
  readCohortVectors,
  readSessionEvents,
} from './scan';
import { readEkgSnapshot } from './ekg-read';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `fekg_${randomBytes(5).toString('hex')}`;
const WS = 'ws-ekg-test';
const T0 = Date.parse('2026-06-10T12:00:00.000Z');

const finding = (over: Partial<AttributedFinding> = {}): AttributedFinding => ({
  feature: 'errorRate',
  kind: 'numeric',
  score: 0.31,
  severity: 'major',
  baselineSummary: 0.05,
  windowSummary: 0.4,
  direction: 'up',
  attributed: false,
  ledgerCandidates: [],
  ...over,
});
const driftResult: DriftResult = { status: 'ok', windowSessions: 10, baselineSessions: 50, findings: [] };

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });

  // Seed one session in the test workspace, one in the '*' scope, one
  // pre-phase row and one foreign-workspace row that must both be excluded.
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({
      ws: WS,
      owner: 'su-a',
      session: 'sess-a',
      tool: i % 3 === 0 ? 'Bash' : 'Read',
      phase: 'post',
      status: i === 5 ? 'error' : 'ok',
      at: T0 + i * 60_000,
    })),
    ...Array.from({ length: 11 }, (_, i) => ({
      ws: '*',
      owner: 'su-b',
      session: 'sess-b',
      tool: 'Edit',
      phase: 'post',
      status: 'ok',
      at: T0 + i * 30_000,
    })),
    { ws: WS, owner: 'su-a', session: 'sess-a', tool: 'Bash', phase: 'pre', status: null, at: T0 },
    { ws: 'other-ws', owner: 'su-c', session: 'sess-c', tool: 'Read', phase: 'post', status: 'ok', at: T0 },
  ];
  for (const r of rows) {
    await sql`
      INSERT INTO harness_shared.agent_activity
        (workspace_id, owner_id, agent, session_id, harness_slug, kind, tool_name, phase, status, created_at)
      VALUES (${r.ws}, ${r.owner}, 'claude', ${r.session}, NULL, 'tool', ${r.tool}, ${r.phase}, ${r.status},
              ${new Date(r.at).toISOString()})`;
  }
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

describe('readSessionEvents (agent_activity grouping)', () => {
  it('groups by (owner, session) across the workspace + the * scope; post-only; other workspaces excluded', async () => {
    const sessions = await readSessionEvents(sql, WS, T0 - 86_400_000);
    const keys = sessions.map((s) => `${s.ownerId}/${s.sessionId}`).sort();
    expect(keys).toEqual(['su-a/sess-a', 'su-b/sess-b']);
    const a = sessions.find((s) => s.ownerId === 'su-a')!;
    expect(a.events).toHaveLength(12); // the phase='pre' row is excluded
    expect(a.events.every((e) => Number.isFinite(e.atMs))).toBe(true);
  });
});

describe('vector store round-trip', () => {
  it('embeds, upserts idempotently, and reads cohorts by ended_at range', async () => {
    const sessions = await readSessionEvents(sql, WS, T0 - 86_400_000);
    const vectors = sessions.map((s) => embedSession(s)!).filter(Boolean);
    expect(vectors.length).toBe(2);
    await persistSessionVectors(sql, WS, vectors);
    await persistSessionVectors(sql, WS, vectors); // re-run = update, not duplicate
    const count = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.fleet_ekg_sessions WHERE workspace_id = ${WS}`;
    expect(count[0].n).toBe(2);

    const all = await readCohortVectors(sql, WS, T0 - 3600_000, T0 + 3600_000);
    expect(all).toHaveLength(2);
    const a = all.find((v) => v.ownerId === 'su-a')!;
    expect(a.eventCount).toBe(12);
    expect(a.features.errorRate).toBeCloseTo(1 / 12);
    expect(a.toolMix.read).toBe(8);
    expect(a.bigrams).toBeTypeOf('object');

    const none = await readCohortVectors(sql, WS, T0 + 3600_000, T0 + 7200_000);
    expect(none).toEqual([]);
  });
});

describe('shift rows — dedup, notify stamp, snapshot read', () => {
  it('upserts per (workspace, feature, window_date); notified_at survives the re-scan', async () => {
    const windowStart = T0;
    const windowEnd = T0 + 86_400_000;

    const first = await persistShiftRows(sql, WS, windowStart, windowEnd, driftResult, [finding()]);
    expect(first).toHaveLength(1);
    expect(first[0].alreadyNotified).toBe(false);

    await markShiftsNotified(sql, WS, [first[0].id]);

    // Re-scan of the same window day: same row id, updated score, prior
    // notify preserved and reported.
    const second = await persistShiftRows(sql, WS, windowStart, windowEnd, driftResult, [
      finding({ score: 0.5 }),
    ]);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].alreadyNotified).toBe(true);

    const rows = await sql<{ score: number; notified_at: Date | null }[]>`
      SELECT score, notified_at FROM harness_shared.fleet_ekg_shifts
       WHERE workspace_id = ${WS} AND feature = 'errorRate'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].score)).toBeCloseTo(0.5);
    expect(rows[0].notified_at).not.toBeNull();
  });

  it('readEkgSnapshot projects shifts + vitals', async () => {
    await persistShiftRows(sql, WS, T0, T0 + 86_400_000, driftResult, [
      finding({
        feature: 'toolMix',
        kind: 'mix',
        severity: 'moderate',
        baselineSummary: null,
        windowSummary: null,
        direction: null,
        attributed: true,
        ledgerCandidates: [
          {
            id: 'chg-1',
            source: 'gym:accept',
            mutationClass: 'gym',
            target: 'papercup/worker',
            recordedAt: new Date(T0).toISOString(),
            summary: 'champion accepted',
          },
        ],
      }),
    ]);
    const snap = await readEkgSnapshot(sql, WS);
    expect(snap.totalShifts).toBe(2);
    expect(snap.unattributedShifts).toBe(1);
    expect(snap.sessionsEmbedded).toBe(2);
    expect(snap.scannedAt).not.toBeNull();
    const mix = snap.shifts.find((s) => s.feature === 'toolMix')!;
    expect(mix.attributed).toBe(true);
    expect(mix.ledgerCandidates[0]).toMatchObject({ id: 'chg-1', source: 'gym:accept' });
  });
});
