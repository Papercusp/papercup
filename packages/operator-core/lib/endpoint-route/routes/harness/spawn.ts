/**
 * Spawn cluster — launch / invoke / resume.
 *
 *   POST /api/harness/:slug/launch    — kick off a full orchestrator run (detached)
 *   POST /api/harness/:slug/invoke    — single-role synchronous invocation (cross-harness primitive)
 *   POST /api/harness/:slug/resume    — clear escalation.md + relaunch
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 41). All three call `launchRun` from `lib/harness-launch.ts`
 * (carved out in b40).
 */
import { join } from 'node:path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getOrgPg, listUnconsumedEvents, consumeEvents } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  resolveProject,
  resolvePhasedProject,
  harnessDir,
} from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { SUPERUSER_TOKEN_PATH } from '../../../superuser-token';
import { launchRun } from '../../../harness-launch';
import { firePluginLifecycle, firePluginEvent } from '../../../plugin-host-runtime';
import { defineTool } from '@papercusp/agent-mcp';
import { requireLoopbackOr403 } from '../../loopback-guard';

const launch = defineTool({
  method: 'POST',
  path: '/harness/:slug/launch',
  auth: 'public',
  async handler(req, ctx) {
    const gate = requireLoopbackOr403(req);
    if (gate) return gate;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    // No gate: a harness can always be launched. SPEC.md is deprecated
    // (plans-central-harness-ux-2026-05-26, D-004) and a started plan is not
    // required to launch — with none, the orchestrator simply finds no
    // plan-scoped features eligible to pick and idles, rather than the launch
    // being rejected.
    const body = await req.json().catch(() => ({}));
    const extra = typeof (body as any).extra === 'string' ? (body as any).extra : '';
    const result = await launchRun(project, extra);
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
    // Phase 6b — plugin lifecycle hooks; best-effort.
    void firePluginLifecycle('beforeMissionStart', {
      installSlug: project.slug,
      projectDir: project.path,
      stateDir: harnessDir(project),
    });
    void firePluginEvent('mission.start', { installSlug: project.slug });
    return Response.json({ ok: true, logPath: result.logPath });
  },
});

/**
 * Extract ```actions``` block from agent output and POST each entry to
 * /api/admin/execute-action with the harness's harness_token. Returns
 * a summary of dispatched actions or null if no block was present.
 */
