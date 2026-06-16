/**
 * /api/external-bench/runs/launch + /cancel + /estimate — the UI run trigger
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005, D-002).
 *
 *   POST /api/external-bench/runs/launch   { arm, taskSetId, taskIds?, model?, cap?,
 *        maxUsdPerTask?, maxTokensPerTask?, maxUsdPerRun? } → kicks the REAL bench
 *        engine as a detached managed run, persists status=running, returns { runId }
 *        IMMEDIATELY (the run streams live via @papercusp/sync). Gated on the
 *        papercusp-external-bench flag (the owner's spend gate) + single-active-run.
 *   POST /api/external-bench/runs/:id/cancel → freeze status + dissolve the hive.
 *   GET  /api/external-bench/estimate?taskSetId=&cap= → a cost+time estimate the
 *        launch form shows BEFORE launch (D-004), derived from the m3 per-task cost.
 *
 * Loopback-only (the run executes in-host; only the local desktop/operator calls
 * it). The spend-safety teardown lives in run-launcher.ts (detached finally + the
 * boot reaper); this route is the thin HTTP seam.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isSafeRunId } from '../../../external-bench/preserved-runs';
import { launchBenchRun, cancelBenchRun } from '../../../external-bench/run-launcher';
import { gradeBenchRun } from '../../../external-bench/grade-runner';
import { deleteBenchRun } from '../../../external-bench/run-store';
import { buildExportBundle } from '../../../external-bench/export-bundle';
import { knownTaskSets } from '../../../external-bench/task-sets';

// Per-task opus cost basis: the m3 real-Queen pass cost $33.98 over 11 tasks
// (~$3.09/task). Round up for a conservative pre-launch estimate.
const PER_TASK_USD = 3.5;
// Rough per-task wall minutes (a SWE-bench Pro task on the hive); time is the
// looser estimate — labelled rough in the UI.
const PER_TASK_WALL_MIN = 18;

const launch = defineTool({
  method: 'POST',
  path: '/external-bench/runs/launch',
  auth: 'loopback',
  timeoutSec: 30,
  async handler(req) {
    let body: {
      arm?: string;
      taskSetId?: string;
      taskIds?: string[];
      model?: string;
      cap?: number;
      maxUsdPerTask?: number;
      maxTokensPerTask?: number;
      maxUsdPerRun?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    if (!body.arm || !body.taskSetId) {
      return Response.json({ ok: false, error: 'arm and taskSetId are required' }, { status: 400 });
    }
    try {
      const { runId } = await launchBenchRun({
        arm: body.arm,
        taskSetId: body.taskSetId,
        taskIds: body.taskIds,
        model: body.model,
        cap: body.cap,
        maxUsdPerTask: body.maxUsdPerTask,
        maxTokensPerTask: body.maxTokensPerTask,
        maxUsdPerRun: body.maxUsdPerRun,
      });
      return Response.json({ ok: true, runId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('gated off')
        ? 403
        : msg.startsWith('conflicting_run_active')
          ? 409
          : 400;
      return Response.json({ ok: false, error: msg }, { status });
    }
  },
});

const cancel = defineTool({
  method: 'POST',
  path: '/external-bench/runs/:id/cancel',
  auth: 'loopback',
  timeoutSec: 60,
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!isSafeRunId(id)) {
      return Response.json({ ok: false, error: 'invalid_run_id' }, { status: 400 });
    }
    const { cancelled } = await cancelBenchRun(id);
    if (!cancelled) {
      return Response.json({ ok: false, error: 'run_not_found', id }, { status: 404 });
    }
    return Response.json({ ok: true, cancelled });
  },
});

const estimate = defineTool({
  method: 'GET',
  path: '/external-bench/estimate',
  auth: 'loopback',
  async handler(req) {
    const params = new URL(req.url).searchParams;
    const taskSetId = params.get('taskSetId') || '11-task-pilot';
    const cap = Math.max(1, Number(params.get('cap') ?? 5) || 5);
    const set = knownTaskSets().find((s) => s.id === taskSetId);
    const taskCount = set?.count ?? (taskSetId === 'swe-bench-pro-full' ? 731 : 11);
    const estCostUsd = Math.round(taskCount * PER_TASK_USD * 100) / 100;
    // Parallel wall ≈ ceil(N/cap) waves × per-task wall (rough).
    const waves = Math.ceil(taskCount / cap);
    const estWallMin = waves * PER_TASK_WALL_MIN;
    return Response.json({
      taskSetId,
      taskCount,
      cap,
      perTaskUsd: PER_TASK_USD,
      estCostUsd,
      estWallMin,
      basis: 'per-task cost from the m3 real-Queen pass ($33.98 / 11 ≈ $3.09/task, opus); time is rough.',
    });
  },
});

const grade = defineTool({
  method: 'POST',
  path: '/external-bench/runs/:id/grade',
  auth: 'loopback',
  timeoutSec: 30,
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!isSafeRunId(id)) {
      return Response.json({ ok: false, error: 'invalid_run_id' }, { status: 400 });
    }
    const res = await gradeBenchRun(id);
    if ('error' in res) {
      return Response.json({ ok: false, error: res.error }, { status: 404 });
    }
    return Response.json({ ok: true, runId: res.runId, grading: true });
  },
});

const exportBundle = defineTool({
  method: 'GET',
  path: '/external-bench/runs/:id/export',
  auth: 'loopback',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!isSafeRunId(id)) {
      return Response.json({ ok: false, error: 'invalid_run_id' }, { status: 400 });
    }
    const bundle = buildExportBundle(id);
    if (!bundle) {
      return Response.json({ ok: false, error: 'no_snapshot', id, hint: 'the run has no on-disk snapshot to export' }, { status: 404 });
    }
    return Response.json(bundle);
  },
});

const remove = defineTool({
  method: 'DELETE',
  path: '/external-bench/runs/:id',
  auth: 'loopback',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!isSafeRunId(id)) {
      return Response.json({ ok: false, error: 'invalid_run_id' }, { status: 400 });
    }
    const { deleted } = await deleteBenchRun(id);
    if (!deleted) {
      return Response.json({ ok: false, error: 'run_not_found', id }, { status: 404 });
    }
    return Response.json({ ok: true, deleted: true });
  },
});

export default [launch, cancel, estimate, grade, exportBundle, remove];
