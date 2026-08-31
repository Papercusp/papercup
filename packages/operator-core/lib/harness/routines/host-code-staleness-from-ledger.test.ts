/**
 * WI-1565914 — the ledger-derived host staleness decider.
 *
 * The assertions that matter here are the ones about the EMPTY and PARTIAL populations.
 * A detector that returns "no stale hosts" from a population of zero is the exact bug
 * this module was written to end, and it is invisible in the happy-path tests: the
 * healthy verdict and the vacuous one are the same shape, the same `stale: []`, and
 * differ only in whether anything was measured. So they get controls of their own.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateLedgerHostStaleness,
  type LedgerHostObservation,
} from './host-code-staleness-from-ledger';

const NOW = Date.UTC(2026, 7, 31, 7, 0, 0);
const DAY = 86_400_000;
const MAX_AGE = 2 * DAY;

const obs = (over: Partial<LedgerHostObservation> = {}): LedgerHostObservation => ({
  servingHost: 'port-3070',
  servingProcessId: 'linux:boot-1:100',
  servingBuildSha: 'aaaaaaaaaa',
  calls: 10,
  firstSeenMs: NOW - 60_000,
  lastSeenMs: NOW,
  ...over,
});

const never = () => null;
const at = (map: Record<string, number>) => (sha: string) => map[sha] ?? null;

describe('the population rule — a zero is unutterable from an empty population', () => {
  it('an empty window is INCONCLUSIVE, not healthy', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.stale).toEqual([]);
    expect(v.reason).toContain('MEASURED NOTHING');
    // The distinguishing assertion: it must NOT read as an all-clear.
    expect(v.reason).not.toMatch(/no stale host/i);
  });

  /**
   * The bootstrap case, and the one that will actually occur: hosts are serving calls
   * but none has restarted onto migration-1043 code yet, so every serving_build_sha is
   * NULL. A naive scan finds no stale sha and reports health.
   */
  it('hosts present but NONE reporting a sha is INCONCLUSIVE, and names them', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3070', servingBuildSha: null }),
        obs({ servingHost: 'port-3271', servingBuildSha: null }),
      ],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.stale).toEqual([]);
    expect(v.population).toMatchObject({ hostsSeen: 2, hostsReporting: 0, hostsSilent: 2 });
    expect(v.population.silentHosts).toEqual(['port-3070', 'port-3271']);
    expect(v.reason).toContain('NONE reported a build sha');
    expect(v.reason).not.toMatch(/no stale host/i);
  });

  it('an unresolvable tree HEAD is INCONCLUSIVE rather than "nothing differs from HEAD"', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs()],
      headSha: null,
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.reason).toContain('MEASURED NOTHING');
  });

  /**
   * The partial case — a real measurement that must not be read as a total one. The
   * reporting subset is genuinely judgeable, so the verdict IS conclusive; what the
   * reason may never do is stay silent about the hosts it could not see.
   */
  it('a conclusive verdict still names the unmeasured remainder', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3170', servingBuildSha: 'headsha123' }),
        obs({ servingHost: 'port-3070', servingBuildSha: null }),
      ],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 844,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stale).toEqual([]);
    expect(v.reason).toContain('No stale host among 1 of 2 host(s)');
    expect(v.reason).toContain('NOT MEASURED');
    expect(v.reason).toContain('port-3070');
    expect(v.reason).toContain('844 call(s)');
  });

  /** Calibration: with a full population and nothing stale, there is no remainder note —
   *  otherwise the assertions above would pass even when the suffix is unconditional. */
  it('says nothing about a remainder when there is none', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'headsha123' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(true);
    expect(v.reason).not.toContain('NOT MEASURED');
  });
});

/**
 * Falsifiability control. The population assertions above would pass just as happily
 * against a decider that never checks a population at all, if the property they encode
 * were weaker than it looks — so this pins a deliberately-wrong implementation IN the
 * test file (never a mutation of the shared tree) and proves the property actually
 * separates the two.
 */
