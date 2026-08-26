/**
 * Arm B (P-005) — the forced, ledger-corroborated self-review judgement.
 *
 * The controls here are the point. A gate that only ever sees well-formed input stops being
 * evidence that it discriminates at all, so every verdict has both a case that reaches it and
 * a neighbouring case that does not.
 */
import { describe, it, expect } from 'vitest';
import {
  claimsSelfReview,
  itemIsArmB,
  judgeSelfReview,
  lastEditAtMs,
  selfReviewLedgerQuery,
  toSelfReviewLedgerRow,
  type SelfReviewLedgerRow,
} from './work-item-self-review';

const T = (min: number): number => Date.parse('2026-08-26T01:00:00Z') + min * 60_000;

const row = (
  toolName: string,
  min: number,
  status?: string,
): SelfReviewLedgerRow => ({ toolName, invokedAtMs: T(min), status });

const REVIEWED = { lookedAt: 'the full diff', findings: ['off-by-one in the retry bound'] };

describe('itemIsArmB — the opt-in marker (D-020)', () => {
  it('DEFAULTS TO FALSE for everything that is not explicitly arm B', () => {
    // The single most load-bearing assertion in this file. A true here would make arm A and
    // arm B the same arm AND refuse every in-flight close in the fleet.
    expect(itemIsArmB(undefined)).toBe(false);
    expect(itemIsArmB(null)).toBe(false);
    expect(itemIsArmB({})).toBe(false);
    expect(itemIsArmB({ payload: null })).toBe(false);
    expect(itemIsArmB({ payload: {} })).toBe(false);
    expect(itemIsArmB({ payload: 'B' })).toBe(false); // a string payload is not a marker
    expect(itemIsArmB({ payload: { pilotArm: 'A' } })).toBe(false);
    expect(itemIsArmB({ payload: { pilotArm: 'C' } })).toBe(false);
    expect(itemIsArmB({ payload: { pilotArm: true } })).toBe(false);
  });

  it('is true only on an explicit B, case- and whitespace-insensitive', () => {
    expect(itemIsArmB({ payload: { pilotArm: 'B' } })).toBe(true);
    expect(itemIsArmB({ payload: { pilotArm: 'b' } })).toBe(true);
    expect(itemIsArmB({ payload: { pilotArm: ' B ' } })).toBe(true);
  });
});

describe('selfReviewLedgerQuery — the false-absence seam (EI-21476445557415319)', () => {
  const q = selfReviewLedgerQuery({
    workspaceId: 'papercusp-workspace',
    coordOwnerId: 'su-abc',
    goalRef: 'WI-1',
    sinceMs: T(0),
  });

  it('does NOT filter by harness_slug', () => {
    // A workspace-scoped su session files under harness_slug='*', so a harness predicate
    // returns a clean zero for it — indistinguishable from "no review happened".
    expect(q.text).not.toMatch(/harness_slug/);
  });

  it('admits rows whose goal_ref is null rather than dropping them', () => {
    expect(q.text).toMatch(/goal_ref\s*=\s*\$3\s*OR\s*goal_ref\s+IS\s+NULL/i);
  });

  it('pins to workspace + owner + goal + window, in that parameter order', () => {
    expect(q.text).toMatch(/workspace_id\s*=\s*\$1/);
    expect(q.text).toMatch(/coord_owner_id\s*=\s*\$2/);
    expect(q.text).toMatch(/invoked_at\s*>=\s*\$4/);
    expect(q.values.slice(0, 3)).toEqual(['papercusp-workspace', 'su-abc', 'WI-1']);
    expect(q.values[3]).toBeInstanceOf(Date);
  });
});

describe('toSelfReviewLedgerRow', () => {
  it('accepts a Date and an ISO string alike', () => {
    const iso = new Date(T(3)).toISOString();
    expect(toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: iso })).toEqual({
      toolName: 'capability:git',
      invokedAtMs: T(3),
      status: undefined,
    });
    expect(
      toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: new Date(T(3)) })
        ?.invokedAtMs,
    ).toBe(T(3));
  });

  it('drops rows it cannot trust rather than inventing a timestamp', () => {
    // A row coerced to epoch 0 would silently read as "reviewed before everything",
    // which is the stale-review check's worst input.
    expect(toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: 'nonsense' })).toBeUndefined();
    expect(toSelfReviewLedgerRow({ invoked_at: new Date() })).toBeUndefined();
    expect(toSelfReviewLedgerRow({})).toBeUndefined();
  });
});

describe('claimsSelfReview', () => {
  it('is false for absent, empty, and whitespace-only evidence', () => {
    expect(claimsSelfReview(undefined)).toBe(false);
    expect(claimsSelfReview(null)).toBe(false);
    expect(claimsSelfReview({})).toBe(false);
    expect(claimsSelfReview({ lookedAt: '   ' })).toBe(false);
  });

  it('is true when any of the three fields carries content', () => {
    expect(claimsSelfReview({ lookedAt: 'the diff' })).toBe(true);
    expect(claimsSelfReview({ findings: ['a bug'] })).toBe(true);
    expect(claimsSelfReview({ changedAsResult: ['fixed it'] })).toBe(true);
  });

  it('counts an explicit zero-findings review as a claim, not as silence', () => {
    // The distinction that makes rubberStampRisk measurable rather than inferred.
    expect(claimsSelfReview({ lookedAt: 'the diff', findings: [] })).toBe(true);
  });
});

