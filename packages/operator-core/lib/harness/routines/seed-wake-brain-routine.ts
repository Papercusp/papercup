/**
 * Seed the `wake-brain` routine — the autonomous-Queen cadence
 * (hive-agent-tabs-psu-tui-2026-06-09 P-005 / D-006 / D-002; handler in
 * `wake-brain-action.ts`).
 *
 *   - `wake-brain` (every 30 min): fire the pinned `psu --brain` session's
 *     inbox-wake so the Queen takes one autonomous supervision turn. No spawn,
 *     no parallel driver — just the shipped wake machinery (D-002).
 *
 * SEEDED ACTIVE by default — but the ACTION is flag-gated on HIVE_AGENT_TABS
 * (off → the handler no-ops, the brain stays a responsive engineer session),
 * so the routine costs nothing until the owner flips the flag. That makes the
 * FLAG the single activation lever for the whole hive-agent-tabs experience,
 * Queen cadence included — no second switch to forget (alpha policy: finished
 * work never ships dark behind an extra toggle).
 *
 *   tsx seed-wake-brain-routine.ts              # seed ACTIVE (flag still gates)
 *   tsx seed-wake-brain-routine.ts --inactive   # seed but leave the cron off
 *
 * trigger_config knobs (editable via the routines admin):
 *   - cron (default every 30 min) — the cadence; cost scales linearly with it
 *     (each fired wake = one billable Queen turn while the flag is on).
 *   - kickoff — override the wake's summary text (the Queen's tick prompt).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.WAKE_BRAIN_ROUTINE_SLUG ?? 'papercup';
/** Every 30 minutes — a conservative default: ~48 Queen turns/day at most,
 *  and only while HIVE_AGENT_TABS is on AND a brain session is live. */
const CRON = '0 */30 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'wake-brain';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:wake-brain', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-wake-brain-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `the autonomous-Queen cadence (every 30 min; the wake fires only under HIVE_AGENT_TABS ` +
      `with a live pinned brain). ` +
      (active ? 'Cron LIVE (flag still gates the action).' : 'Inactive — enable via the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-wake-brain-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
