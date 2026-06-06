/**
 * Release-gating system actions — plan release-gate-ready-branch-2026-06-04
 * (Phase 1 green-checkpoint); staging→main auto-serve model since
 * staging-branch-pipeline-2026-06-06.
 *
 * Two routines, registered here so the routines engine can fire them:
 *   - `system:green-checkpoint` — fast-forwards the green pin (the **`main`
 *     branch**) to the newest GREEN `staging` commit. Runs the suite in an
 *     ISOLATED checkout.
 *   - `system:release-trigger` — when green `main` is ahead of the running
 *     release checkout, runs the SCRIPTED deploy (`deploy-cli --execute`)
 *     directly: the green gate IS the go/no-go now (auto-serve), and the deploy
 *     mechanics carry their own drain + health-check + auto-rollback. The
 *     release-manager agent remains for interactive/incident use only.
 *
 * Both are seeded ACTIVE (seed-release-routines.ts) — auto-serve posture.
 *
 * Layering: these handlers SHELL OUT to the standalone scripts in
 * apps/operator/lib/release/* (operator-core must not import the apps/operator
 * tier). The scripts are designed to run standalone via tsx for exactly this.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { appendPipelineEvent } from '../git-sync/pipeline-events';

/** The integration tree (where green-checkpoint/deploy operate). Explicit env so
 *  it stays correct even after the operator itself runs from the release checkout. */
function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(root: string, relScript: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin(root), [path.join(root, relScript), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * system:green-checkpoint — advance `ready` to the newest green integration
 * commit. Idempotent (FF-only, no-op when already green). Bounded so a stuck
 * suite can't wedge the routines tick.
 */
registerSystemAction('green-checkpoint', async (ctx: SystemActionCtx) => {
  const root = integrationRoot();
  const r = await runScript(root, 'apps/operator/lib/release/green-checkpoint.ts', [], 25 * 60_000);
  if (r.code !== 0) {
    console.warn(`[green-checkpoint] exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`[green-checkpoint] ${(r.stdout || '').trim().slice(-200)}`);
  }

  // Pipeline history (mig 177): log the checkpoint outcome for the /admin Git tab.
  // The CLI prints the CheckpointResult as JSON ({ advanced, candidate, from,
  // green, reason }); `reason` IS our status vocabulary. On a crash before that
  // print (non-zero exit, no parseable JSON), record an 'error' row instead.
  let status = 'error';
  const detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)) as {
      reason?: string;
      green?: boolean | null;
      candidate?: string;
      from?: string | null;
    };
    if (parsed?.reason) {
      status = parsed.reason; // advanced | up-to-date | not-green | not-fast-forward | create-failed
      detail.green = parsed.green ?? null;
      if (parsed.candidate) detail.candidate = parsed.candidate.slice(0, 12);
      if (parsed.from) detail.from = parsed.from.slice(0, 12);
    } else {
      detail.stderr = (r.stderr || r.stdout).slice(-300);
    }
  } catch {
    detail.code = r.code;
    detail.stderr = (r.stderr || r.stdout).slice(-300);
  }
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'green_checkpoint',
    status,
    detail,
  });
});

/** The LAST top-level JSON object printed to stdout (deploy-cli prints the plan
 *  first, then — under --execute — the result; both start a line with `{`). */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  for (let i = stdout.lastIndexOf('\n{'); i >= 0; i = stdout.lastIndexOf('\n{', i - 1)) {
    try {
      return JSON.parse(stdout.slice(i + 1, stdout.lastIndexOf('}') + 1)) as Record<string, unknown>;
    } catch {
      /* not a complete object from here — keep scanning back */
    }
  }
  try {
    return JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * system:release-trigger — AUTO-SERVE (staging-branch-pipeline-2026-06-06 D-002):
 * when green `main` is ahead of what the operator runs, run the SCRIPTED deploy
 * directly. The green gate is the go/no-go; deploy-cli's mechanics carry drain +
 * snapshot + migrate + health-check + auto-rollback. No agent in the loop.
 */
registerSystemAction('release-trigger', async (ctx: SystemActionCtx) => {
  const root = integrationRoot();
  // Cheap, side-effect-free: is there anything green to deploy?
  const plan = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', [], 60_000);
  let noop = true;
  let planObj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(plan.stdout.slice(plan.stdout.indexOf('{'), plan.stdout.lastIndexOf('}') + 1)) as {
      plan?: Record<string, unknown> & { noop?: boolean };
    };
    planObj = parsed?.plan ?? null;
    noop = parsed?.plan?.noop !== false; // default to noop on parse trouble (safe)
  } catch {
    console.warn('[release-trigger] could not parse deploy plan — skipping this tick');
    return;
  }
  if (noop) return; // release checkout already at green main

  const targetSha = typeof planObj?.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : undefined;
  const commits = Array.isArray(planObj?.commits) ? planObj.commits.length : undefined;
  const migrations = Array.isArray(planObj?.migrations) ? (planObj.migrations as string[]) : [];
  console.log(`[release-trigger] green main is ahead — auto-deploying ${targetSha ?? '?'} (${commits ?? '?'} commit(s), ${migrations.length} migration(s))`);

  // Deploy can take minutes (drain + node_modules sync + migrate + restart +
  // health probe). The routine engine's per-routine dedup stops a second trigger
  // racing this one; executeDeploy's own broadcast announces the outcome.
  const r = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', ['--execute'], 20 * 60_000);
  const result = lastJsonObject(r.stdout);
  const ok = r.code === 0 && result?.ok === true;
  const rolledBack = result?.rolledBack === true;
  const status = ok ? 'ok' : rolledBack ? 'rolled-back' : r.code === 2 ? 'refused' : 'failed';
  if (!ok) {
    console.warn(`[release-trigger] auto-deploy ${status} (exit ${r.code}): ${(typeof result?.error === 'string' && result.error) || (r.stderr || r.stdout).slice(-400)}`);
  }

  // Pipeline history (mig 177): one `deploy` row per ATTEMPT for the Git tab.
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'deploy',
    status,
    detail: {
      targetSha,
      commits,
      migrations: migrations.length,
      exitCode: r.code,
      ...(typeof result?.error === 'string' && result.error ? { error: result.error.slice(0, 300) } : {}),
    },
  });
});
