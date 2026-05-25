/**
 * Background scoper invocation — fires a detached bash process that sources
 * `run.sh`'s function library and runs `invoke scoper MODE=<mode>`. Returns
 * an opaque invocationId; the child writes to `scoper-results/<mode>-<id>.log`
 * with a trailing `__INVOCATION_DONE__` sentinel.
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 29 — prereq for the proposals/product-review/replan/cleanup
 * routes which all call this helper).
 *
 * `run.sh` remains on disk as a function library for legacy sourcing call
 * sites (this one) but is no longer the iteration driver — that role moved
 * to the TS orchestrator (`PAPERCUSP_USE_TS_ORCHESTRATOR=1`).
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { harnessDir } from '@/lib/harness-core';
import { type ProjectEntry } from '@/lib/harness-registry';
import { harnessPackageDir } from '@/lib/harness-paths';

/** Read scoper.outputMode from .harness/config.json (default: 'proposal'). */
function readScoperOutputMode(stateDir: string): 'proposal' | 'plan' {
  try {
    const raw = readFileSync(join(stateDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const scoper = cfg.scoper as Record<string, unknown> | undefined;
    return scoper?.outputMode === 'plan' ? 'plan' : 'proposal';
  } catch {
    return 'proposal';
  }
}

export function invokeScoperBackground(
  project: ProjectEntry,
  mode: 'proposal' | 'replan' | 'cleanup',
): { invocationId: string } {
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(project.path, '.harness');
  const resultsDir = join(harnessDir(project), 'scoper-results');
  const resultPath = join(resultsDir, `${mode}-${invocationId}.log`);
  const outputMode = mode === 'proposal' ? readScoperOutputMode(stateDir) : 'proposal';
  const wrapper = `
    set -e
    export PROJECT_DIR="${project.path}"
    export STATE_DIR="${project.path}/.harness"
    export HARNESS_DIR="${harnessPackageDir()}"
    export LOG_DIR="$STATE_DIR/logs"
    export SCOPER_INVOCATION_ID="${invocationId}"
    export SCOPER_OUTPUT_MODE="${outputMode}"
    mkdir -p "$STATE_DIR/proposals" "$LOG_DIR" "${resultsDir}"
    source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|auto_screenshot_post_worker|check_cost_cap|prune_logs)\\(\\)/,/^}/' "$HARNESS_DIR/run.sh")
    invoke scoper "MODE=${mode}" "OUTPUT_MODE=${outputMode}" 2>&1 | tee "${resultPath}"
    echo "__INVOCATION_DONE__" >> "${resultPath}"
  `;
  const child = spawn('bash', ['-c', wrapper], {
    cwd: project.path,
    env: { ...process.env, CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p' },
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return { invocationId };
}
