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
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';

/**
 * Best-effort caller ownerId for the pause-attribution stamp. A ctx-supplied
 * ownerId wins (some in-process callers thread it directly); otherwise derive
 * it (grade-idea's D-012 pattern — resolveAgentIdentity THROWS on an
 * unattributable ctx, and an attribution miss must degrade to the role string,
 * never block the pause).
 */
export function pausedByFrom(ctx: unknown, role: string | undefined): string {
  const explicit = (ctx as { ownerId?: unknown } | undefined)?.ownerId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    return resolveAgentIdentity((ctx ?? {}) as ResolveIdentityCtx).ownerId;
  } catch {
    return `role:${role}`;
  }
}

interface RoutineSnap {
  triggerConfig: Record<string, unknown>;
  payloadTemplate: Record<string, unknown>;
  active: boolean;
  nextFireAtIso: string | null;
  groupSlug: string | null;
  metadata: Record<string, unknown>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively merge a config patch into a routine's payload_template.
 *
 * DEEP, not shallow (WI-4482): a routine payload is NESTED
 * (`payload.budget.maxIdeators`, `payload.models.ideator`, `payload.cadence.*`), so a
 * shallow `Object.assign` of `{ payload: { budget: {...} } }` would REPLACE the whole
 * `payload` object and silently drop `models` / `cadence` — turning a one-key retune into
 * a config wipe. Plain objects merge; arrays and scalars REPLACE wholesale (an array patch
 * means "this is the new list", never an element-wise merge).
 */
function deepMergePlain(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMergePlain(cur, v) : v;
  }
  return out;
}