describe('lastEditAtMs', () => {
  it('returns the latest successful edit', () => {
    expect(
      lastEditAtMs([row('capability:edit', 1), row('capability:write', 5), row('capability:read', 9)]),
    ).toBe(T(5));
  });

  it('ignores edits that did not succeed', () => {
    // A refused edit changed nothing, so it must not move the clock a review has to beat.
    expect(lastEditAtMs([row('capability:edit', 1), row('capability:edit', 8, 'refused')])).toBe(T(1));
  });

  it('is undefined when nothing was edited', () => {
    expect(lastEditAtMs([row('capability:read', 3)])).toBeUndefined();
  });
});

describe('judgeSelfReview', () => {
  it('not-claimed when no review was recorded', () => {
    const v = judgeSelfReview({ evidence: {}, ledger: [row('capability:git', 5)] });
    expect(v.verdict).toBe('not-claimed');
    // Even with a real diff read in the ledger: the gate reports what was CLAIMED,
    // it does not award a review the agent never stated.
    expect(v.reviewCalls).toEqual([]);
  });

  it('uncorroborated when the claim rests on prose alone', () => {
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:edit', 1)] });
    expect(v.verdict).toBe('uncorroborated');
    expect(v.reason).toMatch(/prose alone/);
  });

  it('does NOT let incidental traffic corroborate a review', () => {
    // The failure that makes a gate worse than none: manufacturing evidence.
    const v = judgeSelfReview({
      evidence: REVIEWED,
      ledger: [row('coord:send', 4), row('plans:get', 5), row('work_items:get', 6)],
    });
    expect(v.verdict).toBe('uncorroborated');
  });

  it('does not count a refused read as a review', () => {
    const v = judgeSelfReview({
      evidence: REVIEWED,
      ledger: [row('capability:read', 5, 'refused')],
    });
    expect(v.verdict).toBe('uncorroborated');
  });

  it('corroborated when a real read is on the ledger', () => {
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
    expect(v.verdict).toBe('corroborated');
    expect(v.reviewCalls).toHaveLength(1);
  });

  describe('the stale-review check — a review must post-date the last edit', () => {
    it('catches a review that was overtaken by a later edit', () => {
      // Reads as compliant in a transcript: the diff read really happened.
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('capability:edit', 1), row('capability:git', 5), row('capability:edit', 9)],
      });
      expect(v.verdict).toBe('stale-review');
      expect(v.reason).toMatch(/predates the last edit/);
    });

    it('accepts the same history once the diff is re-read after the final edit', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [
          row('capability:edit', 1),
          row('capability:git', 5),
          row('capability:edit', 9),
          row('capability:git', 11),
        ],
      });
      expect(v.verdict).toBe('corroborated');
    });

    it('is not tripped by a failed edit after the review', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('capability:git', 5), row('capability:edit', 9, 'refused')],
      });
      expect(v.verdict).toBe('corroborated');
    });

    it('corroborates a review-only close, where nothing was edited at all', () => {
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:read', 5)] });
      expect(v.verdict).toBe('corroborated');
    });
  });

  describe('pilot measurements (P-007 reads these — they are not pass/fail)', () => {
    it('flags rubber-stamp risk on a corroborated review that found nothing', () => {
      const v = judgeSelfReview({
        evidence: { lookedAt: 'the diff', findings: [] },
        ledger: [row('capability:git', 5)],
      });
      expect(v.verdict).toBe('corroborated'); // still a pass — this is a measurement
      expect(v.rubberStampRisk).toBe(true);
    });

    it('does not flag rubber-stamp risk when the review found something', () => {
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
      expect(v.rubberStampRisk).toBe(false);
    });

    it('reports yieldedChange so a review YIELD can be computed per arm', () => {
      const found = judgeSelfReview({
        evidence: { ...REVIEWED, changedAsResult: ['clamped the bound'] },
        ledger: [row('capability:git', 5)],
      });
      expect(found.yieldedChange).toBe(true);

      const none = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
      expect(none.yieldedChange).toBe(false);
    });

    it('still reports yield on an uncorroborated claim, so the arm is measurable either way', () => {
      const v = judgeSelfReview({
        evidence: { ...REVIEWED, changedAsResult: ['clamped the bound'] },
        ledger: [],
      });
      expect(v.verdict).toBe('uncorroborated');
      expect(v.yieldedChange).toBe(true);
    });
  });

  it('matches a tool name in either the colon or the client-mangled spelling', () => {
    // Same fold the confinement matcher relies on: a denial or a credit that caught only one
    // spelling would be evadable by invoking the other.
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability_git', 5)] });
    expect(v.verdict).toBe('corroborated');
  });
});
