/**
 * EI-19329513980117751 — the claim-time sibling-path-overlap guard.
 *
 * ⚠ SCOPE. The parity test (`claim-time-enrichment-parity.test.ts`) proves every claim
 * surface ATTACHES this leg; it deliberately proves nothing about whether the leg is
 * right. This file is the other half: the pure predicates and the rendered warning,
 * plus the two no-PG paths that must stay silent.
 *
 * The falsifiability controls below are PERMANENT deliberately-wrong implementations
 * kept in the test file, per the repo rule — never a mutation of the shared tree, which
 * git-sync can commit mid-probe.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCARDED_WORK_ITEM_STATES,
  MAX_SIBLINGS,
  getClaimTimeSiblingPathOverlap,
  implementedWorkItemStates,
  siblingPathOverlapWarning,
  type ClaimTimeSiblingPathOverlapHint,
} from './sibling-path-overlap-claim-port';
import { SETTLED_WORK_ITEM_STATES } from './work-items';

describe('implementedWorkItemStates', () => {
  it('keeps the states that mean the work LANDED', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    expect(implemented).toContain('done');
    expect(implemented).toContain('resolved');
    expect(implemented).toContain('passed');
  });

  it('drops the DISCARD states — they mean the work was explicitly not done', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    // Announcing a dropped sibling as "already implemented" would send an agent to read
    // a decision to SKIP the work as though it were the work.
    expect(implemented).not.toContain('dropped');
    expect(implemented).not.toContain('closed');
    expect(implemented).not.toContain('deprecated');
  });

  it('is derived by subtraction, so a new settled state lands in the warned set', () => {
    // The direction that matters: over-warning is recoverable (this is advisory),
    // silence is the defect the module exists to stop. A state the upstream list gains
    // must therefore be INCLUDED by default, not excluded.
    const withNewState = [...SETTLED_WORK_ITEM_STATES, 'ratified'];
    expect(implementedWorkItemStates(withNewState)).toContain('ratified');
  });

  it('partitions the settled list exactly — nothing is invented or lost', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    const discarded = SETTLED_WORK_ITEM_STATES.filter((s) => DISCARDED_WORK_ITEM_STATES.includes(s));
    expect(implemented.length + discarded.length).toBe(SETTLED_WORK_ITEM_STATES.length);
    expect(implemented.every((s) => SETTLED_WORK_ITEM_STATES.includes(s))).toBe(true);
  });

  describe('falsifiability controls (permanent wrong implementations)', () => {
    /** The bug this guard exists to prevent: treating every settled state as landed. */
    const allSettled = (settled: readonly string[]) => [...settled];
    /** The other plausible weakening: a hand-listed set that silently drifts. */
    const handListed = (_settled: readonly string[]) => ['done'];

    it('the controls accept what the real function rejects', () => {
      // If this ever fails, the controls have stopped being wrong and the tests above
      // prove nothing.
      expect(allSettled(SETTLED_WORK_ITEM_STATES)).toContain('dropped');
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES)).not.toContain('dropped');
    });

    it('the hand-listed control misses states the real function keeps', () => {
      expect(handListed(SETTLED_WORK_ITEM_STATES)).not.toContain('resolved');
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES)).toContain('resolved');
    });

    it('calibration: the real function is not simply empty', () => {
      // Without this, an implementation hard-coded to [] would pass every test above.
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES).length).toBeGreaterThan(0);
    });
  });
});

describe('getClaimTimeSiblingPathOverlap', () => {
  it('returns null without touching PG when the item stores no paths', async () => {
    // The overwhelmingly common claim, which must be completely unaffected by this leg
    // (and must not require a database).
    await expect(getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: {} })).resolves.toBeNull();
  });

  it('returns null when payload.paths is present but not a usable list', async () => {
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: { paths: [] } }),
    ).resolves.toBeNull();
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: { paths: 'not-an-array' } }),
    ).resolves.toBeNull();
  });

  it('returns null when the work-item id is missing', async () => {
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: '', payload: { paths: ['a.ts'] } }),
    ).resolves.toBeNull();
  });
});

