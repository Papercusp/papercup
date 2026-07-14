/**
 * turn-journal-store.ts — the Postgres layer for the per-turn journal
 * (deterministic-context-carry-2026-07-14 P-012; table: migration 605
 * harness_shared.session_turn_journal). Pure SQL binding — the extraction and
 * tripwire logic lives in turn-journal.ts, which is where the tests are.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { JournalTripwire, LedgerEntry } from './turn-journal';

export interface TurnJournalRow {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  agent: string | null;
  source_kind: string;
  session_id: string;
  turn_ts: string | null;
  note: string;
  source: 'agent' | 'mechanical';
  flagged: boolean;
  tripwire: JournalTripwire | null;
  harness_slug: string | null;
  created_at: string;
}

export interface RecordTurnJournalInput {
  ownerId: string | null;
  agent: string | null;
  sourceKind: string;
  sessionId: string;
  turnTs: Date | null;
  note: string;
  source: 'agent' | 'mechanical';
  flagged: boolean;
  tripwire: JournalTripwire | null;
  harnessSlug: string | null;
}

/** Insert one journal row. The (session_id, turn_ts) unique index dedupes the
 *  hook and any server-mediated sweep extracting the SAME message — the first
 *  writer wins, the second insert is a clean no-op ({ deduped: true }). */
export async function recordTurnJournal(
  input: RecordTurnJournalInput,
): Promise<{ id: string | null; deduped: boolean }> {
  const { sql } = getOrgPg();
  // `::text::jsonb` (not `::jsonb`) — postgres-js JSON-encodes the string param
  // first, so a bare `::jsonb` double-encodes (activity-pg-store gotcha).
  // Dates go over as ISO strings — the org client does not serialize Date
  // params (same convention as session-ingest's turn rows).
  const tripwireJson = input.tripwire ? JSON.stringify(input.tripwire) : null;
  const turnTsIso = input.turnTs ? input.turnTs.toISOString() : null;
  const inserted = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.session_turn_journal
      (owner_id, agent, source_kind, session_id, turn_ts, note, source, flagged, tripwire, harness_slug)
    VALUES (
      ${input.ownerId}, ${input.agent}, ${input.sourceKind}, ${input.sessionId},
      ${turnTsIso}::timestamptz, ${input.note}, ${input.source}, ${input.flagged},
      ${tripwireJson}::text::jsonb, ${input.harnessSlug}
    )
    ON CONFLICT (session_id, COALESCE(turn_ts, 'epoch'::timestamptz)) DO NOTHING
    RETURNING id::text AS id
  `;
  const id = inserted[0]?.id ?? null;
  return { id, deduped: id === null };
}

/** Newest journal write time for a session (ISO string) — the tripwire's
 *  turn-window floor (ledger entries since the previous journal belong to
 *  THIS turn). */
export async function latestJournalCreatedAt(sessionId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ latest: string | null }>>`
    SELECT max(created_at)::text AS latest
    FROM harness_shared.session_turn_journal
    WHERE session_id = ${sessionId}
  `;
  return rows[0]?.latest ?? null;
}

/** The turn's tool-ledger slice from harness_shared.agent_activity, NEWEST
 *  FIRST (the order detectClaimLedgerMismatch's latest-execution rule needs). */
export async function ledgerEntriesSince(
  sessionId: string,
  since: Date | string,
  limit = 500,
): Promise<LedgerEntry[]> {
  const { sql } = getOrgPg();
  const sinceIso = typeof since === 'string' ? since : since.toISOString();
  const rows = await sql<Array<{ tool_name: string | null; status: string | null; summary: string | null }>>`
    SELECT tool_name, status, summary
    FROM harness_shared.agent_activity
    WHERE session_id = ${sessionId} AND created_at > ${sinceIso}::timestamptz
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ toolName: r.tool_name, status: r.status, summary: r.summary }));
}

/** Read journal rows, newest first — the ambient cursor / fleet-pull surface
 *  (ambient-semantic-push D-008: readable fleet-wide, delivered by matcher). */
export async function recentTurnJournal(filter: {
  ownerId?: string;
  sessionId?: string;
  tripwiredOnly?: boolean;
  limit?: number;
}): Promise<TurnJournalRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = await sql<TurnJournalRow[]>`
    SELECT id::text AS id, workspace_id, owner_id, agent, source_kind, session_id,
           turn_ts::text AS turn_ts, note, source, flagged, tripwire, harness_slug,
           created_at::text AS created_at
    FROM harness_shared.session_turn_journal
    WHERE TRUE
      ${filter.ownerId ? sql`AND owner_id = ${filter.ownerId}` : sql``}
      ${filter.sessionId ? sql`AND session_id = ${filter.sessionId}` : sql``}
      ${filter.tripwiredOnly ? sql`AND tripwire IS NOT NULL` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}
