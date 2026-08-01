/**
 * `system:p2p-work-intake` — the P-406 (D-004) minimal production intake
 * loop's scheduled tick. Mirrors foreign-git-sync-action.ts /
 * sweep-orphaned-foreign-harnesses-action.ts exactly (registered system
 * action + upsertRoutine, tier:durable, no bare timer — repo rule).
 *
 * The handler is one durable step (system-actions contract). The underlying
 * tick (work-intake-tick.ts) is idempotent and side-effect-scoped per offer:
 * a re-run finds nothing new to claim for an already-claimed/executed offer
 * (the store's `local_disposition` / offer-executor's own idempotent
 * provisioning), a clean offer set is 'nothing'.
 *
 * HOST IDENTITY (see work-intake-tick.ts's module doc for the full context):
 * this host's own hostRef/responderGithubUserId/executorDevice/
 * sourceRepoPath/rootPath are NOT invented here — they are read from the
 * routine's `triggerConfig` (this codebase's existing per-routine config
 * convention: bee-transcript-cap-action.ts, claim-discipline-action.ts, …
 * all read `ctx.triggerConfig` the same way). Missing/malformed config is a
 * LOUD no-op (never a silent skip, never a fabricated identity) — the tick
 * cannot run meaningfully without knowing who it is.
 *
 * SEEDING: `ensureWorkIntakeRoutine` is called at boot by
 * p2p/ensure-host-routines.ts (WI-5327), which resolves this host's identity
 * from existing seams. The previous "NOT YET CALLED FROM ANYWHERE" note here
 * was stale from 2026-07-18 and was corrected under WI-6680.
 */
import { getOrgPg, upsertRoutine, type RoutineRow } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { computeNextFireAt } from './cron';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runWorkIntakeTick, type WorkIntakeHostIdentity } from '../../p2p/work-intake-tick';

export const WORK_INTAKE_ROUTINE_NAME = 'p2p-work-intake';
export const WORK_INTAKE_TARGET = 'system:p2p-work-intake';
/** A tighter cadence than the git-sync family (offers are meant to be picked
 *  up promptly) but still bounded — every 30s. push-nudge (p2p/push-nudge.ts)
 *  is the FAST wake path for a designated receiver; this tick is the steady
 *  floor that also covers open (undesignated) offers push-nudge doesn't target. */
export const DEFAULT_WORK_INTAKE_CRON = '*/30 * * * * *';

function readHostIdentity(cfg: Record<string, unknown>): WorkIntakeHostIdentity | null {
  const hostRef = cfg.hostRef;
  const responderGithubUserId = cfg.responderGithubUserId;
  const executorDevice = cfg.executorDevice;
  const sourceRepoPath = cfg.sourceRepoPath;
  // WI-6680: renamed from `rootPath` — this is the per-host BASE for foreign
  // work, not one offer's root (the tick derives `<base>/<offerId>`). The old
  // key is deliberately NOT accepted: a config still carrying `rootPath` was
  // written by the pre-fix seeder and is one that can never register (it set
  // rootPath === workspaceRoot, which the Q1 invariant always refuses), so
  // reading it would resurrect the broken config rather than re-seed a good one.
  const foreignWorkRoot = cfg.foreignWorkRoot;
  if (
    typeof hostRef !== 'string' || !hostRef ||
    typeof responderGithubUserId !== 'number' || !Number.isFinite(responderGithubUserId) ||
    typeof executorDevice !== 'string' || !executorDevice ||
    typeof sourceRepoPath !== 'string' || !sourceRepoPath ||
    typeof foreignWorkRoot !== 'string' || !foreignWorkRoot
  ) {
    return null;
  }
  return {
    hostRef,
    responderGithubUserId,
    responderDevicePubkey: typeof cfg.responderDevicePubkey === 'string' ? cfg.responderDevicePubkey : null,
    executorDevice,
    sourceRepoPath,
    foreignWorkRoot,
    branch: typeof cfg.branch === 'string' ? cfg.branch : undefined,
    workspaceRoot: typeof cfg.workspaceRoot === 'string' ? cfg.workspaceRoot : undefined,
    canonicalTree: typeof cfg.canonicalTree === 'string' ? cfg.canonicalTree : undefined,
  };
}

