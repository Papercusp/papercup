/**
 * Deploy CLI — the single human/agent entry to the deploy chokepoint
 * (plan release-gate-ready-branch-2026-06-04, Phase 2).
 *
 *   tsx deploy-cli.ts                 # PLAN ONLY — gather + print (review mode)
 *   tsx deploy-cli.ts --execute       # deploy the green `main` branch
 *   tsx deploy-cli.ts --deploy-commit <sha> --execute   # D-009 escape hatch (un-green, loud)
 *
 * AUTO-SERVE (staging-branch-pipeline-2026-06-06): the `system:release-trigger`
 * routine runs `--execute` itself when green `main` is ahead of the release
 * checkout. A human (or the release-manager agent, for incidents) can do the
 * same. The safe default deploys the GREEN pin (releaseRef = `main`); deploying
 * an un-green commit requires --deploy-commit/--force and emits a loud audit
 * broadcast.
 *
 * Flags: --target <ref> | --deploy-commit <sha> | --force | --no-drain
 *        | --no-rollback | --drain-sec <n> | --execute
 *
 * `main` is exported + fully injectable (argv + the gather/deps/execute seams)
 * so the gate's exit-code chokepoint is unit-tested without launching a real
 * deploy (deploy-cli.test.ts). The top-level `main().then(process.exit)` runs
 * ONLY when invoked as the CLI (the ESM `require.main === module` guard), so an
 * `import` of this module is side-effect-free.
 */

import { pathToFileURL } from 'node:url';
import { releaseConfig, type ReleaseConfig } from './release-config';
import {
  gatherPlan as realGatherPlan,
  executeDeploy as realExecuteDeploy,
  type DeployDeps,
  type DeployPlan,
  type DeployResult,
  type ExecuteOpts,
} from './deploy';
import { realDeps } from './deploy-deps';
import type { RealDepsOpts } from './deploy-deps';

/** The marker the deploy CLI prints its plan JSON behind, so the release-trigger routine
 *  parses ONE delimited line instead of brace-slicing all of stdout (P-008). MUST stay in
 *  sync with the literal in release-actions.ts. */
export const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/**
 * Injectable seams for `main`. Every field defaults to the real wiring, so the
 * production CLI behaves exactly as before; tests override the seams to drive
 * the gate's branches (refuse / proceed / forced) against stubs — no git, no
 * drain, no restart, no real deploy.
 */
export interface DeployCliDeps {
  /** argv to parse (default `process.argv`). */
  argv?: string[];
  /** Resolved release config (default `releaseConfig()`). */
  cfg?: ReleaseConfig;
  /** Gather the (side-effect-free) deploy plan (default the real git-only `gatherPlan`). */
  gatherPlan?: (cfg: ReleaseConfig, opts: { target?: string; force?: boolean }) => Promise<DeployPlan>;
  /** Build the real-effect deploy deps (default `realDeps`). */
  makeDeps?: (cfg: ReleaseConfig, opts: RealDepsOpts) => DeployDeps;
  /** Run the deploy mechanics (default the real `executeDeploy`). */
  executeDeploy?: (cfg: ReleaseConfig, plan: DeployPlan, deps: DeployDeps, opts: ExecuteOpts) => Promise<DeployResult>;
  /** stdout sink (default `console.log`). */
  out?: (s: string) => void;
  /** stderr sink (default `console.error`). */
  err?: (s: string) => void;
}

/**
 * The deploy CLI entrypoint. Returns the process exit code:
 *   0 — plan-only, noop, or a successful deploy
 *   1 — a deploy ran but failed
 *   2 — REFUSED: an un-green target without --force/--deploy-commit (the gate)
 *
 * Pure over its injected deps — `process.exit` is the caller's job (the
 * top-level guard below), so a test can assert the returned code directly.
 */
