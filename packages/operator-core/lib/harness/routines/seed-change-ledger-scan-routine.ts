/**
 * Seed the `change-ledger-scan` cadence routine — the repo-edit leg of the
 * behavior-change ledger (self-learning-frontier-2026-06-12 P-004 / FB-02).
 *
 * Hourly git-log scan of the prompt-source roots into
 * harness_shared.behavior_change_ledger. Idempotent (the ledger's dedupe
 * index), no LLM, no queue filing — pure bookkeeping, so it seeds ACTIVE (the
 * claim-discipline precedent: a non-destructive recorder doesn't need human
 * bring-up). The CHANGE_LEDGER flag (default ON) is the kill-switch.
 *
 * MIGRATED (deterministic-blueprints-migration-2026-06-13 bucket A): the routine
 * now fires the `change-ledger` PROGRAM blueprint via `system:blueprint-run`
 * (which detects program-mode and runs the deterministic `change-ledger:scan`
 * step inline) rather than the bespoke `system:change-ledger-scan` action. Same
 * cadence, same flag (the op runs it) — behavior-neutral (D-004). The bespoke
 * action is retained + lint-guarded; the lib logic it called lives on as the
 * op's impl (`runChangeLedgerScan`). NB: this is a pure-bookkeeping recorder, so
 * — unlike the frontier loops — there is NO learning-governor registration here.
 *
 *   tsx seed-change-ledger-scan-routine.ts              # seed ACTIVE
 *   tsx seed-change-ledger-scan-routine.ts --inactive   # seed disabled
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.CHANGE_LEDGER_ROUTINE_SLUG ?? 'papercup';
/** Hourly, offset to :20 to avoid the :00 cadence pileup. */
const CRON = '0 20 * * * *';
/** The program blueprint the routine fires (its deterministic step IS the scan). */
const BLUEPRINT_PAYLOAD = { blueprintId: 'change-ledger' };

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'change-ledger-scan';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // payload_template carries the blueprint pointer; an owner window override
  // lives under `payload_template.payload`. On conflict, ENSURE the blueprintId
  // (a pre-migration row targeted the bespoke action with `{ sinceDays }`) while
  // PRESERVING any existing keys: `{blueprintId} || (existing - blueprintId)`.
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:blueprint-run', ${JSON.stringify(BLUEPRINT_PAYLOAD)}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template =
        ${JSON.stringify(BLUEPRINT_PAYLOAD)}::text::jsonb
        || COALESCE(harness_shared.routines.payload_template - 'blueprintId', '{}'::jsonb),
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-change-ledger-scan-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly prompt-source git-log scan into behavior_change_ledger (via the change-ledger blueprint). ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-change-ledger-scan-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
