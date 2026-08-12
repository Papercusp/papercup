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
   * The npm workspace whose `run build` the green-checkpoint builds as PART of "green"
   * (P-005 — a build break must hold `main` before it ever reaches the deploy swap).
   * Defaults to the platform operator SPA `@papercusp/operator-vite`. A per-hive SUBJECT
   * repo that has no operator SPA sets this to '' (empty) — via PAPERCUSP_SPA_BUILD_WORKSPACE
   * in its env overlay — and the SPA build is SKIPPED (its gate = its test suite only).
   * Without this seam the hardcoded `@papercusp/operator-vite` build died with npm's
   * "No workspaces found" on every per-hive gate, holding that hive's `main` forever
   * (oddsmith: 3+ consecutive reds, green-checkpoint-stall).
   */
  spaBuildWorkspace: string;
  /**
   * Dir the green-checkpoint persists per-run full suite output to. Overridable
   * (caller > PAPERCUSP_CHECKPOINT_LOG_DIR env > homedir default) so tests +
   * throwaway runs don't pollute the REAL ~/.papercusp/checkpoint-logs/ — fixture
   * logs landing there masquerade as real checkpoint failures and mislead the next
   * freeze diagnosis (found 2026-06-20, su-707ed/su-ee7e9).
   */
  checkpointLogDir: string;
  /**
   * Deploy-triggered memory recall canary policy (EI-10361): 'report'
   * (default) attaches the post-restart canary verdict to the health result
   * and logs it, never failing the deploy — a `degraded` outcome still fires
   * its own alert (recall-canary.ts's existing notify path) immediately,
   * rather than waiting for the next scheduled 05:45 tick. 'block' fails the
   * deploy on a `degraded` verdict (→ rollback, while the DB snapshot is
   * still clean) — a deliberate policy escalation that changes release-
   * pipeline declare-good semantics; flip via PAPERCUSP_MEMORY_CANARY_POLICY,
   * never the shipped default. 'off' skips the probe entirely.
   */
  memoryCanaryPolicy: 'off' | 'report' | 'block';
}

/** Last resort when `git rev-parse` fails: walk up from THIS file (apps/operator/lib/release)
 *  to the repo root. Never a hardcoded /home/<user>/… — that is wrong on every machine but
 *  one, and it ships the owner's identity in the release source drop (WI-4419). */
const FALLBACK_INTEGRATION = path.resolve(__dirname, '..', '..', '..', '..');

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

/**
 * The TOOLING root — the operator repo where the release SCRIPTS physically live
 * (green-checkpoint.ts, setup-release-checkout.sh, verify-release-paths.ts). Resolved from
 * THIS file's location, INDEPENDENT of cfg.integrationRoot (the SUBJECT being gated): a
 * per-hive gate's subject is the hive's repo, which has NO release scripts, so the scripts
 * must be resolved from here, not the subject (per-hive-git-and-release-gate P-019). For
 * papercusp tooling == subject == papercusp, so every resolved script path is byte-identical
 * to the old `cfg.integrationRoot`-based one — regression-safe.
 */
export function toolingRoot(): string {
  return scriptRepoRoot();
}

/** Checkouts that must never be GATED. `papercup-release` / `papercusp-release` are the
 *  deploy artifact (pinned to green `main`); `*-checkpoint` are the gate's own isolated test
 *  trees. Mirrors NON_INTEGRATION_CHECKOUTS in release-actions.ts, which guards the OTHER
 *  resolver (WI-38241 records why there are two). */
const NON_GATEABLE_CHECKOUTS = new Set([
  'papercup-release',
  'papercusp-release',
  'papercup-checkpoint',
  'papercusp-checkpoint',
]);

export type IntegrationRootSource = 'override' | 'PAPERCUSP_INTEGRATION_ROOT' | 'script-repo';

/** WHERE the integration root came from, alongside the value. The source is the half that
 *  matters when something looks wrong: `script-repo` is the only branch that can silently
 *  disagree with what the caller intended, because it is derived from where this FILE sits
 *  rather than from anything anyone asked for. */
export function describeIntegrationRoot(
  overrides: Partial<ReleaseConfig> = {},
  // `Record<string, string | undefined>` rather than NodeJS.ProcessEnv: these functions read
  // exactly one key, and under apps/operator's tsconfig a bare `{}` is not assignable to
  // ProcessEnv — which would force every caller and test to fabricate an env object.
  env: Record<string, string | undefined> = process.env,
  /** Injectable ONLY so the derived branch is reachable from a test: `scriptRepoRoot()` reads
   *  this file's own location, so without a seam the refusal below could never be shown to
   *  fire — and a guard that has never fired is not a guard. */
  deriveRoot: () => string = scriptRepoRoot,
): { root: string; source: IntegrationRootSource } {
  if (overrides.integrationRoot) return { root: overrides.integrationRoot, source: 'override' };
  const fromEnv = env.PAPERCUSP_INTEGRATION_ROOT;
  if (fromEnv) return { root: fromEnv, source: 'PAPERCUSP_INTEGRATION_ROOT' };
  return { root: deriveRoot(), source: 'script-repo' };
}

/** True when `root` is a checkout a gate run must never judge. Exported so the decision is
 *  testable in BOTH directions against the real set, rather than re-stated in a test. */
