/**
 * Seed the monthly IQ-battery cadence routine — self-improvement-consume-edges-2026-06-12
 * P-033 / B-12 (mirrors lib/gym/seed-gym-routine.ts).
 *
 *   - `iq-battery-gen` (monthly): one budget-capped benchmark generation per
 *     new code SHA, run through the gen-0 beekeeper runner. The action
 *     self-gates HARD (lib/iq-battery/cadence-tick.ts): no owner-set
 *     payload_template.budgetUsd → REFUSE (the gym's unattended-spend
 *     precedent); an already-measured SHA → skip.
 *
 * SEEDED INACTIVE by default: activation only makes sense after the deploy
 * carries the `system:iq-battery-gen` action (benchmark-actions.ts), and even
 * then the routine refuses until the owner sets a budget. Idempotent (upsert);
 * re-seeding without --budget PRESERVES an owner-set budget.
 *
 *   tsx lib/iq-battery/seed-benchmark-routine.ts                       # seed INACTIVE, no budget
 *   tsx lib/iq-battery/seed-benchmark-routine.ts --active --budget=25  # seed live with a $25 cap
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const SLUG = process.env.IQ_BATTERY_HARNESS ?? 'papercup';
// Monthly at 06:20:00 on the 1st — :20 is deliberately OFFSET from the deploy
// rhythm (release-trigger :00/:15/:30/:45, hourly green-checkpoint ~:30) and
// from the gym's :10/:40 ticks, for the same reason the gym moved off the
// boundary: a battery is a long-running in-host job and a deploy-restart at a
// shared boundary kills it mid-flight.
// MIGRATED (deterministic-blueprints-migration-2026-06-13, D-013): the routine now
// fires the `iq-battery` PROGRAM blueprint via `system:blueprint-run` (which detects
// program-mode and runs the deterministic `iq-battery:gen` step inline) rather than
// the bespoke `system:iq-battery-gen` action. Same cron, same owner-budget gate +
// gen-0 runner (the op runs them); the budget lives under payload_template.payload.
// Behavior-neutral (D-004). The bespoke action is retired (P-130).
const ROUTINE = { name: 'iq-battery-gen', target: 'system:blueprint-run', cron: '0 20 6 1 * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const budgetArg = process.argv.find((a) => a.startsWith('--budget='))?.slice('--budget='.length);
  const budgetUsd = budgetArg !== undefined ? Number(budgetArg) : null;
  if (budgetArg !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd! <= 0)) {
    throw new Error(`--budget must be a positive number of USD, got "${budgetArg}"`);
  }

  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // payload_template carries the blueprint pointer; the owner budget lives under
  // `.payload.budgetUsd` (runScheduledProgram passes `.payload` to the program).
  const blueprintPayload = JSON.stringify(
    budgetUsd != null ? { blueprintId: 'iq-battery', payload: { budgetUsd } } : { blueprintId: 'iq-battery' },
  );
  const budgetPayload = budgetUsd != null ? JSON.stringify({ budgetUsd }) : null;
  // On conflict: ENSURE blueprintId; a re-seed without --budget must NOT wipe the
  // owner-set budget (preserve the existing `.payload`).
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            ${blueprintPayload}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = jsonb_build_object(
        'blueprintId', 'iq-battery',
        'payload', COALESCE(${budgetPayload}::text::jsonb, harness_shared.routines.payload_template->'payload', '{}'::jsonb)
      ),
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-benchmark-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `budget=${budgetUsd != null ? `$${budgetUsd}` : 'NOT SET — the action will refuse until the owner sets one'}). ` +
      (active
        ? 'LIVE — fires monthly (1st, 06:20); refuses without a budget, skips an already-measured SHA.'
        : 'Inactive — enable with --active or the routines admin AFTER the deploy carries system:iq-battery-gen.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-benchmark-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
