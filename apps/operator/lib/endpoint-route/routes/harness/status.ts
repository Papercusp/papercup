/**
 * GET /api/harness/:slug/status — dashboard snapshot for one harness.
 *
 * Returns features + counts + iteration + last-decision + liveness +
 * pending-checkpoints + active-competitions + smoke-fail flag + mission
 * cost/token aggregates. Polled every 3s by the dashboard.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 39).
 */
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import {
  resolvePhasedProject,
  harnessDir,
  parseFeatures,
  tailFile,
  countPulsesFromRunLog,
  aggregateCostFromLogDir,
  isProjectAlive,
  safeRead,
} from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/status',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const features = await parseFeatures(project);
    const counts = features.reduce((acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const runLogPath = join(harnessDir(project), 'logs', 'run.log');
    const runLog = tailFile(runLogPath, 16 * 1024);
    const decisionMatch = [...runLog.matchAll(/ORCH decision: (\S[^\n]*)/g)];
    const lastDecision = decisionMatch.length ? decisionMatch[decisionMatch.length - 1][1] : null;
    const iteration = countPulsesFromRunLog(runLogPath);

    const escalation = safeRead(join(harnessDir(project), 'escalation.md'));

    const __agg = aggregateCostFromLogDir(join(harnessDir(project), 'logs'));
    const missionCostUsd = __agg.cost;
    const missionInputTokens = __agg.inputTokens;
    const missionOutputTokens = __agg.outputTokens;

    const alive = isProjectAlive(project.path);

    let pendingCheckpoints = 0;
    let activeCompetitions = 0;
    let smokeFail = false;
    try {
      const hd = harnessDir(project);
      if (existsSync(hd)) {
        for (const f of readdirSync(hd)) {
          if (/^checkpoint-[A-Za-z0-9_.-]+\.md$/.test(f) && !existsSync(join(hd, `${f}.granted`))) {
            pendingCheckpoints += 1;
          }
          if (/^competition-[A-Za-z0-9_.-]+\.json$/.test(f)) {
            activeCompetitions += 1;
          }
        }
        smokeFail = existsSync(join(hd, 'smoke-failure.md'));
      }
    } catch { /* ignore */ }

    return Response.json({
      project: { slug: project.slug, path: project.path },
      features,
      counts,
      iteration,
      lastDecision,
      alive,
      escalated: escalation != null,
      pendingCheckpoints,
      activeCompetitions,
      smokeFail,
      missionCostUsd,
      missionInputTokens,
      missionOutputTokens,
    });
  },
});