export async function main(injected: DeployCliDeps = {}): Promise<number> {
  const argv = injected.argv ?? process.argv;
  const out = injected.out ?? ((s: string) => console.log(s));
  const err = injected.err ?? ((s: string) => console.error(s));
  const gatherPlan = injected.gatherPlan ?? realGatherPlan;
  const makeDeps = injected.makeDeps ?? realDeps;
  const executeDeploy = injected.executeDeploy ?? realExecuteDeploy;

  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const cfg = injected.cfg ?? releaseConfig();
  const deployCommit = arg('--deploy-commit');
  const force = has('--force') || !!deployCommit;
  const target = deployCommit ?? arg('--target');
  const execute = has('--execute');

  const plan = await gatherPlan(cfg, { target, force });

  out(JSON.stringify({ mode: execute ? 'execute' : 'plan', config: { releaseRoot: cfg.releaseRoot, releaseRef: cfg.releaseRef, unit: cfg.systemdUnit }, plan }, null, 2));
  // P-008: machine-readable plan on ONE delimited line for the release-trigger routine.
  out(`${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: execute ? 'execute' : 'plan', plan })}`);

  if (plan.warnings.length) {
    err('\n⚠ WARNINGS:');
    for (const w of plan.warnings) err(`   - ${w}`);
  }

  if (!execute) {
    err('\n[deploy] PLAN ONLY — pass --execute to run. (The release-manager reviews this diff + the staged migrations before go/no-go.)');
    return 0;
  }

  if (plan.noop) {
    err('[deploy] release checkout already at target — nothing to deploy.');
    return 0;
  }

  // Safe default: refuse a non-green target unless explicitly forced (D-009).
  if (!plan.green && !force) {
    err(`\n[deploy] REFUSING: target is not the green \`${cfg.releaseRef}\` pin.`);
    err('         Override with --deploy-commit <sha> or --force (deploys an UN-GREEN state; loud + audited).');
    // P-008: record the gate refusal so /admin/git's deploy stats fold it — the 'refused'
    // status was counted by the fold but never written by anything. Best-effort.
    await recordRefusedDeploy(plan.targetSha).catch(() => {});
    return 2;
  }

  const deps = makeDeps(cfg, {
    noDrain: has('--no-drain'),
    drainSec: arg('--drain-sec') ? Number(arg('--drain-sec')) : undefined,
  });

  // D-009: a forced un-green deploy is loud + audited before it runs.
  if (!plan.green) {
    err(`\n🚨 FORCED UN-GREEN DEPLOY — deploying a commit that is NOT the green \`${cfg.releaseRef}\` pin. This bypasses the quality gate.`);
    await deps
      .broadcast(
        `🚨 FORCED un-green deploy of ${plan.targetSha.slice(0, 8)} (NOT green \`${cfg.releaseRef}\`) — escape hatch (D-009), by release-deploy`,
        `Target ${plan.targetSha} is not the green ${cfg.releaseRef} pin. Commits: ${plan.commits.length}. Staged migrations: ${plan.migrations.join(', ') || 'none'}.`,
      )
      .catch(() => {});
  }

  const res = await executeDeploy(cfg, plan, deps, { rollbackOnFailure: !has('--no-rollback') });
  out(JSON.stringify({ ok: res.ok, rolledBack: res.rolledBack, error: res.error, steps: res.steps }, null, 2));
  return res.ok ? 0 : 1;
}

/** P-008: append a `refused` deploy event to the /admin/git pipeline history when the
 *  gate declines an un-green --execute. Lazy-imports operator-core so an `import` of this
 *  module stays light; best-effort (a stats-log failure must never affect the gate). */
async function recordRefusedDeploy(targetSha: string): Promise<void> {
  const { appendPipelineEvent } = await import('@papercusp/operator-core/lib/harness/git-sync/pipeline-events');
  let workspaceId = '*';
  try {
    const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
    workspaceId = activeWorkspaceId();
  } catch {
    /* no active workspace (standalone) — '*' is the pipeline_events default */
  }
  await appendPipelineEvent({
    workspaceId,
    installSlug: process.env.RELEASE_ROUTINE_SLUG ?? 'papercup',
    kind: 'deploy',
    status: 'refused',
    detail: { targetSha: targetSha.slice(0, 12), reason: 'not-green and not --force' },
  });
}

// Run as the CLI only — the ESM equivalent of `require.main === module`. An
// `import` of this module (a test, the release-trigger plan-parse) is
// side-effect-free.
const invokedAsCli =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsCli) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[deploy] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
