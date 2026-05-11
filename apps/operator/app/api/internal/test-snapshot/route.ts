/**
 * POST /api/internal/test-snapshot
 *
 * bash run.sh's NEXT_TESTER block POSTs the full set of
 * .harness/tests/*.json files after `invoke tester` finishes. Replaces
 * Mirror 6 in harness-fs-watcher.ts.
 *
 * Body: { files: [{testId, payload: object}, ...], phase?: 'staging'|'testing'|'production' }
 *   - testId derived from filename (basename minus .json)
 *   - payload is the parsed JSON content
 *   - replace-all semantics: tests not in the snapshot are deleted
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.tokenIndexInHarnessShared;
const ht = generated.harnessTestsInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TEST_ID_RE = /^[A-Za-z0-9_.-]+$/;
const VALID_PHASES = new Set(['staging', 'testing', 'production']);

interface FileEntry { testId?: string; payload?: Record<string, unknown> }
interface RequestBody { files?: FileEntry[]; phase?: string }

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const tokenRows = await db
    .select({ harness_slug: ti.harnessSlug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (tokenRows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = tokenRows[0].harness_slug;

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const phase = typeof body.phase === 'string' && VALID_PHASES.has(body.phase) ? body.phase : 'staging';
  const files = Array.isArray(body.files) ? body.files : [];
  const ws = activeWorkspaceId();
  const now = Date.now();

  type Keep = {
    testId: string; name: string; status: string;
    durationMs: number; lastRunTs: number | null;
    payload: Record<string, unknown>;
  };
  const keep: Keep[] = [];
  for (const f of files) {
    if (!f || typeof f.testId !== 'string' || !TEST_ID_RE.test(f.testId)) continue;
    const payload = (f.payload && typeof f.payload === 'object') ? f.payload : {};
    const name = typeof payload.name === 'string' ? payload.name : f.testId;
    const status = typeof payload.status === 'string' ? payload.status : 'pending';
    const durationMs = Number.isFinite(payload.durationMs) ? Number(payload.durationMs)
      : Number.isFinite((payload as { duration_ms?: unknown }).duration_ms)
        ? Number((payload as { duration_ms: number }).duration_ms)
        : 0;
    const lastRunTs = Number.isFinite(payload.lastRunTs) ? Number(payload.lastRunTs)
      : Number.isFinite((payload as { last_run_ts?: unknown }).last_run_ts)
        ? Number((payload as { last_run_ts: number }).last_run_ts)
        : null;
    keep.push({ testId: f.testId, name, status, durationMs, lastRunTs, payload });
  }

  // Replace-all: orphan-delete any test_id not in the snapshot.
  if (keep.length === 0) {
    await db.delete(ht).where(and(eq(ht.harnessSlug, slug), eq(ht.phase, phase)));
  } else {
    const ids = keep.map((k) => k.testId);
    await db
      .delete(ht)
      .where(and(eq(ht.harnessSlug, slug), eq(ht.phase, phase), notInArray(ht.testId, ids)));
    for (const k of keep) {
      await db
        .insert(ht)
        .values({
          harnessSlug: slug,
          phase,
          testId: k.testId,
          name: k.name,
          status: k.status,
          durationMs: k.durationMs,
          lastRunTs: k.lastRunTs,
          payload: k.payload,
          mtimeMs: now,
          workspaceId: ws,
        })
        .onConflictDoUpdate({
          target: [ht.harnessSlug, ht.phase, ht.testId],
          set: {
            name: dsql`EXCLUDED.name`,
            status: dsql`EXCLUDED.status`,
            durationMs: dsql`EXCLUDED.duration_ms`,
            lastRunTs: dsql`EXCLUDED.last_run_ts`,
            payload: dsql`EXCLUDED.payload`,
            mtimeMs: dsql`EXCLUDED.mtime_ms`,
            workspaceId: dsql`EXCLUDED.workspace_id`,
          },
        });
    }
  }
  void notifySyncInvalidate('harnessTests.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true, count: keep.length });
}
