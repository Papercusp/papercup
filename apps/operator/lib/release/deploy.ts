/**
 * The restart-as-deploy chokepoint — plan release-gate-ready-branch-2026-06-04,
 * Phase 2 (D-005). The ONE path that moves `ready` into what-the-fleet-runs.
 *
 *   drain → snapshot → swap release checkout to target → apply staged migrations
 *     → restart → health + path-verify → broadcast        (rollback on failure)
 *
 * Two halves, per D-011:
 *   - MECHANICS (this file): a deterministic, tested scaffold. You never want an
 *     LLM to forget to snapshot, so the steps + their order + rollback are code.
 *   - JUDGMENT (the release-manager agent, Claude Opus 4.8 @ xhigh): go/no-go on
 *     the gathered plan, migration-risk review, post-deploy rollback decision.
 *     The agent calls `gatherPlan` (review) then `executeDeploy` (act).
 *
 * Safe default: deploys the GREEN `ready` ref. `--deploy-commit <sha>`/`--force`
 * deploys a specific un-green commit (D-009) — loud + audited.
 *
 * All external effects go through an injected `DeployDeps`, so the whole
 * orchestration + rollback is unit-tested against stubs and the real wiring
 * (`realDeps`, deploy-deps.ts) is exercised against a throwaway unit/DB.
 */

import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import {
  git,
  revParse,
  refExists,
  currentSha,
  isAncestor,
  commitsBetween,
  migrationsBetween,
  changedFiles,
  lockfilesChanged,
} from './git-ops';
import { assessRisk, type RiskAssessment } from './risk-tier';
import type { ReleaseConfig } from './release-config';
import type { MigrateResult } from './migrate';
import type { HealthResult } from './health-probe';

export interface SnapshotInfo {
  snapshotId: number;
  kopiaSnapshotId: string;
}

export interface DeployPlan {
  target: string;
  targetSha: string;
  currentReleaseSha: string | null;
  /** target is a descendant of the current release sha (a clean FF swap). */
  isFastForward: boolean;
  /** target === the green `ready` ref. */
  green: boolean;
  forced: boolean;
  commits: string[];
  migrations: string[];
  lockfileChanged: boolean;
  warnings: string[];
  noop: boolean;
  /** Phase 5: auto vs review tier (auto = docs/tests only, no migrations → unattended-safe). */
  risk: RiskAssessment;
}

