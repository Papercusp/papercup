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
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
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
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
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

  it('stamps goal_id from the session GOAL-mode subject at write time', async () => {
    const uuid = 'eeee5555-ffff-6666-aaaa-777788889999';
    await sql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, session_id)
      VALUES (${WS}, 'console', 'goal-owner', ${uuid})`;
    await sql`INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, subject, set_by)
      VALUES (${WS}, 'goal-owner', 'overlay:goal', 'goal', 'goal-write-time', 'test')`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-goal-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }] });
    const rows = await sql<Array<{ goal_id: string | null }>>`
      SELECT goal_id FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].goal_id).toBe('goal-write-time');
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

describe('ingestInteractiveUsage — per-owner isolation root sweep (EI-19964643447670242)', () => {
  it('ingests a transcript under <isolationBase>/<owner>/projects/, not just the global root', async () => {
    // Mirrors the REAL on-disk shape every psu-launched agent (su/queen/overwatch/bee)
    // writes to: ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl —
    // a root the ingester never swept before this fix, so this whole population's
    // interactive usage was structurally invisible to agent_usage_samples.
    const uuid = 'cccc3333-dddd-4444-eeee-555566667777';
    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-isobase-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, 'su-fake-owner-id', 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 500, output_tokens: 700 } } }) + '\n',
    );

    // Empty explicit `adapters` (no global-root pollution) + includeIsolationRoots:true
    // (test seam override) + isolationBase pointed at our temp fixture — never touches
    // the real $HOME tree.
    const res = await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase,
    });
    expect(res.samples).toBeGreaterThan(0);

    const rows = await sql<Array<{ session_id: string | null; source: string; cost_usd: number | null }>>`
      SELECT session_id, source, cost_usd FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('interactive');
    expect(rows[0].cost_usd).toBeGreaterThan(0);
  });

  it('ingests a codex rollout under <codexIsolationBase>/session-N/sessions/ keyed by the rollout uuid (WI-2140701 (a))', async () => {
    // Mirrors the REAL on-disk shape every psu-launched codex agent writes to:
    // ~/.papercusp/su-codex-homes/session-<advId>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
    // Before this fix the codex adapter swept only the global ~/.codex/sessions AND
    // keyed samples by the whole basename ("rollout-…"), so the codex everything-goal
    // holder had zero attributable usage samples (WI-2140701 card-4 finding).
    const uuid = '01a06086-e882-7e10-9079-aa29e6a00097';
    const claudeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-claude-empty-'));
    const codexBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-codex-homes-'));
    tmpDirs.push(claudeBase, codexBase);
    const day = path.join(codexBase, 'session-21396', 'sessions', '2026', '09', '02');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(
      path.join(day, `rollout-2026-09-02T01-10-49-${uuid}.jsonl`),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 17396, cached_input_tokens: 16000, cache_write_input_tokens: 0, output_tokens: 55 } },
          },
        }) +
        '\n',
    );

    const res = await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase: claudeBase, // empty — keeps the claude sweep off the real $HOME
      codexIsolationBase: codexBase,
    });
    expect(res.samples).toBe(1);

    const rows = await sql<Array<{ session_id: string | null; source: string; model: string | null; cache_read_tokens: string | null }>>`
      SELECT session_id, source, model, cache_read_tokens FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND provider = 'openai'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(uuid); // the bare uuid — NOT "rollout-2026-…-<uuid>"
    expect(rows[0].source).toBe('interactive');
    expect(rows[0].model).toBe('gpt-5.6-sol');
    expect(Number(rows[0].cache_read_tokens)).toBe(16000);
  });

  it('a caller-supplied `adapters` array WITHOUT includeIsolationRoots opts out — no real-$HOME sweep', async () => {
    // Recurrence guard for the test-pollution risk: every pre-existing test in this
    // file relies on exactly this default (adapters given, includeIsolationRoots
    // unset) to stay hermetic. Pin it explicitly so a future change to the default
    // can't silently start sweeping the real machine's isolation tree in every test.
    const uuid = 'dddd4444-eeee-5555-ffff-666677778888';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-noiso-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 10 } } }) + '\n',
    );
    const res = await ingestInteractiveUsage({
      adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }],
    });
    // Only the one file under `dir` — no other adapter (isolation or otherwise) ran.
    expect(res.root).toBe(dir);
  });
});

describe('ingestInteractiveUsage — harness_slug stamped at INSERT (WI-2144763)', () => {
  // THE GAP THIS GUARDS. Before WI-2144763 the interactive writer omitted harness_slug
  // from its INSERT column list entirely: measured 2026-09-05, all 51,784 interactive
  // rows carried harness_slug IS NULL (0.0%) and rendered as '(unattributed)', against
  // a jsonl writer at 100% on the same column — a WRITER gap, not a schema gap.
  //
  // The fix resolves the value IN SQL via
  // harness_shared.harness_slug_for_usage_attribution(workspace, ownerId, sessionId)
  // (migration 1119), taking the coord owner id straight off the isolation ROOT path.
  // That owner-first route is the whole point: session_briefs covers 83.4% of owners,
  // where the adv_sessions session route the sample already carries covers only 7.8%,
  // so resolving through the session would have capped interactive coverage at ~7.8%
  // while looking like a fix. These tests pin the owner route specifically.
  it('stamps harness_slug from the isolation-root owner (the session_briefs owner route)', async () => {
    const owner = 'su-wi2144763-stamp-owner';
    const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555';
    await sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, harness_slug)
           VALUES (${owner}, ${WS}, ${'harness-under-test'})
      ON CONFLICT (owner_id)
        DO UPDATE SET harness_slug = EXCLUDED.harness_slug, workspace_id = EXCLUDED.workspace_id`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 400, output_tokens: 600 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('harness-under-test');
  });

  it('leaves harness_slug NULL when the owner resolves to nothing — an honest gap, never a fabricated slug', async () => {
    // The companion half of the guard. A stamp that always produced SOME value would
    // pass the test above while silently inventing attribution, which is worse than the
    // NULL it replaced: '(unattributed)' is at least readable as unknown. The function
    // has exactly two resolution branches (owner → session_briefs, then adv_sessions →
    // coord_owner_id → session_briefs) and returns NULL when neither resolves; this
    // owner has no brief and this uuid no adv_sessions row, so both must miss.
    const owner = 'su-wi2144763-unknown-owner';
    const uuid = 'bbbb2222-cccc-3333-dddd-444455556666';
    await sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-null-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 120, output_tokens: 130 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBeNull();
  });

  it('CONTROL: the stamp is resolved per-owner, not a constant — a second owner gets its own slug', async () => {
    // Calibration for the two pins above. If the writer stamped one hardcoded value (or
    // the fixture leaked between cases), the positive test would still pass. Ingesting a
    // DIFFERENT owner in the same run must yield that owner's own slug, which is what
    // makes 'harness-under-test' above evidence of resolution rather than a constant.
    const owner = 'su-wi2144763-second-owner';
    const uuid = 'cccc3333-dddd-4444-eeee-666677778888';
    await sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, harness_slug)
           VALUES (${owner}, ${WS}, ${'a-different-harness'})
      ON CONFLICT (owner_id)
        DO UPDATE SET harness_slug = EXCLUDED.harness_slug, workspace_id = EXCLUDED.workspace_id`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-2nd-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 300 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('a-different-harness');
  });
});
