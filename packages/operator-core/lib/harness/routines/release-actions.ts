/**
 * Release-gating system actions — plan release-gate-ready-branch-2026-06-04
 * (Phase 1 green-checkpoint + D-010 deploy trigger).
 *
 * Two routines, registered here so the routines engine can fire them:
 *   - `system:green-checkpoint` — fast-forwards `ready` to the newest GREEN
 *     integration commit (Phase 1). Runs the suite in an ISOLATED checkout.
 *   - `system:release-trigger` — when `ready` is ahead of the running release
 *     checkout, dispatches the Opus-4.8-xhigh **release-manager** agent to make
 *     the go/no-go call + run the deploy (D-010 + D-011). The fleet-idle gate is
 *     enforced downstream by the deploy's dev-server drain; a scheduled cron
 *     gives the max-staleness backstop.
 *
 * Both are SEEDED INACTIVE (seed-release-routines.ts) — bring-up is
 * human-confirmed, graduating to auto once trust is earned (D-010).
 *
 * Layering: these handlers SHELL OUT to the standalone scripts in
 * apps/operator/lib/release/* (operator-core must not import the apps/operator
 * tier). The scripts are designed to run standalone via tsx for exactly this.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTarget } from '../../blueprint/launch-blueprint';

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
registerSystemAction('green-checkpoint', async (_ctx: SystemActionCtx) => {
  const root = integrationRoot();
  const r = await runScript(root, 'apps/operator/lib/release/green-checkpoint.ts', [], 25 * 60_000);
  if (r.code !== 0) {
    console.warn(`[green-checkpoint] exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`[green-checkpoint] ${(r.stdout || '').trim().slice(-200)}`);
  }
});

/**
 * system:release-trigger — if `ready` is ahead of what the operator runs, hand
 * the deploy to the release-manager agent (which reviews + decides + executes).
 * The drain enforces "idle"; a scheduled cron gives the backstop.
 */
registerSystemAction('release-trigger', async (ctx: SystemActionCtx) => {
  const root = integrationRoot();
  // Cheap, side-effect-free: is there anything green to deploy?
  const plan = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', [], 60_000);
  let noop = true;
  try {
    const parsed = JSON.parse(plan.stdout.slice(plan.stdout.indexOf('{'), plan.stdout.lastIndexOf('}') + 1));
    noop = parsed?.plan?.noop !== false; // default to noop on parse trouble (safe)
  } catch {
    console.warn('[release-trigger] could not parse deploy plan — skipping this tick');
    return;
  }
  if (noop) return; // release checkout already at ready

  // Dispatch the deploy launch (unify-agent-launches-as-blueprints D-002/D-003):
  // the role + model are now DECLARED by the `deploy` launch blueprint (decider
  // release-manager, opus:xhigh) and resolved here, instead of a hardcoded
  // `role=release-manager` literal. The trigger (release cadence) + the cheap
  // "is anything green to deploy" precheck above stay the routine's concern; the
  // go/no-go + rollback gate lives inside the release-manager agent. The /invoke
  // route runs the agent to completion; the agent gathers the plan, reviews,
  // deploys (drain enforces clean-time), and decides rollback. Behavior-preserving:
  // same await + 280s timeout (the await serializes against the next 15-min tick).
  const slug = ctx.installSlug;
  const { url, role } = await resolveLaunchTarget('deploy', { installSlug: slug, workspaceId: ctx.workspaceId });
  console.log(`[release-trigger] ready is ahead — dispatching ${role} (deploy blueprint) for ${slug}`);
  await loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff:
        'A green `ready` is ahead of the running release checkout. Gather the deploy plan, review the diff + staged migrations, make the go/no-go call, and (if go) run the deploy. Hold if anything is unsafe in front of the fleet right now.',
      timeoutMs: 280_000,
    }),
  }).catch((e) => console.warn(`[release-trigger] dispatch failed: ${e instanceof Error ? e.message : e}`));
});
