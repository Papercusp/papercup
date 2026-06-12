/**
 * Seed the `system:change-ledger-scan` cadence routine — the repo-edit leg of
 * the behavior-change ledger (self-learning-frontier-2026-06-12 P-004 / FB-02).
 *
 * Hourly git-log scan of the prompt-source roots into
 * harness_shared.behavior_change_ledger (change-ledger-scan-action.ts).
 * Idempotent (the ledger's dedupe index), no LLM, no queue filing — pure
 * bookkeeping, so it seeds ACTIVE (the claim-discipline precedent: a
 * non-destructive recorder doesn't need human bring-up). The CHANGE_LEDGER
 * flag (default ON) is the kill-switch.
 *
 *   tsx seed-change-ledger-scan-routine.ts              # seed ACTIVE
 *   tsx seed-change-ledger-scan-routine.ts --inactive   # seed disabled
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.CHANGE_LEDGER_ROUTINE_SLUG ?? 'papercup';
/** Hourly, offset to :20 to avoid the :00 cadence pileup. */
const CRON = '0 20 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'change-ledger-scan';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const payloadTemplate = { sinceDays: 14 };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:change-ledger-scan', ${JSON.stringify(payloadTemplate)}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-change-ledger-scan-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly prompt-source git-log scan into behavior_change_ledger. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-change-ledger-scan-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
