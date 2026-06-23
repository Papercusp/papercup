/**
 * Interactive-usage ingestion writes session_id — the loop cost-cap attribution fix
 * (loop-wake-rate-limit-robustness-2026-06-23 P3), proven against a REAL migrated Postgres.
 *
 * THE BUG: the interactive ingestion wrote the native session UUID (the transcript filename)
 * into `agent_usage_samples.run_id` and left `session_id` NULL. But `loop-cost-cap.ts`
 * `readLoopSpendCents` attributes a warm-session loop's spend via
 *   owner → adv_sessions.session_id → agent_usage_samples.session_id → SUM(cost_usd)
 * so it always found 0 and the cost-cap never bound an interactive loop. The native UUID IS
 * the session id (it equals adv_sessions.session_id), so populating `session_id` makes the
 * existing join work — no schema change. This test pins that session_id is now written.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/interactive-usage/ingest-claude-transcripts.session-attribution.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-interactive-ingest-p3';

// getOrgPg() → the testcontainer sql; activeWorkspaceId() → our fixed workspace.
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { ingestInteractiveUsage, parseTranscriptChunk } = await import('./ingest-claude-transcripts');

let org: OrgTestDb;
let sql: Sql;
const tmpDirs: string[] = [];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
});
afterAll(async () => {
  await org?.cleanup();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.interactive_usage_files WHERE workspace_id = ${WS}`;
});

describe('ingestInteractiveUsage — session_id attribution (P3)', () => {
  it('writes the transcript native UUID into agent_usage_samples.session_id (was NULL before the fix)', async () => {
    const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-ingest-'));
    tmpDirs.push(dir);
    const turn = (model: string, usage: Record<string, number>) =>
      JSON.stringify({ type: 'assistant', message: { model, usage } });
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      turn('claude-opus-4-8', { input_tokens: 100, output_tokens: 200 }) + '\n',
    );

    // A claude-only adapter pointed at our temp dir — no codex/omp roots, no pollution.
    const res = await ingestInteractiveUsage({
      adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }],
    });
    expect(res.samples).toBeGreaterThan(0);

    const rows = await sql<Array<{ session_id: string | null; run_id: string | null; source: string; cost_usd: number | null }>>`
      SELECT session_id, run_id, source, cost_usd FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
    expect(rows.length).toBeGreaterThan(0);
    // THE FIX: session_id now carries the native UUID = adv_sessions.session_id (the join key).
    expect(rows[0].session_id).toBe(uuid);
    expect(rows[0].run_id).toBe(uuid); // run_id still carries it too (back-compat preserved)
    expect(rows[0].source).toBe('interactive');
  });

  it('the exact readLoopSpendCents attribution query now sums interactive spend by session_id', async () => {
    // Mirror what readLoopSpendCents runs (owner→session_id resolved upstream): SUM(cost_usd)
    // WHERE session_id = <native uuid>. With the fix, interactive samples are now summed.
    const uuid = 'bbbb2222-cccc-3333-dddd-444455556666';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-spend-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 2000 } } }) + '\n',
    );
    await ingestInteractiveUsage({ adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }] });

    const rows = await sql<Array<{ usd: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
        FROM harness_shared.agent_usage_samples
       WHERE session_id = ${uuid}`;
    // Priced opus spend attributed by session_id — a positive cents figure (was 0 before the fix).
    expect(Math.round((rows[0]?.usd ?? 0) * 100)).toBeGreaterThan(0);
  });
});
