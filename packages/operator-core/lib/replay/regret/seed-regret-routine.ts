/**
 * Seed the regret-mining cadence routine — self-learning-frontier-2026-06-12
 * P-021 / FB-07 (mirrors lib/negative-space/seed-negative-space-routine.ts).
 *
 *   - `regret-mine` (every 6h): select bad historical sessions, detect the
 *     divergence turn, price candidate changes via counterfactual replay
 *     (once FB-06's runner is wired), file scored reports origin=replay.
 *     The action self-gates on the `papercusp-regret-mining` flag (default
 *     OFF — the frontier D-001 arming gate) AND the learning-governor
 *     preflight (D-004 / FB-01 — refuses unregistered/unbudgeted).
 *
 * Seeding ALSO registers loop `regret-mining` on the governor ledger —
 * UNBUDGETED, so it shows on the D-004 watch list while the preflight keeps
 * refusing; the owner sets its per-cycle replay budget at the P-001 arming
 * act (unlike the SQL-only miners this loop SPENDS once the replay leg is
 * live, so the cap is a real bound, not just an arming bit).
 *
 * SEEDED INACTIVE by default: triple-dark (inactive routine + dark flag +
 * unbudgeted governor row) until the plan's P-001 gate closes. Idempotent
 * (upsert); re-seeding PRESERVES an owner-tuned payload and an owner-set
 * governor budget (omitted fields preserved).
 *
 *   tsx lib/replay/regret/seed-regret-routine.ts            # seed INACTIVE
 *   tsx lib/replay/regret/seed-regret-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerLearningLoop } from '../../learning-governor/store';
import { activeWorkspaceId } from '../../workspace-registry';
import { regretRegistrationInput } from './governor';

const SLUG = process.env.REGRET_HARNESS ?? 'papercup';
// Every 6h at :35 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45 fires at minute boundaries; green-checkpoint
// ~:30), the gym's :10/:40, iq-battery's :20, negative-space's :25, and the
// change-ledger scan's :20, so a deploy-restart at a shared boundary never
// kills the tick (the iq-battery precedent).
const ROUTINE = { name: 'regret-mine', target: 'system:regret-mine', cron: '0 35 */6 * * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // COALESCE on conflict: a re-seed must not wipe an owner-tuned payload
  // (windowDays / minScore / replay + filing caps).
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
  const reg = await registerLearningLoop(sql, regretRegistrationInput(ws));
  console.log(
    `[seed-regret-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-regret-mining is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  console.log(
    `[seed-regret-routine] governor loop ${reg.loopId}: budget=${reg.budgetUsd ?? 'NULL (unbudgeted — refuses unattended; owner sets it at P-001)'}, ` +
      `kind=${reg.budgetKind}, enforcement=${reg.enforcement}`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-regret-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
