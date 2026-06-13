/**
 * Seed the Fleet EKG cadence routine — self-learning-frontier-2026-06-12
 * P-030 / FB-10 (mirrors lib/negative-space/seed-negative-space-routine.ts).
 *
 *   - `fleet-ekg-scan` (every 6h): embed recent agent sessions into
 *     behavioral vectors, detect distribution shifts vs the trailing
 *     baseline, attribute against the behavior-change ledger, alarm on
 *     unattributable MAJOR shifts. SQL-only, no LLM spend; the action
 *     self-gates on the `papercusp-fleet-ekg` flag (default OFF — the
 *     frontier D-001 arming gate) AND the learning-governor preflight
 *     (D-004 / FB-01 — refuses unregistered/unbudgeted).
 *
 * Seeding ALSO registers loop `fleet-ekg` on the governor ledger —
 * UNBUDGETED, so it shows on the D-004 watch list while the preflight keeps
 * refusing; the owner sets its (per-cycle) budget at the P-001 arming act.
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload (windows /
 * thresholds) and an owner-set governor budget (omitted fields preserved).
 *
 *   tsx lib/fleet-ekg/seed-fleet-ekg-routine.ts            # seed INACTIVE
 *   tsx lib/fleet-ekg/seed-fleet-ekg-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerLearningLoop } from '../learning-governor/store';
import { activeWorkspaceId } from '../workspace-registry';
import { fleetEkgRegistrationInput } from './governor';

const SLUG = process.env.FLEET_EKG_HARNESS ?? 'papercup';
// Every 6h at :50 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, iq-battery's :20, negative-space's :25, and neologism's :35, so a
// deploy-restart at a shared boundary never kills the tick.
//
// MIGRATED (deterministic-blueprints-migration-2026-06-13 P-120): the routine
// now fires the `fleet-ekg` PROGRAM blueprint via `system:blueprint-run` (which
// detects program-mode and runs the deterministic `fleet-ekg:scan` step inline)
// rather than the bespoke `system:fleet-ekg-scan` action. Same cadence, same
// flag + governor gates (the op runs them) — behavior-neutral (D-004). The
// bespoke action delegates to the SAME shared `runFleetEkgScan` orchestration.
const ROUTINE = { name: 'fleet-ekg-scan', target: 'system:blueprint-run', cron: '0 50 */6 * * *' };
/** The program blueprint the routine fires (its deterministic step IS the scan). */
const BLUEPRINT_PAYLOAD = { blueprintId: 'fleet-ekg' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // payload_template carries the blueprint pointer; owner threshold/window tuning
  // lives under `payload_template.payload`. On conflict, ENSURE the blueprintId (a
  // pre-migration row targeted the bespoke action) while PRESERVING any existing
  // keys (an owner-tuned `payload`): `{blueprintId} || (existing - blueprintId)`.
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            ${JSON.stringify(BLUEPRINT_PAYLOAD)}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template =
        ${JSON.stringify(BLUEPRINT_PAYLOAD)}::text::jsonb
        || COALESCE(harness_shared.routines.payload_template - 'blueprintId', '{}'::jsonb),
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  const reg = await registerLearningLoop(sql, fleetEkgRegistrationInput(ws));
  console.log(
    `[seed-fleet-ekg-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-fleet-ekg is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  console.log(
    `[seed-fleet-ekg-routine] governor loop ${reg.loopId}: budget=${reg.budgetUsd ?? 'NULL (unbudgeted — refuses unattended; owner sets it at P-001)'}, ` +
      `kind=${reg.budgetKind}, enforcement=${reg.enforcement}`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-fleet-ekg-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
