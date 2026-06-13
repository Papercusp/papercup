/**
 * Seed the negative-space miner cadence routine — self-learning-frontier-2026-06-12
 * P-010 / FB-04 (mirrors lib/iq-battery/seed-benchmark-routine.ts).
 *
 *   - `negative-space-mine` (every 6h): recompute the zero-hit-search demand
 *     map + file the capped kind=change candidates. SQL-only, no LLM spend;
 *     the action self-gates on the `papercusp-negative-space-miner` flag
 *     (default OFF — the frontier D-001 arming gate) AND the learning-governor
 *     preflight (D-004 / FB-01 — refuses unregistered/unbudgeted).
 *
 * Seeding ALSO registers loop `negative-space-miner` on the governor ledger —
 * UNBUDGETED, so it shows on the D-004 watch list while the preflight keeps
 * refusing; the owner sets its (per-cycle) budget at the P-001 arming act.
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload (fire
 * bars / window) and an owner-set governor budget (omitted fields preserved).
 *
 *   tsx lib/negative-space/seed-negative-space-routine.ts            # seed INACTIVE
 *   tsx lib/negative-space/seed-negative-space-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerLearningLoop } from '../learning-governor/store';
import { activeWorkspaceId } from '../workspace-registry';
import { negativeSpaceRegistrationInput } from './governor';

const SLUG = process.env.NEGATIVE_SPACE_HARNESS ?? 'papercup';
// Every 6h at :25 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, and iq-battery's :20, so a deploy-restart at a shared boundary
// never kills the tick (the iq-battery precedent).
//
// MIGRATED (deterministic-blueprints-migration-2026-06-13 P-110): the routine
// now fires the `negative-space` PROGRAM blueprint via `system:blueprint-run`
// (which detects program-mode and runs the deterministic `negative-space:scan`
// step inline) rather than the bespoke `system:negative-space-mine` action. Same
// cadence, same flag + governor gates (the op runs them) — behavior-neutral
// (D-004). The bespoke action is retired in P-130; the lib logic it called lives
// on as the op's impl.
const ROUTINE = { name: 'negative-space-mine', target: 'system:blueprint-run', cron: '0 25 */6 * * *' };
/** The program blueprint the routine fires (its deterministic step IS the miner). */
const BLUEPRINT_PAYLOAD = { blueprintId: 'negative-space' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // payload_template carries the blueprint pointer; owner fire-bar tuning lives
  // under `payload_template.payload`. On conflict, ENSURE the blueprintId (a
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
  const reg = await registerLearningLoop(sql, negativeSpaceRegistrationInput(ws));
  console.log(
    `[seed-negative-space-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-negative-space-miner is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  console.log(
    `[seed-negative-space-routine] governor loop ${reg.loopId}: budget=${reg.budgetUsd ?? 'NULL (unbudgeted — refuses unattended; owner sets it at P-001)'}, ` +
      `kind=${reg.budgetKind}, enforcement=${reg.enforcement}`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-negative-space-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