export function isNonGateableCheckout(root: string): boolean {
  return NON_GATEABLE_CHECKOUTS.has(path.basename(root));
}

/** One line of run-scoped evidence naming the tree a gate run is about to judge, and how it
 *  was chosen. Absent this, "which tree is the gate executing?" is unanswerable from the run
 *  log — during the 2026-08-12 freeze several agents asserted the gate was running the
 *  release copy and none could cheaply refute it (EI-20263854732193595). */
export function integrationRootEvidence(
  overrides: Partial<ReleaseConfig> = {},
  // `Record<string, string | undefined>` rather than NodeJS.ProcessEnv: these functions read
  // exactly one key, and under apps/operator's tsconfig a bare `{}` is not assignable to
  // ProcessEnv — which would force every caller and test to fabricate an env object.
  env: Record<string, string | undefined> = process.env,
  deriveRoot: () => string = scriptRepoRoot,
): string {
  const { root, source } = describeIntegrationRoot(overrides, env, deriveRoot);
  return `integration root: ${root} (source=${source})`;
}

/**
 * Refuse to GATE a release/checkpoint checkout.
 *
 * Deliberately NOT enforced inside `releaseConfig()`, even though that is where the bad value
 * is born. `releaseConfig()` has ~37 callers — rollback.ts and deploy-cli.ts among them — and
 * most never read `integrationRoot` at all. Throwing at construction would take out the
 * ROLLBACK path (a safety mechanism) to protect the gate, which trades a silent-wrong verdict
 * for a broken recovery tool. So the refusal lives at the one CONSUMER that must never judge
 * the wrong tree, and every other caller keeps working exactly as before.
 *
 * An explicit override / env root is honoured even if it points at such a checkout: someone
 * who names a root has stated an intent, and this guard exists for the DERIVED case where
 * nobody did.
 */
export function assertGateableIntegrationRoot(
  overrides: Partial<ReleaseConfig> = {},
  // `Record<string, string | undefined>` rather than NodeJS.ProcessEnv: these functions read
  // exactly one key, and under apps/operator's tsconfig a bare `{}` is not assignable to
  // ProcessEnv — which would force every caller and test to fabricate an env object.
  env: Record<string, string | undefined> = process.env,
  deriveRoot: () => string = scriptRepoRoot,
): void {
  const { root, source } = describeIntegrationRoot(overrides, env, deriveRoot);
  if (source !== 'script-repo') return;
  if (!isNonGateableCheckout(root)) return;
  throw new Error(
    `green-checkpoint: refusing to gate ${root} — "${path.basename(root)}" is a release/checkpoint ` +
      `checkout, not the integration tree, and nothing selected it (no override, no ` +
      `PAPERCUSP_INTEGRATION_ROOT — it was derived from where this script file lives). Gating it ` +
      `would judge code nobody commits to and publish a well-formed verdict about the wrong ` +
      `commits. Set PAPERCUSP_INTEGRATION_ROOT explicitly. (WI-38241)`,
  );
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
  // Per-root checkpoint checkout — `<basename(integrationRoot)>-checkpoint` in the parent
  // dir, mirroring checkpointRunLockDir's per-root run lock (green-checkpoint.ts). The old
  // FIXED `papercup-checkpoint` name made every lineage sharing a parent dir share ONE
  // checkout: on 2026-07-02 the retired papercup-root lineage (resurrected via a stale
  // .env.local PAPERCUSP_INTEGRATION_ROOT on :3070) ran setup/checkout on the same tree a
  // live papercusp suite was mid-run in — only the then-shared run lock had been
  // accidentally serializing them, and making that lock per-root exposed the race.
  // Invariant: distinct integrationRoot ⇒ distinct checkpointRoot. The retired papercup
  // root's basename still derives the legacy `papercup-checkpoint` name, so a straggler
  // run of that lineage keeps its old dir instead of colliding with papercusp's.
  const checkpointRoot =
    overrides.checkpointRoot ??
    process.env.PAPERCUSP_CHECKPOINT_ROOT ??
    path.join(parent, `${path.basename(integrationRoot)}-checkpoint`);
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
    // Empty string is a MEANINGFUL value (skip the SPA build), so it must survive the
    // precedence chain — `?? default` only fills a nullish env, never an explicit ''.
    spaBuildWorkspace:
      overrides.spaBuildWorkspace ?? process.env.PAPERCUSP_SPA_BUILD_WORKSPACE ?? '@papercusp/operator-vite',
    checkpointLogDir:
      overrides.checkpointLogDir ??
      process.env.PAPERCUSP_CHECKPOINT_LOG_DIR ??
      path.join(homedir(), '.papercusp', 'checkpoint-logs'),
    memoryCanaryPolicy:
      overrides.memoryCanaryPolicy ??
      (process.env.PAPERCUSP_MEMORY_CANARY_POLICY as 'off' | 'report' | 'block' | undefined) ??
      'report',
  };
}

/** The setup script that (re)builds the release/checkpoint checkout. It lives in the TOOLING
 *  tree, NOT the per-hive SUBJECT integration tree (P-019) — for papercusp these are the
 *  same path. The cfg is no longer needed but kept for call-site stability. */
export function setupScriptPath(_cfg?: ReleaseConfig): string {
  return path.join(toolingRoot(), 'apps/operator/bin/release/setup-release-checkout.sh');
}
