import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { CASCADE_ITEM_LIMIT, captureFactSupport, factRefOf, flagMatchingItems, renderCascadeNotice,
  type CascadeCursor, type FactChangeEvent, type FactChangeKind, type FlaggedItem } from './retraction-cascade';
import type { FactDependency, FactScope, FactSourceProvenance } from './store';

export interface FactChangeRef {
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  kind: FactChangeKind;
  versionId: string;
}

interface Generation {
  workspace_id: string;
  version_id: string;
  kind: FactChangeKind;
  scope: FactScope;
  scope_ref: string;
  fact_key: string;
  successor_id: string | null;
  actor: string | null;
  reason: string | null;
  cursor_harness: string | null;
  cursor_item: string | null;
  remaining: string | null;
  scanned: string;
  matched: string;
  scan_finished: boolean;
  completed_at: Date | null;
  last_error: string | null;
}

function recovery(ref: FactChangeRef) {
  const { scope, scopeRef, key, kind, versionId } = ref;
  return { tool: 'facts:list', args: { scope, ...(scopeRef ? { scopeRef } : {}), key,
    cascade: { kind, versionId } } } as const;
}

export function factCascadeHistoryRef(scope: FactScope, scopeRef: string | null, key: string) {
  return { tool: 'facts:list', args: { scope, ...(scopeRef ? { scopeRef } : {}), key, cascadeHistory: true } } as const;
}

function unknownProgress(ref: FactChangeRef, reason: string) {
  return { state: 'unknown', scanned: null, matched: null, remainingCandidates: null,
    pendingDeliveries: null, unknownRecipients: null, reason, recovery: recovery(ref),
    resync: factCascadeHistoryRef(ref.scope, ref.scopeRef, ref.key) } as const;
}

export async function hasFactCascadeProgress(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ installed: boolean }[]>`SELECT to_regclass('harness_shared.fact_change_cascades') IS NOT NULL AS installed`;
  return row?.installed === true;
}

export async function readFactCascade(sql: Sql, ws: string, ref: FactChangeRef) {
  if (!await hasFactCascadeProgress(sql)) return unknownProgress(ref, 'migration-unavailable');
  const [row] = await sql<(Generation & { pending: string; unresolved: string })[]>`
    SELECT g.*, d.pending, d.unresolved
      FROM harness_shared.fact_change_cascades g
      CROSS JOIN LATERAL (
        SELECT count(*) AS pending, count(*) FILTER (WHERE recipient IS NULL) AS unresolved
          FROM harness_shared.fact_change_cascade_deliveries
         WHERE workspace_id = g.workspace_id AND version_id = g.version_id AND kind = g.kind AND delivered_at IS NULL
      ) d
     WHERE g.workspace_id = ${ws} AND g.version_id = ${ref.versionId}::bigint AND g.kind = ${ref.kind}
       AND g.scope = ${ref.scope} AND g.scope_ref = ${ref.scopeRef ?? ''} AND g.fact_key = ${ref.key}`;
  if (!row) return unknownProgress(ref, 'generation-unavailable');
  if (row.last_error) return unknownProgress(ref, row.last_error);
  return { state: row.completed_at ? 'complete' : 'pending', scanned: Number(row.scanned), matched: Number(row.matched),
    remainingCandidates: row.remaining === null ? null : Number(row.remaining),
    pendingDeliveries: Number(row.pending), unknownRecipients: Number(row.unresolved),
    recovery: recovery(ref) } as const;
}

export type FactCascadeProgress = Awaited<ReturnType<typeof readFactCascade>>;

/** Exact-key resynchronization when the first writer reply or its version was lost. */
export async function readFactCascadeHistory(sql: Sql, ws: string, scope: FactScope, scopeRef: string | null,
  key: string, after?: { versionId: string; kind: FactChangeKind }) {
  if (!await hasFactCascadeProgress(sql)) return { state: 'unknown', reason: 'migration-unavailable' } as const;
  const rows = await sql<(Generation & { total: string })[]>`SELECT g.*, count(*) OVER () AS total
    FROM harness_shared.fact_change_cascades g
    WHERE workspace_id = ${ws} AND scope = ${scope} AND scope_ref = ${scopeRef ?? ''} AND fact_key = ${key}
      AND (${after?.versionId ?? null}::bigint IS NULL OR (version_id,kind) < (${after?.versionId ?? null}::bigint,${after?.kind ?? ''}))
    ORDER BY version_id DESC, kind DESC LIMIT ${CASCADE_ITEM_LIMIT}`;
  const last = rows.at(-1);
  const omitted = last ? Number(last.total) - rows.length : 0;
  return { state: 'available', generations: rows.map(row => recovery(refOf(row))), omitted,
    next: last && omitted ? { ...factCascadeHistoryRef(scope, scopeRef, key).args,
      cascadeHistory: { versionId: String(last.version_id), kind: last.kind } } : null } as const;
}