async function dispatchActionsBlockFromOutput(
  callerSlug: string,
  projectPath: string,
  output: string,
): Promise<{ count: number; results: any[] } | null> {
  let blockMatch = output.match(/```actions\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) {
    const pathMatch = output.match(/stdout:\s*(\S+\.out)/);
    let jsonlPath: string | null = null;
    if (pathMatch) {
      jsonlPath = pathMatch[1].replace(/\.out$/, '.jsonl');
    } else {
      const logsDir = join(projectPath, '.papercusp', 'logs');
      if (existsSync(logsDir)) {
        const files = readdirSync(logsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ path: join(logsDir, f), mt: statSync(join(logsDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        if (files.length > 0) jsonlPath = files[0].path;
      }
    }
    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        const text = readFileSync(jsonlPath, 'utf8').split('\n').reduce((acc, line) => {
          try {
            const j = JSON.parse(line);
            const ev = j.event || j;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              return acc + (ev.delta.text || '');
            }
          } catch { /* skip */ }
          return acc;
        }, '');
        blockMatch = text.match(/```actions\s*\n([\s\S]*?)\n```/);
      } catch { /* skip */ }
    }
  }
  if (!blockMatch) return null;
  let actions: any[];
  try {
    actions = JSON.parse(blockMatch[1]);
    if (!Array.isArray(actions)) return null;
  } catch {
    return { count: 0, results: [{ error: 'malformed JSON in actions block' }] };
  }
  if (actions.length === 0) return null;

  const cfgPath = join(projectPath, '.papercusp', 'config.json');
  if (!existsSync(cfgPath)) return null;
  let token: string;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    token = cfg.harness_token;
    if (!token) return null;
  } catch { return null; }

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const results: any[] = [];
  for (const action of actions) {
    const actionId = randomUUID();
    try {
      const r = await fetch(`${operatorBase}/api/admin/execute-action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ actionId, action }),
        signal: AbortSignal.timeout(360_000),
      });
      const j = await r.json().catch(() => ({}));
      results.push({ op: action.op, ok: (j as any).ok === true, error: (j as any).error ?? null, status: r.status });
    } catch (e: any) {
      results.push({ op: action.op, ok: false, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { count: actions.length, results };
}

/**
 * Single-role invocation — used by NEXT_HARNESS dispatch from a parent
 * harness's coordinator. Synchronously runs the TS orchestrator's
 * `invoke-once` (`invoke <role>`) in the child harness's project dir and
 * returns the captured stdout.
 */
const invoke = defineTool({
  method: 'POST',
  path: '/harness/:slug/invoke',
  auth: 'public',
  // A single-role agent invocation runs an LLM to completion — far longer than
  // the 30s route default. The handler caps the child at `timeoutMs` (≤1200s —
  // raised from 300s for long single-role launches: a scheduled `scan` blueprint
  // run sweeps the workspace for many turns; unify-agent-launches P-009 smoke
  // showed 300s SIGTERMs a real scan with zero output). Give the route a ceiling
  // just above the cap so it never aborts a within-limits agent mid-run
  // (claude-code promote reads the plan + calls plans:promote, ~30-120s).
  timeoutSec: 1210,
  async handler(req, ctx) {
    const gate = requireLoopbackOr403(req);
    if (gate) return gate;
    const url = new URL(req.url);
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = url.searchParams.get('role') ?? 'orchestrator';
    if (!/^[A-Za-z0-9_-]+$/.test(role)) {
      return Response.json({ error: 'invalid role name' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({} as any));
    const timeoutMs = Math.max(5_000, Math.min(1_200_000, Number((body as any)?.timeoutMs ?? 90_000)));
    const extra: string[] = Array.isArray((body as any)?.extra)
      ? (body as any).extra.filter((s: any) => typeof s === 'string')
      : [];

    // Phase 7: write pending_events for the role to read at $STATE_DIR/pending-events.jsonl.
    if (role === 'orchestrator') {
      try {
        const { sql } = getOrgPg();
        // P-041: scope the queue read/consume to the request workspace — the
        // admin handle bypasses RLS and install_slug isn't workspace-unique, so
        // an unscoped read would hand this orchestrator another workspace's
        // events (and the consume would mark them handled).
        const ws = activeWorkspaceId();
        const events = await listUnconsumedEvents(sql, project.slug, { onlyDue: true, limit: 25, workspaceId: ws });
        const stateDir = join(project.path, '.papercusp');
        const eventsFile = join(stateDir, 'pending-events.jsonl');
        mkdirSync(stateDir, { recursive: true });
        if (events.length > 0) {
          const jsonl = events
            .map((e) => JSON.stringify({
              id: e.id,
              kind: e.kind,
              target_role: e.targetRole,
              payload: e.payload,
              due_at: e.dueAt,
              source_id: e.sourceId,
            }))
            .join('\n');
          writeFileSync(eventsFile, jsonl + '\n', 'utf8');
          await consumeEvents(sql, events.map((e) => e.id), `papercusp-invoke:${project.slug}`, ws);
        } else {
          try { rmSync(eventsFile, { force: true }); } catch { /* ignore */ }
        }
      } catch {
        // pending_events table absent — proceed without
      }
    }

    // This route is operator-initiated + loopback-gated (requireLoopbackOr403
    // above), so the spawned agent connects to the agent-mcp via the
    // `?superuser=1` door — giving it the isSuperuser identity that
    // resolveAgentIdentity-gated coord tools (plans:promote, coord:*) require.
    // A plain signed-spawn ctx has no principal, so those tools 4xx. The bearer
    // is read here and threaded to spawn-mcp (writeSignedSpawnMcp) via env.
    const suBearer = (() => {
      try { return readFileSync(SUPERUSER_TOKEN_PATH, 'utf8').trim() || undefined; }
      catch { return undefined; }
    })();

    // Route the spawn through the ONE chokepoint (spawnInvokeOnce) — governor pacing
    // + the unified ceiling + whole-group kill on timeout — instead of a private
    // buildInvokeOnce + raw child_process.spawn (unify-agent-spawn-chokepoint P-008).
    // The per-request timeoutMs is threaded through; the route keeps its
    // actions-dispatch + structured response, now on the chokepoint's output.
    //
    // LAZY import on purpose: orchestrator-runner transitively pulls in the whole DBOS
    // workflow graph (orchestrator-loop/-workflow register process-global workflows at
    // module load). Importing it eagerly would drag those registrations into the route
    // graph, so any test that re-imports the routes under vi.resetModules() would hit a
    // duplicate-registration crash. Loading it on first /invoke (cached thereafter)
    // keeps route registration side-effect-free; the cost is a one-time async import.
    const { spawnInvokeOnce } = await import('../../../dbos/orchestrator-runner');
    const r = await spawnInvokeOnce(
      project.path,
      role,
      extra,
      suBearer ? { PAPERCUSP_SPAWN_SU_BEARER: suBearer } : {},
      { timeoutMs },
    );
    const agentOutput = r.output; // spawnInvokeOnce already strips the [timestamp] log lines
    const decisionLine = (agentOutput.split('\n')[0] ?? '').trim();
    const timedOut = r.timedOut ?? false;
    const ok = r.exitCode === 0 && !timedOut;
    let actionsResult: { count: number; results: any[] } | null = null;
    if (ok) {
      try {
        actionsResult = await dispatchActionsBlockFromOutput(project.slug, project.path, agentOutput);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[invoke ${project.slug}/${role}] actions dispatch failed:`, e);
      }
    }
    return Response.json({
      ok,
      slug: project.slug,
      role,
      decisionLine,
      agentOutput,
      stdout: agentOutput,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut,
      actions: actionsResult,
    });
  },
});

const resume = defineTool({
  method: 'POST',
  path: '/harness/:slug/resume',
  auth: 'public',
  async handler(req, ctx) {
    const gate = requireLoopbackOr403(req);
    if (gate) return gate;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    try { await unlink(join(harnessDir(project), 'escalation.md')); } catch { /* ignore */ }
    const result = await launchRun(project);
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ ok: true, logPath: result.logPath });
  },
});

export default [launch, invoke, resume];
