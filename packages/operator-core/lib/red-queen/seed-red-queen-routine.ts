/**
 * Seed the Red Queen drill cadence routine — self-learning-frontier-2026-06-12
 * P-031 / FB-20 (mirrors lib/fleet-ekg/seed-fleet-ekg-routine.ts).
 *
 *   - `red-queen-drill` (every 6h): expire stale drills, then ONE drill cycle
 *     for the least-recently drilled class — plant → real watchdog tick over
 *     the sandbox workspace → real triage (drill-opted-in) → heal → MTTSH +
 *     zero-leak recorded. SQL-only, no LLM spend; the action self-gates on
 *     the `papercusp-red-queen` flag (default OFF — the frontier D-001
 *     arming gate) AND the learning-governor preflight (D-004 / FB-01 —
 *     refuses unregistered/unbudgeted).
 *
 * Seeding ALSO registers loop `red-queen` on the governor ledger —
 * UNBUDGETED, so it shows on the D-004 watch list while the preflight keeps
 * refusing; the owner sets its (per-cycle) budget at the P-001 arming act.
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload (classId
 * pin) and an owner-set governor budget (omitted fields preserved).
 *
 *   tsx lib/red-queen/seed-red-queen-routine.ts            # seed INACTIVE
 *   tsx lib/red-queen/seed-red-queen-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerLearningLoop } from '../learning-governor/store';
import { activeWorkspaceId } from '../workspace-registry';
import { redQueenRegistrationInput } from './governor';

const SLUG = process.env.RED_QUEEN_HARNESS ?? 'papercup';
// Every 6h at :05 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, iq-battery's :20, negative-space's :25, neologism's :35, and
// fleet-ekg/calibration's :50, so a deploy-restart at a shared boundary
// never kills the tick.
const ROUTINE = { name: 'red-queen-drill', target: 'system:red-queen-drill', cron: '0 5 */6 * * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // COALESCE on conflict: a re-seed must not wipe an owner-tuned payload
  // (classId pin — see red-queen-action.ts).
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
  const reg = await registerLearningLoop(sql, redQueenRegistrationInput(ws));
  console.log(
    `[seed-red-queen-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-red-queen is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  console.log(
    `[seed-red-queen-routine] governor loop ${reg.loopId}: budget=${reg.budgetUsd ?? 'NULL (unbudgeted — refuses unattended; owner sets it at P-001)'}, ` +
      `kind=${reg.budgetKind}, enforcement=${reg.enforcement}`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-red-queen-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
