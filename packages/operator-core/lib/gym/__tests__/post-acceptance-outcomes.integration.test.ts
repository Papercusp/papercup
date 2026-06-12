/**
 * Live-PG tests for gym post-acceptance outcome tracking (P-030 / B-09,
 * self-improvement-consume-edges-2026-06-12). Provisions a throwaway DB with
 * the full live baseline + migrations (so harness_shared.spawned_agents and the
 * 243 gym_champion_outcomes table exist), then proves the whole chain:
 * accept (decideProposal) → baseline row captured atomically → window elapses →
 * finalizePendingChampionOutcomes writes delta + verdict → priming lines render.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym-db-init';
import { decideProposal, recordProposal } from '../control-plane';
import {
  POST_ACCEPTANCE_WINDOW_MS,
  finalizePendingChampionOutcomes,
  gatherChampionOutcomeEntries,
  readLiveRunStats,
  readRecentChampionOutcomes,
} from '../post-acceptance-outcomes';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gympao_${randomBytes(5).toString('hex')}`;
const WS = 'ws-pao';
const HARNESS = 'h-pao';
/** Fixed acceptance instant — every window in the test is computed off this. */
const T = Date.UTC(2026, 0, 10, 12, 0, 0);
const HOUR = 3_600_000;

let spawnSeq = 0;
async function seedRun(q: {
  role: string;
  status: 'done' | 'failed' | 'running' | 'cancelled';
  atMs: number;
  harness?: string;
}): Promise<void> {
  spawnSeq++;
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, status, started_at)
    VALUES (${`sp-${spawnSeq}`}, ${WS}, ${q.harness ?? HARNESS}, 'operator', ${q.role},
            ${`run-${spawnSeq}`}, ${q.status}, ${new Date(q.atMs)})`;
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('readLiveRunStats', () => {
  it('counts only terminal runs of the right role/harness inside the window', async () => {
    // Baseline window [T-72h, T): 6 done + 2 failed for worker …
    for (let i = 0; i < 6; i++) await seedRun({ role: 'worker', status: 'done', atMs: T - 70 * HOUR + i * HOUR });
    for (let i = 0; i < 2; i++) await seedRun({ role: 'worker', status: 'failed', atMs: T - 20 * HOUR + i * HOUR });
    // … plus noise that must NOT count: indeterminate status, other role,
    // other harness, outside the window.
    await seedRun({ role: 'worker', status: 'running', atMs: T - 10 * HOUR });
    await seedRun({ role: 'worker', status: 'cancelled', atMs: T - 10 * HOUR });
    await seedRun({ role: 'validator', status: 'done', atMs: T - 10 * HOUR });
    await seedRun({ role: 'worker', status: 'done', atMs: T - 10 * HOUR, harness: 'other-harness' });
    await seedRun({ role: 'worker', status: 'done', atMs: T - POST_ACCEPTANCE_WINDOW_MS - HOUR });

    const stats = await readLiveRunStats(sql, {
      workspaceId: WS, harnessSlug: HARNESS, role: 'worker',
      fromMs: T - POST_ACCEPTANCE_WINDOW_MS, toMs: T,
    });
    expect(stats).toEqual({ runs: 8, succeeded: 6, failed: 2 });
  });
});

describe('accept → baseline → window elapses → finalize → priming', () => {
  it('decideProposal(accepted) atomically opens a pending outcome row with the live baseline', async () => {
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: HARNESS, cycle: 3, variantId: 'v-1', role: 'worker',
      originalMd: 'old', proposedMd: 'new', rationale: 'tighter checks',
      devAnchorDelta: 0.31, costDelta: -0.02, probeStatus: 'pass',
    });
    const res = await decideProposal(sql, { id, workspaceId: WS, harnessSlug: HARNESS, decision: 'accepted', now: T });
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);

    const rows = await readRecentChampionOutcomes(sql, { workspaceId: WS, harnessSlug: HARNESS });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.proposalId).toBe(id);
    expect(row.role).toBe('worker');
    expect(row.cycle).toBe(3);
    expect(row.acceptedAt).toBe(T);
    expect(row.baseline).toEqual({ runs: 8, succeeded: 6, failed: 2 });
    expect(row.baselineDevAnchorDelta).toBeCloseTo(0.31, 5);
    expect(row.postWindowEndsAt).toBe(T + POST_ACCEPTANCE_WINDOW_MS);
    expect(row.verdict).toBe('pending');
    expect(row.post).toBeNull();
  });

  it('does not finalize before the window elapses', async () => {
    expect(await finalizePendingChampionOutcomes(sql, { workspaceId: WS, now: T + HOUR })).toBe(0);
  });

  it('finalizes a due row with the post-window stats, delta, and verdict', async () => {
    // Post window [T, T+72h): 9 done + 1 failed ⇒ 0.90 vs baseline 0.75 ⇒ improved.
    for (let i = 0; i < 9; i++) await seedRun({ role: 'worker', status: 'done', atMs: T + 2 * HOUR + i * HOUR });
    await seedRun({ role: 'worker', status: 'failed', atMs: T + 30 * HOUR });

    const n = await finalizePendingChampionOutcomes(sql, { workspaceId: WS, now: T + POST_ACCEPTANCE_WINDOW_MS + 1 });
    expect(n).toBe(1);

    const [row] = await readRecentChampionOutcomes(sql, { workspaceId: WS, harnessSlug: HARNESS });
    expect(row.verdict).toBe('improved');
    expect(row.post).toEqual({ runs: 10, succeeded: 9, failed: 1 });
    expect(row.successRateDelta).toBeCloseTo(0.15, 5);
    expect(row.evaluatedAt).toBe(T + POST_ACCEPTANCE_WINDOW_MS + 1);

    // Already finalized ⇒ a re-run finds nothing due.
    expect(await finalizePendingChampionOutcomes(sql, { workspaceId: WS, now: T + POST_ACCEPTANCE_WINDOW_MS + 2 })).toBe(0);
  });

  it('renders the finalized champion as a proposer priming line', async () => {
    const entries = await gatherChampionOutcomeEntries(sql, { workspaceId: WS, harnessSlug: HARNESS });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('[worker · improved]');
    expect(entries[0]).toContain('0.75→0.90');
  });

  it('a judge-role acceptance settles as insufficient-data (no spawned runs by design)', async () => {
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: HARNESS, cycle: 4, variantId: 'v-2', role: 'judge', proposedMd: 'rubric v2',
    });
    await decideProposal(sql, { id, workspaceId: WS, harnessSlug: HARNESS, decision: 'accepted', now: T });
    expect(await finalizePendingChampionOutcomes(sql, { workspaceId: WS, now: T + POST_ACCEPTANCE_WINDOW_MS + 1 })).toBe(1);
    const rows = await readRecentChampionOutcomes(sql, { workspaceId: WS, harnessSlug: HARNESS });
    const judge = rows.find((r) => r.proposalId === id)!;
    expect(judge.verdict).toBe('insufficient-data');
    expect(judge.successRateDelta).toBeNull();
  });

  it('a rejected proposal opens no outcome row', async () => {
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: HARNESS, cycle: 5, variantId: 'v-3', role: 'validator', proposedMd: 'risky',
    });
    const res = await decideProposal(sql, { id, workspaceId: WS, harnessSlug: HARNESS, decision: 'rejected', now: T });
    expect(res.ok).toBe(true);
    const rows = await readRecentChampionOutcomes(sql, { workspaceId: WS, harnessSlug: HARNESS });
    expect(rows.map((r) => r.proposalId)).not.toContain(id);
  });
});
