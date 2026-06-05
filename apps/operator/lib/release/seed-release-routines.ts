/**
 * Seed the release-gating routines — plan release-gate-ready-branch-2026-06-04.
 *
 *   - `green-checkpoint` (every 10 min): advance `ready` to the latest green commit.
 *   - `release-trigger`  (every 15 min): dispatch the release-manager when `ready`
 *      is ahead of the running release checkout.
 *
 * SEEDED INACTIVE by default (D-010 bring-up is human-confirmed). Flip on with
 * `--active`, or later via the routines admin / a SQL UPDATE. Idempotent (upsert).
 *
 *   tsx seed-release-routines.ts            # seed INACTIVE
 *   tsx seed-release-routines.ts --active   # seed + enable
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';

const SLUG = process.env.RELEASE_ROUTINE_SLUG ?? 'papercup';
const ROUTINES = [
  { name: 'green-checkpoint', target: 'system:green-checkpoint', cron: '0 */10 * * * *' }, // every 10 min
  { name: 'release-trigger', target: 'system:release-trigger', cron: '0 */15 * * * *' }, // every 15 min
] as const;

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — this is operator
  // infra config, the same path migrations/cross-workspace tooling use. We set
  // workspace_id ourselves rather than depending on the fill-trigger.
  const { sql } = getOrgPg();
  for (const r of ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${active}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        active = EXCLUDED.active,
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
  }
  console.log(
    `[seed-release-routines] seeded ${ROUTINES.map((r) => r.name).join(' + ')} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active ? 'LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-release-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
