import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'cache-efficiency-parser-state';
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (original) => ({
  ...(await original<typeof import('../workspace-registry')>()), activeWorkspaceId: () => WS,
}));

const { ingestInteractiveUsage, parseTranscriptChunk } = await import('./ingest-claude-transcripts');
const { parseCodexChunk, codexSessionIdForFile } = await import('./ingest-adapters');
let org: OrgTestDb;
let sql: Sql;
let root: string;
const roots: string[] = [];
const line = (value: unknown) => JSON.stringify(value) + '\n';
const context = (model: string) => line({ type: 'turn_context', payload: { model } });
const usage = (total: number, input = 1000) => line({ type: 'event_msg', payload: {
  type: 'token_count', info: {
    total_token_usage: { input_tokens: total, cached_input_tokens: total * 0.6, output_tokens: total * 0.04 },
    last_token_usage: { input_tokens: input, cached_input_tokens: 600, cache_write_input_tokens: 250, output_tokens: 40 },
  },
} });
const adapter = () => [{ name: 'codex', root, parse: parseCodexChunk, sessionIdForFile: codexSessionIdForFile }];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1204-interactive-usage-parser-state-cache-tiers.sql', import.meta.url);
  const body = await fs.readFile(migration, 'utf8').catch(() => fs.readFile(new URL(migration.href + '.DRAFT'), 'utf8'));
  await sql.unsafe(body); // real additive migration, also before the draft is armed
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.interactive_usage_files WHERE workspace_id = ${WS}`;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-ingest-state-'));
  roots.push(root);
});
afterAll(async () => {
  await org?.cleanup();
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('persistent transcript accounting', () => {
  it('resumes the observed model and cumulative identity on a second ingestion call', async () => {
    const file = path.join(root, '00000000-0000-4000-8000-000000000001.jsonl');
    await fs.writeFile(file, context('gpt-6-luna') + usage(1000));
    const first = await ingestInteractiveUsage({ adapters: adapter() });
    expect(first.errors).toEqual([]);
    await fs.appendFile(file, usage(1000) + usage(2000));
    const second = await ingestInteractiveUsage({ adapters: adapter() });
    expect(second.errors).toEqual([]);
    const rows = await sql`SELECT model, sum(input_tokens)::int AS input, sum(cache_read_tokens)::int AS cached,
      sum(cache_creation_tokens)::int AS written, sum(turn_count)::int AS turns
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} GROUP BY model`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ model: 'gpt-6-luna', input: 300, cached: 1200, written: 500, turns: 2 });
    const [wm] = await sql`SELECT parser_state, byte_offset FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(wm.parser_state.model).toBe('gpt-6-luna');
    expect(Number(wm.byte_offset)).toBe((await fs.stat(file)).size);
    expect((await ingestInteractiveUsage({ adapters: adapter() })).samples).toBe(0);
  });

  it('does not count the same byte range twice when two ingestion ticks overlap', async () => {
    await fs.writeFile(path.join(root, 'race.jsonl'), context('gpt-6-astra') + usage(1000));
    const results = await Promise.all([
      ingestInteractiveUsage({ adapters: adapter() }), ingestInteractiveUsage({ adapters: adapter() }),
    ]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    const [row] = await sql`SELECT sum(turn_count)::int AS turns, sum(input_tokens)::int AS input
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row).toEqual({ turns: 1, input: 150 });
  });

  it('persists reported one-hour writes and leaves an absent model unknown', async () => {
    const file = path.join(root, 'claude.jsonl');
    await fs.writeFile(file, line({ type: 'assistant', message: { id: 'request-tier', model: 'claude-opus-4-8', usage: {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    } } }));
    expect((await ingestInteractiveUsage({ adapters: [{ name: 'claude', root, parse: parseTranscriptChunk }] })).errors).toEqual([]);
    const [tier] = await sql`SELECT cost_usd, cache_creation_5m_tokens, cache_creation_1h_tokens
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(tier.cost_usd).toBe(10);
    expect(Number(tier.cache_creation_5m_tokens)).toBe(0);
    expect(Number(tier.cache_creation_1h_tokens)).toBe(1_000_000);
    await fs.writeFile(path.join(root, 'unknown.jsonl'), usage(1000));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const [unknown] = await sql`SELECT provider, model, cost_usd FROM harness_shared.agent_usage_samples
      WHERE workspace_id=${WS} AND model IS NULL`;
    expect(unknown).toEqual({ provider: 'openai', model: null, cost_usd: null });
  });
});
