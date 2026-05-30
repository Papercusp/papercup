/**
 * POST /api/internal/test-snapshot — replace-all tests snapshot per-phase.
 * Ported from app/api/internal/test-snapshot/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import { ensureHarnessPlanAssertionsTable } from '@/lib/ensure-schema';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const ht = generated.harnessTestsInHarnessShared;

const TEST_ID_RE = /^[A-Za-z0-9_.-]+$/;
const VALID_PHASES = new Set(['staging', 'testing', 'production']);
interface FileEntry { testId?: string; payload?: Record<string, unknown> }
interface RequestBody { files?: FileEntry[]; phase?: string }

export default defineTool({
  method: 'POST',
  path: '/internal/test-snapshot',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];
    const { db, sql } = getOrgPg();
    const tokenRows = await db.select({ harness_slug: ti.harnessSlug }).from(ti).where(eq(ti.token, token)).limit(1);
    if (tokenRows.length === 0) return Response.json({ error: 'invalid bearer' }, { status: 401 });
    const slug = tokenRows[0].harness_slug;

    let body: RequestBody;
    try { body = (await req.json()) as RequestBody; }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }

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

    // P-058: quarantine any test row whose `coversVALs` references a VAL
    // that isn't a known plan assertion (harness_plan_assertions). Only
    // enforced when the harness HAS assertions — harnesses not yet on the
    // inline-VAL flow are left untouched. Fail-soft if the table is absent.
    if (keep.length > 0) {
      try {
        await ensureHarnessPlanAssertionsTable();
        const valRows = await sql<{ val_id: string }[]>`
          SELECT val_id FROM harness_shared.harness_plan_assertions
           WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
        if (valRows.length > 0) {
          const known = new Set(valRows.map((r) => r.val_id));
          for (const k of keep) {
            const raw = (k.payload as { coversVALs?: unknown }).coversVALs;
            const covers = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
            if (covers.length > 0 && covers.some((v) => !known.has(v))) {
              k.status = 'invalid_val_ref';
            }
          }
        }
      } catch {
        /* assertions table unavailable — skip validation (fail-soft) */
      }
    }

    if (keep.length === 0) {
      await db.delete(ht).where(and(eq(ht.harnessSlug, slug), eq(ht.phase, phase)));
    } else {
      const ids = keep.map((k) => k.testId);
      await db.delete(ht).where(and(eq(ht.harnessSlug, slug), eq(ht.phase, phase), notInArray(ht.testId, ids)));
      for (const k of keep) {
        await db.insert(ht).values({
          harnessSlug: slug, phase, testId: k.testId, name: k.name, status: k.status,
          durationMs: k.durationMs, lastRunTs: k.lastRunTs, payload: k.payload,
          mtimeMs: now, workspaceId: ws,
        }).onConflictDoUpdate({
          target: [ht.harnessSlug, ht.phase, ht.testId],
          set: {
            name: dsql`EXCLUDED.name`, status: dsql`EXCLUDED.status`,
            durationMs: dsql`EXCLUDED.duration_ms`, lastRunTs: dsql`EXCLUDED.last_run_ts`,
            payload: dsql`EXCLUDED.payload`, mtimeMs: dsql`EXCLUDED.mtime_ms`,
            workspaceId: dsql`EXCLUDED.workspace_id`,
          },
        });
      }
    }
    void notifySyncInvalidate('harnessTests.byHarness', { harnessSlug: slug, phase }).catch(() => {});
    return Response.json({ ok: true, count: keep.length });
  },
});
