/**
 * watchdog-robustness-2026-06-09 LIVE plumbing smoke. Exercises the NEW SQL paths
 * against the dev DB WITHOUT writing real backlog items:
 *   - withWatchdogTickLock (real pg_try_advisory_lock on a reserved connection)
 *   - recordWatchdogTick (the real INSERT with array + jsonb casts)
 *   - readRecentWatchdogTicks (the real SELECT the self-escalation reads)
 * Uses a synthetic failing collector + an INJECTED capture (no real improvements).
 *   DATABASE_URL=... npx tsx .papercusp/scratch/watchdog-robustness-smoke.ts
 */
import {
  runWatchdogTick,
  withWatchdogTickLock,
  readRecentWatchdogTicks,
} from '../../packages/operator-core/lib/harness/improvements/watchdog';
import { getOrgPg } from '@papercusp/db-org';

async function main(): Promise<void> {
  const ws = 'watchdog-robustness-smoke';
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.watchdog_ticks WHERE workspace_id = ${ws}`; // clean slate

  // 1) real advisory lock: a body runs under the held lock
  const lockOut = await withWatchdogTickLock(ws, async () => 'ran-under-lock');
  console.log('1) lock outcome:', JSON.stringify(lockOut));

  // 2) full tick: REAL lock + REAL recordTick + REAL readRecentTicks; synthetic
  //    failing collector + injected capture (failStreak 1 → self-escalates once).
  let captured = 0;
  const res = await runWatchdogTick(
    ws,
    { failStreakToEscalate: 1, maxPerTick: 3, installSlug: 'smoke' },
    {
      collectors: [
        { name: 'smoke-bad', collect: async () => { throw new Error('synthetic collector failure'); } },
      ],
      capture: async () => {
        captured += 1;
        return { ok: true, created: true, issue: { id: 'EI-SMOKE' } as never, possibleDuplicates: [] } as never;
      },
    },
  );
  console.log('2) tick result:', JSON.stringify(res));
  console.log('   injected captures:', captured, '(expect 1 self-escalation for smoke-bad)');

  // 3) read the recorded tick back (the SELECT the self-escalation streak reads)
  const recent = await readRecentWatchdogTicks(ws, 5);
  console.log('3) recent ticks:', JSON.stringify(recent, null, 1));

  // 4) confirm the row landed with the jsonb collectors + self_escalations
  const rows = await sql`SELECT status, signals, captured, collectors, self_escalations FROM harness_shared.watchdog_ticks WHERE workspace_id = ${ws} ORDER BY tick_at DESC`;
  console.log('4) raw rows:', JSON.stringify(rows, null, 1));

  await sql`DELETE FROM harness_shared.watchdog_ticks WHERE workspace_id = ${ws}`; // cleanup
  console.log('5) cleaned up smoke rows. OK');
}

main().then(() => process.exit(0), (e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
