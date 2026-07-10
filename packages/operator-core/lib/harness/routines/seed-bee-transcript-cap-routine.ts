/**
 * Seed the `bee-transcript-cap` routine — bee-context-efficiency P-013 (D-007); design
 * in `../../hive/bee-transcript-cap.ts`, handler in `bee-transcript-cap-action.ts`.
 *
 *   - `bee-transcript-cap` (every 30 min): scan live bees; recycle (graceful
 *     checkpoint-and-recycle nudge) any IDLE bee whose session transcript grew past the
 *     cap so its next task spawns fresh (P-005). Never touches a mid-task bee (D-005).
 *
 * DOUBLE-GATED: the action is flag-gated DEFAULT-OFF (papercusp-bee-transcript-cap) and
 * this routine is SEEDED INACTIVE. Bring-up human-confirmed; idempotent (upsert).
 * Recommended order: `--active` with `dry_run` first to preview the over-cap cohort,
 * then flip the flag, then drop dry_run.
 *
 *   tsx seed-bee-transcript-cap-routine.ts                      # seed INACTIVE
 *   tsx seed-bee-transcript-cap-routine.ts --active            # seed + enable the sweep
 *   tsx seed-bee-transcript-cap-routine.ts --active --dry-run  # enable in preview mode
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - dry_run (default false) — log the over-cap cohort but recycle nothing.
 *   - max_tasks / max_carried_read_tokens / max_transcript_entries — cap overrides.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG =
  process.env.CUP_TRANSCRIPT_CAP_ROUTINE_SLUG ??
  process.env.BEE_TRANSCRIPT_CAP_ROUTINE_SLUG ?? // legacy env name — dual-accept until callers migrate
  operatorHomeHarnessSlug();
/** Every 30 min at :15/:45 — cheap (a few SELECTs + on-disk line counts); a bloated
 *  session is not urgent, but shouldn't linger a whole hour past the cap. */
const CRON = '0 15,45 * * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'bee-transcript-cap';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, dry_run: dryRun };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:bee-transcript-cap', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-bee-transcript-cap-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
      `30-min recycle sweep of over-cap bee transcripts. ` +
      (active
        ? 'Cadence LIVE (still flag-gated by papercusp-bee-transcript-cap).'
        : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-bee-transcript-cap-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
