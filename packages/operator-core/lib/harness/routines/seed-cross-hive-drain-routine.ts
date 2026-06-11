/**
 * Seed the periodic cross-Hive outbox-drain routine
 * (hive-network-surface-2026-06-11 P-001, brief B-01).
 *
 * One routine, `cross-hive-outbox-drain` → `system:cross-hive-outbox-drain`,
 * every 2 minutes at second :30 (6-field cron, offset from git-sync's :00
 * ticks). Per fire it reconciles the boot-wired cross-Hive boundaries against
 * the directory-publish state, then runs one backoff-aware drain pass over
 * every wired Hive's durable outbox (cross-hive-drain-action.ts).
 *
 * Seeded ACTIVE by default: the action SELF-GATES — zero published Hives means
 * a no-op tick (one registry read), so an active routine is safe and goes live
 * the moment a Hive is published; finished work never ships dark (CLAUDE.md).
 * `--inactive` seeds it off for an explicit dark launch.
 *
 * payload_template tunables: `baseBackoffMs` (default 30s), `capBackoffMs`
 * (default 30min) — the per-peer retry window shape.
 *
 *   tsx seed-cross-hive-drain-routine.ts              # seed ACTIVE
 *   tsx seed-cross-hive-drain-routine.ts --inactive   # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.CROSS_HIVE_DRAIN_SLUG ?? 'papercup';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_cross_hive_outbox_drain`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, 'cross-hive-outbox-drain', 'cron',
            ${JSON.stringify({ cron: '30 */2 * * * *' })}::text::jsonb, 'system:cross-hive-outbox-drain',
            ${JSON.stringify({})}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_config = EXCLUDED.trigger_config,
      target_role = EXCLUDED.target_role,
      active = EXCLUDED.active,
      updated_at = now()`;
  console.log(`[seed-cross-hive-drain] routine ${id} seeded (install=${SLUG}, active=${active})`);
  await sql.end({ timeout: 5 });
}

void main();