export default defineTool({
  name: 'routines:set',
  profile: 'engineer',
  description:
    "Retune or pause/resume a scheduled system routine (git-sync, green-checkpoint, release-trigger, scout, …) without raw SQL: change its cron, its active flag (active:false = PAUSE, active:true = RESUME), its trigger_config, its GROUP (group — metadata only, see routines:group-set / routines:list { rollup:true }), and/or DEEP-merge a patch into its payload_template (the routine's own run knobs — e.g. the scout singleton's payload.budget.maxIdeators). Audited + one-call-revertible via the control harness; an invalid cron is rejected. On a cron change, next_fire_at is recomputed.",
  capability: 'operator:write',
  guidance: {
    when: 'Pause git-sync during a delicate manual operation (active:false), resume it (active:true), retune a routine\'s cadence (cron), patch a routine CONFIG value (triggerConfig — e.g. a sweep\'s caps), assign/clear its group (group — WI-5018 routines grouping), or retune a routine\'s RUN KNOBS (payloadTemplate — e.g. the scout singleton\'s budget.maxIdeators / models.ideator) on a running system — the safe alternative to the raw UPDATE harness_shared.routines the playbook forbids.',
    notWhen: 'For a harness blueprint autoloop, use autoloop:control. To just SEE routines, routines:list. To pause/resume a WHOLE group at once, routines:group-set. (These routine rows are their own store; they do not appear in config:list-overrides.)',
    chaining: 'routines:list first to get the exact name + installSlug; routines:list after to confirm the change.',
    seeAlso: [
      'routines:list (get the exact name + installSlug first)',
      'routines:list (rollup:true — see/manage the group registry)',
      'routines:group-set (bulk pause/resume a whole group)',
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
      .describe('Merge these keys into the routine trigger_config (live-configurability-audit P-017 — e.g. the claim-discipline throttle_min, or a reaper dry_run). The safe way to retune a routine CONFIG value without raw SQL. `cron` is ignored here — set it via the validated `cron` arg.'),
    payloadTemplate: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("DEEP-merge this patch into the routine's payload_template — the routine's own run knobs (e.g. the scout singleton's payload.budget.maxIdeators / payload.models.ideator). Nested plain objects merge, so { payload: { budget: { maxIdeators: 4 } } } retunes ONE key without disturbing payload.models or payload.cadence; arrays and scalars replace. Previously the only way to change these was the raw UPDATE harness_shared.routines the playbook forbids (WI-4482)."),
    group: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe(
        'Assign this routine to a routine group (WI-5018 — metadata + management ONLY, never fires anything). Pass a slug (e.g. "health") to assign — the group is auto-created in harness_shared.routine_groups with blank metadata if it does not exist yet (fill it in via routines:group-set). Pass null to clear (ungroup).',
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'REQUIRED when pausing (active:false) — why. Persisted durably as metadata.pause { reason, pausedBy, pausedAtMs } (EI-18654017982759582: a routine paused during an incident with no reason/owner recorded has TWICE stayed silently paused for days — 2026-06-18, then ~4 days 2026-07-21→25 — because nothing durable said WHO paused it or WHY, so a responder could not tell a stuck bug from a deliberate hold). Ignored (but harmless) when resuming (active:true) or when active is unset.',
      ),
    reviewBy: z
      .string()
      .datetime()
      .optional()
      .describe(
        'Only meaningful alongside active:false, for an ALWAYS-ON singleton learning loop (change-ledger / scout / iq-battery). An ISO timestamp persisted as metadata.pause.reviewBy — the DARK_FLAGS_REVIEW_BY analog for a deliberate pause (EI-19370236916382521). While it is in the future, the learning-loop-health sweep treats the pause as EXPLICITLY RE-AFFIRMED and stops daily-re-escalating it (`improvements:capture`-ing a fresh EI every 24h) — the "re-affirm it explicitly rather than letting this alarm re-fire silently" remedy that sweep\'s own health read asks for. Pass this whenever you are pausing (or re-pausing to re-affirm) one of those loops on purpose, with a date you intend to actually re-review it by — omitting it on a deliberate pause just means the alarm keeps re-firing until someone either resumes the loop or comes back and sets one.',
      ),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:set requires operator, architect, or mug role');
    }
    if (
      args.cron === undefined &&
      args.active === undefined &&
      args.triggerConfig === undefined &&
      args.payloadTemplate === undefined &&
      args.group === undefined
    ) {
      throw new Error('set requires cron, active, triggerConfig, payloadTemplate, and/or group');
    }
    // Validate the cron BEFORE touching anything — a typo must not silently kill a routine.
    if (args.cron !== undefined && !computeNextFireAt(args.cron, new Date())) {
      throw new Error(`invalid cron expression: ${args.cron}`);
    }
    // EI-18654017982759582: a pause with no recorded reason/owner is how this recurs — require
    // one up front (a typo'd/omitted reason must not silently produce an unattributed freeze,
    // same "validate before touching anything" discipline as the cron check above).
    if (args.active === false && !args.reason) {
      throw new Error(
        'routines:set { active: false } (pausing) requires a `reason` — an unattributed pause is exactly the class of bug this guards against (a routine paused during an incident with no recorded reason/owner has silently stayed off for DAYS, twice). Pass a short reason (e.g. "pausing during manual deploy-checkout surgery").',
      );
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const slug = args.installSlug ?? operatorHomeHarnessSlug();

    const readSnap = async (): Promise<RoutineSnap> => {
      const rows = await sql<Array<{ trigger_config: Record<string, unknown> | null; payload_template: Record<string, unknown> | null; active: boolean; next_fire_at: Date | null; group_slug: string | null; metadata: Record<string, unknown> | null }>>`
        SELECT trigger_config, payload_template, active, next_fire_at, group_slug, metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${args.name}
         LIMIT 1`;
      if (rows.length === 0) throw new Error(`routine not found: ${slug}/${args.name} (use routines:list to see names)`);
      const r = rows[0];
      const nextIso = r.next_fire_at && !Number.isNaN(new Date(r.next_fire_at).getTime()) ? new Date(r.next_fire_at).toISOString() : null;
      return {
        triggerConfig: r.trigger_config ?? {},
        payloadTemplate: r.payload_template ?? {},
        active: r.active,
        nextFireAtIso: nextIso,
        groupSlug: r.group_slug ?? null,
        metadata: r.metadata ?? {},
      };
    };

    const writeSnap = async (snap: RoutineSnap): Promise<void> => {
      // Auto-create the group (blank metadata) on first assignment — the FK
      // (workspace_id, group_slug) -> routine_groups requires the row to exist;
      // routines:group-set is where a steward fills in description/steward/cadence.
      if (snap.groupSlug) {
        await sql`
          INSERT INTO harness_shared.routine_groups (workspace_id, slug)
          VALUES (${ws}, ${snap.groupSlug})
          ON CONFLICT (workspace_id, slug) DO NOTHING`;
      }
      await sql`
        UPDATE harness_shared.routines
           SET trigger_config = ${JSON.stringify(snap.triggerConfig)}::text::jsonb,
               payload_template = ${JSON.stringify(snap.payloadTemplate)}::text::jsonb,
               active = ${snap.active},
               next_fire_at = ${snap.nextFireAtIso}::timestamptz,
               group_slug = ${snap.groupSlug},
               metadata = ${JSON.stringify(snap.metadata)}::text::jsonb,
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
          const payloadTemplate =
            args.payloadTemplate !== undefined
              ? deepMergePlain(prev.payloadTemplate, args.payloadTemplate)
              : prev.payloadTemplate;
          // EI-18654017982759582: persist WHO/WHY/WHEN at pause time, and clear it on resume
          // (moved to lastPause for audit history) — so a responder (or a watchdog) never has
          // to reverse-engineer the pause from tool_invocations telemetry. Other metadata keys
          // (e.g. gate_health, written by the green-checkpoint tick / stall watchdogs) are
          // preserved untouched via the spread — only the `pause`/`lastPause` keys are patched.
          const metadata = { ...prev.metadata };
          const nextActive = args.active ?? prev.active;
          if (args.active === false) {
            metadata.pause = {
              reason: args.reason,
              pausedBy: pausedByFrom(ctx, ctx.role),
              pausedAtMs: Date.now(),
              // EI-19370236916382521: omit the key entirely rather than storing `undefined` —
              // a present-but-undefined key would round-trip through JSON.stringify as if it
              // were never set, which is harmless, but an explicit omission keeps the stored
              // shape honest (no `reviewBy` key at all on a plain, non-reaffirmed pause).
              ...(args.reviewBy !== undefined ? { reviewBy: args.reviewBy } : {}),
            };
          } else if (args.active === true && prev.metadata.pause) {
            metadata.lastPause = { ...(prev.metadata.pause as Record<string, unknown>), resumedAtMs: Date.now() };
            delete metadata.pause;
          }
          const next: RoutineSnap = {
            triggerConfig,
            payloadTemplate,
            active: nextActive,
            nextFireAtIso: nextIso,
            groupSlug: args.group !== undefined ? args.group : prev.groupSlug,
            metadata,
          };
          await writeSnap(next);
          return next;
        },
        revertTo: (prev) => writeSnap(prev),
        verify: async (next) => {
          const cur = await readSnap();
          const ok =
            cur.active === next.active &&
            (args.cron === undefined || (cur.triggerConfig as { cron?: string }).cron === args.cron) &&
            (args.group === undefined || cur.groupSlug === next.groupSlug) &&
            // The payload merge must actually be READABLE back, not just written — a silent
            // no-op write here would leave the caller believing a live knob was retuned.
            (args.payloadTemplate === undefined ||
              JSON.stringify(cur.payloadTemplate) === JSON.stringify(next.payloadTemplate));
          return { ok, detail: ok ? undefined : 'routine row did not reflect the change' };
        },
        describe: (prev) => ({
          current: {
            cron: (prev.triggerConfig as { cron?: string }).cron ?? null,
            active: prev.active,
            group: prev.groupSlug,
            ...(args.payloadTemplate !== undefined ? { payloadTemplate: prev.payloadTemplate } : {}),
          },
          proposed: {
            cron: args.cron ?? ((prev.triggerConfig as { cron?: string }).cron ?? null),
            active: args.active ?? prev.active,
            group: args.group !== undefined ? args.group : prev.groupSlug,
            ...(args.payloadTemplate !== undefined
              ? { payloadTemplate: deepMergePlain(prev.payloadTemplate, args.payloadTemplate) }
              : {}),
          },
        }),
      },
      { dryRun: args.dryRun },
    );

    // Refresh the owner's automation panes (Blender / Docs) the moment a pause or
    // retune commits — they read `automation.catalog`. Skipped on a dryRun (nothing
    // changed) and never allowed to fail the mutation: the routine row is already
    // written, so a dead SSE hub must not turn a successful pause into an error.
    if (outcome.applied && !outcome.dryRun) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    // Pausing a routine whose own seed script commits it to ACTIVE is a SILENCING event, so
    // the owner-facing notice fires HERE — at the silencing instant — per plan
    // silent-halt-detection-and-owner-rails-2026-08-08 D-001: this is the only moment the
    // system holds both facts (that the routine is being silenced, and who did it). Any later
    // detector has to rediscover state that no longer announces itself, and D-007 measured
    // what that costs: `unguarded-halt-rescue` — the sweep that re-wakes silently-stopped
    // agents — sat paused 11.9 days with nothing saying a word, because every age-based
    // exemption downstream eventually reclassified it as decommissioned.
    //
    // This does NOT tighten the `reason` validator: D-006 rules that out (it would re-break
    // the Agents pane's one-click pause, a regression with its own EI-18680916805234639). The
    // pause is accepted exactly as before — a human is simply told it happened. That split is
    // the point of D-006: when a required field is a deliberate trade-off, get the
    // accountability from a DIFFERENT mechanism rather than breaking the field's caller.
    //
    // Fail-soft and non-blocking, like the SSE refresh above: the row is already written, so
    // a dead notification rail must never turn a successful pause into an error.
    if (outcome.applied && !outcome.dryRun && args.active === false) {
      void (async () => {
        try {
          const { isAlwaysOnSystemRoutine, isReaffirmed } = await import(
            '../../harness/routines/bespoke-active-seeds-check'
          );
          if (!isAlwaysOnSystemRoutine(args.name)) return;
          // A dated re-affirmation is the sanctioned way to pause one of these on purpose
          // (EI-19370236916382521) — respect it, or this notice becomes the cry-wolf noise
          // that motivated the original pause.
          if (isReaffirmed(args.reviewBy ?? null, Date.now())) return;
          const { notifyAttention } = await import('../../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            importance: 'high',
            harnessSlug: slug,
            title: `Always-on routine paused: ${args.name}`,
            body:
              `"${args.name}" (${slug}) is seeded ACTIVE by default and was just paused — ` +
              `reason: "${args.reason}". Nothing re-arms it on its own. Resume with ` +
              `routines:set { name: "${args.name}", installSlug: "${slug}", active: true }, ` +
              `or re-pause with a \`reviewBy\` date to silence this notice deliberately.`,
            data: { routine: args.name, installSlug: slug, reason: args.reason ?? '', event: 'always-on-routine-paused' },
          });
        } catch (e) {
          console.warn('[routines:set] always-on pause notice failed (non-fatal):', (e as Error)?.message ?? e);
        }
      })();
    }

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
