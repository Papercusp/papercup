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
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hs = generated.harness_smoke_testInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  status: z.enum(['pass', 'fail']),
  passContent: z.string().nullable().optional(),
  failureContent: z.string().nullable().optional(),
  results: z.unknown().optional(),
  startupLog: z.string().nullable().optional(),
  mtimeMs: z.number().int().nonnegative().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: ti.harness_slug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { status } = parsed.data;
  const passContent = parsed.data.passContent ?? null;
  const failureContent = parsed.data.failureContent ?? null;
  const startupLog = parsed.data.startupLog ?? null;
  const resultsJson = parsed.data.results == null ? null : JSON.stringify(parsed.data.results);
  const mtimeMs = parsed.data.mtimeMs ?? Date.now();

  const ws = activeWorkspaceId();
  await db
    .insert(hs)
    .values({
      harness_slug: slug,
      status,
      pass_content: passContent,
      failure_content: failureContent,
      results: resultsJson ? (JSON.parse(resultsJson) as any) : null,
      startup_log: startupLog,
      mtime_ms: mtimeMs,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: hs.harness_slug,
      set: {
        status: dsql`EXCLUDED.status`,
        pass_content: dsql`EXCLUDED.pass_content`,
        failure_content: dsql`EXCLUDED.failure_content`,
        results: dsql`EXCLUDED.results`,
        startup_log: dsql`EXCLUDED.startup_log`,
        mtime_ms: dsql`EXCLUDED.mtime_ms`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessSmokeTest.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
