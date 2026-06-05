/**
 * Seed the proactive `scan` launch routine — unify-agent-launches-as-blueprints-2026-06-04
 * (P1, D-003 / D-005).
 *
 * The scan reframe (D-005): the bespoke `operator_scanner_session` + operator-card
 * recommendation stream dissolve into a SCHEDULED LAUNCH of the `scan` blueprint
 * whose findings land as `work_items[kind=change|improvement]` in the
 * self-improvement triage backlog (one triage surface, not a separate card stream).
 *
 * Unlike the bespoke `system:*` release/improvement actions, this routine needs NO
 * bespoke handler — it rides the generic `system:blueprint-run` action with a
 * `payload_template.blueprintId: 'scan'`, which the launch-blueprint primitive fires
 * (resolving the scanner role from the blueprint). That is the unification: a pure
 * cadence launch is a declared blueprint + a generic routine, no hand-wired caller.
 *
 * SEEDED INACTIVE by default (mirrors seed-release-routines.ts /
 * seed-improvement-routines.ts) — bring-up is human-confirmed. Idempotent (upsert).
 *
 *   tsx seed-scan-routine.ts            # seed INACTIVE
 *   tsx seed-scan-routine.ts --active   # seed + enable the cadence
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.SCAN_ROUTINE_SLUG ?? 'papercup';
/** Every 4 hours — matches the `scan` blueprint's declared `triggers.schedule`. */
const CRON = '0 0 */4 * * *';
const KICKOFF =
  'Proactively scan the workspace for latent problems + improvement opportunities no ' +
  'agent has flagged. Capture each finding via improvements:capture (kind=bug for a ' +
  'defect, change for an improvement) so it lands as a tracked work-item in the ' +
  'self-improvement triage backlog — do NOT emit operator cards.';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'scan';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const payloadTemplate = { blueprintId: 'scan', mode: 'run', kickoff: KICKOFF };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:blueprint-run', ${JSON.stringify(payloadTemplate)}::text::jsonb,
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
    `[seed-scan-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `fires the scan blueprint via system:blueprint-run; findings → self-improvement backlog. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-scan-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
