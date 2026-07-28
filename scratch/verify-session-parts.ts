/* Live end-to-end verification for session-turn-storage-2026-07-28.
 * Runs one real ingest sweep, then exercises the DB-primary backfill the
 * history pane now uses. Read-mostly: the sweep is the same bounded tick the
 * 2-min cron already runs. */
import { runSessionIngestOnce } from '../packages/operator-core/lib/search/session-ingest';
import { backfillFromSessionParts, backfillFromSessionTurns } from '../packages/operator-core/lib/endpoint-route/routes/harness/streams';
import { sessionIngestLagSweep } from '../packages/operator-core/lib/search/session-ingest-lag-watchdog';
import { getOrgPg } from '@papercusp/db-org';

async function main() {
  const stats = await runSessionIngestOnce();
  console.log('SWEEP', JSON.stringify({
    filesScanned: stats.filesScanned, filesIngested: stats.filesIngested,
    turnsInserted: stats.turnsInserted, partsInserted: stats.partsInserted,
    errors: stats.errors, errorSample: stats.errorSample, durationMs: stats.durationMs,
    skipped: stats.skipped,
  }));

  const { sql } = getOrgPg();
  const kinds = await sql`
    SELECT part_kind, count(*) AS n, round(avg(length(text))) AS avg_len, max(length(text)) AS max_len
      FROM harness_shared.session_turn_parts GROUP BY 1 ORDER BY 2 DESC`;
  console.log('PART_KINDS', JSON.stringify(kinds));

  const top = await sql`
    SELECT session_id, count(*) AS n FROM harness_shared.session_turn_parts
     GROUP BY 1 ORDER BY 2 DESC LIMIT 1`;
  if (!top.length) { console.log('NO PARTS YET'); return; }
  const sessionId = top[0].session_id as string;
  console.log('TOP_SESSION', sessionId, top[0].n);

  const parts = await backfillFromSessionParts({ sourceKind: 'claude', sessionId });
  const turns = await backfillFromSessionTurns({ sourceKind: 'claude', sessionId });
  console.log('BACKFILL_PARTS', JSON.stringify({
    entries: parts?.entries.length ?? null,
    kinds: [...new Set((parts?.entries ?? []).map((e) => e.kind))],
    sample: (parts?.entries ?? []).slice(-4).map((e) => ({
      kind: e.kind, toolName: e.toolName,
      text: typeof e.text === 'string' ? e.text.slice(0, 70) : undefined,
      toolInput: typeof e.toolInput === 'string' ? e.toolInput.slice(0, 70) : undefined,
    })),
  }, null, 1));
  console.log('BACKFILL_TURNS_entries', turns?.entries.length ?? null);

  // Secret-leak audit over everything ingested so far (P-004).
  const leaks = await sql`
    SELECT count(*) AS n FROM harness_shared.session_turn_parts
     WHERE text ~* '(aws_secret_access_key|api[_-]?key|client_secret|authorization:\\s*bearer)\\s*[:=]?\\s*["'']?[A-Za-z0-9/+_-]{12,}'
       AND text NOT LIKE '%[redacted]%'`;
  console.log('UNREDACTED_SUSPECTS', JSON.stringify(leaks));

  console.log('LAG_SWEEP', JSON.stringify(await sessionIngestLagSweep()));
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); });