export interface StepLog {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface DeployResult {
  ok: boolean;
  plan: DeployPlan;
  steps: StepLog[];
  snapshot?: SnapshotInfo | null;
  migrations?: MigrateResult;
  rolledBack: boolean;
  error?: string;
}

export interface DeployDeps {
  /** Acquire exclusive(dev-server) with a drain, run fn, release (broadcast back-up). */
  withDrain<T>(fn: () => Promise<T>): Promise<T>;
  /** Snapshot before swapping (D-008). null when snapshotting is disabled. */
  snapshot(reason: string): Promise<SnapshotInfo | null>;
  /** Swap the release checkout to `targetSha` (setup-release-checkout.sh). */
  runSetup(targetSha: string, opts: { lockfileChanged: boolean }): Promise<void>;
  /** Apply staged migrations to the operator DB, fail-loud (D-007). */
  migrate(): Promise<MigrateResult>;
  /** Restart the operator (systemctl) so it boots the release checkout. */
  restart(): Promise<void>;
  /** Poll /api/health until healthy or timeout. */
  health(): Promise<HealthResult>;
  /** Confirm every runtime read resolves under the release checkout. */
  verifyPaths(): Promise<{ ok: boolean; failures: string[] }>;
  /** Restore the workspace/DB from a snapshot (rollback of schema). */
  restoreSnapshot(snap: SnapshotInfo): Promise<void>;
  /** coord:send broadcast. */
  broadcast(summary: string, body?: string): Promise<void>;
  log(s: string): void;
}

/**
 * The deploy go/no-go *warnings* policy as a declarative `@papercusp/rules`
 * table (adopt-event-rules-engines D-003): each entry is a `DataCondition` over
 * the gathered facts → a warning string the release-manager weighs before
 * go/no-go. This is the declarable layer *between* the scripted mechanics
 * (`executeDeploy`, which stays imperative) and the agent's judgment — NOT a
 * hard gate. Order is the surfacing order.
 */
const DEPLOY_WARNING_RULES: { cond: DataCondition; warn: (f: DeployWarningFacts) => string }[] = [
  {
    cond: { all: [{ green: { equals: false } }, { forced: { equals: false } }] },
    warn: () => 'target is NOT the green `ready` ref and --force was not set',
  },
  {
    cond: { all: [{ currentReleaseSha: { truthy: true } }, { isFastForward: { equals: false } }] },
    warn: () => 'target is not a fast-forward of the current release — a non-FF code swap',
  },
  {
    cond: { migrationCount: { gt: 0 } },
    warn: (f) => `${f.migrationCount} staged migration(s) will apply atomically at deploy`,
  },
];

interface DeployWarningFacts {
  green: boolean;
  forced: boolean;
  currentReleaseSha: string | null;
  isFastForward: boolean;
  migrationCount: number;
}

/** Run the declarative warning rules over the gathered facts, in surfacing order. */
function deployWarnings(facts: DeployWarningFacts): string[] {
  return DEPLOY_WARNING_RULES.filter((r) => evaluateDataCondition(r.cond, facts)).map((r) => r.warn(facts));
}

/**
 * Gather the deploy plan WITHOUT side effects — the release-manager reviews this
 * (diff + staged migrations) before go/no-go. Git-only, so it's cheap + safe.
 */
export async function gatherPlan(
  cfg: ReleaseConfig,
  opts: { target?: string; force?: boolean } = {},
): Promise<DeployPlan> {
  const targetRef = opts.target ?? cfg.releaseRef;
  const targetSha = await revParse(cfg.integrationRoot, targetRef);
  const readySha = (await refExists(cfg.integrationRoot, cfg.releaseRef))
    ? await revParse(cfg.integrationRoot, cfg.releaseRef)
    : null;
  const green = readySha !== null && targetSha === readySha;

  let currentReleaseSha: string | null = null;
  try {
    currentReleaseSha = await currentSha(cfg.releaseRoot);
  } catch {
    currentReleaseSha = null; // release checkout not set up yet
  }

  const isFastForward = currentReleaseSha
    ? await isAncestor(cfg.integrationRoot, currentReleaseSha, targetSha)
    : true;
  const commits = await commitsBetween(cfg.integrationRoot, currentReleaseSha, targetSha);
  const migrations = await migrationsBetween(cfg.integrationRoot, currentReleaseSha, targetSha);
  const lockfileChanged = await lockfilesChanged(cfg.integrationRoot, currentReleaseSha, targetSha);

  // Phase 5 risk-tier: classify from ALL changed files + the staged migrations'
  // content (so destructive DDL is flagged) — auto vs review.
  const allChanged = await changedFiles(cfg.integrationRoot, currentReleaseSha, targetSha);
  const migrationContents: Record<string, string> = {};
  for (const m of migrations) {
    try {
      migrationContents[m] = await git(cfg.integrationRoot, ['show', `${targetSha}:${m}`]);
    } catch {
      /* file unreadable at ref — leave it out; the path alone already forces review */
    }
  }
  const risk = assessRisk(allChanged, migrations, migrationContents);

  const warnings = deployWarnings({
    green,
    forced: !!opts.force,
    currentReleaseSha,
    isFastForward,
    migrationCount: migrations.length,
  });

  return {
    target: targetRef,
    targetSha,
    currentReleaseSha,
    isFastForward,
    green,
    forced: !!opts.force,
    commits,
    migrations,
    lockfileChanged,
    warnings,
    noop: currentReleaseSha === targetSha,
    risk,
  };
}

export interface ExecuteOpts {
  rollbackOnFailure?: boolean;
}

/**
 * Execute the deploy mechanics in order, inside the drain, with rollback on any
 * failure of swap/migrate/restart/health/verify. Pure orchestration over deps.
 */
export async function executeDeploy(
  cfg: ReleaseConfig,
  plan: DeployPlan,
  deps: DeployDeps,
  opts: ExecuteOpts = {},
): Promise<DeployResult> {
  const rollbackOnFailure = opts.rollbackOnFailure ?? true;
  const steps: StepLog[] = [];
  const short = (s: string | null) => (s ? s.slice(0, 8) : 'none');

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    deps.log(`▶ ${name}`);
    const t = Date.now();
    try {
      const r = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t });
      return r;
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  return deps.withDrain(async (): Promise<DeployResult> => {
    const prevReleaseSha = plan.currentReleaseSha;
    let snapshot: SnapshotInfo | null = null;
    let migrations: MigrateResult | undefined;
    try {
      snapshot = await step('snapshot', () => deps.snapshot(`pre-deploy ${short(plan.targetSha)}`));
      await step('swap', () => deps.runSetup(plan.targetSha, { lockfileChanged: plan.lockfileChanged }));
      migrations = await step('migrate', () => deps.migrate());
      await step('restart', () => deps.restart());

      const health = await step('health', () => deps.health());
      if (!health.healthy) throw new Error(`health probe failed after restart: ${health.error ?? 'unhealthy'}`);
      const verify = await step('verify-paths', () => deps.verifyPaths());
      if (!verify.ok) throw new Error(`release-path verify failed: ${verify.failures.join('; ')}`);

      await step('broadcast', () =>
        deps.broadcast(
          `✅ deployed ${short(plan.targetSha)} (${plan.commits.length} commit(s), ${migrations!.appliedCount} migration(s))`,
          `Release gate: advanced release checkout ${short(prevReleaseSha)} → ${short(plan.targetSha)}. ` +
            `Staged migrations: ${plan.migrations.join(', ') || 'none'}.`,
        ),
      );
      // await-event-primitive-2026-06-05 P-015: deploy-landed is awaitable —
      // the standard "my change reaches GREEN :3070 on the next deploy"
      // deferral can now SLEEP on `release:deployed` instead of being a
      // hand-tracked re-verify chore. Fire-and-forget.
      void import('@papercusp/operator-core/lib/events/await/engine')
        .then(({ emitAwaitedEvent }) =>
          emitAwaitedEvent({
            key: 'release:deployed',
            summary: `deployed ${short(plan.targetSha)} (${plan.commits.length} commit(s), ${migrations!.appliedCount} migration(s))`,
            payload: { sha: plan.targetSha, commits: plan.commits.length, migrations: plan.migrations },
            source: 'release-gate',
          }),
        )
        .catch(() => {});
      return { ok: true, plan, steps, snapshot, migrations, rolledBack: false };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log(`✖ deploy failed: ${error}`);
      let rolledBack = false;
      if (rollbackOnFailure && prevReleaseSha) {
        try {
          await step('rollback-code', () => deps.runSetup(prevReleaseSha, { lockfileChanged: plan.lockfileChanged }));
          // DB restore only when schema actually changed — otherwise a code-ref
          // revert + restart is enough and avoids a destructive workspace restore.
          if (snapshot && plan.migrations.length > 0) {
            await step('rollback-db', () => deps.restoreSnapshot(snapshot!));
          }
          await step('rollback-restart', () => deps.restart());
          const h = await step('rollback-health', () => deps.health());
          rolledBack = h.healthy;
        } catch (re) {
          deps.log(`✖ rollback ALSO failed: ${re instanceof Error ? re.message : re}`);
        }
      }
      await deps
        .broadcast(
          `❌ deploy of ${short(plan.targetSha)} FAILED${
            rolledBack ? ` — rolled back to ${short(prevReleaseSha)}` : ' and ROLLBACK FAILED — operator may need manual recovery'
          }: ${error}`,
        )
        .catch(() => {});
      // P-015: a failure is as awaitable as a success — a deploy-blocked
      // agent learns the bad news now, not at its timeout.
      void import('@papercusp/operator-core/lib/events/await/engine')
        .then(({ emitAwaitedEvent }) =>
          emitAwaitedEvent({
            key: 'release:deploy-failed',
            summary: `deploy of ${short(plan.targetSha)} FAILED${rolledBack ? ' (rolled back)' : ' (rollback failed)'}: ${error}`,
            payload: { sha: plan.targetSha, rolledBack, error },
            source: 'release-gate',
          }),
        )
        .catch(() => {});
      return { ok: false, plan, steps, snapshot, migrations, rolledBack, error };
    }
  });
}