/** A reader can recover every item in their own delivery, including later assignment of an unresolved owner. */
export async function readFactCascadeItems(sql: Sql, ws: string, ref: FactChangeRef, recipient: string, after?: CascadeCursor) {
  const rows = await sql<{ harness: string; item: string; total: string }[]>`
    SELECT d.harness_slug AS harness, d.feature_id AS item, count(*) OVER () AS total
      FROM harness_shared.fact_change_cascade_deliveries d
      JOIN harness_shared.fact_change_cascades g USING (workspace_id, version_id, kind)
     WHERE g.workspace_id = ${ws} AND g.version_id = ${ref.versionId}::bigint AND g.kind = ${ref.kind}
       AND g.scope = ${ref.scope} AND g.scope_ref = ${ref.scopeRef ?? ''} AND g.fact_key = ${ref.key}
       AND d.recipient = ${recipient}
       AND (${after?.harness ?? null}::text IS NULL OR (d.harness_slug,d.feature_id) > (${after?.harness ?? ''},${after?.item ?? ''}))
     ORDER BY d.harness_slug, d.feature_id LIMIT ${CASCADE_ITEM_LIMIT}`;
  const items = rows.map(({ harness, item }) => ({ harness, item }));
  const omitted = rows.length ? Number(rows[0].total) - rows.length : 0;
  return { items, omitted, next: omitted ? { ...recovery(ref).args, cascade: {
    ...recovery(ref).args.cascade, after: items.at(-1)!, items: true } } : null };
}

function refOf(g: Generation): FactChangeRef {
  return { scope: g.scope, scopeRef: g.scope_ref || null, key: g.fact_key, kind: g.kind, versionId: String(g.version_id) };
}

/** The current fact store exposes numeric version IDs. Reject out-of-range historical
 * coordinates intact rather than flagging a neighbouring version through rounding. */
function versionNumber(id: string) {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || String(value) !== String(id)) throw new Error('Unrepresentable fact version ' + id);
  return value;
}

async function eventOf(sql: Sql, g: Generation): Promise<FactChangeEvent> {
  const event: FactChangeEvent = { ...refOf(g), workspaceId: g.workspace_id, versionId: versionNumber(g.version_id),
    by: g.actor, reason: g.reason, supersededBy: g.successor_id === null ? null : versionNumber(g.successor_id) };
  if (g.kind === 'retracted') return event;
  const rows = await sql<{ id: string; body: string; confidence: string | null; source_ref: string | null;
    source_provenance: FactSourceProvenance | null; depends_on: FactDependency[] | null }[]>`
    SELECT id::text, body, confidence, source_ref, source_provenance, depends_on
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${g.workspace_id} AND scope = ${g.scope} AND coalesce(scope_ref,'') = ${g.scope_ref}
       AND key = ${g.fact_key} AND source_hive IS NULL AND id IN (${g.version_id}::bigint, ${g.successor_id}::bigint)`;
  const before = rows.find(r => r.id === String(g.version_id));
  const after = rows.find(r => r.id === String(g.successor_id));
  if (!before || !after) throw new Error('Original or successor fact version is unavailable');
  event.comparison = { bodyChanged: before.body.trim() !== after.body.trim(),
    before: captureFactSupport(before), after: captureFactSupport(after) };
  return event;
}

async function scan(sql: Sql, g: Generation, event: FactChangeEvent) {
  const cursor = g.cursor_harness !== null && g.cursor_item !== null ? { harness: g.cursor_harness, item: g.cursor_item } : null;
  const page = await flagMatchingItems(sql, event, {}, cursor);
  if (page.flagged.length) {
    await sql`INSERT INTO harness_shared.fact_change_cascade_deliveries
      (workspace_id, version_id, kind, harness_slug, feature_id, recipient, title, terminal_status)
      SELECT ${g.workspace_id}, ${g.version_id}::bigint, ${g.kind}, i.harness, i.id, i.recipient, i.title, i.status
        FROM jsonb_to_recordset(${JSON.stringify(page.flagged)}::text::jsonb)
          AS i(harness text, id text, recipient text, title text, status text)
      ON CONFLICT DO NOTHING`;
  }
  await sql`UPDATE harness_shared.fact_change_cascades
    SET cursor_harness = ${page.cursor?.harness ?? null}, cursor_item = ${page.cursor?.item ?? null},
        scanned = scanned + ${page.scanned}, matched = matched + ${page.matched},
        remaining = ${page.remaining}, scan_finished = ${!page.truncated}
    WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}`;
  return !page.truncated;
}

