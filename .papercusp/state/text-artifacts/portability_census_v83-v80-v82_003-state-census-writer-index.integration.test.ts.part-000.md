---
rel_path: "portability/census/v83-v80-v82/003-state-census-writer-index.integration.test.ts.part-000"
updated_at: 1794268279628
_body: "content"
---

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readHistoricalCensusWriterCandidates, readHistoricalCensusWriterSource, recoverHistoricalCensusWriterEvidence } from './state-census-producers';
import type { AdvSessionRow } from '../adv-sessions';
import { acquireTrackedSessionSource } from '../session-port/service';
import postgres from 'postgres';
import { readRetainedReapTaskIds } from '../../../../scripts/state-census-roots.mts';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

describe('historical census writer index and canonical archive boundary', () => {
  let db: FreshPgDb;
  const startedAt = '2026-09-06T00:00:00.000Z';
  const finishedAt = '2026-09-06T00:00:01.000Z';
  const toolInput = 'chromium statePath';
  beforeAll(async () => {
    db = await createFreshPgDb('census-writer-index');
    // Only the indexed columns this reader consumes; the fixture is private.
    await db.sql`CREATE TABLE harness_shared.session_turn_parts (
      workspace_id text, source_kind text, session_id text, part_idx integer,
      part_kind text, text text, ts timestamptz,
      PRIMARY KEY (workspace_id, source_kind, session_id, part_idx))`;
    await db.sql`CREATE TABLE harness_shared.event_key_fires (
      workspace_id text, event_key text, last_fired_by text, last_payload jsonb, fire_count bigint,
      PRIMARY KEY (workspace_id, event_key))`;
    await db.sql`CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY, workspace_id text, surface text, writer_key text, body jsonb)`;
    await db.sql`CREATE TABLE harness_shared.session_turns (
      session_id text, source_kind text, owner text, ingested_at timestamptz)`;
  });
  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.session_turn_parts, harness_shared.event_key_fires, harness_shared.coord_event_log, harness_shared.session_turns`; });
  afterAll(async () => { await db?.cleanup(); });

  it('reads exact terminal latches as the first query on a fresh PostgreSQL connection', async () => {
    for (const [taskId, source, workspace, state] of [
      ['gc-archive', 'task-manager', DEFAULT_COORD_WORKSPACE, 'ended_unobserved'],
      ['other-source', 'another-writer', DEFAULT_COORD_WORKSPACE, 'stranded'],
      ['other-workspace', 'task-manager', 'foreign-workspace', 'stranded'],
      ['still-running', 'task-manager', DEFAULT_COORD_WORKSPACE, 'running'],
    ]) {
      await db.sql`INSERT INTO harness_shared.event_key_fires VALUES
        (${workspace}, ${`task:terminal:${taskId}`}, ${source}, ${db.sql.json({ taskId, state })}, 1)`;
    }
    await db.sql`INSERT INTO harness_shared.event_key_fires
      SELECT ${DEFAULT_COORD_WORKSPACE}, 'task:terminal:unrequested-' || n, 'task-manager',
             jsonb_build_object('taskId', 'unrequested-' || n, 'state', 'stranded'), 1
        FROM generate_series(1, 1001) n`;
    // The first query has no driver array-OID cache. Explicit text[] inference
    // must work without a warmup query or production task/event tables.
    const cold = postgres(db.url, { max: 1 });
    try {
      expect(await readRetainedReapTaskIds(
        ['gc-archive', 'other-source', 'other-workspace', 'still-running', 'missing'], [], {
          terminalSql: cold, readTasks: async () => [],
        },
      )).toEqual(['gc-archive']);
    } finally { await cold.end(); }
  });

  it('reads pre-latch reaper messages on a cold connection in the registered workspace and escapes exact ids', async () => {
    const summary = (id: string) => '[task-reaper] reaped 1/1 agent-session scope(s). '
      + `Log tails archived under ~/.papercusp/reap-archive/. ✓ ${id} (quiet-zombie)`;
    for (const [id, workspace, surface, writer, from] of [
      ['legacy.id', 'active', 'messages', 'task-manager', 'task-manager'],
      ['foreign', 'foreign', 'messages', 'task-manager', 'task-manager'],
      ['wrong-surface', 'active', 'other', 'task-manager', 'task-manager'],
      ['wrong-writer', 'active', 'messages', 'other', 'task-manager'],
      ['wrong-from', 'active', 'messages', 'task-manager', 'other'],
      ['literalXid', 'active', 'messages', 'task-manager', 'task-manager'],
      ['prefix-extra', 'active', 'messages', 'task-manager', 'task-manager'],
    ]) {
      await db.sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, body)
        VALUES (${workspace}, ${surface}, ${writer}, ${db.sql.json({ from, summary: summary(id) })})`;
    }
    const cold = postgres(db.url, { max: 1 });
    try {
      expect(await readRetainedReapTaskIds(
        ['legacy.id', 'foreign', 'wrong-surface', 'wrong-writer', 'wrong-from', 'literal.id', 'prefix', 'missing'],
        [{ id: 'active' }, { id: 'active' }], {
          terminalSql: cold, readTasks: async () => [], readTerminalLatches: async () => [],
        },
      )).toEqual(['legacy.id']);
    } finally { await cold.end(); }
  });

  it('keeps nonadjacent and missing results as candidates while archive call ids reject absent or ambiguous receipts', async () => {
    const sessions = ['interleaved', 'missing', 'ambiguous', 'adjacent'];
    for (const session of sessions) {
      await db.sql`INSERT INTO harness_shared.session_turn_parts VALUES
        ('default', 'codex', ${session}, 1, 'tool_use', ${toolInput}, ${startedAt}),
        ('default', 'codex', ${session}, 2, ${session === 'adjacent' ? 'tool_result' : 'tool_use'}, 'unrelated', ${finishedAt})`;
    }
    await db.sql`INSERT INTO harness_shared.session_turn_parts VALUES
      ('other-workspace', 'codex', 'foreign', 1, 'tool_use', ${toolInput}, ${startedAt}),
      ('default', 'claude', 'foreign', 1, 'tool_use', ${toolInput}, ${startedAt}),
      ('default', 'codex', 'not-a-writer', 1, 'tool_use', 'readFile()', ${startedAt})`;
    const candidates = await readHistoricalCensusWriterCandidates(db.sql);
    expect(candidates.map(row => row.sessionId)).toEqual([...sessions].sort());
    expect(candidates.find(row => row.sessionId === 'missing')?.finishedAt).toBe('');
    expect(Date.parse(candidates.find(row => row.sessionId === 'adjacent')!.finishedAt)).toBe(Date.parse(finishedAt));
    const recovered = await recoverHistoricalCensusWriterEvidence(candidates, async sessionId => {
      const writer = { type: 'response_item', timestamp: startedAt,
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer', input: toolInput } };
      const output = { type: 'response_item', timestamp: finishedAt,
        payload: { type: 'custom_tool_call_output', call_id: 'writer', output: JSON.stringify({ storageState: { mode: '600' } }) } };
      const unrelated = { ...output, payload: { ...output.payload, call_id: 'other' } };
      const rows = sessionId === 'missing' ? [writer, unrelated] : sessionId === 'ambiguous'
        ? [writer, output, output] : [writer, unrelated, output];
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'));
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    expect(recovered.map(row => row.indexedRef)).toEqual([
      'session-part:codex:adjacent:1', 'session-part:codex:interleaved:1',
    ]);
    expect(recovered.every(row => row.receipt && Date.parse(row.finishedAt) === Date.parse(finishedAt))).toBe(true);
  });

  it('discovers bounded verifier receipt writers without adopting foreign index rows', async () => {
    const complete = readFileSync(new URL('./fixtures/bounded-proof-writer.txt', import.meta.url), 'utf8');
    const input = complete.slice(0, 2000) + '… [truncated]';
    expect(input).not.toContain('bounded-proof-receipt.json');
    expect(input).not.toContain('write_text');
    await db.sql`INSERT INTO harness_shared.session_turn_parts VALUES
      ('default', 'codex', 'bounded', 1, 'tool_use', ${input}, ${startedAt}),
      ('foreign', 'codex', 'other', 1, 'tool_use', ${input}, ${startedAt})`;
    const candidates = await readHistoricalCensusWriterCandidates(db.sql);
    expect(candidates.map(row => row.sessionId)).toEqual(['bounded']);
    const receipt = { receipt: join(homedir(), '.papercusp/test-artifacts/run/bounded-proof-receipt.json'),
      cleanup: { fixtureRootAbsent: true }, testRunId: 23654091, sourceSha256: 'a'.repeat(64) };
    const bytes = Buffer.from([
      { type: 'response_item', timestamp: startedAt,
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'bounded', input: complete } },
      { type: 'response_item', timestamp: finishedAt,
        payload: { type: 'custom_tool_call_output', call_id: 'bounded',
          output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, output: JSON.stringify(receipt) }) }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const recovered = await recoverHistoricalCensusWriterEvidence(candidates,
      async () => ({ bytes, sha256: createHash('sha256').update(bytes).digest('hex') }));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ indexedRef: candidates[0].ref, toolInput: complete,
      receipt: JSON.stringify(receipt) });
  });
  it('recovers an indexed earlier incarnation through the exact tracked native reader when its archive is absent', async () => {
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      ('earlier-session', 'codex', 'writer-owner', ${startedAt})`;
    const row: AdvSessionRow = { id: 41, workspaceId: 'workspace', planSlug: null, agent: 'codex',
      role: null, feature: null, mode: 'console', terminalBin: null, pid: null, windowId: null,
      ompThreadId: null, label: null, cwd: '/workspace', coordOwnerId: 'writer-owner',
      sessionId: 'later-session', display: null, launchArgv: null, launchedAt: null,
      startedAt, endedAt: finishedAt, exitCode: 0, endedBy: null, endedSignal: null };
    const missing = vi.fn(async () => { throw new Error('canonical codex archive not found'); });
    const bytes = Buffer.from('exact retained writer');
    const stable = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
      source: 'live-jsonl' as const, highWaterBytes: bytes.length, completeBytes: bytes.length, relpath: null };
    const findLive = vi.fn(async () => '/tracked/exact.jsonl');
    const readLive = vi.fn(async () => stable);
    const rowsForOwner = vi.fn(async () => new Map([['writer-owner', row]]));
    const deps = { sql: db.sql, readArchive: missing, rowsForOwner,
      readTracked: (selected: AdvSessionRow) => acquireTrackedSessionSource(selected, {
        rootForSource: source => `/tracked/${source.id}/sessions`, findLive, readLive,
        readArchive: missing, archiveStore: () => ({} as never),
      }) };
    await expect(readHistoricalCensusWriterSource('earlier-session', deps)).resolves.toEqual(stable);
    expect(rowsForOwner).toHaveBeenCalledWith(1, ['writer-owner']);
    expect(findLive).toHaveBeenCalledWith('/tracked/41/sessions', 'codex', 'earlier-session');
    expect(readLive).toHaveBeenCalledWith('/tracked/exact.jsonl');
    expect(row.sessionId).toBe('later-session');
    findLive.mockClear();
    await expect(readHistoricalCensusWriterSource('unindexed-session', deps)).rejects.toThrow('archive not found');
    await expect(readHistoricalCensusWriterSource('earlier-session', { ...deps,
      rowsForOwner: async () => new Map([['writer-owner', { ...row, coordOwnerId: 'foreign-owner' }]]),
    })).rejects.toThrow('archive not found');
    await expect(readHistoricalCensusWriterSource('earlier-session', { ...deps,
      readArchive: async () => { throw new Error('archive SHA mismatch'); },
    })).rejects.toThrow('archive SHA mismatch');
    expect(findLive).not.toHaveBeenCalled();
  });
  it('refuses an overflowing writer population even when none has an adjacent receipt', async () => {
    await db.sql`INSERT INTO harness_shared.session_turn_parts
      SELECT 'default', 'codex', 'overflow', n, 'tool_use', ${toolInput}, ${startedAt}::timestamptz
      FROM generate_series(1, 101) n`;
    await expect(readHistoricalCensusWriterCandidates(db.sql)).rejects.toThrow('Historical census evidence bound exceeded');
  });
});

