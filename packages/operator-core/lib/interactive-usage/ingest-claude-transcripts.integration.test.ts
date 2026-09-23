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
const { parseCodexChunk, parseOmpChunk, codexSessionIdForFile } = await import('./ingest-adapters');
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
const adapter = () => [{ name: 'codex', root, parse: parseCodexChunk, replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1204-interactive-usage-parser-state-cache-tiers.sql', import.meta.url);
  const body = await fs.readFile(migration, 'utf8').catch(() => fs.readFile(new URL(migration.href + '.DRAFT'), 'utf8'));
  await sql.unsafe(body); // real additive migration, also before the draft is armed
  const provenanceMigration = new URL('../../../../libs/papercusp/libs/db/sql/1205-interactive-usage-request-provenance.sql', import.meta.url);
  await sql.unsafe(await fs.readFile(provenanceMigration, 'utf8').catch(() => fs.readFile(new URL(provenanceMigration.href + '.DRAFT'), 'utf8')));
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
  it('replays a legacy prefix within the byte budget without recounting its usage', async () => {
    const file = path.join(root, 'legacy.jsonl');
    const past = context('gpt-6-luna') + usage(1000) + context('gpt-6-sol') + usage(2000);
    await fs.writeFile(file, past + usage(2000) + usage(3000));
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(past)})`;
    const maxBytesPerFile = Buffer.byteLength(usage(1000)) + 5;
    const first = await ingestInteractiveUsage({ adapters: adapter(), maxBytesPerFile });
    expect(first.errors).toEqual([]);
    expect(first.samples).toBe(0);
    expect(first.bootstrapPending).toBe(1);
    const [progress] = await sql`SELECT byte_offset,parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(Number(progress.byte_offset)).toBe(Buffer.byteLength(past));
    expect(progress.parser_state.bootstrapOffset).toBeGreaterThan(0);
    for (let tick = 0; tick < 8; tick++) {
      expect((await ingestInteractiveUsage({ adapters: adapter(), maxBytesPerFile })).errors).toEqual([]);
    }
    const rows = await sql`SELECT model,turn_count,input_tokens,usage_provenance FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('gpt-6-sol');
    expect(rows[0].turn_count).toBe(1);
    expect(Number(rows[0].input_tokens)).toBe(150);
    expect(rows[0].usage_provenance.parserStateSource).toBe('transcript-prefix');
    const [done] = await sql`SELECT parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(done.parser_state.initialized).toBe(true);
    expect(done.parser_state.bootstrapOffset).toBeUndefined();
  });

  it('keeps a source with no model unknown after legacy replay and does not restart recovery', async () => {
    const file = path.join(root, 'sparse-legacy.jsonl');
    const past = usage(1000);
    await fs.writeFile(file, past + usage(2000));
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(past)})`;
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const [row] = await sql`SELECT model FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.model).toBeNull();
    const [done] = await sql`SELECT parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(done.parser_state).toMatchObject({ initialized: true, bootstrapSource: 'transcript-prefix' });
  });

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

  it.each(['claude', 'omp'])('max-merges %s streaming usage across restart boundaries without double-counting turns', async (backend) => {
    const file = path.join(root, 'streamed.jsonl');
    const timestamp = '2026-09-23T10:00:00.000Z';
    const message = (output: number, id = 'same-request') => backend === 'claude'
      ? line({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-4-8', usage: {
        input_tokens: 10, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
      } } })
      : line({ type: 'message', id, timestamp, message: { role: 'assistant', model: 'claude-opus-4-8', usage: {
        input: 10, output, cacheRead: 200, cacheWrite: 100,
      } } });
    const adapters = [{ name: backend, root, parse: backend === 'claude' ? parseTranscriptChunk : parseOmpChunk }];
    await fs.writeFile(file, message(20));
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    await fs.appendFile(file, message(20) + message(30));
    const second = await ingestInteractiveUsage({ adapters });
    expect(second.errors).toEqual([]);
    expect(second.totals).toMatchObject({ turns: 0, inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const [row] = await sql`SELECT turn_count, input_tokens, output_tokens, event_ts, ingested_at, ts,
      usage_provenance, account_id, turn_trigger, cost_usd FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.turn_count).toBe(1);
    expect(Number(row.input_tokens)).toBe(10);
    expect(Number(row.output_tokens)).toBe(30);
    expect(Number(row.event_ts)).toBe(Date.parse(timestamp));
    expect(Number(row.ts)).toBe(Date.parse(timestamp));
    expect(Number(row.ingested_at)).toBeGreaterThan(Number(row.event_ts));
    expect(row.usage_provenance).toMatchObject({ parserVersion: 2, adapter: backend, sourceId: 'message:same-request', grain: 'request', accountSource: 'unavailable' });
    expect(row.account_id).toBeNull();
    expect(row.turn_trigger).toBeNull();
    if (backend === 'omp') expect(row.cost_usd).toBeNull();
    await fs.appendFile(file, message(30));
    expect((await ingestInteractiveUsage({ adapters })).samples).toBe(0);
    await fs.appendFile(file, message(30, 'another-request'));
    expect((await ingestInteractiveUsage({ adapters })).totals.turns).toBe(1);
    expect(await sql`SELECT id FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toHaveLength(2);
  });

  it('keeps id-less requests distinct across reads and marks missing event times unknown', async () => {
    const file = path.join(root, 'anonymous.jsonl');
    const event = line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } } });
    const adapters = [{ name: 'claude', root, parse: parseTranscriptChunk }];
    await fs.writeFile(file, event);
    await ingestInteractiveUsage({ adapters });
    await fs.appendFile(file, event);
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    const rows = await sql`SELECT usage_event_key, event_ts FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.usage_event_key)).size).toBe(2);
    expect(rows.every((r) => r.event_ts === null)).toBe(true);
  });

  it('distinguishes reused byte offsets after transcript truncation', async () => {
    const file = path.join(root, 'rotated.jsonl');
    const event = line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } } });
    const adapters = [{ name: 'claude', root, parse: parseTranscriptChunk }];
    await fs.writeFile(file, event + line({ type: 'user', content: 'make original larger' }));
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    await fs.writeFile(file, event);
    expect((await ingestInteractiveUsage({ adapters })).totals.turns).toBe(1);
    const rows = await sql`SELECT usage_provenance FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.usage_provenance.fileGeneration).sort()).toEqual([0, 1]);
  });
});
