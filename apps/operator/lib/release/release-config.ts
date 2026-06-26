/**
 * Release-gating shared config — plan release-gate-ready-branch-2026-06-04.
 *
 * One place for the paths/refs/units the green-checkpoint + deploy + rollback
 * scripts share. Everything is env-overridable so the whole system is testable
 * against a throwaway checkout / DB / systemd unit without touching the live
 * fleet (the plan's "runnable standalone, simple, tested" requirement).
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

export interface ReleaseConfig {
  /** The churning shared working tree git-sync commits to (the integration branch). */
  integrationRoot: string;
  /** The separate checkout the operator actually runs from (pinned to `releaseRef`). */
  releaseRoot: string;
  /** A dedicated isolated checkout the green-checkpoint runs tests in (never the churning tree). */
  checkpointRoot: string;
  /** The deployable green ref the restart script deploys. */
  releaseRef: string;
  /** The integration branch git-sync pushes WIP to. */
  integrationBranch: string;
  /** systemd --user unit the operator runs under. */
  systemdUnit: string;
  /** Health endpoint probed after a deploy/restart. */
  operatorHealthUrl: string;
  /** Command (run in a clean checkout) that defines "green". */
  greenCmd: string;
  /**
   * Dir the green-checkpoint persists per-run full suite output to. Overridable
   * (caller > PAPERCUSP_CHECKPOINT_LOG_DIR env > homedir default) so tests +
   * throwaway runs don't pollute the REAL ~/.papercusp/checkpoint-logs/ — fixture
   * logs landing there masquerade as real checkpoint failures and mislead the next
   * freeze diagnosis (found 2026-06-20, su-707ed/su-ee7e9).
   */
  checkpointLogDir: string;
}

const FALLBACK_INTEGRATION = '/home/marsh-office/papercupai-workspace/papercusp';

/** Repo root containing THIS script (the integration tree, since it's committed there). */
function scriptRepoRoot(): string {
  try {
    // __dirname is apps/operator/bin/release inside the integration tree.
    const here = path.resolve(__dirname);
    return execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return FALLBACK_INTEGRATION;
  }
}

export function releaseConfig(overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  // Precedence: explicit caller override > env > derived. Env must NOT beat an
  // explicit override — the operator host exports PAPERCUSP_INTEGRATION_ROOT
  // (release-gate cutover), and with env-first the release lib's own tests
  // (which pass throwaway-repo overrides) resolved git ops against the REAL
  // tree and failed under any env-bearing run (e.g. the green-checkpoint
  // routine, whose child env sets the var).
  const integrationRoot =
    overrides.integrationRoot ?? process.env.PAPERCUSP_INTEGRATION_ROOT ?? scriptRepoRoot();
  const parent = path.dirname(integrationRoot);
  const releaseRoot =
    overrides.releaseRoot ?? process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  const checkpointRoot =
    overrides.checkpointRoot ?? process.env.PAPERCUSP_CHECKPOINT_ROOT ?? path.join(parent, 'papercup-checkpoint');
  const port = process.env.PAPERCUSP_HONO_PORT ?? '3070';
  return {
    integrationRoot,
    releaseRoot,
    checkpointRoot,
    // staging→main model (staging-branch-pipeline-2026-06-06): the green pin is
    // the `main` BRANCH (FF-advanced from green `staging`), not a separate `ready`
    // ref. `integrationBranch` is the agent firehose `staging`. green-checkpoint
    // reads these: candidate = integrationBranch HEAD; FF releaseRef when green.
    releaseRef: overrides.releaseRef ?? process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    integrationBranch:
      overrides.integrationBranch ?? process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
    systemdUnit:
      overrides.systemdUnit ?? process.env.PAPERCUSP_SYSTEMD_UNIT ?? 'papercup-dev-api.service',
    operatorHealthUrl:
      overrides.operatorHealthUrl ??
      process.env.PAPERCUSP_HEALTH_URL ??
      `http://127.0.0.1:${port}/api/health`,
    greenCmd: overrides.greenCmd ?? process.env.PAPERCUSP_GREEN_CMD ?? 'npm run test:affected',
    checkpointLogDir:
      overrides.checkpointLogDir ??
      process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ??
      path.join(homedir(), '.papercusp', 'checkpoint-logs'),
  };
}

/** The setup script that (re)builds the release/checkpoint checkout. */
export function setupScriptPath(cfg: ReleaseConfig): string {
  return path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
}
