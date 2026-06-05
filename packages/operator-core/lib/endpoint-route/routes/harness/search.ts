/**
 * GET /api/harness/search?q=...&kind=messages|features|all&limit=20
 *
 * Cross-harness substring search. Per-harness scan of messages tables;
 * features go through the workspace-scoped consolidated view.
 *
 * Ported from app/api/harness/search/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { routeWithWorkspace } from '../../../route-workspace';
import { defineTool } from '@papercusp/agent-mcp';

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

export default defineTool({
  method: 'GET',
  path: '/harness/search',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q || q.length < 2) {
      return Response.json({ error: 'q required (>=2 chars)' }, { status: 400 });
    }
    if (q.length > 200) {
      return Response.json({ error: 'q too long (max 200 chars)' }, { status: 400 });
    }
    const kind = url.searchParams.get('kind') ?? 'messages';
    const limitN = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    if (!['messages', 'features', 'all'].includes(kind)) {
      return Response.json({ error: 'kind must be messages|features|all' }, { status: 400 });
    }

    const messageHits: MessageHit[] = [];
    const featureHits: FeatureHit[] = [];
    const errors: string[] = [];
    const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;

    const schemas = await routeWithWorkspace(async (tx) => {
      return await tx<{ nspname: string }[]>`
        SELECT 'harness_' || REPLACE(slug, '-', '_') AS nspname
          FROM harness_shared.projects
         WHERE slug IS NOT NULL
      `;
    }).catch(() => [] as { nspname: string }[]);

    const { sql } = getOrgPg();

    if (kind === 'messages' || kind === 'all') {
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

    return Response.json({
      q,
      kind,
      limit: limitN,
      messageHits: kind === 'features' ? undefined : messageHits,
      featureHits: kind === 'messages' ? undefined : featureHits,
      errors: errors.length > 0 ? errors : undefined,
    });
  },
});
