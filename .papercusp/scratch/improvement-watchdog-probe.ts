/**
 * READ-ONLY probe of the watchdog signal collectors against the live DB
 * (close-the-self-improvement-loop-2026-06-05 P3 prep). Shows what the watchdog
 * WOULD capture this tick — captures nothing.
 *   DATABASE_URL=... npx tsx .papercusp/scratch/improvement-watchdog-probe.ts
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  collectRedTestSignals,
  collectSmokeFailSignals,
  collectToolErrorSignals,
  planWatchdogCaptures,
} from '../../packages/operator-core/lib/harness/improvements/watchdog';

async function main(): Promise<void> {
  const { sql } = getOrgPg();
  const ws = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
  const [red, smoke, toolErr] = await Promise.all([
    collectRedTestSignals(sql),
    collectSmokeFailSignals(sql, ws),
    collectToolErrorSignals(sql),
  ]);
  const all = [...red, ...smoke, ...toolErr];
  const plan = planWatchdogCaptures(all);
  console.log(JSON.stringify({
    counts: { redTest: red.length, smokeFail: smoke.length, repeatedToolError: toolErr.length },
    signals: all.map((s) => ({ source: s.source, key: s.key, sev: s.severity, title: s.title.slice(0, 80) })),
    wouldCaptureThisTick: plan.toCapture.map((s) => `${s.source}:${s.key}`),
    deferredByCap: plan.deferred.length,
  }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
