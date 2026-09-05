import { describe, expect, it } from 'vitest';
import {
  composeGateRedOwnership,
  describeGateRedOwnership,
  gateFailureSignature,
  projectGateRepairOwner,
  type GateRedOwnershipState,
} from './gate-red-ownership';
import { assessGateOwnership, unownedCell, type CellOwnership } from '../coord/gate-ownership';
import { CRITICAL_CLAIM_PROGRESS_LEASE_MS } from '../agent-tools/work_items/release-force-guard';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import type { ConditionClaimState } from '../coord/condition-object';

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
    // EI-18696737036975615: the label must NOT tell the reader to "coordinate with the
    // owner" — a release-fixer spawn has no coordination-roster identity, so coord:send
    // to its spawnId always fails (unknown_recipient); that instruction was unactionable.
    expect(o.label).not.toMatch(/coordinate with the owner instead/);
    expect(o.label).toMatch(/unknown_recipient/);
    expect(o.label).toMatch(/checkpoint:await/);
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
      // P-008. Declared here so a new state is still a COMPILE error on this map, but
      // listed in COMPOSITE_ONLY below because this function cannot produce it: it is
      // reachable only through composeGateRedOwnership, which the next suite exercises.
      'owned-by-repair-holder': 'OWNED',
    };
    // States the DESCRIBE path cannot reach. Kept as an explicit, named subtraction rather
    // than by trimming the map: the map's exhaustiveness is what makes a newly-added state
    // fail to compile, and an unreachable state must be justified here, not deleted.
    const COMPOSITE_ONLY: readonly GateRedOwnershipState[] = ['owned-by-repair-holder'];
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
    const describeReachable = (Object.keys(expectedPrefix) as GateRedOwnershipState[]).filter(
      (s) => !COMPOSITE_ONLY.includes(s),
    );
    expect([...seen].sort()).toEqual(describeReachable.sort());
    // And the subtraction itself is checked: a state listed as composite-only must really
    // be unreachable here, or the exemption is hiding a gap instead of documenting one.
    expect(COMPOSITE_ONLY.filter((s) => seen.has(s))).toEqual([]);
  });
});

/**
 * P-008 — the automated fixer and the live singleton work-item holder are TWO owners, and
 * the trace must never emit a bare `owner-gone` while the second one holds the item.
 *
 * The failure these pin down is not hypothetical: on 2026-08-23 a trace named a 32h-dead
 * release-fixer as the reason to claim a red that `dev:pipeline_position` showed was held by
 * a live owner in the same minute (EI-21271478314960803), and the false invitation that
 * produces is what let 37 distinct agents take 97 stints on ONE gate item on 2026-08-26.
 */
const cell = (over: Partial<CellOwnership>): CellOwnership => {
  const base = unownedCell('gate-red-streak:papercusp');
  const merged = { ...base, ...over };
  return {
    ...merged,
    assessment: assessGateOwnership({
      claimState: merged.claimState,
      holderSessionState: merged.holderSessionState,
      duplicates: merged.duplicates,
    }),
  };
};

const heldBy = (takenBy: string, session: SessionState, progressAgeMs = 60_000): CellOwnership =>
  cell({
    workItem: 'WI-40086',
    claimState: 'held',
    takenBy,
    takenAt: new Date(NOW - 30 * 60_000).toISOString(),
    lastProgressAt: new Date(NOW - progressAgeMs).toISOString(),
    holderSessionState: session,
  });

