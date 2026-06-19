/**
 * Seed the `telemetry-retention` routine — the periodic janitor for the unbounded
 * high-volume diagnostic tables (`route_invocations`, `tool_invocations`) the
 * 2026-06-18 infra audit found growing without bound (R2; handler in
 * `telemetry-retention-action.ts`, prune logic in `storage/prune.ts`).
 *
 *   - `telemetry-retention` (daily 04:00): prune route-invocations >7d +
 *     tool-invocations >14d via the shared storage prune (chunked + VACUUM).
 *     Pure DB maintenance — spawns no agent, makes no network call.
 *
 * SEEDED INACTIVE by default (mirrors seed-session-dir-gc-routine). Bring-up is
 * human-confirmed; idempotent (upsert). After deploy:
 *
 *   tsx seed-telemetry-retention-routine.ts             # seed INACTIVE
 *   tsx seed-telemetry-retention-routine.ts --active     # seed + enable the daily prune
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - targets   — [{ category, retention_days }]; default route-invocations@7d +
 *                 tool-invocations@14d.
 *   - dry_run   — plan + log, delete nothing.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.TELEMETRY_RETENTION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 04:00 — off the busy hours; off-set from session-dir-gc (04:30). */
const CRON = '0 0 4 * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'telemetry-retention';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    targets: [
      { category: 'route-invocations', retention_days: 7 },
      { category: 'tool-invocations', retention_days: 14 },
    ],
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:telemetry-retention', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-telemetry-retention-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily prune of route-invocations >7d + tool-invocations >14d. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-telemetry-retention-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
