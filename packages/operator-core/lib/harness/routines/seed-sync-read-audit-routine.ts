/**
 * Seed the `sync-read-audit` routine (EI-19457924854150358).
 *
 * The sync-read payload audit (`sync-resolver/sync-read-audit.ts`) decides whether a
 * sync read has outgrown its byte ceiling. Nothing ran it: its own source says "run on
 * demand", which in practice meant "run when an agent happens to look". `plans.list`
 * drifted past its allowlisted ceiling and sat there ~12h until an unrelated
 * investigation tripped over it. Every byte cut on `no-http-anywhere-2026-07-28`
 * ratchets a ceiling DOWN so the win cannot silently drift back — a promise that was
 * unenforced, because the ratchet was a number in a comment that only a human
 * re-measuring by hand could check.
 *
 * ── Why this reuses `system:precompute-derived-reads` instead of a new action ────
 * That action ALREADY reads `only` from its `trigger_config` and forwards it to
 * `refreshDerivedReads({ only })`, and `refreshDerivedReads` already runs an
 * `excludeFromDefaultSweep` producer when it is named explicitly. So the entire
 * "give this producer its own cadence" requirement is satisfied by a SECOND ROUTINE
 * ROW against the SAME target_role — no sibling action, no duplicated dispatch seam.
 * A new `system:sync-read-audit` action would have been a parallel mechanism for
 * something the existing one already does.
 *
 * ── Why a separate routine at all, rather than just letting the sweep run it ─────
 * `syncReads.audit` is registered `excludeFromDefaultSweep: true`. Producers run
 * SEQUENTIALLY and the shared 2-min routine is `concurrency: 'skip'`, so a
 * minutes-scale producer in that pass holds the loop long enough to starve the
 * 90s-ttl `serviceHealth` for several ticks. Separate routine rows have independent
 * `concurrency: 'skip'` locks, so this audit can take as long as it needs without
 * ever blocking the sweep's head of line. THAT is the isolation being bought here —
 * not a lower frequency.
 *
 * DAILY. The signal is content drift (plans grow ~45-50/week), not code drift, so a
 * daily reading is ample; the producer's 12h ttl sits below this cadence so each fire
 * always finds it due (the ttl is the don't-recompute-twice guard, not the schedule).
 *
 * Seeded ACTIVE: pure measurement — it spawns no agent, makes no network call, and
 * writes only to its own snapshot row. It WARNS and must never block a deploy
 * (no-http-anywhere-2026-07-28#D-009/#D-011: a budget warns, an invariant blocks, and
 * the remedy for a blind instrument is a red spec, not a blocked deploy).
 *
 *   tsx seed-sync-read-audit-routine.ts             # seed + enable (default)
 *   tsx seed-sync-read-audit-routine.ts --inactive  # seed but leave disabled
 *   tsx seed-sync-read-audit-routine.ts --backfill  # also force one immediate run
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SYNC_READ_AUDIT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 04:30. Six-field cron (leading seconds), matching the sibling routines. */
const CRON = '0 30 4 * * *';
/** The one producer this routine drives — it is excluded from the default sweep. */
const PRODUCER_KEY = 'syncReads.audit';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const backfill = process.argv.includes('--backfill');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'sync-read-audit';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // `only` is what makes this routine drive the excluded producer and NOTHING else —
  // without it this row would re-run the entire default sweep on a second cadence.
  const triggerConfig = { cron: CRON, only: [PRODUCER_KEY] };

  // Next scheduled 04:30 UTC, NOT now(). The sibling precompute routine seeds
  // `now()`, which is harmless at a 2-minute cadence — but this producer is a
  // minutes-scale audit on a DAILY cron, so `now()` would make the act of SEEDING
  // (or of any re-seed, e.g. a deploy) silently kick off a heavy compute
  // immediately. Seeding should install a schedule, not trigger a run.
  // `--backfill` remains the explicit way to ask for one now.
  const nextFire = new Date();
  nextFire.setUTCHours(4, 30, 0, 0);
  if (nextFire.getTime() <= Date.now()) nextFire.setUTCDate(nextFire.getUTCDate() + 1);

  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:precompute-derived-reads', 'skip', 'skip-old', ${active}, ${nextFire.toISOString()})
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-sync-read-audit-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily ${CRON}, only=[${PRODUCER_KEY}].`,
  );

  if (backfill) {
    const { refreshDerivedReads } = await import('../../derived-reads/registry');
    await import('../../derived-reads/producers');
    const outcomes = await refreshDerivedReads({
      workspaceId: ws,
      harnessSlug: SLUG,
      force: true,
      only: [PRODUCER_KEY],
    });
    for (const o of outcomes) {
      console.log(
        `[seed-sync-read-audit-routine] backfill ${o.key}: ` +
          (o.error ? `FAILED — ${o.error}` : `${o.computeMs}ms`),
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-sync-read-audit-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
