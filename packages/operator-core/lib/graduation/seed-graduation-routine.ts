/**
 * Seed the graduation tracker cadence routine — self-learning-frontier-2026-06-12
 * P-046 / FB-19 (mirrors lib/neologism/seed-neologism-routine.ts).
 *
 *   - `graduation-scan` (daily): count per-class clean auto-passes over the
 *     outcome rails and file owner ratification reports for classes that
 *     cross the graduation threshold. SQL-only, no LLM spend; the action
 *     self-gates on the `papercusp-graduation-tracker` flag (default OFF —
 *     the frontier D-001 arming gate) AND the learning-governor preflight
 *     (loop `graduation-tracker`, unbudgeted until P-001).
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload.
 *
 *   tsx lib/graduation/seed-graduation-routine.ts            # seed INACTIVE
 *   tsx lib/graduation/seed-graduation-routine.ts --active   # arm the cadence (flag + governor still gate)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.GRADUATION_HARNESS ?? 'papercup';
// Daily at 04:05 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, iq-battery's :20, change-ledger-scan's :20, negative-space's :25,
// neologism's :35, EKG/calibration's :50, and the 03:35 nightly pair
// (deferral-interest refit, transfer distill), so a deploy-restart at a
// shared boundary never kills the tick. Graduation evidence moves on a
// 14-day decay window — daily is generous.
const ROUTINE = { name: 'graduation-scan', target: 'system:graduation-scan', cron: '0 5 4 * * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // COALESCE on conflict: a re-seed must not wipe an owner-tuned payload
  // (threshold / windows / report cap / never-graduate patterns).
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            NULL::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = COALESCE(harness_shared.routines.payload_template, EXCLUDED.payload_template),
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-graduation-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-graduation-tracker is flipped ON ' +
          'AND the governor loop graduation-tracker is budgeted (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-graduation-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
