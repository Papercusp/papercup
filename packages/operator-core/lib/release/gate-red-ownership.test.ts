import { describe, expect, it } from 'vitest';
import { describeGateRedOwnership } from './gate-red-ownership';

const NOW = 1_800_000_000_000;
const mins = (n: number) => NOW - n * 60_000;

describe('describeGateRedOwnership — surfacing the owner the dispatcher already knows (EI-18672078222841101)', () => {
  it('reports UNOWNED when no fixer has ever been dispatched', () => {
    const o = describeGateRedOwnership({ currentSignature: 'a.test.ts', nowMs: NOW });
    expect(o.state).toBe('unowned');
    expect(o.covered).toBe(false);
    expect(o.label).toMatch(/^UNOWNED/);
    expect(o.label).toMatch(/Claim it/);
  });

  it('reports OWNED and covered when a live fixer holds the SAME signature', () => {
    const o = describeGateRedOwnership({
      ownerSignature: 'a.test.ts,b.test.ts',
      currentSignature: 'a.test.ts,b.test.ts',
      dispatchedAtMs: mins(20),
      spawnId: 'spawn-77',
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.state).toBe('owned-live');
    expect(o.covered).toBe(true);
    expect(o.spawnId).toBe('spawn-77');
    expect(o.label).toMatch(/^OWNED/);
    expect(o.label).toContain('spawn-77');
    expect(o.label).toContain('20m ago');
    expect(o.label).toMatch(/Do NOT start a parallel diagnosis/);
  });

  it('treats unknowable liveness as covered — matching decideReleaseFixerDispatch, which must not disagree', () => {
    // fixerAlive null = durable fire / legacy record with no spawn id. The dispatcher
    // reads this as "presumed covered"; a renderer that called it unowned would send
    // agents at a gate the dispatcher is deliberately not re-dispatching for.
    const o = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: 'x',
      dispatchedAtMs: mins(5),
      spawnId: null,
      fixerAlive: null,
      nowMs: NOW,
    });
    expect(o.state).toBe('owned-unknown');
    expect(o.covered).toBe(true);
    expect(o.label).toContain('liveness unknowable');
  });

  it('reports the CONFIRMED-GONE fixer as unowned — the case where the old alert prose was actively false', () => {
    // The stall alert says "A release-fixer is on it". When the fixer died without
    // clearing the red, that sentence is a lie and nobody picks the gate up.
    const o = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: 'x',
      dispatchedAtMs: mins(180),
      spawnId: 'spawn-dead',
      fixerAlive: false,
      nowMs: NOW,
    });
    expect(o.state).toBe('owner-gone');
    expect(o.covered).toBe(false);
    expect(o.label).toMatch(/^UNOWNED/);
    expect(o.label).toContain('CONFIRMED GONE');
    expect(o.label).toContain('3h ago');
  });

  it('reports a fixer on a DIFFERENT failure as not covering this red', () => {
    // The signature is the whole point: while the gate stays red staging advances
    // hourly, so a candidate-keyed surface would call this "covered" every time.
    const o = describeGateRedOwnership({
      ownerSignature: 'old.test.ts',
      currentSignature: 'new.test.ts',
      dispatchedAtMs: mins(30),
      spawnId: 'spawn-1',
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.state).toBe('stale-signature');
    expect(o.covered).toBe(false);
    expect(o.label).toMatch(/^UNOWNED/);
    expect(o.label).toContain('DIFFERENT failure');
    expect(o.label).toContain('old.test.ts');
  });

  it('a live fixer on a different signature is NOT covered — liveness must not override signature mismatch', () => {
    const o = describeGateRedOwnership({
      ownerSignature: 'other',
      currentSignature: 'mine',
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.covered).toBe(false);
  });

  it('does not invent a signature mismatch when the current signature is unknown', () => {
    // With no current signature we cannot prove a mismatch; falling through to the
    // liveness answer is the honest read (and matches the dispatcher's own dedup,
    // which only compares when it has both).
    const o = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: null,
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.state).toBe('owned-live');
    expect(o.covered).toBe(true);
  });

  it('renders a missing/!finite dispatch time as unknown age rather than NaN', () => {
    const o = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: 'x',
      dispatchedAtMs: null,
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.ageMs).toBeNull();
    expect(o.label).toContain('unknown age');
    expect(o.label).not.toMatch(/NaN/);
  });

  it('never renders a negative age from a clock skew', () => {
    const o = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: 'x',
      dispatchedAtMs: NOW + 60_000,
      fixerAlive: true,
      nowMs: NOW,
    });
    expect(o.ageMs).toBe(0);
    expect(o.label).toContain('just now');
  });

  it('every not-covered state opens with UNOWNED and every covered state with OWNED — the scannable invariant', () => {
    const cases: Array<Parameters<typeof describeGateRedOwnership>[0]> = [
      { currentSignature: 'x', nowMs: NOW },
      { ownerSignature: 'a', currentSignature: 'b', nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: false, nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: true, nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: null, nowMs: NOW },
    ];
    for (const c of cases) {
      const o = describeGateRedOwnership(c);
      expect(o.label.startsWith(o.covered ? 'OWNED' : 'UNOWNED'), o.label).toBe(true);
    }
  });
});
