/**
 * Seed the release-gating routines — plan release-gate-ready-branch-2026-06-04.
 *
 *   - `green-checkpoint` (hourly): advance `ready` to the latest green commit.
 *     ACTIVE by default — it never deploys (FF of `ready` + a broadcast), keeps
 *     `ready` fresh for deliberate deploys, and gives the fleet a continuous
 *     main-is-green signal. Hourly (not every 10 min) respects the shared box.
 *   - `release-trigger` (every 15 min): dispatch the release-manager when `ready`
 *     is ahead of the running release checkout. INACTIVE by default — this IS the
 *     auto-deploy path, and the post-cutover posture (2026-06-05) is
 *     **deploys stay deliberate**: a human (or an explicitly-launched
 *     release-manager) runs `deploy-cli --execute`.
 *
 * The per-routine defaults above ARE the decided posture. `--active` forces both
 * on (graduating release-trigger once trust is earned, D-010); `--inactive`
 * forces both off. Idempotent (upsert).
 *
 *   tsx seed-release-routines.ts             # seed the decided posture
 *   tsx seed-release-routines.ts --active    # force both ON
 *   tsx seed-release-routines.ts --inactive  # force both OFF
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';

const SLUG = process.env.RELEASE_ROUTINE_SLUG ?? 'papercup';
const ROUTINES = [
  // Hourly at :15 — offset from git-sync's every-10-min ticks.
  { name: 'green-checkpoint', target: 'system:green-checkpoint', cron: '0 15 * * * *', activeDefault: true },
  { name: 'release-trigger', target: 'system:release-trigger', cron: '0 */15 * * * *', activeDefault: false },
] as const;

async function main(): Promise<void> {
  const forceActive = process.argv.includes('--active');
  const forceInactive = process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — this is operator
  // infra config, the same path migrations/cross-workspace tooling use. We set
  // workspace_id ourselves rather than depending on the fill-trigger.
  const { sql } = getOrgPg();
  const states: string[] = [];
  for (const r of ROUTINES) {
    const active = forceActive ? true : forceInactive ? false : r.activeDefault;
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
    states.push(`${r.name}=${active ? 'ACTIVE' : 'inactive'}`);
  }
  console.log(
    `[seed-release-routines] seeded for "${SLUG}" (ws=${ws}): ${states.join(', ')}. ` +
      'Defaults encode the deploys-stay-deliberate posture (green-checkpoint auto-advances `ready`; release-trigger is the owner-gated auto-deploy path).',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-release-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
