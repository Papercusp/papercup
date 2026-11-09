import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readHistoricalCensusWriterCandidates, recoverHistoricalCensusWriterEvidence } from './state-census-producers';

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
  });
  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.session_turn_parts`; });
  afterAll(async () => { await db?.cleanup(); });

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
