/**
 * tick-load-shed.ts — the shared load-shed policy for background ticks.
 *
 * Extracted from periodic-workflows.ts (EI-1622) so the SAME shed rule is used
 * by both the remaining DBOS periodic workflows AND the lightweight in-process
 * periodic checks (in-process-periodic.ts). A heavy background tick sheds a
 * cycle under EITHER acute event-loop pressure (P5-1 — recover the serving
 * loop) OR chronic power-save (P5-3 — battery life).
 *
 * operator-scalability-event-loop-2026-06-16 P5-1/P5-3.
 */
import { isLoopSaturated } from '../event-loop-lag-monitor';
import { getResourceProfile } from '../resource-profile';

// P5-1: Layer-2 load-shedding. When the request event loop is CRITICALLY
// saturated, skip this cycle of a HEAVY background tick so the serving loop
// recovers — instead of piling background CPU onto an already-wedged loop (the
// exact failure that crash-looped :3070). Safe to skip: each heavy tick has an
// on-demand / next-cycle correctness floor. Light ticks (single-query sweeps,
// the connection-pressure + service-health probes) are NOT shed — they're cheap
// and we want their signal precisely under load.
export function shedUnderLoopPressure(tickName: string): boolean {
  if (isLoopSaturated()) {
    console.warn(`[loop-shed] skipped ${tickName} — event loop critically saturated (P5-1)`);
    return true;
  }
  return false;
}

// P5-3: power-aware cadence throttle. On battery the resource profile widens the
// background cadence (backgroundCadenceMultiplier > 1). We approximate the wider
// cadence by SKIPPING (mult-1)/mult of a heavy tick's invocations — a 1-min tick
// at multiplier 3 effectively fires ~every 3 min. Deterministic per-tick counter
// (no Math.random); AC ⇒ multiplier 1 ⇒ never skips.
const powerSaveCounters = new Map<string, number>();
export function shedUnderPowerSave(tickName: string): boolean {
  const mult = getResourceProfile().backgroundCadenceMultiplier;
  if (mult <= 1) return false;
  const n = (powerSaveCounters.get(tickName) ?? 0) + 1;
  powerSaveCounters.set(tickName, n);
  if (n % mult !== 0) {
    console.warn(`[power-save] skipped ${tickName} — on battery (cadence x${mult}, P5-3)`);
    return true;
  }
  return false;
}

// A heavy background tick sheds this cycle under EITHER acute loop pressure (P5-1)
// OR chronic power-save (P5-3).
export function shouldShedHeavyTick(tickName: string): boolean {
  return shedUnderLoopPressure(tickName) || shedUnderPowerSave(tickName);
}
