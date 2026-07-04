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
} from './git-ops';
import { assessRisk, type RiskAssessment } from './risk-tier';
import type { ReleaseConfig } from './release-config';
import type { MigrateResult } from './migrate';
import type { HealthResult } from './health-probe';

/**
 * Repo-relative path of the papercusp-desktop submodule gitlink in the
 * superproject (desktop-submodule-of-papercup-2026-06-09 D-002). A git-sync
 * pointer bump to the submodule appears in the superproject's
 * `git diff --name-only` as exactly this single path.
 */
export const DESKTOP_SUBMODULE_PATH = 'papercusp-desktop';

/**
 * True when EVERY changed path is the desktop submodule gitlink (or under it):
 * the delta between the running release checkout and green `main` is a
 * desktop-only pointer bump the `:3070` operator never builds or uses
 * (desktop-submodule-of-papercup-2026-06-09 D-003). The auto-serve trigger uses
 * this to SKIP a deploy that would otherwise drain + restart the live operator
 * for a shell-only change. An empty list is NOT desktop-only — that's the noop
 * case, gated separately.
 */
export function isDesktopOnlyDelta(changedPaths: string[]): boolean {
  if (changedPaths.length === 0) return false;
  return changedPaths.every(
    (p) => p === DESKTOP_SUBMODULE_PATH || p.startsWith(`${DESKTOP_SUBMODULE_PATH}/`),
  );
}

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
  warnings: string[];
  noop: boolean;
  /** Every changed path between the running release checkout and target is the
   *  papercusp-desktop submodule gitlink — a shell-only pointer bump the operator
   *  deploy can skip (D-003). false when nothing, or anything non-desktop, changed. */
  desktopOnly: boolean;
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
  /** Swap the release checkout to `targetSha` (setup-release-checkout.sh). node_modules
   *  sync is the setup script's own on-disk decision (`--node-modules auto`); the old
   *  git-based lockfile signal was structurally blind and is removed (P-015). */
  runSetup(targetSha: string): Promise<void>;
  /** Apply staged migrations to the operator DB, fail-loud (D-007). */
  migrate(): Promise<MigrateResult>;
  /** Restart the operator (systemctl) so it boots the release checkout. */
  restart(): Promise<void>;
  /** Poll /api/health until healthy or timeout. */
  health(): Promise<HealthResult>;
  /** Confirm every runtime read resolves under the release checkout. */
  verifyPaths(): Promise<{ ok: boolean; failures: string[] }>;
  /** PRE-CUTOVER boot check (mcp-host-availability-resilience-2026-06-22 P-001):
   *  import the swapped release checkout's side-effect-free host-handler module
   *  graph (all routes + the agent-tools/MCP registry) in a child process,
   *  resolving against ITS node_modules — WITHOUT starting a server or bootstrap.
   *  A missing/incomplete dep throws MODULE_NOT_FOUND here, so the deploy aborts
   *  BEFORE the live `:3070` cutover instead of crash-looping systemd after the
   *  restart. `ok:false` ⇒ do not cut over (the OLD process keeps serving). */
  preflight(): Promise<{ ok: boolean; error?: string }>;
  /** Restore the workspace/DB from a snapshot (rollback of schema). */
  restoreSnapshot(snap: SnapshotInfo): Promise<void>;
  /** coord:send broadcast. */
  broadcast(summary: string, body?: string): Promise<void>;
  /** Emit an awaitable event onto the shared await/notify bus (release:deployed /
   *  release:deploy-failed). INJECTED (WI-2399) instead of a hard dynamic import
   *  of the await engine inside executeDeploy: for that emit alone the mechanics
   *  used to reach past the deps seam, so a unit test that forgot to `vi.mock` the
   *  engine fired a REAL event onto the shared bus (EI-7287 — two phantom
   *  deploy:await wakes). Now it's a required dep, so TypeScript forces every
   *  caller to wire an emitter and no test can emit by default; the sole prod
   *  caller (realDeps) forwards to emitAwaitedEvent. AWAITED at the call site
   *  (EI-5993): deploy-cli process.exit()s right after executeDeploy resolves, so
   *  a fire-and-forget emit would race that exit and almost never fire. */
  emitEvent(opts: { key: string; summary?: string; payload?: unknown; source?: string }): Promise<void>;
  /** Append a `deploy` row to harness_shared.pipeline_events (the /admin/git
   *  history). Lives HERE (not in the release-trigger routine) because the
   *  routine's host dies at this deploy's own restart step — only the deploy
   *  process itself survives to record the outcome (2026-06-06 10:31: the
   *  first auto-deploy's health/rollback/broadcast/event were all lost that
   *  way). Optional: stub tests omit it. */
  recordEvent?(ev: { status: 'ok' | 'rolled-back' | 'failed'; detail: Record<string, unknown> }): Promise<void>;
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

  // Phase 5 risk-tier: classify from ALL changed files + the staged migrations'
  // content (so destructive DDL is flagged) — auto vs review.
  const allChanged = await changedFiles(cfg.integrationRoot, currentReleaseSha, targetSha);
  // D-003: a desktop-only pointer bump (every changed path under papercusp-desktop)
  // must not auto-redeploy the operator (which never builds/uses the shell).
  const desktopOnly = isDesktopOnlyDelta(allChanged);
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
    warnings,
    noop: currentReleaseSha === targetSha,
    desktopOnly,
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
    // Track how far the deploy got, so rollback only undoes what actually happened:
    //   migrateRan  → migrations were applied (need a DB restore on rollback)
    //   liveCutover → :3070 was restarted into the new release (need a live restart back)
    // A pre-cutover failure (e.g. preflight) leaves BOTH false ⇒ the live process never
    // changed ⇒ rollback just reverts the tree, zero downtime.
    let migrateRan = false;
    let liveCutover = false;
    try {
      snapshot = await step('snapshot', () => deps.snapshot(`pre-deploy ${short(plan.targetSha)}`));
      await step('swap', () => deps.runSetup(plan.targetSha));
      // PRE-CUTOVER boot check (P-001): confirm the swapped checkout can load its
      // module graph BEFORE touching live :3070. If a botched swap left node_modules
      // incomplete (→ MODULE_NOT_FOUND), we catch it here while the OLD process is
      // still serving — no crash-loop, and rollback reverts the tree without a restart.
      const preflight = await step('preflight', () => deps.preflight());
      if (!preflight.ok) {
        throw new Error(
          `pre-cutover boot check failed — release checkout would not boot, refusing to cut over :3070: ${preflight.error ?? 'unknown'}`,
        );
      }
      migrations = await step('migrate', () => deps.migrate());
      migrateRan = true;
      await step('restart', () => deps.restart());
      liveCutover = true;

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
      // hand-tracked re-verify chore.
      // AWAITED (not void, EI-5993 fix): deploy-cli process.exit()s right after
      // main() resolves, same as recordEvent below — a fire-and-forget emit here
      // raced that exit and was almost always killed before it fired, so every
      // caller `events:await`-ing `release:deployed` timed out despite the deploy
      // succeeding. Now via the INJECTED deps.emitEvent (WI-2399), not a hard
      // dynamic import — the swallow keeps a bus hiccup from failing a good deploy.
      try {
        const summary = `deployed ${short(plan.targetSha)} (${plan.commits.length} commit(s), ${migrations!.appliedCount} migration(s))`;
        const payload = { sha: plan.targetSha, commits: plan.commits.length, migrations: plan.migrations };
        // GLOBAL key — wake on the NEXT deploy of any sha (the payload.sha says which).
        await deps.emitEvent({ key: 'release:deployed', summary, payload, source: 'release-gate' });
        // PER-SHA key (event-await-… P-102) — "did MY sha land?" without payload-
        // filtering the global. An agent that knows its target sha awaits exactly it.
        await deps.emitEvent({ key: `release:deployed:${plan.targetSha}`, summary, payload, source: 'release-gate' });
      } catch {
        /* a bus hiccup must never fail an otherwise-successful deploy */
      }
      // AWAITED (not void): deploy-cli process.exit()s right after main()
      // resolves — a dangling append would be killed before the row lands.
      if (deps.recordEvent) {
        await deps
          .recordEvent({
            status: 'ok',
            detail: { targetSha: plan.targetSha.slice(0, 12), commits: plan.commits.length, migrations: plan.migrations.length },
          })
          .catch(() => {});
      }
      return { ok: true, plan, steps, snapshot, migrations, rolledBack: false };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log(`✖ deploy failed: ${error}`);
      let rolledBack = false;
      if (rollbackOnFailure && prevReleaseSha) {
        try {
          // Always revert the on-disk tree to the prior (consistent) sha.
          await step('rollback-code', () => deps.runSetup(prevReleaseSha));
          // DB restore only when migrations were actually APPLIED — a pre-cutover
          // failure (e.g. preflight) aborts before `migrate`, so the schema is
          // unchanged and a (destructive) workspace restore must be skipped.
          if (snapshot && migrateRan && plan.migrations.length > 0) {
            await step('rollback-db', () => deps.restoreSnapshot(snapshot!));
          }
          if (liveCutover) {
            // :3070 was already restarted into the bad release. Before restarting back
            // onto prev, VERIFY prev still boots (P-002): a heuristic runSetup can leave
            // prev-code + target-node_modules inconsistent (the documented "rollback ALSO
            // failed → manual recovery" class). If prev won't boot, don't restart into a
            // SECOND crash-loop — fall through to the loud manual-recovery broadcast.
            const rollbackPreflight = await step('rollback-preflight', () => deps.preflight());
            if (rollbackPreflight.ok) {
              await step('rollback-restart', () => deps.restart());
              const h = await step('rollback-health', () => deps.health());
              rolledBack = h.healthy;
            } else {
              deps.log(
                `✖ rollback preflight failed — prev checkout will not boot either (${rollbackPreflight.error ?? 'unknown'}); skipping restart, manual recovery needed`,
              );
            }
          } else {
            // PRE-CUTOVER failure: the live :3070 is still the pre-deploy process and
            // never went down. Tree reverted to prev ⇒ fully back to the pre-deploy
            // state with ZERO downtime; no live restart needed. THIS is the path that
            // turns a botched deploy from a crash-loop into a no-op (P-001).
            deps.log('pre-cutover failure — tree reverted to prev; live :3070 untouched (no restart, no downtime)');
            rolledBack = true;
          }
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
      // AWAITED (not void, EI-5993): same process.exit() race as the success path.
      // Via the INJECTED deps.emitEvent (WI-2399), not a hard dynamic import.
      await deps
        .emitEvent({
          key: 'release:deploy-failed',
          summary: `deploy of ${short(plan.targetSha)} FAILED${rolledBack ? ' (rolled back)' : ' (rollback failed)'}: ${error}`,
          payload: { sha: plan.targetSha, rolledBack, error },
          source: 'release-gate',
        })
        .catch(() => {});
      if (deps.recordEvent) {
        await deps
          .recordEvent({
            status: rolledBack ? 'rolled-back' : 'failed',
            detail: { targetSha: plan.targetSha.slice(0, 12), commits: plan.commits.length, migrations: plan.migrations.length, error: error.slice(0, 300) },
          })
          .catch(() => {});
      }
      return { ok: false, plan, steps, snapshot, migrations, rolledBack, error };
    }
  });
}
