/**
 * hive-release-env — resolve a hive's effective staging→main release gate and the env
 * overlay the green-checkpoint / deploy SUBPROCESS runs under.
 *
 * Plan per-hive-git-and-release-gate-2026-06-29 (P-006, D-007/D-008).
 *
 * The release lib (apps/operator/lib/release/release-config.ts) is intentionally
 * lightweight + fully env-overridable and CANNOT import the harness registry / blueprint
 * layer. So per-hive generalization lives HERE (operator-core, where both are reachable):
 * compute the per-hive env vars from the registry path + the hive's `releaseGate` knob and
 * hand them to the subprocess; its `releaseConfig()` re-derives everything from that env.
 * No change to release-config.ts is needed — its env seam already supports this.
 *
 * The operator-home (papercusp) slug is special-cased to an EMPTY overlay so its LIVE :3070
 * pipeline keeps its EXACT current behavior (systemd-unit env + releaseConfig defaults) —
 * regression-safe (D-007). The gate is effective ONLY when `releaseGate.enabled` AND the
 * hive actually has a repo (belt-and-suspenders — a repo-less / non-coding hive can never
 * be gated, D-002).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadHarnessRegistry } from '../../harness-registry';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../../agent-tools/blueprint/_resolve';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Fallback green command when a hive has neither an explicit releaseGate.greenCmd nor a
 *  detected `testCommand` knob — gate on "it at least builds", never an unconditional FF. */
export const DEFAULT_GREEN_CMD = 'npm run build';

export interface HiveReleaseGate {
  enabled: boolean;
  integrationBranch: string;
  releaseRef: string;
  /** Explicit green command, or null to fall back to testCommand → DEFAULT_GREEN_CMD. */
  greenCmd: string | null;
  /** WI-2828: opt-in only — defaults to '' (skip the operator-SPA build leg) unless the
   *  hive's blueprint explicitly sets releaseGate.spaBuildWorkspace to the workspace it
   *  actually carries. Never silently defaults to '@papercusp/operator-vite'. */
  spaBuildWorkspace?: string | null;
  /** Deploy target (leg 3). null/undefined ⇒ green-gate only (no release-trigger). */
  deploy: { systemdUnit?: string; healthUrl?: string } | null;
  /** The repo's detected test command (the existing `testCommand` knob) — the preferred
   *  greenCmd default so the gate runs the SAME command the worker/gym use (D-004). */
  testCommand?: string;
}

/**
 * Resolve a hive's effective `releaseGate` knob (+ `testCommand`) by reading its
 * `.papercusp/blueprint.yaml` and resolving the blueprint `extends` chain. Returns null
 * when the hive has no blueprint file or it fails to resolve.
 */
