/**
 * Seed the coordination-substrate watcher routines
 * (coord-system-e2e-testing-2026-06-10 P-012 + P-013, Layer D).
 *
 *   - `coord-probe-canary` → `system:coord-probe-canary`, every 15 min at :07
 *     (offset from git-sync's :00/:10/… ticks): the live probe-pair verb cycle.
 *   - `coord-invariant-monitor` → `system:coord-invariant-monitor`, hourly at
 *     :37: handoff/escalation/lock/presence/wake-queue invariants.
 *
 * Both seeded ACTIVE by default — they are read-mostly, file deduped
 * improvements (never wake anyone), and the probe sweeps its own rows; finished
 * work never ships dark (CLAUDE.md). `--inactive` for an explicit dark launch.
 * payload_template tunables: `totalSloMs` (probe), the threshold fields of
 * `DEFAULT_THRESHOLDS` (monitor).
 *
 *   tsx seed-coord-invariant-routines.ts             # seed ACTIVE
 *   tsx seed-coord-invariant-routines.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.COORD_WATCH_SLUG ?? 'papercup';
const ROUTINES = [
  { name: 'coord-probe-canary', target: 'system:coord-probe-canary', cron: '0 7/15 * * * *', payload: { totalSloMs: 10_000 } },
  { name: 'coord-invariant-monitor', target: 'system:coord-invariant-monitor', cron: '0 37 * * * *', payload: {} },
] as const;

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  for (const r of ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron',
              ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              ${JSON.stringify(r.payload)}::text::jsonb,
              'skip', 'skip-old', ${active}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        trigger_config = EXCLUDED.trigger_config,
        target_role = EXCLUDED.target_role,
        active = EXCLUDED.active,
        updated_at = now()`;
    console.log(`[seed-coord-invariant] ${id} seeded (active=${active})`);
  }
  await sql.end({ timeout: 5 });
}

void main();
