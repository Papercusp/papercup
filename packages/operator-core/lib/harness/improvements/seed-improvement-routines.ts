/**
 * Seed the self-improvement-loop routines — plans
 * papercusp-self-improvement-loop-2026-06-04 + close-the-self-improvement-loop-2026-06-05.
 *
 *   - `improvement-digest`    (every 30 min): triage the papercusp-improvement
 *      backlog + surface the headline to the human inbox (Phase 2). Read-only.
 *   - `improvement-watchdog`  (every 15 min): the HARD feed-in (close-loop D-003) —
 *      auto-capture red tests / failing smokes / repeated tool errors / down
 *      services as kind=bug improvements. Capture only (search-first dedup +
 *      per-tick cap); builds nothing.
 *   - `improvement-implement` (every 30 min): the auto-implement loop (Phase 3).
 *      ADDITIONALLY gated by the `papercusp-improvement-auto-implement` flag
 *      (default OFF) AND a configured PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS (D-006);
 *      until both are set it no-ops.
 *
 * SEEDED INACTIVE by default (mirrors seed-release-routines.ts). Flip routines
 * on with `--active` (digest + watchdog — the safe, capture/triage-only cadence);
 * the implement routine needs the EXPLICIT `--arm-implement` flag on top (it is
 * the autonomous-code-modification path — owner-gated, close-loop D-004; even
 * then it no-ops until the flag + runner env are also set). Idempotent (upsert).
 *
 *   tsx seed-improvement-routines.ts                          # seed all INACTIVE
 *   tsx seed-improvement-routines.ts --active                 # digest + watchdog live; implement stays inactive
 *   tsx seed-improvement-routines.ts --active --arm-implement # all three live (owner-confirmed arming)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.IMPROVEMENT_ROUTINE_SLUG ?? 'papercup';
const ROUTINES = [
  { name: 'improvement-digest', target: 'system:improvement-digest', cron: '0 */30 * * * *', arm: 'safe' }, // every 30 min
  { name: 'improvement-watchdog', target: 'system:improvement-watchdog', cron: '0 */15 * * * *', arm: 'safe' }, // every 15 min
  { name: 'improvement-implement', target: 'system:improvement-implement', cron: '0 */30 * * * *', arm: 'owner' }, // every 30 min
] as const;

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const armImplement = process.argv.includes('--arm-implement');
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — operator infra config,
  // the same path migrations/cross-workspace tooling use (mirrors seed-release-routines).
  const { sql } = getOrgPg();
  for (const r of ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    // The implement routine is the autonomous-code-modification path — it only goes
    // active with the EXPLICIT --arm-implement (owner-gated, close-loop D-004).
    const rowActive = r.arm === 'owner' ? active && armImplement : active;
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${rowActive}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        active = EXCLUDED.active,
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
  }
  console.log(
    `[seed-improvement-routines] seeded ${ROUTINES.map((r) => r.name).join(' + ')} for "${SLUG}" (ws=${ws}, active=${active}, armImplement=${armImplement}). ` +
      (active
        ? armImplement
          ? 'All three LIVE — implement still no-ops until the papercusp-improvement-auto-implement flag + PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS are set.'
          : 'Digest + watchdog LIVE; implement stays INACTIVE (owner-gated — re-run with --arm-implement after owner confirm).'
        : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-improvement-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
