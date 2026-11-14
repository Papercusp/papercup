/**
 * Seed the `stuck-work-waiting-check` routine — the durable waiting check's 600s cadence
 * (stuck-work-detection-and-honest-waits-2026-11-13 P-002; handler in
 * `stuck-work-waiting-check-action.ts`, rule in `../../stuck-work/waiting-check.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`), like
 * `seed-consult-expiry-routine.ts`: an operator-HOME-level sweep over the waits table, not
 * a per-blueprint-install cadence. Armed by the per-host ephemeral executor on boot — NOT a
 * bare `setInterval`.
 *
 * 600s cadence: the rule's shortest threshold is 4 hours, so a 10-minute sweep keeps the
 * detection latency under 5% of it. Each run re-reads every count from the table.
 *
 * SEEDED ACTIVE by default ("finished work never ships dark"). Pass `--inactive` to seed dark.
 *
 *   tsx seed-stuck-work-waiting-check-routine.ts              # seed ACTIVE (default)
 *   tsx seed-stuck-work-waiting-check-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name)). Restart papercusp-bg-host to live-arm a
 * freshly-seeded row on a host that was already up.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.STUCK_WORK_WAITING_CHECK_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'stuck-work-waiting-check';
const TARGET_ROLE = 'system:stuck-work-waiting-check';
const DEFAULT_INTERVAL_SEC = 600;

void runRoutineSeed({
  scriptTag: 'seed-stuck-work-waiting-check-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    return {
      installSlug: SLUG,
      name: NAME,
      active,
      triggerConfig: JSON.stringify({ interval_sec: DEFAULT_INTERVAL_SEC }),
      targetRole: TARGET_ROLE,
      tier: 'ephemeral' as const,
      nextFire: 'null' as const,
      updateTriggerKind: true,
    };
  },
  afterSeed: async ({ active, workspaceId: ws }) => {
    console.log(
      `[seed-stuck-work-waiting-check-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
        `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s).` +
        (active ? ' Restart papercusp-bg-host to live-arm on a host that was already up.' : ' Inactive.'),
    );
  },
});
