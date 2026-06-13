/**
 * Seed the neologism miner cadence routine — self-learning-frontier-2026-06-12
 * P-011 / FB-05 (mirrors lib/negative-space/seed-negative-space-routine.ts).
 *
 *   - `neologism-mine` (every 6h): mine coord traffic + insights for emergent
 *     vocabulary with no corresponding primitive; route capped abstraction-
 *     proposal candidates into Scout's improvement rail. SQL/fs-only, no LLM
 *     spend; the action self-gates on the `papercusp-neologism-miner` flag
 *     (default OFF — the frontier D-001 arming gate) AND the learning-governor
 *     preflight (loop `neologism-miner`, unbudgeted until P-001).
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload.
 *
 *   tsx lib/neologism/seed-neologism-routine.ts            # seed INACTIVE
 *   tsx lib/neologism/seed-neologism-routine.ts --active   # arm the cadence (flag + governor still gate)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.NEOLOGISM_HARNESS ?? 'papercup';
// Every 6h at :35 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, iq-battery's :20, change-ledger-scan's :20, and the
// negative-space miner's :25, so a deploy-restart at a shared boundary
// never kills the tick (the iq-battery precedent).
//
// MIGRATED (deterministic-blueprints-migration-2026-06-13 P-120): the routine
// now fires the `neologism` PROGRAM blueprint via `system:blueprint-run` (which
// detects program-mode and runs the deterministic `neologism:mine` step inline)
// rather than the bespoke `system:neologism-mine` action. Same cadence, same
// flag + governor gates (the op runs them) — behavior-neutral (D-004). The
// bespoke action delegates to the SAME shared `runNeologismMine` orchestration.
const ROUTINE = { name: 'neologism-mine', target: 'system:blueprint-run', cron: '0 35 */6 * * *' };
/** The program blueprint the routine fires (its deterministic step IS the miner). */
const BLUEPRINT_PAYLOAD = { blueprintId: 'neologism' };

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
  console.log(
    `[seed-neologism-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-neologism-miner is flipped ON ' +
          'AND the governor loop neologism-miner is budgeted (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-neologism-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
