/**
 * host-code-staleness-from-ledger — which operator hosts are serving live calls with
 * stale code, judged from the LEDGER rather than from inside each host (WI-1565914).
 *
 * ── Why this exists beside stale-routine-executor-watchdog, not inside it ────────────
 * That watchdog is an IN-PROCESS SELF-CHECK. One line into its sweep:
 *
 *     if (!routinesEnabledHere()) return { outcome: 'skipped', reason: '…not enabled…' };
 *
 * so a process only ever judges ITSELF, and only if it carries PAPERCUSP_DBOS_ROUTINES=1.
 * Measured 2026-08-31: every one of the six :3070 listeners has that variable UNSET, so
 * the host actually serving agent MCP calls has never once evaluated its own staleness.
 * Meanwhile :3271 reported "RECOVERED — running current code again" 106 times across the
 * exact window in which ≥17.5-day-stale hosts were serving live calls. Both statements
 * were true; together they read as an all-clear over a population of one.
 *
 * Two properties make the self-check structurally unable to close this, no matter how its
 * identity is computed:
 *   1. It cannot cover a process that does not run it.
 *   2. A process stale enough to matter may PREDATE the check's own code, so it cannot
 *      contain the instrument that would report it — the detector is weakest exactly
 *      where it is needed most.
 *
 * Judging from the ledger inverts both: `harness_shared.tool_invocations` now carries the
 * serving host's identity and loaded sha (migration 1043), so a host is measured by the
 * calls it ACTUALLY SERVED, needing no cooperation from it — and a host too old to report
 * is not silently absent, it is a counted silent host (see below).
 *
 * ── The rule this module exists to enforce ──────────────────────────────────────────
 * Every verdict carries its POPULATION, and a "nothing is stale" answer is UNUTTERABLE
 * from an empty one. This is not defensive garnish: it is the failure being fixed,
 * reappearing one level up. Until each host restarts onto migration-1043 code its
 * `serving_build_sha` is NULL, so a naive scan finds no stale sha and returns a
 * confident all-clear that actually means NOBODY IS REPORTING YET — the same shape as
 * the "RECOVERED" pages that masked the original bug.
 *
 * So `conclusive:false` is a real, expected verdict, not an error, and a caller may not
 * read it as health. Hosts seen WITHOUT a sha are counted as `hostsSilent` and named, so
 * the unmeasured remainder is always visible next to whatever was measured.
 *
 * Pure decider + a thin collector, mirroring evaluateExecutorStaleness/…Sweep next door.
 */

import { claimWatchdogFire, recentWatchdogFires, scopedFireReason } from '../../pot/watchdog';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { resolveCurrentHeadCommit } from '../../dbos/process-boot-identity';

