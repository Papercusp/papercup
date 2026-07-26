import { describe, expect, it } from 'vitest';
import {
  describeGateRedOwnership,
  gateFailureSignature,
  type GateRedOwnershipState,
} from './gate-red-ownership';

describe('gateFailureSignature — the one derivation the dispatcher and the renderer share', () => {
  it('is order-independent, so the same failure set on a later run keys the same', () => {
    // This is the property the whole dedup rests on: the gate does not promise a stable
    // order for failingTests, and if the key changed with the order, a re-detected failure
    // would look like a NEW one and re-dispatch a second fixer every hour.
    expect(gateFailureSignature(['b.test.ts', 'a.test.ts'], 'sha1')).toBe(
      gateFailureSignature(['a.test.ts', 'b.test.ts'], 'sha1'),
    );
  });

  it('is candidate-independent when tests are named — a red survives hourly new candidates', () => {
    expect(gateFailureSignature(['a.test.ts'], 'sha-old')).toBe(gateFailureSignature(['a.test.ts'], 'sha-new'));
  });

  it('falls back to the candidate only when the verdict named no tests', () => {
    expect(gateFailureSignature([], 'sha1')).toBe('sha1');
    expect(gateFailureSignature(null, 'sha1')).toBe('sha1');
    expect(gateFailureSignature(null, null)).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = ['b.test.ts', 'a.test.ts'];
    gateFailureSignature(input, null);
    expect(input).toEqual(['b.test.ts', 'a.test.ts']);
  });
});

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

  it('reports STALE VERDICT ahead of any ownership answer, and says not to chase the named tests', () => {
    // The 02:19 case, verbatim in shape: a fixer looks like it is on this signature, but the
    // verdict itself predates the current candidate — so the failures it names may already
    // be fixed. Answering "unowned, go claim it" here is what sent agents at an already-green
    // leg; the staleness has to win over the ownership answer, not be reported beside it.
    const o = describeGateRedOwnership({
      ownerSignature: 'lint:identity-leak',
      currentSignature: 'lint:identity-leak',
      dispatchedAtMs: mins(30),
      spawnId: 'spawn-9',
      fixerAlive: false, // would be 'owner-gone' (=> "claim it") if staleness did not win
      verdictStale: true,
      nowMs: NOW,
    });
    expect(o.state).toBe('verdict-stale');
    expect(o.covered).toBe(true); // stand down — but because there may be nothing here
    expect(o.label).toMatch(/^STALE VERDICT/);
    expect(o.label).toMatch(/Do NOT diagnose/);
    expect(o.label).toMatch(/release:checkpoint-run/);
  });

  it('ignores verdictStale:false / undefined — a fresh verdict answers ownership normally', () => {
    const fresh = describeGateRedOwnership({
      ownerSignature: 'x',
      currentSignature: 'x',
      fixerAlive: true,
      verdictStale: false,
      nowMs: NOW,
    });
    expect(fresh.state).toBe('owned-live');
  });

  it('every state opens with its own scannable prefix — the whole point is a one-glance verdict', () => {
    // Was "covered ⇒ OWNED, else UNOWNED". 'verdict-stale' is covered (stand down) but is
    // NOT owned by anyone, so a two-way prefix rule can no longer express it. Asserting the
    // state→prefix map directly is stronger anyway: it pins each label's opening word rather
    // than a boolean derived from it, and a new state must add a row here to pass.
    const expectedPrefix: Record<GateRedOwnershipState, string> = {
      'verdict-stale': 'STALE VERDICT',
      unowned: 'UNOWNED',
      'stale-signature': 'UNOWNED',
      'owner-gone': 'UNOWNED',
      'owned-live': 'OWNED',
      'owned-unknown': 'OWNED',
    };
    const cases: Array<Parameters<typeof describeGateRedOwnership>[0]> = [
      { currentSignature: 'x', nowMs: NOW },
      { ownerSignature: 'a', currentSignature: 'b', nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: false, nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: true, nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: null, nowMs: NOW },
      { ownerSignature: 'x', currentSignature: 'x', fixerAlive: true, verdictStale: true, nowMs: NOW },
    ];
    const seen = new Set<GateRedOwnershipState>();
    for (const c of cases) {
      const o = describeGateRedOwnership(c);
      seen.add(o.state);
      expect(o.label.startsWith(expectedPrefix[o.state]), `${o.state}: ${o.label}`).toBe(true);
    }
    // Every declared state is actually exercised above — otherwise the map silently rots.
    expect([...seen].sort()).toEqual(Object.keys(expectedPrefix).sort());
  });
});
