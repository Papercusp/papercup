/**
 * loop:standdown-all — bulk-pause EVERY active per-session engine loop
 * (loop-su-% routines) workspace-wide, or scoped to one fleet's CURRENT
 * members with `fleetSlug` — the fleet-wide-stand-down primitive that
 * routines:group-set cannot reach (loop-su-% rows are never routine-group
 * members).
 *
 * WHY (EI-22138154596110669): a fleet-wide "stand-down" broadcast asserted
 * "All engine loops are paused (routines:set active:false, resumable)" but
 * had, by hand-calling routines:set a few times, actually touched only 2 of
 * 26+ active loop-su-% rows in its window — there was no dedicated bulk-pause
 * tool for engine loops. No expiry was stamped on the ad-hoc pause either, so
 * the broadcast's sole named resume authority dying would have stranded every
 * paused loop indefinitely (it did not, only by luck).
 *
 * Same pattern class as release-pause-ttl.ts (gate-verdict-liveness-and-repair-
 * reliability-2026-08-31 P-004): every stand-down pause carries a finite expiry
 * (default DEFAULT_RELEASE_PAUSE_TTL_HOURS, overridable via `pauseTtlHours`) and
 * `sweepExpiredLoopStanddowns` (release-pause-ttl.ts, riding the SAME
 * routinesTick step the release sweep already rides) auto-resumes it and
 * records a notice on lapse — no new scheduler mechanism, no new pause family.
 * `loop:status` renders the hold via `loopStanddownBanner` while it is active.
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply
 * verify+auto-revert, audit, one-call revert) — same pattern as
 * routines:group-set, scoped to the dynamic loop-su-% set instead of a
 * routine group.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { pausedByFrom } from '../routines/set';
import {
  DEFAULT_RELEASE_PAUSE_TTL_HOURS,
  LOOP_STANDDOWN_MARKER,
  resolveLoopStanddownExpiryMs,
} from '../../harness/routines/release-pause-ttl';

interface LoopTargetSnap {
  installSlug: string;
  name: string;
  targetOwnerId: string;
  /** The routine's `metadata.pause` at capture time, for an exact revert. Active
   *  loops (the only rows this tool ever captures) are essentially always null,
   *  but a row can carry a stale `lastPause` sibling key — captured verbatim so
   *  revert restores the EXACT pre-mutation metadata.pause, not an assumption. */
  pause: Record<string, unknown> | null;
}

const MAX_TARGETS_FOR_REVERT_CAPTURE = 5000;

