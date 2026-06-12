/**
 * Seed the negative-space miner cadence routine — self-learning-frontier-2026-06-12
 * P-010 / FB-04 (mirrors lib/iq-battery/seed-benchmark-routine.ts).
 *
 *   - `negative-space-mine` (every 6h): recompute the zero-hit-search demand
 *     map + file the capped kind=change candidates. SQL-only, no LLM spend;
 *     the action self-gates on the `papercusp-negative-space-miner` flag
 *     (default OFF — the frontier D-001 arming gate).
 *
 * SEEDED INACTIVE by default: the loop is double-dark (inactive routine +
 * dark flag) until the plan's P-001 gate closes. Idempotent (upsert);
 * re-seeding PRESERVES an owner-tuned payload (fire bars / window).
 *
 *   tsx lib/negative-space/seed-negative-space-routine.ts            # seed INACTIVE
 *   tsx lib/negative-space/seed-negative-space-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.NEGATIVE_SPACE_HARNESS ?? 'papercup';
// Every 6h at :25 — deliberately OFFSET from the deploy rhythm
// (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
// :10/:40, and iq-battery's :20, so a deploy-restart at a shared boundary
// never kills the tick (the iq-battery precedent).
const ROUTINE = { name: 'negative-space-mine', target: 'system:negative-space-mine', cron: '0 25 */6 * * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // COALESCE on conflict: a re-seed must not wipe an owner-tuned payload
  // (fire bars minMisses/minAgents/maxPerTick, windowDays).
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            NULL::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = COALESCE(harness_shared.routines.payload_template, EXCLUDED.payload_template),
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-negative-space-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-negative-space-miner is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-negative-space-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
