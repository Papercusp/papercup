/**
 * LIVE watchdog tick (close-the-self-improvement-loop-2026-06-05 — D-003 e2e
 * verification). Runs the REAL runWatchdogTick against the live DB with the
 * per-tick cap at 1: captures the single top signal as a real kind=bug
 * improvement, then runs a SECOND tick to prove the open-duplicate decline
 * (the cross-tick dedup). Equivalent to two system:improvement-watchdog fires.
 *   DATABASE_URL=... npx tsx .papercusp/scratch/improvement-watchdog-live-tick.ts
 */
import { runWatchdogTick } from '../../packages/operator-core/lib/harness/improvements/watchdog';

async function main(): Promise<void> {
  const ws = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
  const first = await runWatchdogTick(ws, { maxPerTick: 1 });
  console.log('tick 1:', JSON.stringify(first));
  const second = await runWatchdogTick(ws, { maxPerTick: 1 });
  console.log('tick 2:', JSON.stringify(second));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
