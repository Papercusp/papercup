/**
 * Seed the self-improvement-loop routines — plan papercusp-self-improvement-loop-2026-06-04.
 *
 *   - `improvement-digest`    (every 30 min): triage the papercusp-improvement
 *      backlog + surface the headline to the human inbox (Phase 2). Read-only.
 *   - `improvement-implement` (every 30 min): the auto-implement loop (Phase 3).
 *      ADDITIONALLY gated by the `papercusp-improvement-auto-implement` flag
 *      (default OFF) AND a configured PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS (D-006);
 *      until both are set it no-ops.
 *
 * SEEDED INACTIVE by default (mirrors seed-release-routines.ts). Flip the routine
 * on with `--active`; flip the auto-implement FLAG separately (the routine being
 * active just means the digest runs — implement stays a no-op until the flag +
 * runner are set). Idempotent (upsert).
 *
 *   tsx seed-improvement-routines.ts            # seed INACTIVE
 *   tsx seed-improvement-routines.ts --active   # seed + enable the cadence
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.IMPROVEMENT_ROUTINE_SLUG ?? 'papercup';
const ROUTINES = [
  { name: 'improvement-digest', target: 'system:improvement-digest', cron: '0 */30 * * * *' }, // every 30 min
  { name: 'improvement-implement', target: 'system:improvement-implement', cron: '0 */30 * * * *' }, // every 30 min
] as const;

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — operator infra config,
  // the same path migrations/cross-workspace tooling use (mirrors seed-release-routines).
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
    `[seed-improvement-routines] seeded ${ROUTINES.map((r) => r.name).join(' + ')} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'Cadence LIVE — digest runs; implement stays a no-op until the papercusp-improvement-auto-implement flag + PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS are set.'
        : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-improvement-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
