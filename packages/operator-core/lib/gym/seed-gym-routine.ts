/**
 * Seed the gym-cycle routine — learning-system-audit-improvements-2026-06-09
 * P-031 (mirrors seed-improvement-routines.ts).
 *
 *   - `gym-cycle` (every 30 min): the gym's pulse. Each tick runs AT MOST ONE
 *     bounded, human-gated gym cycle for the least-recently-run autoloop that
 *     is enabled + idle + explicitly budgeted with remaining > the floor
 *     (~$0.50). The action self-gates HARD (lib/gym/autoloop-tick.ts): a
 *     disabled / non-idle / uncapped / exhausted autoloop is never fired, the
 *     shared autoloop fire-gate (error backoff / circuit) brakes a failing
 *     harness, and autoPromote stays FALSE — proposals remain human-decided.
 *
 * SEEDED INACTIVE by default: activation only makes sense after the deploy
 * carries the `system:gym-cycle` action (gym-actions.ts), and even then the
 * routine no-ops until a gym autoloop row is enabled WITH a budget (gym UI).
 * Flip on with `--active` or the routines admin. Idempotent (upsert).
 *
 *   tsx lib/gym/seed-gym-routine.ts            # seed INACTIVE (default)
 *   tsx lib/gym/seed-gym-routine.ts --active   # seed live
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.GYM_ROUTINE_SLUG ?? 'papercup';
const ROUTINE = { name: 'gym-cycle', target: 'system:gym-cycle', cron: '0 */30 * * * *' }; // every 30 min

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — operator infra config,
  // the same path migrations/cross-workspace tooling use (mirrors seed-improvement-routines).
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron', ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gym-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE — still no-ops until a gym autoloop row is enabled WITH an explicit budget (gym UI).'
        : 'Inactive — enable with --active or the routines admin AFTER the deploy carries system:gym-cycle.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gym-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
