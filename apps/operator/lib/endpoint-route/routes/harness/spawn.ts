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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getOrgPg, listUnconsumedEvents, consumeEvents } from '@restart/db-org';
import {
  resolveProject,
  resolvePhasedProject,
  harnessDir,
} from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { harnessPath, harnessPackageDir } from '@/lib/harness-paths';
import { launchRun } from '@/lib/harness-launch';
import { firePluginLifecycle, firePluginEvent } from '@/lib/plugin-host-runtime';
import { defineTool } from '@papercusp/agent-mcp';

const launch = defineTool({
  method: 'POST',
  path: '/harness/:slug/launch',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const specPath = join(project.path, 'SPEC.md');
    if (!existsSync(specPath)) {
      return Response.json(
        {
          error: 'SPEC.md not found',
          hint: 'Create SPEC.md in the project directory describing what you want built. The scoper reads this to generate the work queue.',
          path: specPath,
        },
        { status: 400 },
      );
    }
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
      const logsDir = join(projectPath, '.harness', 'logs');
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

  const cfgPath = join(projectPath, '.harness', 'config.json');
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
 * harness's coordinator. Synchronously runs `bash run.sh invoke <role>` in
 * the child harness's project dir and returns the captured stdout.
 */
const invoke = defineTool({
  method: 'POST',
  path: '/harness/:slug/invoke',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = url.searchParams.get('role') ?? 'orchestrator';
    if (!/^[A-Za-z0-9_-]+$/.test(role)) {
      return Response.json({ error: 'invalid role name' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({} as any));
    const timeoutMs = Math.max(5_000, Math.min(300_000, Number((body as any)?.timeoutMs ?? 90_000)));
    const extra: string[] = Array.isArray((body as any)?.extra)
      ? (body as any).extra.filter((s: any) => typeof s === 'string')
      : [];

    const runScript = harnessPath('run.sh');
    if (!existsSync(runScript)) return Response.json({ error: 'run.sh missing' }, { status: 500 });

    // Phase 7: write pending_events for the role to read at $STATE_DIR/pending-events.jsonl.
    if (role === 'orchestrator') {
      try {
        const { sql } = getOrgPg();
        const events = await listUnconsumedEvents(sql, project.slug, { onlyDue: true, limit: 25 });
        const stateDir = join(project.path, '.harness');
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
          await consumeEvents(sql, events.map((e) => e.id), `papercusp-invoke:${project.slug}`);
        } else {
          try { rmSync(eventsFile, { force: true }); } catch { /* ignore */ }
        }
      } catch {
        // pending_events table absent — proceed without
      }
    }

    const harnessDirPath = harnessPackageDir();
    const escapedExtra = [role, ...extra]
      .map((s) => `'${String(s).replace(/'/g, "'\\''")}'`)
      .join(' ');
    const wrapper = `
    set -e
    export PROJECT_DIR="${project.path}"
    export STATE_DIR="${project.path}/.harness"
    export HARNESS_DIR="${harnessDirPath}"
    export LOG_DIR="$STATE_DIR/logs"
    mkdir -p "$STATE_DIR" "$LOG_DIR"
    if [ -f "$STATE_DIR/config.json" ]; then
      export HARNESS_PHASE="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("phase", "staging"))
except Exception:
    print("staging")
')"
    fi
    source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|auto_screenshot_post_worker|notify_event|check_cost_cap|prune_logs)\\(\\)/,/^}/' $HARNESS_DIR/run.sh)
    invoke ${escapedExtra}
  `;
    return new Promise<Response>((resolve) => {
      const child = spawn('bash', ['-c', wrapper], {
        cwd: project.path,
        env: {
          ...process.env,
          CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
          MAX_ITERATIONS: '1',
        },
      });
      let stdout = '', stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
      child.stdout?.on('data', (d) => { stdout += String(d); });
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const agentLines = stdout.split('\n').filter((l) => !/^\[20\d\d-\d\d-\d\dT/.test(l));
        const agentOutput = agentLines.join('\n').trim();
        const decisionLine = (agentOutput.split('\n')[0] ?? '').trim();

        (async () => {
          let actionsResult: { count: number; results: any[] } | null = null;
          if (code === 0 && !timedOut) {
            try {
              actionsResult = await dispatchActionsBlockFromOutput(project.slug, project.path, agentOutput);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn(`[invoke ${project.slug}/${role}] actions dispatch failed:`, e);
            }
          }

          resolve(Response.json({
            ok: code === 0 && !timedOut,
            slug: project.slug,
            role,
            decisionLine,
            agentOutput,
            stdout,
            stderr,
            exitCode: code,
            timedOut,
            actions: actionsResult,
          }));
        })();
      });
    });
  },
});

const resume = defineTool({
  method: 'POST',
  path: '/harness/:slug/resume',
  auth: 'public',
  async handler(req, ctx) {
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
