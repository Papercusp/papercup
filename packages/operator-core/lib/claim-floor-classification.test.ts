/**
 * THE GUARD for claim-floor-classification.ts (WI-2141964).
 *
 * The bug this pins is not "a wrong answer" — it is THREE hand-rolled copies of one rule
 * that disagreed while every individual test passed. The classification is only worth
 * having if a NEW floor cannot reach consumers unclassified, so this asserts TOTALITY
 * against the oracle's own vocabulary rather than against a list retyped here.
 *
 * Read `partitionFloors` as the whole point: it is the shared instrument, exercised
 * against the real data AND against controls that are wrong in each direction, so a
 * green run means the check works — not merely that it ran.
 */
import { describe, expect, it } from 'vitest';

import {
  NON_FLOOR_LABELS,
  STRUCTURAL_CLAIM_FLOORS,
  TRANSIENT_CLAIM_FLOORS,
  isStructurallyUnclaimable,
} from './claim-floor-classification';
import { ISSUE_FLOOR_EXPLANATIONS } from './work-items';

interface Partition {
  /** In the oracle's vocabulary but classified nowhere — the silent-drift direction. */
  unclassified: string[];
  /** Classified but not a real floor — a stale entry left after a rename. */
  phantom: string[];
  /** Classified in more than one bucket — an ambiguous answer to a binary question. */
  doubleClassified: string[];
}

function partitionFloors(
  vocabulary: readonly string[],
  buckets: readonly ReadonlySet<string>[],
): Partition {
  const classified = new Set(buckets.flatMap((b) => [...b]));
  const vocab = new Set(vocabulary);
  return {
    unclassified: vocabulary.filter((label) => !classified.has(label)).sort(),
    phantom: [...classified].filter((label) => !vocab.has(label)).sort(),
    doubleClassified: [...classified]
      .filter((label) => buckets.filter((b) => b.has(label)).length > 1)
      .sort(),
  };
}

const VOCABULARY = Object.keys(ISSUE_FLOOR_EXPLANATIONS);
const BUCKETS = [STRUCTURAL_CLAIM_FLOORS, TRANSIENT_CLAIM_FLOORS, NON_FLOOR_LABELS] as const;

describe('claim-floor classification is TOTAL over the oracle vocabulary', () => {
  it('every floor explainIssueClaimFloors can report is classified exactly once', () => {
    const { unclassified, phantom, doubleClassified } = partitionFloors(VOCABULARY, BUCKETS);

    expect(
      unclassified,
      `These claim floors reach consumers with NO structural/transient classification: ` +
        `${JSON.stringify(unclassified)}. Decide in claim-floor-classification.ts — the decision ` +
        `cannot be defaulted, because both defaults are harmful in opposite directions: ` +
        `structural spams every consumer for a floor that clears itself, transient hides a ` +
        `genuinely stranded critical item (the 19-day hide the unservable-critical-watchdog exists ` +
        `to catch).`,
    ).toEqual([]);

    expect(
      phantom,
      `Classified labels that the oracle can no longer report: ${JSON.stringify(phantom)}. ` +
        `A renamed floor leaves the old name behind, where it silently matches nothing.`,
    ).toEqual([]);

    expect(doubleClassified, 'a floor cannot be both structural and transient').toEqual([]);
  });

  it('CALIBRATION: the instrument reports a floor added to the oracle but left unclassified', () => {
    // The falsifiability control. Rather than mutate the shipped sets (which the shared
    // tree's sweep can commit), run the SAME partitioner over a vocabulary carrying one
    // extra floor — exactly what "someone adds a floor to the claim path" looks like.
    const withNewFloor = [...VOCABULARY, 'newly-added-floor'];

    expect(partitionFloors(withNewFloor, BUCKETS).unclassified).toEqual(['newly-added-floor']);
  });

  it('CALIBRATION: the instrument reports a classified label the oracle dropped', () => {
    const stale = [new Set([...STRUCTURAL_CLAIM_FLOORS, 'renamed-away-floor'])] as const;

    expect(partitionFloors(VOCABULARY, stale).phantom).toEqual(['renamed-away-floor']);
  });

  it('CALIBRATION: the instrument reports a label classified in two buckets', () => {
    const overlapping = [new Set(['claim-hold']), new Set(['claim-hold'])] as const;

    expect(partitionFloors(['claim-hold'], overlapping).doubleClassified).toEqual(['claim-hold']);
  });

  it('ANTI-VACUITY: the vocabulary and both real buckets are non-degenerate', () => {
    // A partition over an EMPTY vocabulary, or with everything dumped in one bucket,
    // satisfies every assertion above while classifying nothing meaningfully.
    expect(VOCABULARY.length).toBeGreaterThan(10);
    expect(STRUCTURAL_CLAIM_FLOORS.size).toBeGreaterThan(1);
    expect(TRANSIENT_CLAIM_FLOORS.size).toBeGreaterThan(1);
  });
});

describe('isStructurallyUnclaimable', () => {
  it('an admissible row (null refusal) is NOT stranded', () => {
    // The distinction the watchdog depends on: a claimable-but-unclaimed critical item is
    // a prioritisation problem, not a structural strand, and must stay silent.
    expect(isStructurallyUnclaimable(null)).toBe(false);
    expect(isStructurallyUnclaimable(undefined)).toBe(false);
  });

  it('separates the two populations', () => {
    expect(isStructurallyUnclaimable('observation-lane')).toBe(true);
    expect(isStructurallyUnclaimable('claim-hold')).toBe(true);
    expect(isStructurallyUnclaimable('not-claimable-status')).toBe(true);
    // Self-clearing: something else already owns ending the wait.
    expect(isStructurallyUnclaimable('cooldown')).toBe(false);
    expect(isStructurallyUnclaimable('already-taken')).toBe(false);
    expect(isStructurallyUnclaimable('admission-pending')).toBe(false);
  });

  it('an unrecognised label is not reported as structural', () => {
    expect(isStructurallyUnclaimable('some-future-floor')).toBe(false);
  });
});
