/**
 * GET /api/harness/search?q=<query>&kind=messages|features|all&limit=20
 *
 * Cross-harness substring search across every harness's state. Reads
 * operator-local; no auth (same posture as the inbox/outbox endpoints).
 *
 * Scope:
 *   - kind=messages (default): subject + body of every harness's messages table
 *   - kind=features: title + summary + notes of harness_shared.harness_features_consolidated
 *   - kind=all: both, merged in result; each row tagged with `kind`
 *
 * Returns at most `limit` rows per kind, sorted by ts desc. Uses ILIKE for
 * portable substring search; FTS upgrade is a v2 concern.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { routeWithWorkspace } from '@/lib/route-workspace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface MessageHit {
  kind: 'message';
  harness_slug: string;
  id: string;
  from_slug: string;
  to_slug: string;
  to_role: string | null;
  message_kind: string;
  subject: string;
  body: string | null;
  status: string;
  created_at: string;
}

interface FeatureHit {
  kind: 'feature';
  harness_slug: string;
  feature_id: string;
  title: string;
  summary: string | null;
  status: string;
  notes: string | null;
  updated_ts: number;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'q required (>=2 chars)' }, { status: 400 });
  }
  if (q.length > 200) {
    return NextResponse.json({ error: 'q too long (max 200 chars)' }, { status: 400 });
  }
  const kind = url.searchParams.get('kind') ?? 'messages';
  const limitN = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
  if (!['messages', 'features', 'all'].includes(kind)) {
    return NextResponse.json({ error: 'kind must be messages|features|all' }, { status: 400 });
  }

  const messageHits: MessageHit[] = [];
  const featureHits: FeatureHit[] = [];
  const errors: string[] = [];
  const pattern = `%${q.replace(/[%_\\]/g, '\\  const { sql } = getOrgPg();
  const messageHits: MessageHit[] = [];
  const featureHits: FeatureHit[] = [];
  const errors: string[] = [];
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;

  if (kind === 'messages' || kind === 'all') {
    // Per-harness scan: enumerate schemas, query each. The shared
    // harness_features_consolidated view doesn't include messages; scan
    // each per-harness messages table directly.
    const schemas = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
    `;')}%`;

  // Workspace-scope the schema enumeration: only harnesses whose
  // projects row is in the active workspace are queried. The pg_namespace
  // scan would otherwise include schemas from other workspaces' harnesses.
  const schemas = await routeWithWorkspace(async (tx) => {
    return await tx<{ nspname: string }[]>`
      SELECT 'harness_' || REPLACE(slug, '-', '_') AS nspname
        FROM harness_shared.projects
       WHERE slug IS NOT NULL
    `;
  }).catch(() => [] as { nspname: string }[]);

  // Use the admin connection for the per-schema reads (per-harness
  // schemas are scoped by name, not RLS).
  const { sql } = getOrgPg();

  if (kind === 'messages' || kind === 'all') {
    // Per-harness scan: enumerate workspace-filtered schemas, query each.
    for (const { nspname } of schemas) {
      try {
        const exists = await sql<{ exists: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ${nspname} AND table_name = 'messages') AS exists
        `;
        if (!exists[0]?.exists) continue;
        const rows = await sql.unsafe(
          `SELECT id, from_slug, to_slug, to_role, kind AS message_kind, subject, body, status,
                  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS created_at
           FROM ${nspname}.messages
           WHERE subject ILIKE $1 ESCAPE '\\' OR body ILIKE $1 ESCAPE '\\'
           ORDER BY created_at DESC
           LIMIT ${limitN}`,
          [pattern],
        );
        // Derive harness_slug from schema (harness_<slug_with_underscores>)
        const harnessSlug = nspname.replace(/^harness_/, '').replace(/_/g, '-');
        for (const r of rows as any[]) {
          messageHits.push({ kind: 'message', harness_slug: harnessSlug, ...r });
        }
      } catch (e: any) {
        errors.push(`${nspname}: ${String(e?.message ?? e).slice(0, 100)}`);
      }
    }
    messageHits.sort((a, b) => b.created_at.localeCompare(a.created_at));
    messageHits.splice(limitN);
  }

  if (kind === 'features' || kind === 'all') {
    // Workspace-scoped: read through the harness_shared.harness_features_consolidated
    // table inside the active workspace's GUC. RLS filters cross-workspace
    // rows. Falls back to all_features view if consolidated isn't backfilled.
    try {
      const rows = await routeWithWorkspace(async (tx) => {
        return await tx<any[]>`
          SELECT harness_slug, feature_id, title, summary, status, notes, updated_ts
            FROM harness_shared.harness_features_consolidated
           WHERE title ILIKE ${pattern} ESCAPE '\\'
              OR summary ILIKE ${pattern} ESCAPE '\\'
              OR notes ILIKE ${pattern} ESCAPE '\\'
           ORDER BY updated_ts DESC
           LIMIT ${limitN}
        `;
      });
      for (const r of rows) {
        featureHits.push({ kind: 'feature', ...r });
      }
    } catch (e: any) {
      errors.push(`features view: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  return NextResponse.json({
    q,
    kind,
    limit: limitN,
    messageHits: kind === 'features' ? undefined : messageHits,
    featureHits: kind === 'messages' ? undefined : featureHits,
    errors: errors.length > 0 ? errors : undefined,
  });
}
