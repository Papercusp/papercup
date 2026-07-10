/**
 * Seed the coordination-substrate watcher routines
 * (coord-system-e2e-testing-2026-06-10 P-012 + P-013, Layer D).
 *
 *   - `coord-probe-canary` → `system:coord-probe-canary`, every 15 min at :07
 *     (offset from git-sync's :00/:10/… ticks): the live probe-pair verb cycle.
 *   - `coord-invariant-monitor` → `system:coord-invariant-monitor`, hourly at
 *     :37: handoff/escalation/lock/presence/wake-queue invariants.
 *   - `claim-integrity-sweep` → `system:claim-integrity-sweep`, every 10 min
 *     (fleet-reliability-verification-2026-07-10 P-001 / EI-8999): orphaned-wip
 *     + unbacked-active-assignment claim desyncs — a LIVE double-placement
 *     risk, so it ALARMS (directed + woken message to the holder + its fleet
 *     leader), not just a filed backlog item like the two above.
 *
 * All three seeded ACTIVE by default — read-mostly, and even the alarming one
 * only wakes the specific holder/leader it names (never a broadcast); finished
 * work never ships dark (CLAUDE.md). `--inactive` for an explicit dark launch.
 * payload_template tunables: `totalSloMs` (probe), the threshold fields of
 * `DEFAULT_THRESHOLDS` (monitor), `presenceGraceSec`/`settleSec` (claim-integrity).
 *
 *   tsx seed-coord-invariant-routines.ts             # seed ACTIVE
 *   tsx seed-coord-invariant-routines.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.COORD_WATCH_SLUG ?? operatorHomeHarnessSlug();
const ROUTINES = [
  // 30s cycle SLO: a 10s budget was unrealistic for a shared dev box at peak fleet
  // load — the EI-401 breach was a transient ~23s coord-write spike (NOTIFY-queue
  // commit serialization under fleet write load), not a regression. 30s still catches
  // a genuinely-stuck/2×-degraded cycle; the per-step `baseline` control + attributeBreach
  // remain so a real breach is still self-attributing. (NOTE: the ON CONFLICT below does
  // NOT update payload_template, so existing rows are tuned directly in harness_shared.routines.)
  { name: 'coord-probe-canary', target: 'system:coord-probe-canary', cron: '0 7/15 * * * *', payload: { totalSloMs: 30_000 } },
  { name: 'coord-invariant-monitor', target: 'system:coord-invariant-monitor', cron: '0 37 * * * *', payload: {} },
  // fleet-reliability-verification-2026-07-10 P-001 / EI-8999: claim-integrity
  // invariant sweep — offset from the two above (:07/:37) so all three don't
  // contend the same tick. Every 10 min (not hourly like P-013): this is a LIVE
  // double-placement risk, not a slow leak, so it needs a short detection window.
  { name: 'claim-integrity-sweep', target: 'system:claim-integrity-sweep', cron: '0 */10 * * * *', payload: {} },
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
