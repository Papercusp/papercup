/**
 * routines:set — retune or pause/resume a scheduled system routine (live-configurability-audit
 * P-002). The safe, audited replacement for the raw `UPDATE harness_shared.routines` the playbook
 * forbids: change a routine's cron and/or active flag (active:false = PAUSE, true = RESUME).
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply verify+auto-revert, audit,
 * one-call revert). A bad cron is rejected up front (computeNextFireAt returns null), so a typo
 * can't silently kill a routine. On a cron change, next_fire_at is recomputed.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { computeNextFireAt } from '../../harness/routines/cron';
import { runControlMutation } from '../../gateway-control/control-harness';

interface RoutineSnap {
  triggerConfig: Record<string, unknown>;
  active: boolean;
  nextFireAtIso: string | null;
}

export default defineTool({
  name: 'routines:set',
  profile: 'engineer',
  description:
    "Retune or pause/resume a scheduled system routine (git-sync, green-checkpoint, release-trigger, …) without raw SQL: change its cron and/or active flag (active:false = PAUSE, active:true = RESUME). Audited + one-call-revertible via the control harness; an invalid cron is rejected. On a cron change, next_fire_at is recomputed.",
  capability: 'operator:write',
  guidance: {
    when: 'Pause git-sync during a delicate manual operation (active:false), resume it (active:true), retune a routine\'s cadence (cron), or patch a routine CONFIG value (triggerConfig — e.g. the bee-transcript-cap caps) on a running system — the safe alternative to the raw UPDATE harness_shared.routines the playbook forbids.',
    notWhen: 'For a harness blueprint autoloop, use autoloop:control. To just SEE routines, routines:list. (These routine rows are their own store; they do not appear in config:list-overrides.)',
    chaining: 'routines:list first to get the exact name + installSlug; routines:list after to confirm the change.',
    seeAlso: [
      'routines:list (get the exact name + installSlug first)',
      'autoloop:control (a harness blueprint autoloop instead)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.object({
    name: z.string().min(1).max(200).describe('Routine name, e.g. "git-sync", "green-checkpoint", "release-trigger".'),
    installSlug: z.string().max(120).optional().describe('Install slug owning the routine (default: the operator home harness).'),
    cron: z.string().min(1).max(120).optional().describe('New cron expression (5/6-field). Rejected if invalid.'),
    active: z.boolean().optional().describe('false = pause the routine, true = resume it.'),
    triggerConfig: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Merge these keys into the routine trigger_config (live-configurability-audit P-017 — e.g. the bee-transcript-cap caps max_tasks / max_carried_read_tokens / max_transcript_entries). The safe way to retune a routine CONFIG value without raw SQL. `cron` is ignored here — set it via the validated `cron` arg.'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:set requires operator, architect, or queen role');
    }
    if (args.cron === undefined && args.active === undefined && args.triggerConfig === undefined) {
      throw new Error('set requires cron, active, and/or triggerConfig');
    }
    // Validate the cron BEFORE touching anything — a typo must not silently kill a routine.
    if (args.cron !== undefined && !computeNextFireAt(args.cron, new Date())) {
      throw new Error(`invalid cron expression: ${args.cron}`);
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const slug = args.installSlug ?? operatorHomeHarnessSlug();

    const readSnap = async (): Promise<RoutineSnap> => {
      const rows = await sql<Array<{ trigger_config: Record<string, unknown> | null; active: boolean; next_fire_at: Date | null }>>`
        SELECT trigger_config, active, next_fire_at
          FROM harness_shared.routines
         WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${args.name}
         LIMIT 1`;
      if (rows.length === 0) throw new Error(`routine not found: ${slug}/${args.name} (use routines:list to see names)`);
      const r = rows[0];
      const nextIso = r.next_fire_at && !Number.isNaN(new Date(r.next_fire_at).getTime()) ? new Date(r.next_fire_at).toISOString() : null;
      return { triggerConfig: r.trigger_config ?? {}, active: r.active, nextFireAtIso: nextIso };
    };

    const writeSnap = async (snap: RoutineSnap): Promise<void> => {
      await sql`
        UPDATE harness_shared.routines
           SET trigger_config = ${JSON.stringify(snap.triggerConfig)}::text::jsonb,
               active = ${snap.active},
               next_fire_at = ${snap.nextFireAtIso}::timestamptz,
               updated_at = now()
         WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${args.name}`;
    };

    const outcome = await runControlMutation<RoutineSnap>(
      {
        action: 'routines:set',
        subject: `${slug}/${args.name}`,
        actor: `role:${ctx.role}`,
        capturePrev: readSnap,
        apply: async () => {
          const prev = await readSnap();
          const triggerConfig = { ...prev.triggerConfig };
          let nextIso = prev.nextFireAtIso;
          if (args.cron !== undefined) {
            triggerConfig.cron = args.cron;
            const computed = computeNextFireAt(args.cron, new Date());
            nextIso = computed ? computed.toISOString() : null;
          }
          if (args.triggerConfig !== undefined) {
            // P-017: merge the config patch, but NEVER let it set `cron` here — cron only flows
            // through the validated `cron` arg above (else a typo'd cron could silently kill the routine).
            const { cron: _ignoredCron, ...patch } = args.triggerConfig;
            Object.assign(triggerConfig, patch);
          }
          const next: RoutineSnap = { triggerConfig, active: args.active ?? prev.active, nextFireAtIso: nextIso };
          await writeSnap(next);
          return next;
        },
        revertTo: (prev) => writeSnap(prev),
        verify: async (next) => {
          const cur = await readSnap();
          const ok =
            cur.active === next.active &&
            (args.cron === undefined || (cur.triggerConfig as { cron?: string }).cron === args.cron);
          return { ok, detail: ok ? undefined : 'routine row did not reflect the change' };
        },
        describe: (prev) => ({
          current: { cron: (prev.triggerConfig as { cron?: string }).cron ?? null, active: prev.active },
          proposed: {
            cron: args.cron ?? ((prev.triggerConfig as { cron?: string }).cron ?? null),
            active: args.active ?? prev.active,
          },
        }),
      },
      { dryRun: args.dryRun },
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            routine: `${slug}/${args.name}`,
            dryRun: outcome.dryRun,
            applied: outcome.applied,
            reverted: outcome.reverted,
            preview: outcome.preview,
            verify: outcome.verify,
            auditId: outcome.auditId,
          }),
        },
      ],
    };
  },
});
