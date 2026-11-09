import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readHistoricalCensusWriterCandidates, recoverHistoricalCensusWriterEvidence } from './state-census-producers';
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
  });
  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.session_turn_parts, harness_shared.event_key_fires, harness_shared.coord_event_log`; });
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

  it('refuses an overflowing writer population even when none has an adjacent receipt', async () => {
    await db.sql`INSERT INTO harness_shared.session_turn_parts
      SELECT 'default', 'codex', 'overflow', n, 'tool_use', ${toolInput}, ${startedAt}::timestamptz
      FROM generate_series(1, 101) n`;
    await expect(readHistoricalCensusWriterCandidates(db.sql)).rejects.toThrow('Historical census evidence bound exceeded');
  });
});