export default defineTool({
  name: 'loop:standdown-all',
  profile: 'engineer',
  description:
    "Bulk-pause EVERY active per-session engine loop (loop-su-% routines) workspace-wide, or scoped to one fleet's CURRENT members with `fleetSlug` — the fleet-wide-stand-down primitive routines:group-set cannot reach (loops are never group members). Requires `reason`. ALWAYS stamps a finite auto-resume expiry (default 4h, override with `pauseTtlHours`) — there is no open-ended stand-down — so a broadcast can never strand every loop the way an ad-hoc hand-called routines:set stand-down twice did. Returns the ACTUAL {pausedCount, targets} touched, a checkable number instead of an assertion. Audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when:
      "Pausing EVERY (or one fleet's) active engine loop at once for a coordinated stand-down (a delicate host restart, a shared-tree operation that must not race concurrent loop wakes) — instead of hand-calling routines:set once per loop, which is how a stand-down silently misses most of the fleet and how it drifts into an unbounded hold with no attributed resume.",
    notWhen:
      'To pause your OWN loop, use loop:end (permanent, no TTL — by design). To pause one specific OTHER loop, routines:set { name, active:false }. To pause a routine GROUP (not engine loops), routines:group-set.',
    chaining:
      "loop:status / fleet:assignments before, to see which loops are active. After `pauseTtlHours` lapses (or an early routines:set { active:true } per routine), a stood-down loop auto-resumes via the SAME routines-engine sweep release-pause-ttl.ts uses — loop:status renders the stand-down banner while it is held.",
    seeAlso: [
      'loop:end (stop your own loop, permanently)',
      'routines:set (one routine)',
      'routines:group-set (a routine GROUP, not engine loops)',
      'loop:status (see the stand-down banner + when it auto-resumes)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 5 } },
  args: z.object({
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'REQUIRED — why every engine loop is being paused fleet-wide (e.g. "coordinated host restart"). Persisted on each stamped routine as metadata.pause { reason, pausedBy, pausedAtMs, standdownAll: true, expiresAtMs }.',
      ),
    fleetSlug: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Scope the stand-down to loops owned by this fleet's CURRENT members only (per coord_presence.fleet_slug — the live projection, not the historical membership ledger, so a member who already left is not touched). Omit to stand down EVERY active loop-su-% routine in the workspace.",
      ),
    pauseTtlHours: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe(
        `How long this stand-down may last, in hours — stamped on every paused loop as metadata.pause.expiresAtMs, after which the routines engine AUTO-RESUMES it and records a notice (same TTL mechanism as a release-group pause). Omit for the ${DEFAULT_RELEASE_PAUSE_TTL_HOURS}h default. A stand-down pause is ALWAYS finite — there is no open-ended option.`,
      ),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('loop:standdown-all requires operator, architect, or mug role');
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const scopeLabel = args.fleetSlug ? `fleet:${args.fleetSlug}` : 'workspace';

    const readActiveTargets = async (): Promise<LoopTargetSnap[]> => {
      const rows = args.fleetSlug
        ? await sql<
            Array<{ install_slug: string; name: string; target_owner_id: string; pause: Record<string, unknown> | null }>
          >`
            SELECT r.install_slug, r.name, r.target_owner_id, r.metadata -> 'pause' AS pause
              FROM harness_shared.routines r
             WHERE r.workspace_id = ${ws}
               AND r.reschedule_interval_sec IS NOT NULL
               AND r.active = true
               AND r.name LIKE 'loop-su-%'
               AND r.target_owner_id IS NOT NULL
               AND r.target_owner_id IN (
                     SELECT p.owner_id FROM harness_shared.coord_presence p
                      WHERE p.workspace_id = ${ws} AND p.fleet_slug = ${args.fleetSlug}
                   )
             LIMIT ${MAX_TARGETS_FOR_REVERT_CAPTURE}`
        : await sql<
            Array<{ install_slug: string; name: string; target_owner_id: string; pause: Record<string, unknown> | null }>
          >`
            SELECT r.install_slug, r.name, r.target_owner_id, r.metadata -> 'pause' AS pause
              FROM harness_shared.routines r
             WHERE r.workspace_id = ${ws}
               AND r.reschedule_interval_sec IS NOT NULL
               AND r.active = true
               -- EI-22818006456104074: the workspace scan MUST be confined to su engine
               -- loops with a real owner. Without these two predicates the 17 NULL-owner
               -- system routines (service-health, stale-claim-sweep, …) entered prev,
               -- the owner-keyed UPDATE/verify below could never match them (ANY() never
               -- matches NULL), verify() failed, and runControlMutation auto-reverted —
               -- ok:true with applied:false / pausedCount:0. The lever silently no-op'd.
               AND r.name LIKE 'loop-su-%'
               AND r.target_owner_id IS NOT NULL
             LIMIT ${MAX_TARGETS_FOR_REVERT_CAPTURE}`;
      return rows.map((r) => ({
        installSlug: r.install_slug,
        name: r.name,
        targetOwnerId: r.target_owner_id,
        pause: r.pause ?? null,
      }));
    };

    const outcome = await runControlMutation<LoopTargetSnap[]>(
      {
        action: 'loop:standdown-all',
        subject: scopeLabel,
        actor: `role:${ctx.role}`,
        capturePrev: readActiveTargets,
        apply: async () => {
          // Re-read at apply time (not the dryRun-shared capturePrev instance) so a
          // caller who dryRun-previewed first and applied moments later is scoped to
          // what is ACTUALLY active now, same discipline as routines:group-set.
          const prev = await readActiveTargets();
          if (prev.length === 0) return prev;
          const pausedAtMs = Date.now();
          const expiresAtMs = resolveLoopStanddownExpiryMs({ pausedAtMs, ttlHours: args.pauseTtlHours ?? null });
          const stamp: Record<string, unknown> = {
            reason: args.reason,
            pausedBy: pausedByFrom(ctx, ctx.role),
            pausedAtMs,
            [LOOP_STANDDOWN_MARKER]: true,
            expiresAtMs,
          };
          if (args.fleetSlug) stamp.fleetSlug = args.fleetSlug;
          const ownerIds = prev.map((t) => t.targetOwnerId);
          // Re-guarded on active=true here too: a row that flipped inactive between the
          // read above and this write (another agent's own routines:set, a race) is
          // naturally excluded rather than double-stamped.
          await sql`
            UPDATE harness_shared.routines
               SET active = false,
                   -- jsonb bound as explicit stringify + cast: sql.json() throws on the
                   -- getOrgPg client (EI-607) and a bare object does not bind.
                   metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(stamp)}::jsonb),
                   updated_at = now()
             WHERE workspace_id = ${ws}
               AND reschedule_interval_sec IS NOT NULL
               AND active = true
               AND name LIKE 'loop-su-%'
               AND target_owner_id = ANY(${ownerIds}::text[])`;
          return prev;
        },
        revertTo: async (prev) => {
          for (const t of prev) {
            await sql`
              UPDATE harness_shared.routines
                 SET active = true,
                     metadata = CASE
                       WHEN ${t.pause === null}
                         THEN COALESCE(metadata, '{}'::jsonb) - 'pause'
                       ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(t.pause ?? {})}::jsonb)
                     END,
                     updated_at = now()
               WHERE workspace_id = ${ws} AND install_slug = ${t.installSlug} AND name = ${t.name}`;
          }
        },
        verify: async (touched) => {
          if (touched.length === 0) return { ok: true };
          // Verify by ROW identity (install_slug, name), not by owner: an owner can have
          // an older inactive sibling loop row, and a NULL owner can never be looked up
          // in an owner-keyed map (EI-22818006456104074).
          const ownerIds = touched.map((t) => t.targetOwnerId);
          const cur = await sql<
            Array<{ install_slug: string; name: string; target_owner_id: string; active: boolean; standdown: boolean | null }>
          >`
            SELECT install_slug, name, target_owner_id, active,
                   (metadata -> 'pause' ->> ${LOOP_STANDDOWN_MARKER})::boolean AS standdown
              FROM harness_shared.routines
             WHERE workspace_id = ${ws}
               AND reschedule_interval_sec IS NOT NULL
               AND name LIKE 'loop-su-%'
               AND target_owner_id = ANY(${ownerIds}::text[])`;
          const rowKey = (installSlug: string, name: string) => `${installSlug}/${name}`;
          const byRow = new Map(cur.map((r) => [rowKey(r.install_slug, r.name), r]));
          const ok = touched.every((t) => {
            const row = byRow.get(rowKey(t.installSlug, t.name));
            return row?.active === false && row?.standdown === true;
          });
          return { ok, detail: ok ? undefined : 'not every targeted loop is paused + stamped standdownAll' };
        },
        describe: (prev) => ({
          scope: scopeLabel,
          current: { activeCount: prev.length },
          proposed: { activeCount: 0, pausedCount: prev.length },
        }),
      },
      { dryRun: args.dryRun },
    );

    const touched = outcome.applied ? (outcome.next ?? []) : [];
    const pausedCount = touched.length;
    const targets = touched.map((t) => ({ ownerId: t.targetOwnerId, routineName: t.name, harness: t.installSlug }));

    // Keep the owner's automation panes live after a bulk pause — same contract as
    // routines:set / routines:group-set. Never fails the mutation.
    if (outcome.applied && !outcome.dryRun && pausedCount > 0) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    // REFUSE-OR-LOUDLY-WARN (the whole point of this tool): a caller broadcasting
    // "stood down" off this result must never be able to trust a silent 0. A real
    // apply that captured zero active candidates is loudly flagged rather than
    // returned as an unremarkable success — the exact shape of the original bug
    // (asserting "all" while touching almost none) but now MEASURABLE instead of
    // trusted. Not a throw: a genuinely quiet moment (no active loops at all, or a
    // fleet between members) is a legitimate — if rare — true reading, and a caller
    // must be able to dryRun-probe it without an exception in the way.
    const warning =
      !outcome.dryRun && outcome.applied && pausedCount === 0
        ? `No active loop-su-% routines were found in scope (${scopeLabel}) — NOTHING was paused. If you expected active loops, check fleetSlug / workspace before treating this as "stood down".`
        : undefined;

    return {
      data: {
        ok: true,
        scope: scopeLabel,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        pausedCount,
        targets,
        ...(warning ? { warning } : {}),
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
      },
    };
  },
});