describe('the population rule is falsifiable', () => {
  /** The shape this module exists to forbid: scan for a stale sha, and call the absence
   *  of one "healthy" — with no notion of how many hosts were measurable. */
  function naiveDecider(observations: LedgerHostObservation[], headSha: string) {
    const stale = observations.filter((o) => o.servingBuildSha && o.servingBuildSha !== headSha);
    return { conclusive: true, reason: stale.length ? `${stale.length} stale` : 'no stale host', stale };
  }

  const emptyPopulation = [
    obs({ servingHost: 'port-3070', servingBuildSha: null }),
    obs({ servingHost: 'port-3271', servingBuildSha: null }),
  ];

  it('CONTROL: the naive decider reports health from a population it could not measure', () => {
    const bad = naiveDecider(emptyPopulation, 'headsha123');
    expect(bad.conclusive).toBe(true);
    expect(bad.reason).toMatch(/no stale host/i);
    expect(bad.stale).toEqual([]);
  });

  it('SUBJECT: the real decider refuses that same input', () => {
    const good = evaluateLedgerHostStaleness({
      observations: emptyPopulation,
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(good.conclusive).toBe(false);
    expect(good.reason).not.toMatch(/no stale host/i);
  });

  /** Calibration: on a genuinely stale population BOTH agree, so the split above is the
   *  population rule doing work — not the control being broken for unrelated reasons. */
  it('CALIBRATION: both flag a genuinely stale host', () => {
    const stalePopulation = [obs({ servingBuildSha: 'oldsha0000' })];
    expect(naiveDecider(stalePopulation, 'headsha123').stale).toHaveLength(1);
    expect(
      evaluateLedgerHostStaleness({
        observations: stalePopulation,
        headSha: 'headsha123',
        commitTimeMs: at({ oldsha0000: NOW - 18 * DAY }),
        now: NOW,
        maxCodeAgeMs: MAX_AGE,
      }).stale,
    ).toHaveLength(1);
  });
});

describe('staleness by ABSOLUTE code age', () => {
  it('flags a host whose loaded code is older than the threshold', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3070', servingBuildSha: 'oldsha0000', calls: 297 })],
      headSha: 'headsha123',
      commitTimeMs: at({ oldsha0000: NOW - 18 * DAY }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stale).toHaveLength(1);
    expect(v.stale[0]).toMatchObject({ servingHost: 'port-3070', buildSha: 'oldsha0000', calls: 297 });
    expect(v.stale[0]!.codeAgeMs).toBe(18 * DAY);
    // The magnitude the in-process check could never report: it measured hours since
    // boot, which tops out long before an 18-day-old binary becomes visible.
    expect(v.reason).toContain('18.0 days old');
  });

  it('does not flag a host running recent code that merely differs from HEAD', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'recentsha1' })],
      headSha: 'headsha123',
      commitTimeMs: at({ recentsha1: NOW - 60_000 }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toEqual([]);
  });

  it('treats a sha equal to HEAD as fresh without needing its commit time', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'headsha123' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toEqual([]);
  });

  it('matches a short sha against a full HEAD (and the reverse)', () => {
    for (const [loaded, head] of [
      ['f488ad47df', 'f488ad47df0011223344556677889900aabbccdd'],
      ['f488ad47df0011223344556677889900aabbccdd', 'f488ad47df'],
    ]) {
      const v = evaluateLedgerHostStaleness({
        observations: [obs({ servingBuildSha: loaded })],
        headSha: head,
        commitTimeMs: never,
        now: NOW,
        maxCodeAgeMs: MAX_AGE,
      });
      expect(v.stale, `${loaded} vs ${head}`).toEqual([]);
    }
  });

  /**
   * A differing sha whose age cannot be established must still be REPORTED. Dropping it
   * would let an unresolvable commit pass as fresh — an absence of evidence rendered as
   * evidence of health, which is this lane's whole failure mode.
   */
  it('reports a differing sha with an unresolvable commit time rather than passing it', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'ghostsha00' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toHaveLength(1);
    expect(v.stale[0]!.codeAgeMs).toBeNull();
    expect(v.reason).toContain('an unresolvable age');
  });

  it('ranks the oldest host first', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3170', servingBuildSha: 'mid0000000' }),
        obs({ servingHost: 'port-3070', servingBuildSha: 'ancient000' }),
      ],
      headSha: 'headsha123',
      commitTimeMs: at({ mid0000000: NOW - 5 * DAY, ancient000: NOW - 18 * DAY }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale.map((s) => s.servingHost)).toEqual(['port-3070', 'port-3170']);
  });
});