/** One host's footprint in the ledger window. */
export interface LedgerHostObservation {
  servingHost: string;
  servingProcessId: string | null;
  /** The code that host loaded. NULL = it has not reported one (pre-1043, or unprovable). */
  servingBuildSha: string | null;
  calls: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** What the verdict was computed OVER. Reported unconditionally. */
export interface HostPopulation {
  /** Distinct serving_host values in the window. */
  hostsSeen: number;
  /** Those reporting a build sha — the only ones staleness could be judged for. */
  hostsReporting: number;
  /** Seen but reporting no sha: present, serving calls, and UNMEASURABLE. */
  hostsSilent: number;
  /** Names of the silent hosts, so the gap is addressable and not just a count. */
  silentHosts: string[];
  /** Calls whose serving host is not recorded at all (rows predating migration 1043). */
  callsUnattributed: number;
  callsAttributed: number;
}

export interface StaleHost {
  servingHost: string;
  servingProcessId: string | null;
  buildSha: string;
  /** ABSOLUTE age of the loaded code — now minus that commit's time. The measure the
   *  self-check could not produce: it reported hours-since-boot, which tops out at a few
   *  hours and can never surface an 18-day-old binary. */
  codeAgeMs: number | null;
  calls: number;
  lastSeenMs: number;
}

export interface LedgerStalenessVerdict {
  /**
   * Whether a stale/not-stale answer is even utterable. FALSE means the instrument
   * measured nothing — never that everything is healthy.
   */
  conclusive: boolean;
  reason: string;
  population: HostPopulation;
  /** Always empty when `conclusive` is false. */
  stale: StaleHost[];
}

export interface EvaluateLedgerStalenessInput {
  observations: LedgerHostObservation[];
  /** Current tree HEAD. Null ⇒ nothing to compare against; the verdict is inconclusive. */
  headSha: string | null;
  /** Commit time of a build sha, for ABSOLUTE age. Null when unresolvable. */
  commitTimeMs: (sha: string) => number | null;
  now: number;
  /** How old the LOADED CODE may be before a host is called stale. */
  maxCodeAgeMs: number;
  /** Rows in the window carrying no serving_host at all. */
  callsUnattributed?: number;
}

/** Two shas match if either is a prefix of the other (short vs full sha). */
function shaMatches(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

function buildPopulation(input: EvaluateLedgerStalenessInput): HostPopulation {
  const byHost = new Map<string, LedgerHostObservation[]>();
  for (const o of input.observations) {
    const list = byHost.get(o.servingHost);
    if (list) list.push(o);
    else byHost.set(o.servingHost, [o]);
  }
  const silentHosts: string[] = [];
  let hostsReporting = 0;
  for (const [host, rows] of byHost) {
    if (rows.some((r) => !!r.servingBuildSha)) hostsReporting++;
    else silentHosts.push(host);
  }
  return {
    hostsSeen: byHost.size,
    hostsReporting,
    hostsSilent: silentHosts.length,
    silentHosts: silentHosts.sort(),
    callsUnattributed: input.callsUnattributed ?? 0,
    callsAttributed: input.observations.reduce((n, o) => n + o.calls, 0),
  };
}

/** How the unmeasured remainder is appended to every conclusive reason — the sentence
 *  that keeps a partial measurement from reading as a total one. */
function remainderSuffix(pop: HostPopulation): string {
  const parts: string[] = [];
  if (pop.hostsSilent > 0) {
    parts.push(
      `${pop.hostsSilent} host(s) served calls WITHOUT reporting a build sha and could not be judged ` +
        `(${pop.silentHosts.join(', ')})`,
    );
  }
  if (pop.callsUnattributed > 0) {
    parts.push(`${pop.callsUnattributed} call(s) in the window carry no serving host at all`);
  }
  return parts.length ? ` NOT MEASURED: ${parts.join('; ')}.` : '';
}

/**
 * Pure decider. Never returns "nothing is stale" without a non-empty reporting
 * population, and never states a measured result without naming what it could not see.
 */
export function evaluateLedgerHostStaleness(input: EvaluateLedgerStalenessInput): LedgerStalenessVerdict {
  const population = buildPopulation(input);

  if (population.hostsSeen === 0) {
    return {
      conclusive: false,
      reason:
        'MEASURED NOTHING: no host reported serving any call in this window. That is a statement about ' +
        'the instrument, not about host health — do not read it as an all-clear.',
      population,
      stale: [],
    };
  }

  if (!input.headSha) {
    return {
      conclusive: false,
      reason:
        `MEASURED NOTHING: tree HEAD could not be resolved, so no loaded sha could be compared against it ` +
        `(${population.hostsReporting} of ${population.hostsSeen} host(s) were reporting a sha).`,
      population,
      stale: [],
    };
  }

  if (population.hostsReporting === 0) {
    return {
      conclusive: false,
      reason:
        `MEASURED NOTHING: ${population.hostsSeen} host(s) served calls but NONE reported a build sha, so ` +
        `staleness is unjudgeable for every one of them (${population.silentHosts.join(', ')}). Expected while ` +
        `hosts have not yet restarted onto migration-1043 code — a zero here means nobody is reporting, ` +
        `NOT that nothing is stale.`,
      population,
      stale: [],
    };
  }

  // Judge only the reporting subset, newest observation per host+sha.
  const stale: StaleHost[] = [];
  for (const o of input.observations) {
    const sha = o.servingBuildSha;
    if (!sha) continue;
    if (shaMatches(sha, input.headSha)) continue;
    const committedAt = input.commitTimeMs(sha);
    const codeAgeMs = committedAt === null ? null : Math.max(0, input.now - committedAt);
    // An unresolvable commit time must not silently pass as fresh: a sha that differs
    // from HEAD and whose age cannot be established is still reported, with a null age.
    if (codeAgeMs !== null && codeAgeMs < input.maxCodeAgeMs) continue;
    stale.push({
      servingHost: o.servingHost,
      servingProcessId: o.servingProcessId,
      buildSha: sha,
      codeAgeMs,
      calls: o.calls,
      lastSeenMs: o.lastSeenMs,
    });
  }
  stale.sort((a, b) => (b.codeAgeMs ?? Number.MAX_SAFE_INTEGER) - (a.codeAgeMs ?? Number.MAX_SAFE_INTEGER));

  const scope = `${population.hostsReporting} of ${population.hostsSeen} host(s) reporting a build sha`;
  if (stale.length === 0) {
    return {
      conclusive: true,
      reason: `No stale host among ${scope}.${remainderSuffix(population)}`,
      population,
      stale,
    };
  }

  const worst = stale[0]!;
  const age =
    worst.codeAgeMs === null ? 'an unresolvable age' : `${(worst.codeAgeMs / 86_400_000).toFixed(1)} days old`;
  return {
    conclusive: true,
    reason:
      `${stale.length} of ${scope} are serving live calls with stale code. Worst: ${worst.servingHost} ` +
      `running ${worst.buildSha.slice(0, 10)}, code ${age}, ${worst.calls} call(s) in window. ` +
      `Restart that host to pick up current code.${remainderSuffix(population)}`,
    population,
    stale,
  };
}