describe('siblingPathOverlapWarning', () => {
  /** The measured real duplicate: WI-6992 landed the fix WI-6994 was filed to build. */
  const landed: ClaimTimeSiblingPathOverlapHint = {
    claimedPaths: [
      'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json',
      'scripts/lib/identity-leak-patterns.mjs',
    ],
    ratedPaths: ['packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json'],
    siblings: [
      {
        workItemId: 'WI-6992',
        title: 'add redaction at the fixture-write choke point',
        state: 'done',
        inFlight: false,
        sharedPaths: ['packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json'],
        rarestSharedPathSharers: 3,
      },
    ],
    totalMatched: 1,
    implementedCount: 1,
    inFlightCount: 0,
  };

  it('returns null for no hint — saying nothing asserts nothing', () => {
    expect(siblingPathOverlapWarning(null, 'WI-1')).toBeNull();
  });

  it('returns null for a hint with no siblings', () => {
    expect(
      siblingPathOverlapWarning(
        {
          claimedPaths: ['a.ts'],
          ratedPaths: [],
          siblings: [],
          totalMatched: 0,
          implementedCount: 0,
          inFlightCount: 0,
        },
        'WI-1',
      ),
    ).toBeNull();
  });

  it('names the sibling, its state and the SHARED PATHS — the evidence, not a score', () => {
    const msg = siblingPathOverlapWarning(landed, 'WI-6994');
    expect(msg).toContain('WI-6992');
    expect(msg).toContain('prose-corpus.v1.json');
    expect(msg).toContain('done');
    expect(msg).toContain('WI-6994');
    // The actionable half: what to do instead of re-implementing.
    expect(msg).toContain('ALREADY LANDED');
    expect(msg).toContain('duplicate');
  });

  it('states how RARE the shared path is — that is what makes it evidence', () => {
    // Without the rarity figure the reader cannot tell a 3-sharer match (real signal)
    // from a 98-sharer hub-file coincidence. See the module note's measured table.
    const msg = siblingPathOverlapWarning(landed, 'WI-6994') ?? '';
    expect(msg).toContain('only 3 settled item(s)');
    expect(msg).toContain('RARE PATHS');
  });

  it('calls itself a FILTER, not a verdict', () => {
    // The honest framing. Overselling this as duplicate detection is what would get an
    // agent to close a non-duplicate.
    expect(siblingPathOverlapWarning(landed, 'WI-6994')).toContain('FILTER, not');
  });

  it('distinguishes an IN-FLIGHT peer from an already-landed sibling', () => {
    // These are different problems with different responses: coordinate vs. do not
    // rebuild. Collapsing them would make the warning unactionable.
    const inFlight: ClaimTimeSiblingPathOverlapHint = {
      claimedPaths: ['a.ts'],
      ratedPaths: ['a.ts'],
      siblings: [
        {
          workItemId: 'WI-2',
          title: 't',
          state: 'open',
          inFlight: true,
          sharedPaths: ['a.ts'],
          rarestSharedPathSharers: 2,
        },
      ],
      totalMatched: 1,
      implementedCount: 0,
      inFlightCount: 1,
    };
    const msg = siblingPathOverlapWarning(inFlight, 'WI-1');
    expect(msg).toContain('IN FLIGHT');
    expect(msg).toContain('held by a peer');
    expect(msg).not.toContain('ALREADY LANDED');

    const landedMsg = siblingPathOverlapWarning(landed, 'WI-1');
    expect(landedMsg).not.toContain('held by a peer');
  });

  it('reports the TRUE total and marks the list as capped', () => {
    // The repo's bounded-measurement rule: a count computed over a capped fetch must
    // say so ON the aggregate, or a floor gets quoted as a total.
    const capped: ClaimTimeSiblingPathOverlapHint = {
      ...landed,
      siblings: Array.from({ length: MAX_SIBLINGS }, (_, i) => ({
        ...landed.siblings[0],
        workItemId: `WI-${100 + i}`,
      })),
      totalMatched: 23,
      implementedCount: MAX_SIBLINGS,
    };
    const msg = siblingPathOverlapWarning(capped, 'WI-1') ?? '';
    expect(msg).toContain('23 other work-item(s)');
    expect(msg).toContain(`${MAX_SIBLINGS} of 23 shown`);
  });

  it('does not announce a cap when nothing was capped', () => {
    const msg = siblingPathOverlapWarning(landed, 'WI-1') ?? '';
    expect(msg).toContain('1 other work-item(s)');
    expect(msg).not.toContain('shown, strongest first');
  });
});
