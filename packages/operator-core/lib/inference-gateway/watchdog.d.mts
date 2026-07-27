#!/usr/bin/env node
/** Distinguish an INTERNAL wedge (a true deadlock/leak a restart fixes) from an EXTERNAL stall a
 *  restart can NOT fix and would only worsen by dropping every in-flight bee/queen spawn (EI-2421).
 *  The frozen-while-saturated signature ALSO fires when the whole account pool is rate-limit exhausted
 *  (every account paused / circuit-open → nothing trickles → totalRequests genuinely frozen), or while
 *  the gateway's own in-process self-heal valve (gateway.ts SELFHEAL_FREEZE_MS, < this 120s freeze) is
 *  already reclaiming the wedge. In those cases a restart is pure harm. Returns a reason string when the
 *  stall is external/self-healing (→ SUPPRESS the restart), else null (→ a real wedge, restart). */
export function externalStallReason(s: any, selfHealAtFreezeStart: any): string | null;
/** Rank egress proxies that are chronically failing (EI-2537): an account whose volume-fair
 *  egressFailRateByAccount (= egressFailsByAccount / egressAttemptsByAccount, computed gateway-side) is
 *  >= rateThreshold over >= minAttempts attempts. The min-attempts floor filters small-sample noise (a 1/1
 *  blip reads 100% but is not a dead proxy). Returns the offenders worst-first. Pure (no I/O) so a unit
 *  test can drive it with synthetic /stats; the poll loop logs the result + debounces per account. The
 *  RATE is the source-of-truth signal because a raw fail count ranks the BUSIEST proxy worst, not the
 *  deadest (the 2026-06-22 audit: aviynw had the most raw fails only because it carried the most traffic;
 *  definitelyahuman was the true dead proxy at ~95% rate). */
export function deadProxyAlerts(stats: any, { minAttempts, rateThreshold }?: {
    minAttempts?: number | undefined;
    rateThreshold?: number | undefined;
}): {
    accountId: string;
    rate: number;
    attempts: number;
    fails: number;
}[];
