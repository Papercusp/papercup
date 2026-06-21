/**
 * release-deploy-launch — the agent-facing deploy lever's launch + status primitives
 * (release-pipeline-resilience-2026-06-09 P-015 / deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The `release:deploy` MCP tool wraps these. Why a separate module: the launch logic
 * fires a DETACHED deploy (the deploy RESTARTS the very :3070 operator that hosts the
 * tool — an awaited child deploy-cli is killed by its own restart before returning;
 * root-caused 2026-06-06, see release-actions.ts). Keeping the launch + the pure
 * status/recommendation computation here makes both unit-testable WITHOUT firing a real
 * deploy (inject the spawn seam / pass a snapshot), and keeps the tool file thin.
 *
 * Design (owner-confirmed, deploy-trigger D-003): build on the EXISTING deploy chokepoint
 * `apps/operator/lib/release/deploy-cli.ts` — no new deploy logic. operator-core MUST NOT
 * import `apps/operator/lib/release/*` (wrong dependency direction + that lib carries a
 * deploy/rollback surface), so this SHELLS OUT to the CLI via tsx, mirroring
 * `harness/routines/release-actions.ts`'s auto-serve launch. The live auto-serve routine is
 * left untouched; the few small launch primitives (the unit name, the tsx/root resolution)
 * are duplicated BY VALUE — the codebase's standing convention for these cross-tier literals
 * (see the `__DEPLOY_PLAN__` marker comment in release-actions.ts / deploy-cli.ts).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import { gitPipelineSnapshot } from './git-pipeline-stats';

/**
 * The fixed transient systemd unit the detached deploy runs as. MUST match
 * `AUTO_DEPLOY_UNIT` in `harness/routines/release-actions.ts` — systemd-run refuses a
 * second unit with the same name while one is active, so sharing it makes a MANUAL deploy
 * (this lever) and the AUTO-serve deploy mutually exclusive: one release checkout, one
 * deploy at a time. A concurrent attempt returns "deploy already in flight" instead of two
 * deploys racing the same checkout (which storms the live :3070 operator).
 */
export const DEPLOY_UNIT = 'papercup-auto-deploy';

/** The integration tree the deploy operates in. Explicit env (set in the :3070 unit env at
 *  the release-gate cutover) so it stays correct after the operator itself runs from the
 *  release checkout. Mirrors release-actions.ts `integrationRoot()`. */
export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

/** Absolute tsx bin in the integration tree (the systemd unit can't depend on the manager
 *  PATH resolving a project-local `tsx` — EI-193). Mirrors release-actions.ts. */
export function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

// ─── Status / recommendation (pure) ───────────────────────────────────────────

/** Where the live :3070 stands relative to the green pin + why a deploy is/ isn't possible. */
export type DeployStateKind =
  | 'up-to-date' // live :3070 is at the green pin; nothing to deploy
  | 'green-deployable' // green code is ahead + deployable but not yet live (the trigger case)
  | 'gate-red' // the gate is RED — the green pin can't advance until the reds are fixed
  | 'gate-wedged' // the green-checkpoint isn't firing (0 reds but stale) — surface to an operator
  | 'staging-buffered' // staging has commits awaiting the next (green) checkpoint — normal, just wait
  | 'unknown';

export interface DeployStatus {
  gate: {
    green: boolean;
    consecutiveReds: number;
    stalled: boolean;
    fireStale: boolean;
    fireStaleReason: string | null;
    lastGreenAtMs: number | null;
    lastFixerStatus: string | null;
    lastFixerCandidate: string | null;
    flakyWorkspaces: string[];
  };
  deploy: {
    deployedSha: string | null;
    stagingHeadSha: string | null;
    greenPinSha: string | null;
    deployedBehindMain: number | null;
    readyBehindMain: number | null;
    deployedBehindReady: number | null;
    readyAtMainHead: boolean | null;
    deployedAtMs: number | null;
  };
  /** True iff `trigger` would do something safe + useful: there is green code ahead of the
   *  live deploy AND the gate is not currently red/wedged. */
  canTriggerGreen: boolean;
  /** True iff the live :3070 is already at the green pin (nothing green to deploy). */
  nothingToDeploy: boolean;
  state: DeployStateKind;
  /** The decision-tree recommendation (fix-reds > quarantine > owner-force; never silent-wait). */
  recommendation: string;
  /** One human-readable line. */
  summary: string;
  /** Non-fatal problems gathering the snapshot. */
  errors: string[];
}

