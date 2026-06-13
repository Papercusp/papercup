/**
 * Seed the `scout-cycle` cadence routine — Scout P-008 (hive-creative-ideation
 * D-010). The autonomous-ideation cadence primitive's registration half.
 *
 * The routine fires `system:scout-cycle` (registered by registerScoutCycleAction)
 * on a FREQUENT cron; the handler SELF-GATES on idle-capacity/friction + budget +
 * the autoloop fire-gate, so a real (budgeted) Scout cycle runs only when the gate
 * says so — the cron is just the heartbeat, not the cadence (b6c3f Risk A). Most
 * ticks no-op cheaply.
 *
 * SEEDED INACTIVE by default (mirrors seed-scan-routine / seed-improvement-routines)
 * — bring-up is human-confirmed. Idempotent (upsert by install_slug+name).
 *
 *   tsx seed-scout-routine.ts            # seed INACTIVE
 *   tsx seed-scout-routine.ts --active   # seed + enable the cadence
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.SCOUT_ROUTINE_SLUG ?? 'papercup';
/** Heartbeat cron — every 30 min. The handler's gate decides whether to actually run. */
const CRON = '0 */30 * * * *';
/** Cadence + budget overrides the handler reads from payload_template (else gate/budget defaults).
 *  maxCostUsd must comfortably exceed the ideator stage's cost (~$1.25 at 6 opus
 *  ideators, 2026-06-11) — budget checks run BETWEEN stages, so a cap the ideators
 *  alone exhaust burns the whole spend while routing nothing (owner-set $3, 2026-06-11). */
const PAYLOAD = {
  cadence: { minIntervalSec: 3600, idleThreshold: 0.5, frictionThreshold: 3 },
  budget: { maxCostUsd: 3.0, maxIdeators: 6, maxCriticsPerIdea: 2 },
};

// MIGRATED (deterministic-blueprints-migration-2026-06-13 P-121): the routine now
// fires the `scout` PROGRAM blueprint via `system:blueprint-run` (which detects
// program-mode and runs the deterministic `scout:cycle` step inline) rather than the
// bespoke `system:scout-cycle` action. The cadence/budget overrides move UNDER
// `payload_template.payload` (the blueprint interpolates `{{ payload.cadence }}` /
// `{{ payload.budget }}` into the op's args). Same heartbeat cron, same structural
// self-gate (cadence → fire-gate → claim → budget, inside the tick) — behavior-neutral
// (D-004). The bespoke action is retired in P-130.
const BLUEPRINT_PAYLOAD = { blueprintId: 'scout', payload: PAYLOAD };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'scout-cycle';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:blueprint-run', ${JSON.stringify(BLUEPRINT_PAYLOAD)}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-scout-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `cron heartbeat fires the scout blueprint via system:blueprint-run; the scout:cycle step ` +
      `self-gates on idle/friction + budget. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-scout-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
