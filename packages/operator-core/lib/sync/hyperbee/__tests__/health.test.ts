/**
 * assessHarnessSubstrateHealth tests.
 */

import { describe, expect, it } from 'vitest';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthInputs,
  type SubstrateHealthVerdictResult,
} from '../health';

describe('assessHarnessSubstrateHealth', () => {
  it('flag off → disabled', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: false,
      handlePresent: false,
    });
    expect(r.verdict).toBe('disabled');
    expect(r.reasons).toContain('flag off');
  });

  it('flag on, handle missing → booting', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: false,
    });
    expect(r.verdict).toBe('booting');
  });

  it('handle present, no stats → healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
    });
    expect(r.verdict).toBe('healthy');
    expect(r.reasons).toEqual(['no issues detected']);
  });

  it('low claim error rate (<5%) → healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 96, lost: 3, error: 1 },
    });
    expect(r.verdict).toBe('healthy');
  });

  it('claim error rate 5-25% → degraded', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 80, lost: 10, error: 10 },
    });
    expect(r.verdict).toBe('degraded');
    expect(r.reasons[0]).toContain('claim error rate');
  });

  it('claim error rate ≥25% → unhealthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 50, lost: 20, error: 30 },
    });
    expect(r.verdict).toBe('unhealthy');
  });

  it('bootstrap stalled past threshold → unhealthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 0,
        caughtUp: false,
      },
      nowMs: 600_000, // 10 minutes
      staleThresholdMs: 300_000, // 5 minutes
    });
    expect(r.verdict).toBe('unhealthy');
    expect(r.reasons.some((m) => m.includes('stalled'))).toBe(true);
  });

  it('bootstrap caught up doesnt trigger stall path', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 10,
        highestSeen: 10,
        lastChangeMs: 0,
        caughtUp: true,
      },
      nowMs: 10_000_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('healthy');
  });

  it('bootstrap recent activity not stalled', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 9_000_000,
        caughtUp: false,
      },
      nowMs: 9_010_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('healthy');
  });

  it('claim error rate beats bootstrap stall (worst wins)', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 60, lost: 5, error: 35 },
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 9_000_000,
        caughtUp: false,
      },
      nowMs: 9_100_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('unhealthy');
  });

  it('respects custom degraded threshold', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 99, lost: 0, error: 1 },
      degradedErrorRate: 0.01,
      unhealthyErrorRate: 0.5,
    });
    expect(r.verdict).toBe('degraded');
  });

  it('claim stats with total=0 stays healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 0, won: 0, lost: 0, error: 0 },
    });
    expect(r.verdict).toBe('healthy');
  });

  // EI-1618 — substrate-outbox drain stall (the silent-stall / EI-681 class).
  it('fresh undrained rows (age < threshold) stay healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      drainStats: { undrainedCount: 3, oldestUndrainedAgeMs: 5_000 }, // 5s
    });
    expect(r.verdict).toBe('healthy');
  });

  it('undrainedCount=0 stays healthy (no false positive)', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      drainStats: { undrainedCount: 0, oldestUndrainedAgeMs: null },
    });
    expect(r.verdict).toBe('healthy');
  });

  it('outbox lagging (oldest undrained >= 60s, < 5m) -> degraded', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      drainStats: { undrainedCount: 3, oldestUndrainedAgeMs: 90_000 }, // 90s
    });
    expect(r.verdict).toBe('degraded');
    expect(r.reasons.join(' ')).toMatch(/outbox lagging/);
  });

  it('outbox STALLED (oldest undrained >= 5m) -> unhealthy (the EI-681 silent stall)', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      drainStats: { undrainedCount: 12, oldestUndrainedAgeMs: 600_000 }, // 10m
    });
    expect(r.verdict).toBe('unhealthy');
    expect(r.reasons.join(' ')).toMatch(/STALLED.*not federating/);
  });

  it('worst-wins: an unhealthy claim rate is NOT upgraded by a merely-lagging drain', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 40, lost: 0, error: 60 }, // 60% -> unhealthy
      drainStats: { undrainedCount: 2, oldestUndrainedAgeMs: 90_000 }, // lagging (degraded-tier)
    });
    expect(r.verdict).toBe('unhealthy');
  });

  it('respects custom drain thresholds', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      drainStats: { undrainedCount: 1, oldestUndrainedAgeMs: 2_000 }, // 2s
      drainStalledThresholdMs: 1_000, // 1s -> already lagging
    });
    expect(r.verdict).toBe('degraded');
  });

  // WI-899 (A): sidecarLive:false is a confirmed-dead-sidecar signal — the
  // strongest override, forcing 'unhealthy' regardless of every other input
  // (the boot-time handle proxy still reads "present" even after the sidecar
  // that actually owns replication has died).
  describe('sidecarLive (WI-899 A)', () => {
    it('sidecarLive:false forces unhealthy even with an otherwise-healthy handle', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        sidecarLive: false,
      });
      expect(r.verdict).toBe('unhealthy');
      expect(r.reasons.join(' ')).toMatch(/sidecar is DOWN/);
    });

    it('sidecarLive:false overrides a healthy claim rate (worst-wins)', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        claimStats: { total: 100, won: 100, lost: 0, error: 0 },
        sidecarLive: false,
      });
      expect(r.verdict).toBe('unhealthy');
    });

    it('sidecarLive:true is a no-op (does not itself force healthy or override other verdicts)', () => {
      const healthy = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        sidecarLive: true,
      });
      expect(healthy.verdict).toBe('healthy');

      const stillUnhealthy = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        claimStats: { total: 100, won: 0, lost: 0, error: 100 },
        sidecarLive: true,
      });
      expect(stillUnhealthy.verdict).toBe('unhealthy');
    });

    it('sidecarLive:null/undefined is a no-op (sidecar mode off / not measured)', () => {
      const withNull = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        sidecarLive: null,
      });
      expect(withNull.verdict).toBe('healthy');

      const withUndefined = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
      });
      expect(withUndefined.verdict).toBe('healthy');
    });
  });

  // WI-3604: split-DHT-universe outage class must read as its OWN distinct
  // 'unhealthy' reason — never lumped into the noReplicator/frozen
  // "connected-but-dead WI-183 class" wording.
  describe('replicationLiveness.dhtUniverseMismatch (WI-3604)', () => {
    it('dhtUniverseMismatch > 0 → unhealthy with a distinct reason', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        replicationLiveness: { noReplicator: 0, frozen: 0, dhtUniverseMismatch: 2 },
      });
      expect(r.verdict).toBe('unhealthy');
      expect(r.reasons.join(' ')).toMatch(/DHT-universe mismatch/);
      expect(r.reasons.join(' ')).not.toMatch(/WI-183 class/);
    });

    it('does not double-fire alongside noReplicator/frozen (structurally exclusive in practice)', () => {
      // In practice deriveVerdict routes a mismatched harness's logs away from
      // no_replicator/frozen entirely, so these counts are never simultaneously
      // positive for the SAME harness — but the health-verdict function itself
      // must not crash or produce a garbled reason if it ever were.
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        replicationLiveness: { noReplicator: 0, frozen: 0, dhtUniverseMismatch: 0 },
      });
      expect(r.verdict).toBe('healthy');
    });

    it('omitted dhtUniverseMismatch is a no-op (never fabricates a verdict)', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        replicationLiveness: { noReplicator: 0, frozen: 0 },
      });
      expect(r.verdict).toBe('healthy');
    });
  });

  // WI-5777: a stale/failing EI-8892 DHT-bootstrap probe degrades a harness
  // whose 'never_connected' peers (WI-183, never-alarms-on-its-own) might
  // actually be a silently-wedged substrate rather than genuinely offline.
  describe('dhtBootstrapProbeStaleMs (WI-5777)', () => {
    it('stale past the default 20m threshold → degraded, with a correlational (not certain) reason', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        dhtBootstrapProbeStaleMs: 25 * 60 * 1_000,
      });
      expect(r.verdict).toBe('degraded');
      expect(r.reasons.join(' ')).toMatch(/isolated-DHT bootstrap liveness probe stale/);
      expect(r.reasons.join(' ')).toMatch(/never_connected.*unverified/);
    });

    it('under threshold → no-op (healthy)', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        dhtBootstrapProbeStaleMs: 5 * 60 * 1_000,
      });
      expect(r.verdict).toBe('healthy');
    });

    it('null/omitted → no-op, never fabricates a verdict (process not on the isolated DHT)', () => {
      const r1 = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        dhtBootstrapProbeStaleMs: null,
      });
      expect(r1.verdict).toBe('healthy');
      const r2 = assessHarnessSubstrateHealth({ flagEnabled: true, handlePresent: true });
      expect(r2.verdict).toBe('healthy');
    });

    it('never escalates past degraded on its own (correlational, not certain) — worst-wins does not downgrade an existing unhealthy', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        replicationLiveness: { noReplicator: 1, frozen: 0 },
        dhtBootstrapProbeStaleMs: 60 * 60 * 1_000,
      });
      expect(r.verdict).toBe('unhealthy'); // from noReplicator, not downgraded by the DHT-probe check
      expect(r.reasons.join(' ')).toMatch(/replication stalled/);
      expect(r.reasons.join(' ')).toMatch(/isolated-DHT bootstrap liveness probe stale/);
    });

    it('a custom threshold is honored', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        dhtBootstrapProbeStaleMs: 4 * 60 * 1_000,
        dhtBootstrapProbeStaleThresholdMs: 3 * 60 * 1_000,
      });
      expect(r.verdict).toBe('degraded');
    });
  });

  // EI-20575137548097507 — the fifth instance of this diagnostic rendering
  // ABSENCE OF INFORMATION as reassurance. A process that cannot observe a
  // harness's process-local health inputs passes them all as `undefined`, which
  // every check above correctly skips as "not measured" — and the verdict then
  // fell through to a confident `healthy` / "no issues detected".
  describe('unobservable health inputs must never read as healthy', () => {
    it('healthInputsObservable:false ⇒ degraded, and says it is absence of measurement', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        healthInputsObservable: false,
      });
      expect(r.verdict).toBe('degraded');
      expect(r.reasons.join(' ')).toMatch(/UNOBSERVABLE from this process/);
      // The distinction the whole defect turns on must be stated, not implied.
      expect(r.reasons.join(' ')).toMatch(/ABSENCE of measurement, not evidence of health/);
      expect(r.reasons).not.toContain('no issues detected');
    });

    it('omitted (the default) is unchanged — an ordinary owner read still reads healthy', () => {
      const r = assessHarnessSubstrateHealth({ flagEnabled: true, handlePresent: true });
      expect(r.verdict).toBe('healthy');
      expect(r.reasons).toEqual(['no issues detected']);
    });

    it('explicit true is unchanged (measured, nothing to report)', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        healthInputsObservable: true,
      });
      expect(r.verdict).toBe('healthy');
    });

    // Worst-wins: unobservable is not proof of a fault, so it must never
    // DOWNGRADE a genuine unhealthy verdict into a milder-looking 'degraded'.
    it('does not downgrade a genuine unhealthy verdict', () => {
      const r = assessHarnessSubstrateHealth({
        flagEnabled: true,
        handlePresent: true,
        healthInputsObservable: false,
        sidecarLive: false,
      });
      expect(r.verdict).toBe('unhealthy');
      expect(r.reasons.join(' ')).toMatch(/UNOBSERVABLE from this process/);
    });

    // ---- FALSIFIABILITY CONTROL (EI-20575137548097507) --------------------
    //
    // A guard that has never failed is a guard nobody has tested. The usual way
    // to prove one CAN fail — mutate the real file, run, restore — is unsafe in
    // this shared checkout: git-sync sweeps the whole tree on a timer and can
    // COMMIT the mutant during the run, and no trap can close that race. So the
    // control is kept here permanently instead (repo-conventions, tier 1: "a
    // MODULE / logic you import"). It re-proves the property discriminates on
    // every single run, rather than once in a probe nobody can see afterwards.
    //
    // `preFixAssess` is the assessor as it behaved BEFORE this fix: it is a
    // faithful stand-in for the live defect, because the defect was never a
    // wrong branch — it was the ABSENCE of any branch for unobservable inputs,
    // so every check simply skipped and the verdict fell through to healthy.
    const preFixAssess = (
      inputs: SubstrateHealthInputs,
    ): SubstrateHealthVerdictResult => {
      const { healthInputsObservable: _ignored, ...rest } = inputs;
      return assessHarnessSubstrateHealth(rest);
    };

    /** The invariant this item exists to enforce, as a reusable predicate. */
    const violatesUnobservableInvariant = (
      assess: (i: SubstrateHealthInputs) => SubstrateHealthVerdictResult,
    ): boolean => {
      const r = assess({
        flagEnabled: true,
        handlePresent: true,
        healthInputsObservable: false,
      });
      return r.verdict === 'healthy' || r.reasons.includes('no issues detected');
    };

    it('the REAL assessor satisfies the invariant', () => {
      expect(violatesUnobservableInvariant(assessHarnessSubstrateHealth)).toBe(false);
    });

    // If this ever goes green, the guard above has stopped being able to fail
    // and is no longer protecting anything — the property, not the assertion,
    // is what must keep working.
    it('the pre-fix assessor VIOLATES it — so the invariant really discriminates', () => {
      expect(violatesUnobservableInvariant(preFixAssess)).toBe(true);
    });
  });
});
