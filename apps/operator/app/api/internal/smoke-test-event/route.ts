/**
 * POST /api/internal/smoke-test-event
 *
 * bin/service-smoke-test.sh POSTs the aggregated smoke-test outcome
 * here at the end of each run. Replaces the chokidar mirror that
 * read 4 sibling files on every fs event.
 *
 * Auth: Authorization: Bearer <harness_token>.
 *
 * Body: { status: 'pass'|'fail', passContent?, failureContent?,
 *         results?, startupLog?, mtimeMs? }
 *   - status === 'unknown' is omitted; the runner only POSTs once it
 *     has decided pass vs fail.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  status?: string;
  passContent?: string;
  failureContent?: string;
  results?: unknown;
  startupLog?: string;
  mtimeMs?: number;
}

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE token = ${token} LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const status = body.status === 'pass' ? 'pass' : body.status === 'fail' ? 'fail' : 'unknown';
  if (status === 'unknown') {
    return NextResponse.json({ error: "status must be 'pass' or 'fail'" }, { status: 400 });
  }
  const passContent = typeof body.passContent === 'string' ? body.passContent : null;
  const failureContent = typeof body.failureContent === 'string' ? body.failureContent : null;
  const startupLog = typeof body.startupLog === 'string' ? body.startupLog : null;
  const resultsJson = body.results == null ? null : JSON.stringify(body.results);
  const mtimeMs = typeof body.mtimeMs === 'number' ? Math.floor(body.mtimeMs) : Date.now();

  const ws = activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.harness_smoke_test
      (harness_slug, status, pass_content, failure_content, results,
       startup_log, mtime_ms, workspace_id)
    VALUES (
      ${slug}, ${status}, ${passContent}, ${failureContent},
      ${resultsJson}::jsonb,
      ${startupLog}, ${mtimeMs}, ${ws}
    )
    ON CONFLICT (harness_slug) DO UPDATE
      SET status = EXCLUDED.status,
          pass_content = EXCLUDED.pass_content,
          failure_content = EXCLUDED.failure_content,
          results = EXCLUDED.results,
          startup_log = EXCLUDED.startup_log,
          mtime_ms = EXCLUDED.mtime_ms,
          workspace_id = EXCLUDED.workspace_id
  `;
  void notifySyncInvalidate('harnessSmokeTest.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