/** The six fixer verdicts, by the input that produces each. */
const FIXER_CASES: Record<GateRedOwnershipState, Parameters<typeof describeGateRedOwnership>[0] | null> = {
  unowned: { currentSignature: 'x', nowMs: NOW },
  'stale-signature': { ownerSignature: 'a', currentSignature: 'b', spawnId: 's-1', dispatchedAtMs: mins(90), nowMs: NOW },
  'owner-gone': {
    ownerSignature: 'x',
    currentSignature: 'x',
    spawnId: 's-dead',
    dispatchedAtMs: mins(32 * 60),
    fixerAlive: false,
    nowMs: NOW,
  },
  'owned-live': { ownerSignature: 'x', currentSignature: 'x', spawnId: 's-2', fixerAlive: true, nowMs: NOW },
  'owned-unknown': { ownerSignature: 'x', currentSignature: 'x', fixerAlive: null, nowMs: NOW },
  'verdict-stale': { ownerSignature: 'x', currentSignature: 'x', fixerAlive: true, verdictStale: true, nowMs: NOW },
  // Composite-only: produced BY the composer, never fed INTO it as a fixer verdict.
  'owned-by-repair-holder': null,
};

describe('composeGateRedOwnership — the fixer and the repair owner are two owners, not one', () => {
  it('never emits a bare owner-gone while a live repair owner holds the item', () => {
    // THE acceptance criterion, stated directly. `owner-gone` is the state whose prose is
    // "UNOWNED — claim it before investigating", which is actively false here.
    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-ccd31f35', 'live'), NOW),
    });

    expect(composed.state).toBe('owned-by-repair-holder');
    expect(composed.covered).toBe(true);
    expect(composed.label).toMatch(/^OWNED/);
    expect(composed.label).not.toMatch(/Claim it before investigating/);
    expect(composed.label).toContain('WI-40086');
    expect(composed.label).toContain('su-ccd31f35');
    // The fixer's death is PRESERVED, not erased — it is the actionable half.
    expect(composed.fixerState).toBe('owner-gone');
    expect(composed.spawnId).toBe('s-dead');
    expect(composed.label).toMatch(/CONFIRMED GONE/);
    expect(composed.label).toMatch(/does NOT mean this red is unowned/);
  });

  it.each(['live', 'parked', 'recorded'] as const)(
    'treats a %s holder as covering the red — the oracle allowlist, not a hand-rolled one',
    (session) => {
      const composed = composeGateRedOwnership({
        fixer: describeGateRedOwnership(FIXER_CASES.unowned!),
        repairOwner: projectGateRepairOwner(heldBy('su-a', session), NOW),
      });
      expect(composed.state).toBe('owned-by-repair-holder');
      expect(composed.covered).toBe(true);
      expect(composed.repairOwner?.live).toBe(true);
    },
  );

  it.each(['draining', 'suspect', 'ended'] as const)(
    'does NOT promote a %s holder, but still NAMES the claim so the refusal is never bare',
    (session) => {
      const composed = composeGateRedOwnership({
        fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
        repairOwner: projectGateRepairOwner(heldBy('su-b', session), NOW),
      });
      // Standing agents down on an absence of evidence is the opposite failure, so the
      // state stays the fixer's. But the label must not pretend no claim exists.
      expect(composed.state).toBe('owner-gone');
      expect(composed.covered).toBe(false);
      expect(composed.repairOwner?.live).toBe(false);
      expect(composed.label).toContain('WI-40086');
      expect(composed.label).toContain('su-b');
      expect(composed.label).toMatch(/not POSITIVELY live/);
      expect(composed.label).toMatch(/absence of evidence/);
    },
  );

  it('keeps a live fixer as the state and appends the live holder rather than displacing it', () => {
    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owned-live']!),
      repairOwner: projectGateRepairOwner(heldBy('su-c', 'live'), NOW),
    });
    expect(composed.state).toBe('owned-live');
    expect(composed.fixerState).toBe('owned-live');
    expect(composed.covered).toBe(true);
    expect(composed.label).toContain('ALSO:');
    expect(composed.label).toContain('su-c');
  });

  it('leaves verdict-stale untouched — gate-stop-chasing-the-tip is unchanged', () => {
    // A stale verdict means the failure names may already be fixed, so "who owns it" is the
    // wrong question. A live holder must not dress that up as covered ownership.
    const fromFixer = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['verdict-stale']!),
      repairOwner: projectGateRepairOwner(heldBy('su-d', 'live'), NOW),
    });
    expect(fromFixer.state).toBe('verdict-stale');
    expect(fromFixer.label).toMatch(/^STALE VERDICT/);

    // ...and the CALLER's independent staleness verdict suppresses promotion identically.
    const fromCaller = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-d', 'live'), NOW),
      verdictStale: true,
    });
    expect(fromCaller.state).toBe('owner-gone');
    expect(fromCaller.covered).toBe(false);
  });

  it('surfaces STALE PROGRESS without demoting a live holder to unowned', () => {
    const stale = projectGateRepairOwner(
      heldBy('su-quiet', 'live', CRITICAL_CLAIM_PROGRESS_LEASE_MS + 60_000),
      NOW,
    );
    expect(stale?.progressStale).toBe(true);

    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: stale,
    });
    // Demoting a quiet holder to "unowned" would re-create the 97-stint pile-on. The
    // staleness is surfaced structurally and named in prose; cover is unchanged.
    expect(composed.state).toBe('owned-by-repair-holder');
    expect(composed.covered).toBe(true);
    expect(composed.repairOwner?.progressStale).toBe(true);
    expect(composed.label).toMatch(/QUIET for/);
    expect(composed.label).toMatch(/coordinate/);
  });

  it('reports fresh progress as fresh, and an unmeasurable anchor as UNMEASURED not fresh', () => {
    const fresh = projectGateRepairOwner(heldBy('su-e', 'live', 5 * 60_000), NOW);
    expect(fresh?.progressStale).toBe(false);
    expect(fresh?.progressAgeMs).toBe(5 * 60_000);

    const noAnchor = projectGateRepairOwner(
      cell({ workItem: 'WI-1', claimState: 'held', takenBy: 'su-f', holderSessionState: 'live' }),
      NOW,
    );
    expect(noAnchor?.progressAgeMs).toBeNull();
    // Fails closed: an unread lease is not an expired one.
    expect(noAnchor?.progressStale).toBe(false);
    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES.unowned!),
      repairOwner: noAnchor,
    });
    expect(composed.label).toMatch(/UNMEASURED/);
    expect(composed.label).toMatch(/not a fresh one/);
  });

  it('follows a CLAIM RELEASE back to the fixer verdict instead of stranding stale cover', () => {
    const held = projectGateRepairOwner(heldBy('su-g', 'live'), NOW);
    expect(
      composeGateRedOwnership({ fixer: describeGateRedOwnership(FIXER_CASES.unowned!), repairOwner: held }).covered,
    ).toBe(true);

    // The holder released it: the condition object survives, the lease does not.
    const released = projectGateRepairOwner(
      cell({ workItem: 'WI-40086', claimState: 'claimable', takenBy: null, holderSessionState: null }),
      NOW,
    );
    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES.unowned!),
      repairOwner: released,
    });
    expect(composed.state).toBe('unowned');
    expect(composed.covered).toBe(false);
    // Still not bare: the reader is told a work-item exists to claim, not that nothing does.
    expect(composed.label).toContain('WI-40086');
  });

  it('follows a HANDOFF to the new holder', () => {
    const before = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-first', 'live'), NOW),
    });
    expect(before.label).toContain('su-first');

    const after = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-second', 'live'), NOW),
    });
    expect(after.state).toBe('owned-by-repair-holder');
    expect(after.covered).toBe(true);
    expect(after.label).toContain('su-second');
    expect(after.label).not.toContain('su-first');
  });

  it('reads a MEASURED no-object as no claim, and a NULL block as unread — never the same thing', () => {
    const measuredAbsence = projectGateRepairOwner(unownedCell('gate-red-streak:papercusp'), NOW);
    expect(measuredAbsence?.claimState).toBe('no-object');
    const composed = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: measuredAbsence,
    });
    // A measured "nobody owns it" must NOT invent a claim to name.
    expect(composed.state).toBe('owner-gone');
    expect(composed.label).not.toContain('gate singleton');

    // And an unread one degrades to the fixer verdict with the block explicitly null.
    const unread = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(null, NOW),
    });
    expect(unread.repairOwner).toBeNull();
    expect(unread.state).toBe('owner-gone');
  });

  it('is idempotent — composing twice cannot promote a composite into the fixer verdict', () => {
    const once = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-h', 'live'), NOW),
    });
    const twice = composeGateRedOwnership({
      fixer: once,
      repairOwner: projectGateRepairOwner(heldBy('su-h', 'live'), NOW),
    });
    expect(twice.fixerState).toBe('owner-gone');
    expect(twice.state).toBe('owned-by-repair-holder');
    expect(twice.label).toBe(once.label);
  });

  it('applies an executor cover only when nothing else covered, and never masks a holder', () => {
    const executorCover = { label: 'OWNED — the live checkpoint run-lock is held by the canonical gate executor.' };

    // Nothing else covers ⇒ the run-lock does.
    const bare = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: null,
      executorCover,
    });
    expect(bare.covered).toBe(true);
    expect(bare.label).toBe(executorCover.label);
    expect(bare.fixerState).toBe('owner-gone');

    // A live holder outranks it — the specific owner is more actionable than "a run is up".
    const withHolder = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['owner-gone']!),
      repairOwner: projectGateRepairOwner(heldBy('su-i', 'live'), NOW),
      executorCover,
    });
    expect(withHolder.state).toBe('owned-by-repair-holder');
    expect(withHolder.label).toContain('su-i');

    // And a stale verdict outranks BOTH.
    const stale = composeGateRedOwnership({
      fixer: describeGateRedOwnership(FIXER_CASES['verdict-stale']!),
      repairOwner: null,
      executorCover,
    });
    expect(stale.state).toBe('verdict-stale');
  });

  it('covers EVERY fixer-verdict x holder-liveness combination without ever losing the fixer state', () => {
    // The exhaustive matrix the acceptance asks for. Two invariants hold in all 30 cells,
    // and they are the two the substitution implementation broke:
    //   1. fixerState always survives the composition.
    //   2. `covered` is true iff the fixer covered OR a positively-live holder exists
    //      (with verdict-stale short-circuiting to the fixer's own answer).
    const holders: Array<[string, CellOwnership | null]> = [
      ['none', null],
      ['no-object', unownedCell('gate-red-streak:papercusp')],
      ['held-live', heldBy('su-x', 'live')],
      ['held-ended', heldBy('su-x', 'ended')],
      ['held-suspect', heldBy('su-x', 'suspect')],
      ['lease-expired', cell({ workItem: 'WI-9', claimState: 'lease-expired', takenBy: 'su-x' })],
    ];
    const fixerStates = (Object.keys(FIXER_CASES) as GateRedOwnershipState[]).filter(
      (s) => FIXER_CASES[s] !== null,
    );
    expect(fixerStates).toHaveLength(6);

    for (const fs of fixerStates) {
      const fixer = describeGateRedOwnership(FIXER_CASES[fs]!);
      expect(fixer.state, `fixture for ${fs} produces ${fixer.state}`).toBe(fs);

      for (const [name, ownership] of holders) {
        const repairOwner = projectGateRepairOwner(ownership, NOW);
        const composed = composeGateRedOwnership({ fixer, repairOwner });
        const label = `${fs} x ${name}`;

        expect(composed.fixerState, label).toBe(fs);
        const holderLive = repairOwner?.live === true;
        const expectedCovered = fs === 'verdict-stale' ? fixer.covered : fixer.covered || holderLive;
        expect(composed.covered, `${label}: covered`).toBe(expectedCovered);

        // The headline invariant: an UNCOVERED verdict may never read as a bare
        // claim-it invitation while a live holder is on the item.
        if (holderLive && fs !== 'verdict-stale') {
          expect(composed.label, `${label}: label`).not.toMatch(/Claim it before investigating/);
          expect(composed.label, `${label}: label`).not.toMatch(/Claim this red before investigating/);
        }
      }
    }
  });
});
