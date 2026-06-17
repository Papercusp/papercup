/**
 * Cross-harness inbox/outbox/supervisor-notes/recent-activity readers.
 *
 * Used by both the legacy /api/_hono/cross-harness routes and the
 * cross_harness:* MCP tools so they share one implementation.
 *
 * Per-harness messages live in `harness_<slug>.messages`; supervisor
 * notes live in `harness_<slug>.supervisor_notes`; cross-workspace
 * audit rows live in `harness_shared.audit_log` (workspace-scoped).
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

// A harness slug feeds a schema IDENTIFIER into `sql.unsafe` below (`${schema}.
// messages`), so it MUST be validated before interpolation — postgres-js does
// no escaping for `.unsafe` string concatenation. Harness slugs are [a-z0-9_-]
// (migration 044's `'harness_' || lower(replace(slug,'-','_'))`); the sibling
// agent-mcp `messages:inbox` tool guards the SAME vector with this regex (audit
// P-029). A dot would survive into the identifier (postgres-js splits dotted
// identifiers into qualified parts), so dots are rejected too.
const SLUG_RE = /^[a-z0-9_-]+$/i;

/**
 * Map a harness slug to its PG schema name (`harness_<lower-slug, hyphens→
 * underscores>`). Throws on a slug that isn't a single safe identifier segment
 * — the schema name is interpolated raw into `sql.unsafe`, so an unvalidated
 * slug would be a SQL-injection vector (mirrors `messages:inbox`'s guard).
 */
export function slugToSchema(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid harness slug ${JSON.stringify(slug)}`);
  }
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

export interface MessageRow {
  id: string;
  from_slug: string;
  to_slug: string;
  to_role: string | null;
  kind: string;
  subject: string;
  body: string;
  parent_message_id: string | null;
  status: string;
  created_at: string;
  acknowledged_at: string | null;
}

export interface SupervisorNoteRow {
  id: string;
  body: string;
  source: string | null;
  created_at: string;
}

export interface RecentActivityRow {
  ts: string;
  action: string;
  subject: string | null;
  actor: string | null;
}

export interface ReadInboxOpts {
  status?: string;
  role?: string | null;
  limit?: number;
}

export async function readInbox(slug: string, opts: ReadInboxOpts = {}): Promise<MessageRow[]> {
  const status = opts.status ?? 'pending';
  const role = opts.role ?? null;
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
  const schema = slugToSchema(slug);
  const { sql } = getOrgPg();
  const valid = role && /^[a-z][a-z0-9_-]*$/i.test(role);
  if (valid) {
    return (await sql.unsafe(
      `SELECT id, from_slug, to_slug, to_role, kind, subject, body, parent_message_id, status, created_at, acknowledged_at
         FROM ${schema}.messages
        WHERE to_slug = $1 AND ($2 = 'all' OR status = $2)
          AND (to_role IS NULL OR to_role = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [slug, status, role, limit],
    )) as MessageRow[];
  }
  return (await sql.unsafe(
    `SELECT id, from_slug, to_slug, to_role, kind, subject, body, parent_message_id, status, created_at, acknowledged_at
       FROM ${schema}.messages
      WHERE to_slug = $1 AND ($2 = 'all' OR status = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [slug, status, limit],
  )) as MessageRow[];
}

export async function readOutbox(slug: string, limitRaw = 20): Promise<MessageRow[]> {
  const limit = Math.min(Math.max(1, limitRaw), 200);
  const { sql } = getOrgPg();
  const schemas = await sql<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
     WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
  `;
  const rows: MessageRow[] = [];
  for (const { nspname } of schemas) {
    const r = (await sql.unsafe(
      `SELECT id, from_slug, to_slug, to_role, kind, subject, body, parent_message_id, status, created_at, acknowledged_at
         FROM ${nspname}.messages
        WHERE from_slug = $1
        ORDER BY created_at DESC LIMIT $2`,
      [slug, limit],
    )) as MessageRow[];
    rows.push(...r);
  }
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return rows.slice(0, limit);
}

export async function readSupervisorNotes(slug: string, limitRaw = 10): Promise<SupervisorNoteRow[]> {
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const schema = slugToSchema(slug);
  const { sql } = getOrgPg();
  return (await sql.unsafe(
    `SELECT id, body, source, created_at
       FROM ${schema}.supervisor_notes
      ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )) as SupervisorNoteRow[];
}

export async function readRecentActivity(limitRaw = 20): Promise<RecentActivityRow[]> {
  const limit = Math.min(Math.max(1, limitRaw), 200);
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    return await tx<RecentActivityRow[]>`
      SELECT to_char(to_timestamp(ts / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS ts,
             action,
             subject,
             actor
        FROM harness_shared.audit_log
       ORDER BY ts DESC
       LIMIT ${limit}
    `;
  });
}
