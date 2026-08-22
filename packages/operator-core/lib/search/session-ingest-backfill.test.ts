/**
 * WI-4297 migration contract guard. The historical counter repair must have
 * its own cursor and completion marker; resetting byte_offset would replay
 * indexed turns and can create duplicate turn-index conflicts.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/libs/db/sql/601-session-ingest-counts-backfill.sql',
);

const agentChatUnexemptMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/libs/db/sql/743-backfill-agent-chat-counts-wi4297.sql',
);

const partsBackfillMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/libs/db/sql/880-session-turn-parts-backfill.sql',
);

const sessionIngestSourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  './session-ingest.ts',
);

describe('WI-4297 historical counter backfill migration', () => {
  it('uses an independent resumable cursor and never resets the indexed cursor', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('counts_backfill_offset BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('counts_backfilled_at TIMESTAMPTZ');
    expect(migration).toContain('counts_backfilled_at IS NULL');
    expect(migration).not.toMatch(/SET\s+byte_offset\s*=\s*0/i);
  });
});

describe('WI-4297 follow-up: migration 601 wrongly exempted agent_chat rows', () => {
  it('re-opens only agent_chat rows with a live transcript and all-zero counts, never file-adapter rows', async () => {
    // Root cause: syncAgentChats() always writes byte_offset=0 for
    // source_kind='agent_chat' (a chat has no byte cursor), so migration
    // 601's `byte_offset = 0` exemption — correct for the file adapters,
    // where byte_offset is a real advancing cursor — silently and
    // permanently marked every pre-existing, never-counted agent_chat row
    // as "backfilled" without ever computing its prompt/response counts.
    // Migration 743 re-opens exactly those rows (and only those) for the
    // existing backfillHistoricalCounts routine to recompute for real.
    const migration = await readFile(agentChatUnexemptMigrationPath, 'utf8');

    // Scoped to agent_chat only — must never touch claude/omp/codex rows,
    // which have a real byte_offset semantic migration 601 already handles
    // correctly.
    expect(migration).toMatch(/source_kind\s*=\s*'agent_chat'/);
    // Must re-arm eligibility (counts_backfilled_at back to NULL) rather
    // than trying to compute the counts itself in SQL — the recompute logic
    // (readNewLines-equivalent for chats: per-turn role tally) already
    // lives in backfillHistoricalCounts/session-ingest.ts and must stay the
    // single source of truth.
    expect(migration).toMatch(/counts_backfilled_at\s*=\s*NULL/i);
    // Must only touch rows genuinely worth recomputing: real turns, all
    // three counters still at their zero default (never actually counted).
    expect(migration).toMatch(/turn_count\s*>\s*0/);
    expect(migration).toMatch(/prompt_count\s*=\s*0/);
    expect(migration).toMatch(/response_count\s*=\s*0/);
    expect(migration).toMatch(/tool_call_count\s*=\s*0/);
    // Must NOT re-open rows whose source transcript is already gone — those
    // are permanently unrecoverable (the agent_chat analog of
    // counts_backfill_source_missing) and must stay terminally marked, not
    // spin forever as "eligible" with nothing to recompute from.
    expect(migration).toMatch(/transcript\s+IS\s+NOT\s+NULL/i);
    // Must never touch the __hwm__ bookkeeping row.
    expect(migration).toMatch(/__hwm__/);
  });
});

describe('P-001 historical faithful-part backfill', () => {
  it('adds an independent resumable cursor without reopening the live turn cursor', async () => {
    const migration = await readFile(partsBackfillMigrationPath, 'utf8');

    expect(migration).toContain('parts_backfill_offset BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('parts_backfilled_at TIMESTAMPTZ');
    expect(migration).toContain('parts_backfilled_at IS NULL');
    expect(migration).toContain("source_kind NOT IN ('claude', 'codex')");
    expect(migration).not.toMatch(/SET\s+byte_offset\s*=\s*0/i);
  });

  it('runs the EOF repair before ordinary tailing and writes faithful parts', async () => {
    const source = await readFile(sessionIngestSourcePath, 'utf8');

    // This is the recurrence guard for the filed defect: a completed file has
    // no new bytes, so only the independent historical path can reach it.
    expect(source).toContain('async function backfillHistoricalParts');
    expect(source).toMatch(/parts_backfill_offset\s+IS NULL|parts_backfill_offset\s*>\s*0/);
    expect(source).toContain('partRowsFrom(result.parts');
    expect(source).toContain('stats.partsBackfillFiles = await backfillHistoricalParts(sql)');
  });
});
