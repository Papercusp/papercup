/**
 * POST /api/internal/test-snapshot — replace-all tests snapshot per-phase.
 * Ported from app/api/internal/test-snapshot/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { deriveAssertionStatus } from '../../../harness-test-rollup';
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

    // The plan↔test link, through the VAL (Phase E P-058 + Phase G P-080/P-081).
    // One assertion fetch drives three things; fail-soft if the table is absent
    // and skipped entirely for harnesses not yet on the inline-VAL flow.
    if (keep.length > 0) {
      try {
        const assertions = await sql<
          { val_id: string; plan_slug: string; item_id: string; requires_test: boolean }[]
        >`
          SELECT val_id, plan_slug, item_id, requires_test
            FROM harness_shared.harness_plan_assertions
           WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
        if (assertions.length > 0) {
          const byVal = new Map(assertions.map((a) => [a.val_id, a]));
          const coversOf = (k: Keep): string[] => {
            const raw = (k.payload as { coversVALs?: unknown }).coversVALs;
            return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
          };

          // P-058: quarantine test rows whose coversVALs reference an unknown VAL.
          for (const k of keep) {
            const covers = coversOf(k);
            if (covers.length > 0 && covers.some((v) => !byVal.has(v))) {
              k.status = 'invalid_val_ref';
            }
          }

          // P-080: stamp plan linkage (plan_slug + item ids) onto each test's
          // payload, resolved from the VALs it covers. Empty/unmatched → no stamp
          // (infra/Built-in tests stay plan-unlinked, P-084).
          for (const k of keep) {
            const matched = coversOf(k)
              .map((v) => byVal.get(v))
              .filter((a): a is NonNullable<typeof a> => !!a);
            if (matched.length > 0) {
              k.payload = {
                ...k.payload,
                planSlug: matched[0].plan_slug,
                planItemIds: Array.from(new Set(matched.map((a) => a.item_id))),
              };
            }
          }

          // P-081: drive each VAL's assertion status from the tests covering it.
          // Uncovered VALs (derived 'todo') are left as-is.
          const tests = keep.map((k) => ({ coversVALs: coversOf(k), status: k.status }));
          for (const a of assertions) {
            const derived = deriveAssertionStatus(a.val_id, tests);
            if (derived !== 'todo') {
              await sql`
                UPDATE harness_shared.harness_plan_assertions
                   SET status = ${derived}
                 WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND val_id = ${a.val_id}`;
            }
          }
        }
      } catch {
        /* assertions table unavailable — skip linkage/status (fail-soft) */
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
