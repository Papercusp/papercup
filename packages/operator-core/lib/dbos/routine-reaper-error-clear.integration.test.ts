/**
 * clearStaleReaperLastError — the self-heal clear that stops the improvement-watchdog
 * re-filing phantom `routine-failure` bugs (EI-5938 + the 25+ routines that leaked the
 * `dbos-executor-reaper` marker forever). Proven against a REAL migrated Postgres
 * (testcontainer).
 *
 * THE BUG: the executor reaper stamps `routines.metadata.last_error` (source
 * `dbos-executor-reaper`) as a SELF-HEAL marker when it cancels+requeues a stuck fire.
 * A later successful fire never cleared it for the loop-wake branch (returned before any
 * metadata clear) nor for non-`runner`-sourced errors in the system branch — so
 * `collectRoutineFailureSignals` kept alarming on a routine that had already recovered.
 *
 * THE SAFETY PROPERTY proven here: the clear is SOURCE-SCOPED — it removes ONLY a
 * reaper-sourced marker and PRESERVES a genuine `runner`-sourced action error and
 * git-sync's own no-source error, so a real wedge still surfaces.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/dbos/routine-reaper-error-clear.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { clearStaleReaperLastError, REAPER_LAST_ERROR_SOURCE } from './dbos-executor-reaper';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-reaper-clear';
const HARNESS = 'papercup';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

/** Seed a routine carrying the given metadata (only the columns this clear cares about). */
async function seedRoutine(id: string, metadata: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', '{}'::jsonb, 'su', TRUE, ${WS},
      ${JSON.stringify(metadata)}::text::jsonb
    )`;
}

async function readMeta(id: string): Promise<Record<string, unknown> | null> {
  const r = await sql<{ metadata: Record<string, unknown> | null }[]>`
    SELECT metadata FROM harness_shared.routines WHERE id = ${id}`;
  return r[0]?.metadata ?? null;
}

/** The exact marker the reaper writes on cancel+requeue (dbos-executor-reaper.ts). */
const REAPER_ERR = {
  last_error:
    'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
  last_error_at: '2026-07-01T09:14:02.000Z',
  last_error_source: REAPER_LAST_ERROR_SOURCE,
};

describe('clearStaleReaperLastError (real PG)', () => {
  it('clears a reaper-sourced last_error (the EI-5938 phantom marker) but keeps unrelated keys', async () => {
    await seedRoutine('rt-reaper', { ...REAPER_ERR, head_sha: 'abc123', last_status: 'ok' });

    await clearStaleReaperLastError(sql, 'rt-reaper');

    const meta = await readMeta('rt-reaper');
    expect(meta?.last_error).toBeUndefined();
    expect(meta?.last_error_at).toBeUndefined();
    expect(meta?.last_error_source).toBeUndefined();
    // Only the three marker keys are dropped; everything else survives.
    expect(meta?.head_sha).toBe('abc123');
    expect(meta?.last_status).toBe('ok');
  });

  it('WI-1416: also drops reaped_count (the consecutive-reap counter) — a completed dispatch disproves the reap verdict', async () => {
    await seedRoutine('rt-reaped', { ...REAPER_ERR, reaped_count: 7, head_sha: 'abc123' });

    await clearStaleReaperLastError(sql, 'rt-reaped');

    const meta = await readMeta('rt-reaped');
    expect(meta?.last_error).toBeUndefined();
    expect(meta?.reaped_count).toBeUndefined();
    expect(meta?.head_sha).toBe('abc123'); // unrelated keys survive
  });

  it('PRESERVES a runner-sourced action error (a genuinely-throwing system action stays visible)', async () => {
    await seedRoutine('rt-runner', {
      last_error: 'action boom',
      last_error_at: '2026-07-01T09:00:00.000Z',
      last_error_source: 'runner',
    });

    await clearStaleReaperLastError(sql, 'rt-runner');

    const meta = await readMeta('rt-runner');
    expect(meta?.last_error).toBe('action boom');
    expect(meta?.last_error_source).toBe('runner');
  });

  it("PRESERVES git-sync's own no-source last_error (a real push failure stays visible)", async () => {
    await seedRoutine('rt-gitsync', {
      last_error: 'push rejected (non-fast-forward)',
      last_error_at: '2026-07-01T09:00:00.000Z',
      head_sha: 'deadbeef',
    });

    await clearStaleReaperLastError(sql, 'rt-gitsync');

    const meta = await readMeta('rt-gitsync');
    expect(meta?.last_error).toBe('push rejected (non-fast-forward)');
    expect(meta?.head_sha).toBe('deadbeef');
  });

  it('is a fail-soft no-op for an unknown routine id', async () => {
    await expect(clearStaleReaperLastError(sql, 'rt-does-not-exist')).resolves.toBeUndefined();
  });

  it('is idempotent — a second clear on an already-clean routine is a no-op', async () => {
    await seedRoutine('rt-reaper2', { ...REAPER_ERR });
    await clearStaleReaperLastError(sql, 'rt-reaper2');
    await clearStaleReaperLastError(sql, 'rt-reaper2');
    const meta = await readMeta('rt-reaper2');
    expect(meta?.last_error).toBeUndefined();
    expect(meta?.last_error_source).toBeUndefined();
  });
});