/**
 * Pure: derive the deploy status + the decision-tree recommendation from a pipeline snapshot.
 * Exported for unit testing — no I/O.
 */
export function computeDeployStatus(snap: GitPipelineSnapshot): DeployStatus {
  const g = snap.gate;
  const d = snap.deploy;
  const gateGreen = g.consecutiveReds === 0 && !g.fireStale;
  const deployedBehindReady = d.deployedBehindReady;
  const readyBehindMain = d.readyBehindMain;

  // Green code ahead of the live deploy that we could ship right now.
  const hasGreenAhead = typeof deployedBehindReady === 'number' && deployedBehindReady > 0;
  const nothingToDeploy = deployedBehindReady === 0;
  const canTriggerGreen = gateGreen && hasGreenAhead;

  let state: DeployStateKind;
  let recommendation: string;
  if (hasGreenAhead) {
    // There IS green, deployable code that hasn't reached :3070 — the expedite case.
    state = 'green-deployable';
    recommendation =
      `${deployedBehindReady} green commit(s) are deployable but not yet live on :3070 ` +
      `(auto-serve stalled/backed-off). Run release:deploy { op: 'trigger', confirm: true } to expedite — it can only ship the green pin.`;
  } else if (g.consecutiveReds > 0) {
    state = 'gate-red';
    recommendation =
      `The green gate is RED (${g.consecutiveReds} consecutive red${g.consecutiveReds === 1 ? '' : 's'})` +
      `${g.lastFixerStatus ? `, release-fixer: ${g.lastFixerStatus}` : ''}. Your change can't reach the green pin until the reds are fixed. ` +
      `FIX the reds (even out of your lane); if a red is CONFIRMED-unrelated + you can't fix it quickly, quarantine that test by hand (accountably: reason + de-quarantine follow-up); force only with explicit OWNER sign-off. Never silently wait.`;
  } else if (g.fireStale) {
    state = 'gate-wedged';
    recommendation =
      `The green-checkpoint is WEDGED — not firing (${g.fireStaleReason ?? 'stale'}). It produces 0 reds because it never ran, so the gate can't advance. Surface this to an operator; the pipeline can't self-heal a non-firing checkpoint.`;
  } else if (typeof readyBehindMain === 'number' && readyBehindMain > 0) {
    state = 'staging-buffered';
    recommendation =
      `${readyBehindMain} staging commit(s) are awaiting the next green-checkpoint (gate is green, it just hasn't promoted them to the pin yet). Wait one checkpoint cycle, then re-check; nothing to do.`;
  } else if (nothingToDeploy) {
    state = 'up-to-date';
    recommendation = 'The live :3070 operator is at the green pin — nothing to deploy.';
  } else {
    state = 'unknown';
    recommendation =
      'Could not determine the deploy position from the snapshot (a ref may be unresolved). Inspect dev:pipeline_position / the /admin Git tab.';
  }

  const summary = `[${state}] ${recommendation}`;
  return {
    gate: {
      green: gateGreen,
      consecutiveReds: g.consecutiveReds,
      stalled: g.stalled,
      fireStale: g.fireStale,
      fireStaleReason: g.fireStaleReason,
      lastGreenAtMs: g.lastGreenAtMs,
      lastFixerStatus: g.lastFixerStatus,
      lastFixerCandidate: g.lastFixerCandidate,
      flakyWorkspaces: g.flakyWorkspaces,
    },
    deploy: {
      deployedSha: d.deployed?.sha ?? null,
      stagingHeadSha: d.mainHead?.sha ?? null, // field name predates staging→main rename: mainHead = integration (staging) HEAD
      greenPinSha: d.ready?.sha ?? null,
      deployedBehindMain: d.deployedBehindMain,
      readyBehindMain: d.readyBehindMain,
      deployedBehindReady: d.deployedBehindReady,
      readyAtMainHead: d.readyAtMainHead,
      deployedAtMs: d.deployedAtMs,
    },
    canTriggerGreen,
    nothingToDeploy,
    state,
    recommendation,
    summary,
    errors: d.errors ?? [],
  };
}

