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
  let candidate: string | undefined;
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
      candidate = parsed.candidate;
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

  // P-006 (release-pipeline-resilience-2026-06-09): a held gate auto-dispatches a
  // release-fixer agent to diagnose + fix the failing test — the test-failure
  // sibling of git-sync's merge-resolver. Fail-safe + deduped per red-candidate.
  if (status === 'not-green' && candidate) {
    await dispatchReleaseFixer(ctx, candidate).catch((e) =>
      console.warn(`[green-checkpoint] release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }
});

/**
 * P-006: dispatch a release-fixer agent for a held (not-green) gate, mirroring
 * git-sync's merge-resolver (git-sync-action.ts `spawnMergeResolver`). Resolves
 * the `release-fix` launch blueprint from the `green-checkpoint:red` trigger event
 * and invokes its role via the loopback invoke route. Deduped per red-candidate
 * via the green-checkpoint routine metadata (`last_fixer`) so the hourly tick
 * doesn't respawn a fixer while one is in flight for the same candidate.
 * Fail-safe: every step is best-effort and never throws into the routine tick.
 */
async function dispatchReleaseFixer(ctx: SystemActionCtx, candidate: string): Promise<void> {
  const { resolveLaunchTargetForEvent } = await import('../../blueprint/launch-blueprint');
  const target = await resolveLaunchTargetForEvent('green-checkpoint:red', {
    installSlug: ctx.installSlug,
    workspaceId: ctx.workspaceId,
  });
  if (!target) return; // no blueprint declares the trigger — nothing to dispatch
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // Dedup: a fixer dispatched for THIS candidate within the last 2h is "in flight".
  const rows = (await sql.unsafe(
    `SELECT metadata->'last_fixer' AS lf FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ lf: { candidate?: string; at?: number } | null }>;
  const lf = rows[0]?.lf ?? null;
  if (lf?.candidate === candidate && typeof lf.at === 'number' && Date.now() - lf.at < 2 * 60 * 60_000) {
    return;
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ last_fixer: { candidate, at: Date.now(), status: 'dispatched' } })],
  );
  const { loopbackFetch } = await import('../../loopback-fetch');
  void loopbackFetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff: `green-checkpoint held \`main\`: candidate ${candidate.slice(0, 8)} failed the gate suite. Read the newest ~/.papercusp/checkpoint-logs/*.log, reproduce the failing test(s) locally to classify regression-vs-flake, then fix the code or de-flake (hermetic > tier-out > accountable quarantine). Do NOT push — the next checkpoint re-verifies.`,
      extra: ['--green-checkpoint-red', JSON.stringify({ candidate })],
      timeoutMs: 280_000,
    }),
  })
    .then((res) =>
      appendPipelineEvent({
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        kind: 'release_fixer',
        status: res.ok ? 'ok' : 'failed',
        detail: { candidate: candidate.slice(0, 12), httpStatus: res.status },
      }),
    )
    .catch((e) =>
      appendPipelineEvent({
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        kind: 'release_fixer',
        status: 'error',
        detail: { candidate: candidate.slice(0, 12), error: (e instanceof Error ? e.message : String(e)).slice(0, 200) },
      }).catch(() => {}),
    );
}

/** The fixed transient-unit name for the detached auto-deploy — fixed on
 *  purpose: systemd-run refuses a second unit with the same name while one is
 *  active, which is exactly the dedup we want across trigger ticks. */
export const AUTO_DEPLOY_UNIT = 'papercup-auto-deploy';

/** The subset of the deploy plan (deploy.ts `DeployPlan`, emitted as JSON by
 *  `deploy-cli`) that the auto-serve gate reads. */
export interface AutoServePlan {
  targetSha?: string;
  currentReleaseSha?: string | null;
  isFastForward?: boolean;
  commits?: string[];
  noop?: boolean;
  /** Every changed path in this plan is the papercusp-desktop submodule gitlink — a
   *  shell-only pointer bump the operator deploy must skip (desktop-submodule-of-
   *  papercup-2026-06-09 D-003). Set by gatherPlan; absent on old plan JSON. */
  desktopOnly?: boolean;
}

/**
 * Auto-serve policy — may the unattended release-trigger deploy this plan?
 *
 * The trigger may ONLY advance the release checkout **forward** to a green
 * `main` that brings ≥1 NEW commit via a fast-forward (or perform the first
 * deploy, when the checkout isn't set up yet). It must NEVER act on a
 * zero-new-commit plan.
 *
 * Why this guard exists (root-caused 2026-06-07): the *detached* release
 * checkout can transiently sit AHEAD of green `main` — a
 * `chore(git-sync): auto-commit` lands in it during a deploy / green-checkpoint
 * race — so `currentReleaseSha !== targetSha` (the old `noop` SHA-equality test
 * is false) while `commits` is empty and `isFastForward` is false. The old gate
 * (`if (plan.noop) return`) missed exactly this case and redeployed a plan that
 * applies ZERO commits, which reverts the checkout BACKWARD; the next git-sync
 * tick re-advances it → an infinite redeploy storm, each iteration
 * HARD-RESTARTING the `:3070` operator and dropping in-flight MCP/HTTP requests.
 * Forward-only + non-empty + fast-forward is the structural fix. A
 * backward / lateral / non-FF move is a deliberate rollback (`rollback.ts`) or a
 * reviewed forced deploy (`deploy-cli --force`), never auto-serve.
 *
 * Also skips a DESKTOP-ONLY pointer bump (desktop-submodule-of-papercup-2026-06-09
 * D-003): once papercusp-desktop is a submodule, every desktop edit bumps the
 * superproject `papercusp-desktop` gitlink → FFs onto green `main`. Without this guard
 * a shell-only change would drain + restart the live `:3070` operator (which never
 * builds or uses the desktop). A forced/manual `deploy-cli --execute` still can.
 */
export function shouldAutoServe(plan: AutoServePlan): boolean {
  // First deploy — the release checkout isn't set up yet → establish it.
  if (plan.currentReleaseSha === null) return true;
  // Malformed/absent field → conservative: don't deploy.
  if (typeof plan.currentReleaseSha !== 'string') return false;
  if (plan.noop === true) return false;
  // D-003: a desktop-only pointer bump doesn't touch the operator — don't
  // auto-redeploy :3070 for a shell-only change.
  if (plan.desktopOnly === true) return false;
  // Forward-only: a genuine fast-forward bringing ≥1 NEW commit. A 0-commit or
  // non-FF plan means the checkout is AT or AHEAD of `main` → never redeploy.
  return plan.isFastForward === true && Array.isArray(plan.commits) && plan.commits.length > 0;
}

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
  let planObj: AutoServePlan | null = null;
  try {
    const parsed = JSON.parse(plan.stdout.slice(plan.stdout.indexOf('{'), plan.stdout.lastIndexOf('}') + 1)) as {
      plan?: AutoServePlan;
    };
    planObj = parsed?.plan ?? null;
  } catch {
    console.warn('[release-trigger] could not parse deploy plan — skipping this tick');
    return;
  }
  // Forward-only auto-serve: only advance to a green `main` that brings ≥1 new
  // commit via a fast-forward (or the first deploy). Skips the
  // checkout-at/ahead-of-main case that previously storm-redeployed :3070 — see
  // `shouldAutoServe`.
  if (!planObj || !shouldAutoServe(planObj)) return;

  const targetSha = typeof planObj.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : '?';
  const commits = Array.isArray(planObj.commits) ? planObj.commits.length : '?';
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
