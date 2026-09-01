import { describe, expect, it } from 'vitest';
import { deriveCapacityVerdict, type AdmissionTerms } from './capacity-verdict';
import type { ProviderPoolVerdict } from '../deployment/account-pool-store';

/**
 * capacity-verdict.test.ts — the canonical capacity verdict
 * (capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-004).
 *
 * The cases that matter here are the ones where a WRONG answer is indistinguishable from a
 * right one at the call site: a pacing projection rendered as a wall, an unmeasured leg
 * rendered as clear, and a measured wall rendered as "nothing is binding". Each has a named
 * test below, and the first of them is pinned to the real reading that produced it.
 */

const MEASURED_ADMISSION: AdmissionTerms = { reachable: true, blind: false, dispatchBudget: 6, inFlight: 0 };

/** A pool rollup with sane defaults; override only the fields a case is about. */
function pool(over: Partial<ProviderPoolVerdict> = {}): ProviderPoolVerdict {
  return {
    provider: 'claude',
    total: 7,
    serviceable: 7,
    walledFresh: 0,
    paused: 0,
    pacing: 0,
    unknown: 0,
    atCapacity: false,
    binding: 'none',
    reason: 'test fixture',
    ...over,
  };
}

describe('deriveCapacityVerdict', () => {
  /**
   * ⚠ THE REGRESSION THIS FUNCTION SHIPPED WITH, CAUGHT BY THE LIVE EXERCISE.
   *
   * These exact numbers are the real `claude` pool read through `fleet:capacity` on the
   * staging operator at 2026-09-01T05:07Z. The first implementation gated the wall branch on
   * `pool.atCapacity && binding === 'usage-wall'`; `atCapacity` was false (correctly — one
   * stale reading could still serve), so it fell through every branch and answered
   * `binding: 'none'` — "no term is measurably binding" — with SIX of seven accounts
   * measurably usage-walled.
   *
   * A fixture would not have caught it: you have to see a pool that is walled AND partially
   * stale at the same time, which is the ordinary state of a live pool and an unusual thing
   * to think to write down.
   */
  it('names the wall when the pool measured one, even though a stale reading keeps atCapacity false', () => {
    const v = deriveCapacityVerdict({
      provider: 'claude',
      pool: pool({ serviceable: 0, walledFresh: 6, paused: 0, pacing: 1, unknown: 1, atCapacity: false, binding: 'usage-wall' }),
      admission: MEASURED_ADMISSION,
    });

    // The REMEDY is reported even though the confidence is partial.
    expect(v.binding).toBe('usage-wall');
    // ...and the confidence is still honest: one row could serve, so this is not a measured wall.
    expect(v.atCapacity).toBe(false);
    expect(v.reason).toMatch(/PROBABLY walled but NOT measurably at capacity/);
    expect(v.reason).toMatch(/accounts:probe-capacity/);
    // The specific false-green the live read produced must never come back.
    expect(v.reason).not.toMatch(/no term is measurably binding/);
  });

  it('reports a measured wall as at-capacity with the wait-it-out remedy', () => {
    const v = deriveCapacityVerdict({
      provider: 'claude',
      pool: pool({ serviceable: 0, walledFresh: 7, unknown: 0, atCapacity: true, binding: 'usage-wall' }),
      admission: MEASURED_ADMISSION,
    });
    expect(v.binding).toBe('usage-wall');
    expect(v.atCapacity).toBe(true);
    expect(v.unknown).toEqual([]);
    expect(v.reason).toMatch(/MEASURABLY at capacity/);
    // A provider wall cannot be relieved locally; the reason must say so.
    expect(v.reason).toMatch(/Do NOT raise admission or change pacing/);
  });

  /** Rule 1 of the module contract: a pacing projection is NEVER a wall. */
  it('reports a pacing projection as policy, never as a provider wall', () => {
    const v = deriveCapacityVerdict({
      provider: 'claude',
      pool: pool({ serviceable: 0, walledFresh: 0, paused: 0, pacing: 4, unknown: 0, atCapacity: true, binding: 'pacing-policy' }),
      admission: MEASURED_ADMISSION,
    });
    expect(v.binding).toBe('pacing-policy');
    expect(v.reason).toMatch(/not a provider wall/);
    // The actionable half: there is no reset coming, so waiting is the wrong move.
    expect(v.reason).toMatch(/No provider reset is coming/);
    expect(v.reason).not.toMatch(/usage window resets/);
  });

  it('names our own admission clamp when the door is at zero and the pool is not walled', () => {
    const v = deriveCapacityVerdict({
      provider: 'claude',
      pool: pool({ serviceable: 5, binding: 'none' }),
      admission: { reachable: true, blind: false, dispatchBudget: 0, inFlight: 12 },
    });
    expect(v.binding).toBe('admission-concurrency');
    expect(v.atCapacity).toBe(true);
    expect(v.reason).toMatch(/OUR OWN admission clamp, not the provider/);
    expect(v.reason).toMatch(/Do NOT wait for a provider reset/);
  });

  /** A wall outranks the door: raising a self-imposed clamp cannot relieve a walled pool. */
  it('prefers the provider wall over the admission clamp when both are present', () => {
    const v = deriveCapacityVerdict({
      provider: 'claude',
      pool: pool({ serviceable: 0, walledFresh: 7, unknown: 0, atCapacity: true, binding: 'usage-wall' }),
      admission: { reachable: true, blind: false, dispatchBudget: 0, inFlight: 0 },
    });
    expect(v.binding).toBe('usage-wall');
  });

  /** Rule 2: unmeasured is never at capacity, and never silently clear either. */
  describe('unmeasured legs', () => {
    it('treats an unreachable gateway as unmeasured admission, not an open door', () => {
      const v = deriveCapacityVerdict({
        provider: 'claude',
        pool: pool(),
        admission: { reachable: false, blind: false, dispatchBudget: null, inFlight: null },
      });
      expect(v.atCapacity).toBe(false);
      expect(v.unknown.join(' ')).toMatch(/gateway did not answer/);
      expect(v.unknown.join(' ')).toMatch(/UNMEASURED — not open/);
      // The headline is false, so the reason must refuse to read as a green.
      expect(v.reason).toMatch(/NOT a measured green/);
    });

    it('treats a blind gateway reading as unmeasured admission', () => {
      const v = deriveCapacityVerdict({
        provider: 'claude',
        pool: pool(),
        admission: { reachable: true, blind: true, dispatchBudget: 6, inFlight: 0 },
      });
      expect(v.unknown.join(' ')).toMatch(/blind\/stale/);
      expect(v.reason).toMatch(/NOT a measured green/);
    });

    it('never derives a verdict from a null pool, and says the pool was unmeasured', () => {
      const v = deriveCapacityVerdict({ provider: 'claude', pool: null, admission: MEASURED_ADMISSION });
      expect(v.atCapacity).toBe(false);
      expect(v.binding).toBe('none');
      expect(v.unknown.join(' ')).toMatch(/UNMEASURED — not clear/);
      expect(v.evidence.some((e) => e.signal === 'pool.rows' && e.value === null)).toBe(true);
    });

    it('a fully measured all-clear says so WITHOUT the unmeasured caveat', () => {
      const v = deriveCapacityVerdict({ provider: 'claude', pool: pool(), admission: MEASURED_ADMISSION });
      expect(v.binding).toBe('none');
      expect(v.atCapacity).toBe(false);
      expect(v.unknown).toEqual([]);
      expect(v.reason).toMatch(/measured green/);
      expect(v.reason).not.toMatch(/NOT a measured green/);
    });
  });

  /** P-004's "evidence (writer-stamped)" — the field is worthless without the writer. */
  describe('evidence', () => {
    it('stamps every evidence entry with the code that wrote it', () => {
      const v = deriveCapacityVerdict({ provider: 'claude', pool: pool(), admission: MEASURED_ADMISSION });
      expect(v.evidence.length).toBeGreaterThan(0);
      for (const e of v.evidence) {
        expect(e.writer, `evidence "${e.signal}" has no writer`).toBeTruthy();
        expect(e.writer).toMatch(/@ lib\//);
        expect(e.means, `evidence "${e.signal}" has no meaning`).toBeTruthy();
      }
    });

    it('carries both legs so a reader can see which one is missing', () => {
      const v = deriveCapacityVerdict({ provider: 'claude', pool: pool(), admission: MEASURED_ADMISSION });
      const signals = v.evidence.map((e) => e.signal);
      expect(signals).toContain('pool.serviceable');
      expect(signals).toContain('admission.dispatchBudget');
    });

    it('reports an unmeasured admission value as null rather than a stale number', () => {
      const v = deriveCapacityVerdict({
        provider: 'claude',
        pool: pool(),
        // A blind reading still carries a dispatchBudget number — it must NOT be published as measured.
        admission: { reachable: true, blind: true, dispatchBudget: 6, inFlight: 0 },
      });
      const budget = v.evidence.find((e) => e.signal === 'admission.dispatchBudget');
      expect(budget?.value).toBeNull();
      expect(budget?.means).toMatch(/not measured/);
    });
  });

  /**
   * `host` is in the shared CapacityBinding vocabulary but this resolver cannot observe the
   * box, so it must never be emitted. The cell's assessment declares only the four codes
   * below; an undeclared code would downgrade every read to `unavailable`.
   */
  it('never emits a binding it cannot measure', () => {
    const cases: Array<Parameters<typeof deriveCapacityVerdict>[0]> = [
      { provider: 'claude', pool: null, admission: { reachable: false, blind: false, dispatchBudget: null, inFlight: null } },
      { provider: 'claude', pool: pool(), admission: MEASURED_ADMISSION },
      { provider: 'claude', pool: pool({ serviceable: 0, walledFresh: 7, atCapacity: true, binding: 'usage-wall' }), admission: MEASURED_ADMISSION },
      { provider: 'claude', pool: pool({ serviceable: 0, pacing: 3, atCapacity: true, binding: 'pacing-policy' }), admission: MEASURED_ADMISSION },
      { provider: 'codex', pool: pool({ provider: 'codex', serviceable: 2 }), admission: { reachable: true, blind: false, dispatchBudget: 0, inFlight: 3 } },
    ];
    for (const input of cases) {
      expect(['usage-wall', 'admission-concurrency', 'pacing-policy', 'none']).toContain(
        deriveCapacityVerdict(input).binding,
      );
    }
  });
});