registerSystemAction(WORK_INTAKE_ROUTINE_NAME, async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const host = readHostIdentity(cfg);
  if (!host) {
    // LOUD, not silent: this routine cannot decide anything meaningful
    // without knowing who it is — see module doc. Never fabricates one.
    console.log(
      `[p2p-work-intake] NO-OP: routine '${WORK_INTAKE_ROUTINE_NAME}' triggerConfig is missing/malformed host identity ` +
        `(hostRef/responderGithubUserId/executorDevice/sourceRepoPath/foreignWorkRoot) — see work-intake-tick.ts module doc.`,
    );
    return;
  }

  const { potHomeSlugForHarness } = await import('../../hive-federation');
  const potHomeSlug = (await potHomeSlugForHarness(ctx.workspaceId, ctx.installSlug)) ?? ctx.installSlug;

  const result = await runWorkIntakeTick(ctx.workspaceId, potHomeSlug, { host });
  if (result.offers.length) {
    const executed = result.offers.filter((o) => o.outcome === 'executed').length;
    const skipped = result.offers.filter((o) => o.outcome === 'skip').length;
    const unresolvable = result.offers.filter((o) => o.outcome === 'unresolvable').length;
    console.log(
      `[p2p-work-intake] ${result.offers.length} open offer(s): ${executed} executed, ${skipped} skipped, ${unresolvable} unresolvable`,
    );
  }
});

/**
 * Idempotent upsert of the workspace's work-intake routine (active). The
 * host identity is stored in `triggerConfig` (this routine's whole config
 * surface — see module doc for why it is not resolved any other way).
 */
export async function ensureWorkIntakeRoutine(
  input: { workspaceId: string; installSlug: string; host: WorkIntakeHostIdentity; cron?: string },
  sql: Sql = getOrgPg().sql,
): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: WORK_INTAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: { cron: input.cron ?? DEFAULT_WORK_INTAKE_CRON, ...input.host },
      targetRole: WORK_INTAKE_TARGET,
      active: true,
    },
    computeNextFireAt,
  );
}

/**
 * The identity a PACKAGED host can actually resolve: everything except the two
 * repo-path fields. `sourceRepoPath` (the tree a foreign clone is made FROM)
 * and `canonicalTree` require a registered project dir, which a packaged
 * sidecar has none of — see WI-6680 and `ensureWorkIntakeRoutineInactive`.
 */
export type PartialWorkIntakeHostIdentity = Omit<
  WorkIntakeHostIdentity,
  'sourceRepoPath' | 'canonicalTree'
>;

/**
 * WI-6680 D3 (option (b), ruled by the P-406 lane owner 2026-08-01) — seed the
 * work-intake routine INACTIVE on a host that cannot resolve `sourceRepoPath`.
 *
 * WHY INACTIVE RATHER THAN ACTIVE: activating this routine means the host
 * begins accepting and EXECUTING remote-authored work. The containment tier
 * that would make that safe (the mechanical-kill layer — cgroup / dedicated OS
 * user) is P-105's and is UNBUILT; D-001 ships v1 without it. Turning remote
 * execution on at install time is therefore an owner-ratified decision, not
 * something boot code self-approves. Seeding inactive resolves the null
 * *visibly* (the row shows up in `schedule:inventory` carrying the reason it is
 * off) instead of the routine silently never existing.
 *
 * WHY THIS IS NOT A PLAIN `upsertRoutine(..., { active: false })`:
 * `upsertRoutine` does `ON CONFLICT DO UPDATE SET active = EXCLUDED.active,
 * trigger_config = EXCLUDED.trigger_config` (routines-runtime.ts). This
 * function is called from a BOOT hook that runs on every start, so an
 * unconditional inactive upsert would silently re-disable a routine the owner
 * had deliberately activated AND wipe any `sourceRepoPath` they had supplied in
 * its config — every reboot. (The seed-INACTIVE precedent,
 * seed-gate-canary-sweep-routine.ts, is a one-shot CLI script and so never hits
 * this.) So this seeds ONLY when no row exists yet, and otherwise leaves the
 * existing row completely untouched.
 *
 * Returns the created row, or `null` when a row already existed (untouched).
 */
export async function ensureWorkIntakeRoutineInactive(
  input: {
    workspaceId: string;
    installSlug: string;
    host: PartialWorkIntakeHostIdentity;
    /** Human-readable reason this routine ships off, and what would flip it on.
     *  Stored in `triggerConfig.inactiveReason` so the disabled state reads as a
     *  design decision rather than a broken routine. */
    inactiveReason: string;
    cron?: string;
  },
  sql: Sql = getOrgPg().sql,
): Promise<RoutineRow | null> {
  const existing = await sql<Array<{ one: number }>>`
    SELECT 1 AS one
      FROM harness_shared.routines
     WHERE install_slug = ${input.installSlug}
       AND name = ${WORK_INTAKE_ROUTINE_NAME}
     LIMIT 1
  `;
  if (existing.length > 0) return null;

  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: WORK_INTAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {
        cron: input.cron ?? DEFAULT_WORK_INTAKE_CRON,
        ...input.host,
        inactiveReason: input.inactiveReason,
      },
      targetRole: WORK_INTAKE_TARGET,
      active: false,
    },
    computeNextFireAt,
  );
}
