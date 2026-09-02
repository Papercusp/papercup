/**
 * fixer-liveness.integration.test.ts — P-005 of
 * frozen-candidate-freeze-actually-holds-2026-09-02.
 *
 * Proves what a seam-injected unit test CANNOT: that the real SQL behind
 * `classifyDeadReleaseFixerSpawn` actually runs against the migrated
 * `harness_shared.spawned_agents` / `harness_shared.tool_invocations` tables.
 *
 * This file exists because of a live outage. The read selected `sa.error`, which is
 * not a column (it is `error_message`), so Postgres rejected the statement with 42703.
 * The function's deliberately fail-CLOSED catch turned that into `null` — which the
 * caller reads as "no evidence, burn the attempt". The consequence was invisible and
 * total: P-005's attempt refund could never be granted in production, so every
 * unproductive infrastructure death (provider usage-wall, spawn failure, permission
 * fault) burned a real attempt and marched the frozen repair queue toward
 * hold-exhausted. Observed 2026-09-02: release-fixers dying in ~30s on a usage-walled
 * provider with zero tool calls, each one burning an attempt that P-005 was written to
 * refund.
 *
 * A mocked `sql` cannot falsify any of this — a stub returns whatever rows the test
 * hands it and never validates a column name, which is exactly how the wrong column
 * survived. Only real Postgres can tell these apart, so every case below asserts a
 * NON-null classification: before the fix all four returned `null`.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { classifyDeadReleaseFixerSpawn } = await import('./fixer-liveness');

const WS = 'ws-fixer-liveness-integration';
const HARNESS = 'papercusp';

let db: OrgTestDb;

/** Insert a spawned_agents row shaped like a real release-fixer launch. */
async function insertSpawn(opts: {
  spawnId: string;
  status: string;
  errorMessage?: string | null;
}): Promise<void> {
  await db.adminSql.unsafe(
    `INSERT INTO harness_shared.spawned_agents
       (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, status,
        error_message, cancel_requested, coordination_domain, heartbeat_at,
        restart_count, restart_strategy)
     VALUES ($1, $2, $3, 'system:green-checkpoint', 'release-fixer', $4, $5,
             $6, false, 'release', now(), 0, 'one_for_one')`,
    [opts.spawnId, WS, HARNESS, `run-${opts.spawnId}`, opts.status, opts.errorMessage ?? null],
  );
}

/** Record one MCP tool call against a spawn — the evidence of real repair work. */
async function insertToolCall(spawnId: string): Promise<void> {
  await db.adminSql.unsafe(
    `INSERT INTO harness_shared.tool_invocations
       (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status)
     VALUES ($1, $2, 'papercusp', 'capability:edit', 'release-fixer', $3, 'w-1', 'ok')`,
    [WS, HARNESS, spawnId],
  );
}

beforeAll(async () => {
  db = await createOrgTestDb();
});

afterAll(async () => {
  await db?.cleanup();
});

describe('classifyDeadReleaseFixerSpawn against real Postgres', () => {
  it('classifies a usage-walled fixer (zero tool calls) as an INFRASTRUCTURE death worth a refund', async () => {
    // The exact live shape: the provider refused the turn, so the agent died having
    // made no tool calls at all.
    const spawnId = 's-usage-wall-no-tool-calls';
    await insertSpawn({
      spawnId,
      status: 'failed',
      errorMessage: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 10:26 PM.",
    });

    const got = await classifyDeadReleaseFixerSpawn(db.adminSql, spawnId);

    // Before the sa.error fix this was `null` (42703 swallowed by the fail-closed
    // catch), which the caller reads as "burn the attempt".
    expect(got).not.toBeNull();
    expect(got?.infrastructure).toBe(true);
    expect(got?.reason).toContain('zero tool invocations');
    // The error tail must actually reach the reason — that is the column this
    // regression was about, so a silent re-break of it fails here rather than
    // degrading quietly to a less informative string.
    expect(got?.reason).toContain('usage limit');
    expect(got?.reason).toContain('status=failed');
  });

  it('does NOT refund a fixer that made tool calls before dying — that is a real repair attempt', async () => {
    const spawnId = 's-worked-then-died';
    await insertSpawn({ spawnId, status: 'failed', errorMessage: 'killed mid-edit' });
    await insertToolCall(spawnId);

    const got = await classifyDeadReleaseFixerSpawn(db.adminSql, spawnId);

    expect(got).not.toBeNull();
    expect(got?.infrastructure).toBe(false);
    expect(got?.reason).toContain('made tool calls');
  });

  it('treats a spawn id with no spawned_agents row as an unrecorded launch (refundable)', async () => {
    const got = await classifyDeadReleaseFixerSpawn(db.adminSql, 's-never-recorded');

    expect(got).not.toBeNull();
    expect(got?.infrastructure).toBe(true);
    expect(got?.reason).toContain('no spawned_agents row');
  });

  it('reports a spawn with a NULL error_message without inventing an error tail', async () => {
    const spawnId = 's-no-error-text';
    await insertSpawn({ spawnId, status: 'cancelled', errorMessage: null });

    const got = await classifyDeadReleaseFixerSpawn(db.adminSql, spawnId);

    expect(got).not.toBeNull();
    expect(got?.infrastructure).toBe(true);
    expect(got?.reason).toContain('status=cancelled');
    expect(got?.reason).not.toContain('error:');
  });

  it('returns null for a missing spawn id — the caller must not refund on no evidence', async () => {
    expect(await classifyDeadReleaseFixerSpawn(db.adminSql, null)).toBeNull();
    expect(await classifyDeadReleaseFixerSpawn(db.adminSql, '')).toBeNull();
  });
});