export function resolveHiveReleaseGate(hivePath: string): HiveReleaseGate | null {
  const bpFile = join(hivePath, '.papercusp', 'blueprint.yaml');
  if (!existsSync(bpFile)) return null;
  let childObj: Record<string, unknown>;
  try {
    childObj = (parseYaml(readFileSync(bpFile, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resolver = operatorResolveExtends({ localDirs: [] });
  const validation = resolveAndValidate(childObj, resolver);
  if (!validation.ok || !validation.blueprint) return null;
  const knobs = (validation.blueprint.knobs ?? {}) as Record<string, unknown>;
  const gate = (knobs.releaseGate ?? {}) as Record<string, unknown>;
  // GATED when releaseGate.enabled is explicitly true, OR — when the knob is unset — it's a
  // CODING profile (output.kind:'repo-commit' + requiresRepo). Coding MEMBERS run kind:harness
  // blueprints (coding-factory / coding-solo) that carry no releaseGate knob but ARE code
  // repos, so they gate by default; explicit releaseGate.enabled:false (the non-coding `work`
  // blueprint) opts OUT. (per-hive-git-and-release-gate P-017 — gate code-in-member hives,
  // not just self_repo homes.)
  const outputKind =
    ((validation.blueprint as { output?: { kind?: string } }).output?.kind as string | undefined) ?? 'repo-commit';
  const codingProfile = outputKind === 'repo-commit' && knobs.requiresRepo !== false;
  const enabled = gate.enabled === true || (gate.enabled !== false && codingProfile);
  const fromRepo = (knobs.fromRepo ?? {}) as Record<string, unknown>;
  // WI-2828 durable fix (opt-in polarity): default to SKIPPING the operator-SPA build leg
  // for every subject hive, unless it EXPLICITLY opts in via releaseGate.spaBuildWorkspace.
  // The old default (null, when neither `fromRepo.frontend:false` nor an explicit
  // spaBuildWorkspace knob was set) left PAPERCUSP_SPA_BUILD_WORKSPACE unset, and
  // release-config.ts's OWN fallback then silently assumed '@papercusp/operator-vite' —
  // so ANY foreign/subject hive that doesn't carry that workspace (e.g. quartermaster,
  // whose frontend is apps/desktop) had its gate's SPA-build leg try to build a workspace
  // that doesn't exist in its tree and red-pin the whole gate (21 consecutive reds before
  // the quartermaster blueprint's own `fromRepo.frontend:false` bridge unblocked it).
  // `fromRepo.frontend === false` still forces the skip explicitly (kept for clarity /
  // back-compat with existing blueprints that already set it); the operator-home
  // (papercusp itself) is unaffected — it returns via the isOperatorHome early exit in
  // resolveHiveReleaseEnv before this value is ever read.
  const spaBuildWorkspace =
    fromRepo.frontend === false
      ? ''
      : typeof gate.spaBuildWorkspace === 'string'
        ? gate.spaBuildWorkspace
        : '';
  return {
    enabled,
    integrationBranch: typeof gate.integrationBranch === 'string' ? gate.integrationBranch : 'staging',
    releaseRef: typeof gate.releaseRef === 'string' ? gate.releaseRef : 'main',
    greenCmd: typeof gate.greenCmd === 'string' ? gate.greenCmd : null,
    spaBuildWorkspace,
    deploy: (gate.deploy as HiveReleaseGate['deploy']) ?? null,
    testCommand: typeof knobs.testCommand === 'string' ? knobs.testCommand : undefined,
  };
}

export interface HiveReleaseEnv {
  /** Whether this hive should run the green gate (enabled knob AND has a repo). */
  enabled: boolean;
  /** Why disabled, when enabled === false. */
  reason?: 'not_found' | 'no_blueprint' | 'gate_disabled' | 'no_repo';
  /** The env overlay to merge over process.env for the green-checkpoint/deploy subprocess.
   *  EMPTY for the operator-home slug (preserve exact current behavior). */
  env: Record<string, string>;
  /** Whether a deploy target is configured (releaseGate.deploy) → release-trigger seeded. */
  hasDeploy: boolean;
  /** True for the operator-home (papercusp) slug — overlay is intentionally empty. */
  isOperatorHome: boolean;
  /** The resolved green command (for logging / the /admin/git surface). */
  greenCmd?: string;
  /** True when greenCmd came from the per-hive owner override (hive_settings), not the
   *  blueprint knob / detected testCommand / build fallback (P-014 /admin/git surface). */
  greenCmdOverridden?: boolean;
}

function disabled(reason: HiveReleaseEnv['reason']): HiveReleaseEnv {
  return { enabled: false, reason, env: {}, hasDeploy: false, isOperatorHome: false };
}

/**
 * Compute the per-hive release-gate env overlay for the green-checkpoint / deploy
 * subprocess. Returns `{ enabled:false, reason }` when the hive shouldn't be gated
 * (not found / no blueprint / gate disabled / no repo) — callers skip seeding/running.
 */
export async function resolveHiveReleaseEnv(slug: string, workspaceId: string): Promise<HiveReleaseEnv> {
  const reg = await loadHarnessRegistry(workspaceId);
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) return disabled('not_found');

  const gate = resolveHiveReleaseGate(entry.path);
  if (!gate) return disabled('no_blueprint');
  if (!gate.enabled) return disabled('gate_disabled');

  // A harness is gateable when its checkout has a real `.git` — a self_repo HOME (fresh-init
  // hive) OR a code MEMBER (a create_from_repo clone, e.g. oddsmith). The metadata-only home
  // (no .git) is correctly excluded — the gate rides the code-bearing harness, not the
  // control dir. (P-017: gate code-in-member hives, not just self_repo homes.)
  const hasRepo = existsSync(join(entry.path, '.git'));
  if (!hasRepo) return disabled('no_repo');

  // Operator-home (papercusp): EMPTY overlay → the subprocess uses the existing systemd-unit
  // env + releaseConfig defaults, i.e. EXACT current behavior (D-007, regression-safe).
  if (slug === operatorHomeHarnessSlug()) {
    return { enabled: true, env: {}, hasDeploy: !!gate.deploy, isOperatorHome: true };
  }

  const parent = dirname(entry.path);
  // Per-hive owner override (P-014): top precedence over the blueprint knob / detected
  // testCommand / build fallback, so editing the green command on /admin/git actually
  // changes what the gate runs. Best-effort — a DB hiccup must never break gate routing.
  let greenCmdOverride: string | null = null;
  try {
    const { getReleaseGreenCmdOverride } = await import('../../hive-settings-store');
    greenCmdOverride = await getReleaseGreenCmdOverride(workspaceId, slug);
  } catch {
    greenCmdOverride = null;
  }
  const greenCmd = greenCmdOverride ?? gate.greenCmd ?? gate.testCommand ?? DEFAULT_GREEN_CMD;
  const env: Record<string, string> = {
    PAPERCUSP_INTEGRATION_ROOT: entry.path,
    PAPERCUSP_RELEASE_SLUG: slug,
    PAPERCUSP_INTEGRATION_BRANCH: gate.integrationBranch,
    PAPERCUSP_RELEASE_REF: gate.releaseRef,
    PAPERCUSP_GREEN_CMD: greenCmd,
    PAPERCUSP_RELEASE_ROOT: join(parent, `${slug}-release`),
    PAPERCUSP_CHECKPOINT_ROOT: join(parent, `${slug}-checkpoint`),
    PAPERCUSP_CHECKPOINT_LOG_DIR: join(homedir(), '.papercusp', 'checkpoint-logs', slug),
  };
  // WI-2828: ALWAYS thread the resolved value (now always a string — resolveHiveReleaseGate
  // defaults it to '' rather than null) so a subject hive can never fall through to
  // release-config.ts's own '@papercusp/operator-vite' fallback by omission.
  env.PAPERCUSP_SPA_BUILD_WORKSPACE = gate.spaBuildWorkspace ?? '';
  return {
    enabled: true,
    env,
    hasDeploy: !!gate.deploy,
    isOperatorHome: false,
    greenCmd,
    greenCmdOverridden: greenCmdOverride != null,
  };
}

export interface CheckpointRouting {
  /** The integration tree root the checkpoint/deploy subprocess runs in. */
  root: string;
  /** Env overlay for the subprocess (EMPTY for operator-home / default). */
  extraEnv: Record<string, string>;
  /** Present when this installSlug should NOT run a suite (not a gated coding hive). */
  skip?: { reason: string };
}

/**
 * Decide how a `system:green-checkpoint` / `system:release-trigger` fire should run, given
 * the FIRING routine's installSlug (per-hive-git-and-release-gate P-010). The operator-home
 * slug (or no slug) → the default root + EMPTY overlay = EXACT current behavior
 * (regression-safe, D-007). A gated coding hive → its per-hive root + env overlay. A
 * non-gated slug (gate disabled / no repo) → `skip` (the handler records it and runs no
 * suite — a stray routine for a non-coding hive must never run the home suite).
 */
export async function resolveCheckpointRouting(
  ctx: { installSlug?: string | null; workspaceId: string },
  defaultRoot: string,
): Promise<CheckpointRouting> {
  if (!ctx.installSlug || ctx.installSlug === operatorHomeHarnessSlug()) {
    return { root: defaultRoot, extraEnv: {} };
  }
  const hive = await resolveHiveReleaseEnv(ctx.installSlug, ctx.workspaceId);
  if (!hive.enabled) return { root: defaultRoot, extraEnv: {}, skip: { reason: hive.reason ?? 'not-gated' } };
  // CRUCIAL (P-019): `root` is the TOOLING root — where green-checkpoint.ts + setup-release-
  // checkout.sh + tsx physically live (the papercusp operator tree, `defaultRoot`). It is NOT
  // the hive's repo: the hive's checkout has no release scripts. The hive is the SUBJECT,
  // carried ONLY in extraEnv (PAPERCUSP_INTEGRATION_ROOT) so the script runs FROM papercusp
  // and OPERATES ON the hive. (Earlier this returned the hive root → script-not-found.)
  return { root: defaultRoot, extraEnv: hive.env };
}