export interface ReadDeployStatusDeps {
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
}

/** Read the current deploy status (the snapshot + the pure computation). READ-ONLY. */
export async function readDeployStatus(deps: ReadDeployStatusDeps = {}): Promise<DeployStatus> {
  const load = deps.loadSnapshot ?? (() => gitPipelineSnapshot());
  const snap = await load();
  return computeDeployStatus(snap);
}

// ─── Detached deploy launch ───────────────────────────────────────────────────

export interface LaunchDeployOpts {
  /** Force an UN-GREEN deploy of a specific commit (the owner-gated escape). Omitted ⇒ a
   *  safe green-pin deploy (deploy-cli's `--execute` ships green `main`/`ready`). */
  force?: boolean;
  /** REQUIRED when force — the exact commit to ship past the red gate (`--deploy-commit`). */
  commit?: string;
  /** Integration tree root (default integrationRoot()). */
  root?: string;
}

export interface LaunchDeployResult {
  launched: boolean;
  unit: string;
  mode: 'trigger' | 'force';
  commit?: string;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a deploy is in flight). */
  reason?: string;
}

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Pure: the deploy-cli flags for a trigger (green) vs a force (un-green commit). */
export function buildDeployCliArgs(opts: { force?: boolean; commit?: string }): string[] {
  if (opts.force) {
    if (!opts.commit || !SHA_RE.test(opts.commit)) {
      throw new Error(`force deploy requires a valid commit sha (--deploy-commit), got ${JSON.stringify(opts.commit)}`);
    }
    return ['--deploy-commit', opts.commit, '--force', '--execute'];
  }
  return ['--execute'];
}

/** Pure: the full `systemd-run` argv for the detached deploy. Mirrors release-actions.ts's
 *  auto-serve launch (PATH passthrough so the unit doesn't depend on the systemd-manager env,
 *  PAPERCUSP_ALLOW_DEV_RESTART=1 to self-authorize the restart step — the role gate at the tool
 *  IS the authorization). Exported for unit testing the command construction. */
export function buildSystemdRunArgv(root: string, deployCliArgs: string[], logPath: string, pathEnv: string): string[] {
  const inner =
    `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' ` +
    `apps/operator/lib/release/deploy-cli.ts ${deployCliArgs.join(' ')} > ${logPath} 2>&1`;
  return [
    '--user',
    '--collect',
    `--unit=${DEPLOY_UNIT}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    'bash',
    '-c',
    inner,
  ];
}

export type SpawnLike = typeof spawn;

/**
 * Fire the deploy as a DETACHED transient systemd unit (survives the :3070 restart the deploy
 * itself triggers). Returns once systemd-run has accepted/refused the unit — the deploy's
 * OUTCOME is reported by deploy.ts (broadcast + pipeline event + the awaitable
 * release:deployed / deploy-failed events), NOT by this (about-to-be-restarted) caller.
 *
 * `spawnFn` is injectable so the tool's handler is unit-testable without launching anything.
 */
export function launchDetachedDeploy(opts: LaunchDeployOpts, spawnFn: SpawnLike = spawn): Promise<LaunchDeployResult> {
  const root = opts.root ?? integrationRoot();
  const mode: 'trigger' | 'force' = opts.force ? 'force' : 'trigger';
  const logPath = `/tmp/${DEPLOY_UNIT}.log`;
  const deployCliArgs = buildDeployCliArgs(opts);
  const argv = buildSystemdRunArgv(root, deployCliArgs, logPath, process.env.PATH ?? '');

  return new Promise<LaunchDeployResult>((resolve) => {
    const base: LaunchDeployResult = { launched: false, unit: DEPLOY_UNIT, mode, commit: opts.commit, argv, logPath };
    let stderr = '';
    const child = spawnFn('systemd-run', argv);
    child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, launched: true });
      } else {
        // Most common cause: the unit already exists ⇒ a deploy (manual or auto-serve) is in flight.
        resolve({
          ...base,
          launched: false,
          reason: `systemd-run exited ${code} (a deploy may already be in flight): ${stderr.trim().slice(0, 200)}`,
        });
      }
    });
  });
}
