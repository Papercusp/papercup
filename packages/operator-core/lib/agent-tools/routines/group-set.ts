/**
 * routines:group-set — bulk pause/resume every routine in a group, and/or patch the
 * group's metadata (description, steward, review_cadence, mark-reviewed) — WI-5018
 * "routines can grow infinitely large ... grouping functionality would be very
 * beneficial" [owner 2026-07-15].
 *
 * GUARDRAIL (non-negotiable, per repo CLAUDE.md scheduling rules): this tool is
 * metadata + management ONLY. It never fires anything and never creates a third
 * execution mechanism — it flips the SAME `active` flag routines:set already flips,
 * just for every member of a group in one call, and it patches routine_groups (a
 * pure label/steward/cadence registry, no trigger_config).
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply verify+auto-revert,
 * audit, one-call revert) — same pattern as routines:set, scoped to N rows instead of one.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';

interface MemberSnap {
  installSlug: string;
  name: string;
  active: boolean;
}

interface GroupSnap {
  exists: boolean;
  description: string | null;
  steward: string | null;
  reviewCadence: string | null;
  lastReviewedAtIso: string | null;
  members: MemberSnap[];
}

const MAX_MEMBERS_FOR_REVERT_CAPTURE = 5000;

export default defineTool({
  name: 'routines:group-set',
  profile: 'engineer',
  description:
    "Bulk pause/resume every routine in a group (active:false/true), and/or patch the group's metadata (description, steward, reviewCadence) and/or mark it reviewed now (markReviewed:true — clears review-due). WI-5018 routines grouping — metadata + a bulk convenience over routines:set, never a new execution mechanism. Audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Pause/resume EVERY routine in a group at once (e.g. pause the whole "release" group during a delicate manual deploy) instead of calling routines:set once per routine, or update a group\'s steward/description/review cadence, or clear its review-due flag after auditing it.',
    notWhen: 'To change ONE routine (cron, one-off pause, payload knobs), use routines:set. To just SEE groups/rollup, routines:list { rollup:true }.',
    chaining: 'routines:list { rollup:true } first to see current group state + review-due; routines:list { rollup:true, group } after to confirm.',
    seeAlso: [
      'routines:list (rollup:true for the group view; group filter for raw member rows)',
      'routines:set (change ONE routine, including assigning it to this group)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 15 } },
  args: z.object({
    group: z.string().min(1).max(120).describe('The routine group slug (must already exist — routines:set { group } auto-creates one on first assignment).'),
    active: z.boolean().optional().describe('Bulk-set EVERY routine in this group active:false (pause all) or active:true (resume all).'),
    description: z.string().max(2000).optional().describe('Patch the group description.'),
    steward: z.string().max(200).optional().describe('Patch the group steward (who owns reviewing it).'),
    reviewCadence: z.string().max(40).optional().describe('Patch the review cadence, e.g. "90d". Used with lastReviewedAt to compute review-due in routines:list rollup.'),
    markReviewed: z.boolean().optional().describe('true = bump last_reviewed_at to now (clears review-due).'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:group-set requires operator, architect, or mug role');
    }
    if (
      args.active === undefined &&
      args.description === undefined &&
      args.steward === undefined &&
      args.reviewCadence === undefined &&
      !args.markReviewed
    ) {
      throw new Error('group-set requires active, description, steward, reviewCadence, and/or markReviewed');
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const group = args.group;

    const readSnap = async (): Promise<GroupSnap> => {
      const groupRows = await sql<
        Array<{ description: string | null; steward: string | null; review_cadence: string | null; last_reviewed_at: Date | null }>
      >`
        SELECT description, steward, review_cadence, last_reviewed_at
          FROM harness_shared.routine_groups
         WHERE workspace_id = ${ws} AND slug = ${group}
         LIMIT 1`;
      if (groupRows.length === 0) {
        throw new Error(
          `routine group not found: "${group}" (assign a routine to it first via routines:set { group: "${group}" }, which auto-creates it — or check the slug via routines:list { rollup:true })`,
        );
      }
      const g = groupRows[0];
      const memberRows = await sql<Array<{ install_slug: string; name: string; active: boolean }>>`
        SELECT install_slug, name, active
          FROM harness_shared.routines
         WHERE workspace_id = ${ws} AND group_slug = ${group}
         LIMIT ${MAX_MEMBERS_FOR_REVERT_CAPTURE}`;
      return {
        exists: true,
        description: g.description,
        steward: g.steward,
        reviewCadence: g.review_cadence,
        lastReviewedAtIso: g.last_reviewed_at ? new Date(g.last_reviewed_at).toISOString() : null,
        members: memberRows.map((r) => ({ installSlug: r.install_slug, name: r.name, active: r.active })),
      };
    };

    const writeGroupMeta = async (snap: GroupSnap): Promise<void> => {
      await sql`
        UPDATE harness_shared.routine_groups
           SET description = ${snap.description},
               steward = ${snap.steward},
               review_cadence = ${snap.reviewCadence},
               last_reviewed_at = ${snap.lastReviewedAtIso}::timestamptz,
               updated_at = now()
         WHERE workspace_id = ${ws} AND slug = ${group}`;
    };

    const outcome = await runControlMutation<GroupSnap>(
      {
        action: 'routines:group-set',
        subject: group,
        actor: `role:${ctx.role}`,
        capturePrev: readSnap,
        apply: async () => {
          const prev = await readSnap();
          const next: GroupSnap = {
            exists: true,
            description: args.description !== undefined ? args.description : prev.description,
            steward: args.steward !== undefined ? args.steward : prev.steward,
            reviewCadence: args.reviewCadence !== undefined ? args.reviewCadence : prev.reviewCadence,
            lastReviewedAtIso: args.markReviewed ? new Date().toISOString() : prev.lastReviewedAtIso,
            members: prev.members,
          };
          await writeGroupMeta(next);
          if (args.active !== undefined) {
            await sql`
              UPDATE harness_shared.routines
                 SET active = ${args.active}, updated_at = now()
               WHERE workspace_id = ${ws} AND group_slug = ${group}`;
            next.members = prev.members.map((m) => ({ ...m, active: args.active! }));
          }
          return next;
        },
        revertTo: async (prev) => {
          await writeGroupMeta(prev);
          if (args.active !== undefined && prev.members.length > 0) {
            // Restore each member's ORIGINAL active flag (not just flip back) — a bulk
            // pause must not silently resume a routine that was already paused before it.
            for (const m of prev.members) {
              await sql`
                UPDATE harness_shared.routines
                   SET active = ${m.active}, updated_at = now()
                 WHERE workspace_id = ${ws} AND install_slug = ${m.installSlug} AND name = ${m.name}`;
            }
          }
        },
        verify: async (next) => {
          const cur = await readSnap();
          let activeOk = true;
          if (args.active !== undefined) {
            activeOk = cur.members.every((m) => m.active === args.active);
          }
          const metaOk =
            cur.description === next.description &&
            cur.steward === next.steward &&
            cur.reviewCadence === next.reviewCadence &&
            (!args.markReviewed || cur.lastReviewedAtIso !== null);
          const ok = activeOk && metaOk;
          return { ok, detail: ok ? undefined : 'group row / member active flags did not reflect the change' };
        },
        describe: (prev) => ({
          current: {
            description: prev.description,
            steward: prev.steward,
            reviewCadence: prev.reviewCadence,
            memberCount: prev.members.length,
            activeCount: prev.members.filter((m) => m.active).length,
          },
          proposed: {
            description: args.description !== undefined ? args.description : prev.description,
            steward: args.steward !== undefined ? args.steward : prev.steward,
            reviewCadence: args.reviewCadence !== undefined ? args.reviewCadence : prev.reviewCadence,
            memberCount: prev.members.length,
            activeCount: args.active !== undefined ? (args.active ? prev.members.length : 0) : prev.members.filter((m) => m.active).length,
          },
        }),
      },
      { dryRun: args.dryRun },
    );

    return {
      data: {
        ok: true,
        group,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
      },
    };
  },
});
