/**
 * Seed the `operator-e2e-isolated` routine (plan operator-e2e-standing-isolated-run-2026-10-06
 * P-002, WI-10006805): `system:operator-e2e-isolated` → `operator-e2e-isolated-action.ts`, which
 * launches the operator Playwright suite inside the isolated verify-tauri-headless rig and records
 * every spec result in `harness_shared.test_runs` under the run group `operator-e2e-nightly:<fire>`.
 *
 * Nightly at 04:30, an hour and a half after the 03:00 nightly release cut (a 30-40 min build), so
 * the two heaviest nightly jobs do not start together. The run is also pc-heavy-wrapped, so it
 * queues behind any heavy job that still holds a slot.
 *
 * `tier: 'durable'` puts the fire on the DBOS routines engine. Seeded ACTIVE by default: the suite
 * runs against a throwaway database and WebView profile (VERIFY_TAURI_ISOLATED_DB=1), it never
 * mutates tracked source, and the action self-gates to the operator-home harness. Finished work
 * never ships dark (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 *
 *   tsx seed-operator-e2e-isolated-routine.ts             # seed ACTIVE
 *   tsx seed-operator-e2e-isolated-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.OPERATOR_E2E_ISOLATED_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Nightly at 04:30, clear of the 03:00 nightly release cut. */
const OPERATOR_E2E_ISOLATED_CRON = '0 30 4 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'operator-e2e-isolated';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: OPERATOR_E2E_ISOLATED_CRON })}::text::jsonb,
            'system:operator-e2e-isolated', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-operator-e2e-isolated-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}): ` +
      `nightly (04:30) isolated operator Playwright run, ledger group operator-e2e-nightly:<fire>. ` +
      (active ? 'Cadence LIVE.' : 'Inactive; enable it from the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-operator-e2e-isolated-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
