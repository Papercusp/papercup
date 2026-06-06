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

function runScript(
  root: string,
  relScript: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin(root), [path.join(root, relScript), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root, ...extraEnv },
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

/** The fixed transient-unit name for the detached auto-deploy — fixed on
 *  purpose: systemd-run refuses a second unit with the same name while one is
 *  active, which is exactly the dedup we want across trigger ticks. */
export const AUTO_DEPLOY_UNIT = 'papercup-auto-deploy';

/**
 * system:release-trigger — AUTO-SERVE (staging-branch-pipeline-2026-06-06 D-002):
 * when green `main` is ahead of what the operator runs, launch the SCRIPTED
 * deploy. The green gate is the go/no-go; deploy-cli's mechanics carry drain +
 * snapshot + migrate + restart + health-check + auto-rollback, and deploy.ts
 * records the `deploy` pipeline event itself.
 *
 * The deploy is launched as a DETACHED transient systemd unit, NOT a child of
 * this host: the deploy restarts the very host this routine runs in, so a child
 * deploy-cli dies at its own restart step — the 2026-06-06 10:31 auto-deploy
 * lost its health probe, AUTO-ROLLBACK, broadcast and event exactly that way
 * (swap+migrate land before restart, which is why it half-worked). A transient
 * unit survives the restart and completes the whole lifecycle.
 */
registerSystemAction('release-trigger', async (_ctx: SystemActionCtx) => {
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

  const targetSha = typeof planObj?.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : '?';
  const commits = Array.isArray(planObj?.commits) ? planObj.commits.length : '?';
  console.log(`[release-trigger] green main is ahead — launching detached auto-deploy of ${targetSha} (${commits} commit(s)) as ${AUTO_DEPLOY_UNIT}`);

  // PAPERCUSP_ALLOW_DEV_RESTART=1: the restart step is env-gated against ad-hoc
  // runs restarting the shared host — this routine IS the owner-authorized
  // auto-serve path (D-002), so it self-authorizes. Fire-and-forget: the
  // outcome is reported by deploy.ts (broadcast + pipeline event + awaitable
  // release:deployed/deploy-failed), not by this (about-to-be-restarted) host.
  await new Promise<void>((resolve) => {
    const child = spawn('systemd-run', [
      '--user',
      '--collect',
      `--unit=${AUTO_DEPLOY_UNIT}`,
      `--working-directory=${root}`,
      'bash',
      '-lc',
      `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' npx tsx apps/operator/lib/release/deploy-cli.ts --execute >> /tmp/${AUTO_DEPLOY_UNIT}.log 2>&1`,
    ]);
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      console.warn(`[release-trigger] failed to launch ${AUTO_DEPLOY_UNIT}: ${e instanceof Error ? e.message : e}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Most common cause: the unit already exists = a deploy is in flight.
        console.warn(`[release-trigger] systemd-run exited ${code} (deploy already running?): ${stderr.trim().slice(0, 200)}`);
      }
      resolve();
    });
  });
});
