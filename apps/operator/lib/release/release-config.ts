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
}

const FALLBACK_INTEGRATION = '/home/marsh-office/papercupai-workspace/papercup';

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
  const integrationRoot =
    process.env.PAPERCUSP_INTEGRATION_ROOT ?? overrides.integrationRoot ?? scriptRepoRoot();
  const parent = path.dirname(integrationRoot);
  const releaseRoot =
    process.env.PAPERCUSP_RELEASE_ROOT ?? overrides.releaseRoot ?? path.join(parent, 'papercup-release');
  const checkpointRoot =
    process.env.PAPERCUSP_CHECKPOINT_ROOT ?? overrides.checkpointRoot ?? path.join(parent, 'papercup-checkpoint');
  const port = process.env.PAPERCUSP_HONO_PORT ?? '3070';
  return {
    integrationRoot,
    releaseRoot,
    checkpointRoot,
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? overrides.releaseRef ?? 'ready',
    integrationBranch:
      process.env.PAPERCUSP_INTEGRATION_BRANCH ?? overrides.integrationBranch ?? 'main',
    systemdUnit:
      process.env.PAPERCUSP_SYSTEMD_UNIT ?? overrides.systemdUnit ?? 'papercup-dev-api.service',
    operatorHealthUrl:
      process.env.PAPERCUSP_HEALTH_URL ??
      overrides.operatorHealthUrl ??
      `http://127.0.0.1:${port}/api/health`,
    greenCmd: process.env.PAPERCUSP_GREEN_CMD ?? overrides.greenCmd ?? 'npm run test:affected',
  };
}

/** The setup script that (re)builds the release/checkpoint checkout. */
export function setupScriptPath(cfg: ReleaseConfig): string {
  return path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
}