async function deliver(sql: Sql, tx: TransactionSql, g: Generation, event: FactChangeEvent) {
  await sql`UPDATE harness_shared.fact_change_cascade_deliveries d
    SET recipient = coalesce(nullif(w.terminal_owner,''), nullif(w.taken_by,''))
    FROM harness_shared.work_items w
    WHERE d.workspace_id = ${g.workspace_id} AND d.version_id = ${g.version_id}::bigint AND d.kind = ${g.kind}
      AND d.recipient IS NULL AND d.delivered_at IS NULL AND w.workspace_id = d.workspace_id
      AND w.harness_slug = d.harness_slug AND w.feature_id = d.feature_id
      AND coalesce(nullif(w.terminal_owner,''), nullif(w.taken_by,'')) IS NOT NULL`;
  const recipients = await sql<{ recipient: string }[]>`SELECT DISTINCT recipient
    FROM harness_shared.fact_change_cascade_deliveries
    WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}
      AND delivered_at IS NULL AND recipient IS NOT NULL ORDER BY recipient LIMIT ${CASCADE_ITEM_LIMIT}`;
  if (recipients.length) {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    // Normal inboxes omit self-authored lines. The notice is authored by
    // maintenance even when the original retractor owns the affected close.
    const sender = 'system:retraction-cascade';
    const log = new PgCoordLog({ getSql: () => sql, workspaceId: g.workspace_id, ensureSchema: async () => {} });
    for (const { recipient } of recipients) {
      const rows = await sql<(FlaggedItem & { total: string })[]>`
        SELECT harness_slug AS harness, feature_id AS id, title, terminal_status AS status, recipient, count(*) OVER () AS total
          FROM harness_shared.fact_change_cascade_deliveries
         WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}
           AND recipient = ${recipient}
         ORDER BY harness_slug, feature_id LIMIT ${CASCADE_ITEM_LIMIT}`;
      const omitted = Number(rows[0].total) - rows.length;
      const ref = refOf(g);
      const read = { ...recovery(ref).args, cascade: { ...recovery(ref).args.cascade, items: true } };
      const notice = renderCascadeNotice(event, rows, Number(rows[0].total));
      const digest = createHash('sha256').update(JSON.stringify([g.workspace_id, ref.versionId, ref.kind, recipient])).digest('hex');
      const msgId = 'fact-change-' + digest;
      await sendMessage({ ownerId: sender, ownerLabel: sender, source: 'static-client', workspaceId: g.workspace_id,
        userId: null }, { to: [recipient], msgId, summary: notice.summary,
        body: notice.body + (omitted ? '\nAdditional affected items: ' + omitted : '') + '\nYour full item list: facts:list ' + JSON.stringify(read),
        extra: { auto: true, factChangeCascade: { kind: ref.kind,
          factRef: factRefOf(event.scope, event.scopeRef, event.key, event.versionId), generation: ref, by: event.by,
          items: rows.map(r => r.id), omitted, recovery: read } },
        persistEnvelope: async env => (await log.appendLineIfAbsent('messages', sender, env, { transactionSql: tx })).envelope });
      await sql`UPDATE harness_shared.fact_change_cascade_deliveries SET delivered_at = clock_timestamp()
        WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}
          AND recipient = ${recipient} AND delivered_at IS NULL`;
    }
  }
  await sql`UPDATE harness_shared.fact_change_cascades SET completed_at = clock_timestamp()
    WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}
      AND scan_finished AND NOT EXISTS (SELECT FROM harness_shared.fact_change_cascade_deliveries
        WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind} AND delivered_at IS NULL)`;
}

/** One bounded generation per maintenance turn. Row locks serialize duplicate workers.
 * Rotate even a failing or unattributable generation behind its peers. */
export async function resumeFactCascade(sql: Sql, specific?: { ws: string; ref: FactChangeRef }) {
  const process = async (tx: TransactionSql) => {
    const db = tx as unknown as Sql;
    const [g] = await db<Generation[]>`SELECT g.* FROM harness_shared.fact_change_cascades g
      WHERE completed_at IS NULL
        AND (${specific?.ws ?? null}::text IS NULL OR
          (workspace_id = ${specific?.ws ?? null} AND version_id = ${specific?.ref.versionId ?? null}::bigint
            AND kind = ${specific?.ref.kind ?? null} AND scope = ${specific?.ref.scope ?? null}
            AND scope_ref = ${specific?.ref.scopeRef ?? ''} AND fact_key = ${specific?.ref.key ?? null}))
      ORDER BY last_attempt, created_at, workspace_id, version_id, kind LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!g) return;
    await db`UPDATE harness_shared.fact_change_cascades SET last_attempt = clock_timestamp(), last_error = NULL
      WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}`;
    try {
      await tx.savepoint(async page => {
        const pageDb = page as unknown as Sql;
        const event = await eventOf(pageDb, g);
        if (g.scan_finished || await scan(pageDb, g, event)) await deliver(pageDb, page, g, event);
      });
    } catch (error) {
      await db`UPDATE harness_shared.fact_change_cascades SET last_error = 'page-unavailable'
        WHERE workspace_id = ${g.workspace_id} AND version_id = ${g.version_id}::bigint AND kind = ${g.kind}`;
      console.warn('[retraction-cascade] retained pending generation', refOf(g), error instanceof Error ? error.name : 'unknown');
      return unknownProgress(refOf(g), 'page-unavailable');
    }
  };
  const scoped = sql as unknown as TransactionSql;
  return typeof scoped.savepoint === 'function' ? process(scoped) : sql.begin(process);
}
