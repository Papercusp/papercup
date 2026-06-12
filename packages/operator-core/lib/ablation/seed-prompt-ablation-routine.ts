/**
 * Seed the prompt-sedimentology cadence routine — self-learning-frontier
 * P-023 / FB-09 (mirrors lib/negative-space/seed-negative-space-routine.ts).
 *
 *   - `prompt-ablation` (weekly, Mon 04:35): shadow-ablate ONE SU-playbook
 *     rule and score the behavioral delta over the llm-testing `su` suite.
 *     Real LLM spend; the action self-gates on the `papercusp-prompt-ablation`
 *     flag (default OFF — the frontier D-001 arming gate) AND the
 *     learning-governor preflight (D-004 / FB-01 — refuses unregistered/
 *     unbudgeted; the per-cycle budget is the hard cycle spend cap).
 *
 * Seeding ALSO registers loop `prompt-ablation` on the governor ledger —
 * UNBUDGETED, so it shows on the D-004 watch list while the preflight keeps
 * refusing; the owner sets its per-cycle budget at the P-001 arming act.
 *
 * SEEDED INACTIVE by default: the loop is triple-dark (inactive routine +
 * dark flag + unbudgeted governor row) until the plan's P-001 gate closes.
 * Idempotent (upsert); re-seeding PRESERVES an owner-tuned payload
 * (scenarioIds / repeat / ruleKey / ledgerWindowDays) and an owner-set
 * governor budget (omitted fields preserved).
 *
 * Cadence: weekly Monday 04:35 — deliberately OFFSET from the deploy rhythm
 * (release-trigger :00/:15/:30/:45, green-checkpoint ~:30), the gym's
 * :10/:40, iq-battery's :20, negative-space's :25, and the Monday 13:30
 * human digest, so a deploy-restart at a shared boundary never kills the tick
 * (the iq-battery precedent) and the weekly owner digest never races a
 * mid-flight cycle.
 *
 *   tsx lib/ablation/seed-prompt-ablation-routine.ts            # seed INACTIVE
 *   tsx lib/ablation/seed-prompt-ablation-routine.ts --active   # arm the cadence (flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerLearningLoop } from '../learning-governor/store';
import { activeWorkspaceId } from '../workspace-registry';
import { promptAblationRegistrationInput } from './governor';

const SLUG = process.env.PROMPT_ABLATION_HARNESS ?? 'papercup';
const ROUTINE = { name: 'prompt-ablation', target: 'system:prompt-ablation', cron: '0 35 4 * * 1' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // COALESCE on conflict: a re-seed must not wipe an owner-tuned payload.
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
  const reg = await registerLearningLoop(sql, promptAblationRegistrationInput(ws));
  console.log(
    `[seed-prompt-ablation-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action still no-ops until papercusp-prompt-ablation is flipped ON (frontier P-001 gate).'
        : 'Inactive — enable with --active or the routines admin once the P-001 arming gate closes.'),
  );
  console.log(
    `[seed-prompt-ablation-routine] governor loop ${reg.loopId}: budget=${reg.budgetUsd ?? 'NULL (unbudgeted — refuses unattended; owner sets the per-cycle cap at P-001)'}, ` +
      `kind=${reg.budgetKind}, enforcement=${reg.enforcement}`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-prompt-ablation-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
