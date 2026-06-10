/**
 * runs.integration.test.ts — the plan_runs / plan_run_turns DAL walked
 * end-to-end against real Postgres (port of the long-skipped P-027
 * "needs org-pg fixture" suite, plan-agent-launch-2026-05-21 Phase 3).
 *
 * The org-pg fixture the old skip note waited for exists now: the shared
 * baseline-schema globalSetup stands up the COMPLETE harness_shared schema
 * from the real migration set, and `setupPlanPgFixture` re-points the
 * tools' own `getOrgPg*()` connections at it — so this drives the REAL
 * `withWorkspace` path (harness_app role) with zero mocking, exactly as
 * `concurrency.integration.test.ts` does.
 *
 * Covers the current DAL surface:
 *   - insertPlanRun / getPlanRun round-trip (BIGINT coercion included);
 *   - appendPlanRunTurn's `max+1` seq allocation (returns the seq);
 *   - readPlanRunTranscript: ordering, cursor pagination, substring
 *     query (with LIKE-metachar literalness — escapeLikePattern walked
 *     live), beforeTs upper bound, unknown-session empty page;
 *   - listPlanRuns: newest-first, per-run turnCount, harness scoping;
 *   - setPlanRunStatus / markPlanRunResumed (archived → running
 *     reactivation, D-010, + content-hash re-stamp for P-023);
 *   - sweepPlanRuns (P-016): orphaned running → failed, stale idle →
 *     archived, fresh/mid-aged rows untouched, idempotency.
 *
 * Cleans up its throwaway rows (scoped by a unique harness slug).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  appendPlanRunTurn,
  getPlanRun,
  insertPlanRun,
  listPlanRuns,
  markPlanRunResumed,
  PLAN_RUN_IDLE_ARCHIVE_MS,
  PLAN_RUN_ORPHAN_FAIL_MS,
  readPlanRunTranscript,
  setPlanRunStatus,
  sweepPlanRuns,
} from '../runs';
import { setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

// Unique-per-run harness slug: scopes every row this suite creates, so
// cleanup is one DELETE and the suite can never collide with (or sweep)
// another suite's rows.
const HARNESS = `zzz-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUITE_SLUG = `plan-run-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SWEEP_SLUG = `${SUITE_SLUG}-sweep`;
const LIKE_SLUG = `${SUITE_SLUG}-like`;
const SESSION_A = crypto.randomUUID();
const SESSION_B = crypto.randomUUID();
const SESSION_LIKE = crypto.randomUUID();

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

let fx: PlanPgFixture;
let admin: postgres.Sql;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  // Turns first (FK), then runs — everything this suite made is under HARNESS.
  await admin`
    DELETE FROM harness_shared.plan_run_turns
     WHERE plan_run_id IN (
       SELECT id FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}
     )
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}
  `.catch(() => {});
  await fx?.dispose();
});

describe('plan_runs round-trip (P-027)', () => {
  let runId: number;

  it('insertPlanRun returns a positive numeric id', async () => {
    runId = await insertPlanRun({
      planSlug: SUITE_SLUG,
      harnessSlug: HARNESS,
      planContentHash: HASH_A,
      sessionId: SESSION_A,
      note: 'launch with a note',
      launchedBy: 'test@example.com',
      title: 'integration launch',
      status: 'running',
    });
    expect(typeof runId).toBe('number');
    expect(runId).toBeGreaterThan(0);
  });

  it('getPlanRun returns the row we just inserted, fully coerced', async () => {
    const row = await getPlanRun(runId);
    expect(row).not.toBeNull();
    expect(row!.planSlug).toBe(SUITE_SLUG);
    expect(row!.planContentHash).toBe(HASH_A);
    expect(row!.sessionId).toBe(SESSION_A);
    expect(row!.status).toBe('running');
    expect(row!.note).toBe('launch with a note');
    expect(row!.launchedBy).toBe('test@example.com');
    expect(row!.title).toBe('integration launch');
    // BIGINT columns arrive from PG as strings — the mapper's Number()
    // coercion is load-bearing and must hold at the integration boundary.
    expect(typeof row!.id).toBe('number');
    expect(typeof row!.launchedAt).toBe('number');
    expect(typeof row!.updatedAt).toBe('number');
    expect(row!.launchedAt).toBeGreaterThan(0);
  });

  it('getPlanRun on an unknown id returns null', async () => {
    expect(await getPlanRun(999_999_999)).toBeNull();
  });

  it('appendPlanRunTurn allocates sequential seq per run (and returns it)', async () => {
    const s1 = await appendPlanRunTurn({
      planRunId: runId,
      role: 'user',
      content: 'first user turn',
    });
    const s2 = await appendPlanRunTurn({
      planRunId: runId,
      role: 'assistant',
      content: 'first assistant turn — short response',
      tokensIn: 12,
      tokensOut: 8,
      costUsd: 0.0001,
    });
    const s3 = await appendPlanRunTurn({
      planRunId: runId,
      role: 'user',
      content: 'second user turn — keyword foobar',
    });
    expect([s1, s2, s3]).toEqual([1, 2, 3]);

    const page = await readPlanRunTranscript(SESSION_A);
    expect(page.turns).toHaveLength(3);
    expect(page.turns.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(page.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(page.turns.every((t) => typeof t.createdAt === 'number' && t.createdAt > 0)).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('readPlanRunTranscript paginates via cursor', async () => {
    const first = await readPlanRunTranscript(SESSION_A, { limit: 2 });
    expect(first.turns).toHaveLength(2);
    expect(first.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);

    const second = await readPlanRunTranscript(SESSION_A, {
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]!.seq).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it('readPlanRunTranscript filters by substring query', async () => {
    const hit = await readPlanRunTranscript(SESSION_A, { query: 'foobar' });
    expect(hit.turns).toHaveLength(1);
    expect(hit.turns[0]!.content).toContain('foobar');

    const miss = await readPlanRunTranscript(SESSION_A, { query: 'no-such-word' });
    expect(miss.turns).toHaveLength(0);
    expect(miss.nextCursor).toBeNull();
  });

  it('readPlanRunTranscript applies the beforeTs upper bound (P-007 scoping)', async () => {
    // Deterministic: backdate turn 1's created_at, then bound exactly at it.
    const oldTs = Date.now() - 1_000_000;
    await admin`
      UPDATE harness_shared.plan_run_turns
         SET created_at = ${oldTs}
       WHERE plan_run_id = ${runId} AND seq = 1
    `;
    const scoped = await readPlanRunTranscript(SESSION_A, { beforeTs: oldTs });
    expect(scoped.turns.map((t) => t.seq)).toEqual([1]);

    const all = await readPlanRunTranscript(SESSION_A, { beforeTs: Date.now() + 60_000 });
    expect(all.turns.map((t) => t.seq)).toEqual([1, 2, 3]);
  });

  it('listPlanRuns returns the run with the correct turnCount', async () => {
    const runs = await listPlanRuns(SUITE_SLUG, { harnessSlug: HARNESS });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.turnCount).toBe(3);
    expect(typeof runs[0]!.turnCount).toBe('number');
  });

  it('runs are harness-scoped — the default harness does not see them', async () => {
    // Same plan slug, default harness ('papercup') → none of our rows.
    expect(await listPlanRuns(SUITE_SLUG)).toHaveLength(0);
  });

  it('setPlanRunStatus settles the run to idle and bumps updated_at', async () => {
    const before = (await getPlanRun(runId))!;
    await setPlanRunStatus(runId, 'idle');
    const row = (await getPlanRun(runId))!;
    expect(row.status).toBe('idle');
    expect(row.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('markPlanRunResumed reactivates even an archived run + re-stamps the hash (D-010)', async () => {
    await setPlanRunStatus(runId, 'archived');
    expect((await getPlanRun(runId))!.status).toBe('archived');

    await markPlanRunResumed(runId, HASH_B);
    const row = (await getPlanRun(runId))!;
    expect(row.status).toBe('running');
    expect(row.planContentHash).toBe(HASH_B);
  });

  it('a second launch under the same slug coexists with the first, newest-first', async () => {
    const runId2 = await insertPlanRun({
      planSlug: SUITE_SLUG,
      harnessSlug: HARNESS,
      planContentHash: HASH_C,
      sessionId: SESSION_B,
      note: null,
      launchedBy: 'test@example.com',
      title: 'second launch',
      status: 'running',
    });
    expect(runId2).toBeGreaterThan(runId);

    const runs = await listPlanRuns(SUITE_SLUG, { harnessSlug: HARNESS });
    expect(runs).toHaveLength(2);
    // Newest-first (launched_at DESC, id DESC tie-break).
    expect(runs[0]!.id).toBe(runId2);
    expect(runs[1]!.id).toBe(runId);
    // Independent turn-count tallies.
    expect(runs[0]!.turnCount).toBe(0);
    expect(runs[1]!.turnCount).toBe(3);
    // null note/title round-trip.
    expect(runs[0]!.note).toBeNull();
  });

  it('readPlanRunTranscript on an unknown sessionId returns an empty page', async () => {
    const stray = await readPlanRunTranscript(crypto.randomUUID());
    expect(stray.turns).toHaveLength(0);
    expect(stray.nextCursor).toBeNull();
  });
});

describe('transcript query LIKE-escaping (P-008, walked live)', () => {
  it('metacharacters match literally, never as wildcards; match is case-insensitive', async () => {
    const likeRunId = await insertPlanRun({
      planSlug: LIKE_SLUG,
      harnessSlug: HARNESS,
      planContentHash: HASH_A,
      sessionId: SESSION_LIKE,
      note: null,
      launchedBy: 'test@example.com',
      title: null,
      status: 'running',
    });
    const contents = [
      'progress: 50% complete',
      'progress: 50x complete', // decoy: matches if % leaks as a wildcard
      'token a_b here',
      'token aXb here', // decoy: matches if _ leaks as a wildcard
      'win path C:\\Users done',
    ];
    for (const content of contents) {
      await appendPlanRunTurn({ planRunId: likeRunId, role: 'user', content });
    }

    const pct = await readPlanRunTranscript(SESSION_LIKE, { query: '50%' });
    expect(pct.turns.map((t) => t.content)).toEqual(['progress: 50% complete']);

    const underscore = await readPlanRunTranscript(SESSION_LIKE, { query: 'a_b' });
    expect(underscore.turns.map((t) => t.content)).toEqual(['token a_b here']);

    const backslash = await readPlanRunTranscript(SESSION_LIKE, { query: 'C:\\Users' });
    expect(backslash.turns.map((t) => t.content)).toEqual(['win path C:\\Users done']);

    // ILIKE: case-insensitive.
    const ci = await readPlanRunTranscript(SESSION_LIKE, { query: 'AXB' });
    expect(ci.turns.map((t) => t.content)).toEqual(['token aXb here']);
  });
});

describe('sweepPlanRuns (P-016)', () => {
  it('fails orphaned running rows, archives stale idle rows, leaves the rest alone', async () => {
    const mkRun = (sessionId: string, status: 'running' | 'idle') =>
      insertPlanRun({
        planSlug: SWEEP_SLUG,
        harnessSlug: HARNESS,
        planContentHash: HASH_A,
        sessionId,
        note: null,
        launchedBy: 'test@example.com',
        title: null,
        status,
      });
    const orphanId = await mkRun(crypto.randomUUID(), 'running');
    const staleIdleId = await mkRun(crypto.randomUUID(), 'idle');
    const midIdleId = await mkRun(crypto.randomUUID(), 'idle');
    const freshRunningId = await mkRun(crypto.randomUUID(), 'running');

    const now = Date.now();
    // Backdate: the orphan past the 30-min running window; the stale idle
    // past the 7-day archive window; the mid idle past the ORPHAN window
    // only (an idle row must NOT get the orphan treatment).
    await admin`
      UPDATE harness_shared.plan_runs
         SET updated_at = ${now - PLAN_RUN_ORPHAN_FAIL_MS - 1_000}
       WHERE id = ${orphanId}
    `;
    await admin`
      UPDATE harness_shared.plan_runs
         SET updated_at = ${now - PLAN_RUN_IDLE_ARCHIVE_MS - 1_000}
       WHERE id = ${staleIdleId}
    `;
    await admin`
      UPDATE harness_shared.plan_runs
         SET updated_at = ${now - PLAN_RUN_ORPHAN_FAIL_MS - 1_000}
       WHERE id = ${midIdleId}
    `;

    const res = await sweepPlanRuns(now);
    expect(res).toEqual({ failed: 1, archived: 1 });

    expect((await getPlanRun(orphanId))!.status).toBe('failed');
    expect((await getPlanRun(staleIdleId))!.status).toBe('archived');
    expect((await getPlanRun(midIdleId))!.status).toBe('idle');
    expect((await getPlanRun(freshRunningId))!.status).toBe('running');
  });

  it('is idempotent — an immediate second sweep transitions nothing', async () => {
    const res = await sweepPlanRuns();
    expect(res).toEqual({ failed: 0, archived: 0 });
  });
});
