/**
 * goals:propose — the contract-bearing door for a goal PROPOSAL
 * (goal-mode-2026-08-07 P-022, ruling D-024).
 *
 * This tool writes nothing, so there is no schema to punish a mistake here —
 * which is exactly why its refusals need pinning. Everything it guards is a
 * proposal that would RENDER as a confirm card the owner cannot sensibly act
 * on, and each failure is silent by construction:
 *
 *  - a `relationship` naming an existing thing WITHOUT a ref renders a card
 *    that says "sub-goal" and cannot say of what;
 *  - `new-top-level` WITH a ref is the contradiction the contract calls out —
 *    if something already targets the goal, the kind is one of the other three;
 *  - a placeholder kill criterion ("TBD") is the blank menu wearing a sentence,
 *    and the criterion is the only thing that can ever stop a goal.
 *
 * The last one is deliberately a SHAPE check, not a judgement of substance —
 * these tests pin that boundary in both directions so a later tightening
 * doesn't quietly start rejecting weak-but-real criteria.
 */

import { describe, expect, it } from 'vitest';
import tool, { GOAL_RELATIONSHIP_KINDS, GoalProposalSchema, validateProposal } from './propose';

const REL = (over: Record<string, unknown> = {}) => ({
  kind: 'new-top-level',
  why: 'nothing in the portfolio targets this outcome',
  ...over,
});

const PROPOSAL = (over: Record<string, unknown> = {}) =>
  GoalProposalSchema.parse({
    title: 'Ship a paid iOS app to the App Store',
    killCriterion: 'no TestFlight build accepted by 2026-09-01',
    budgetCents: 250_000,
    relationship: REL(),
    ...over,
  });

/** The handler ignores ctx entirely (it writes nothing), but the signature wants one. */
const CTX = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', log: () => {} };

type Res = { data: unknown; degraded?: boolean; degradedReasons?: string[] };
const call = async (args: unknown): Promise<Res> =>
  (await tool.handler(args as never, CTX as never)) as Res;

describe('goals:propose — tripwire advisories (WI-10004424)', () => {
  it('flags a platform-shaped tripwire that no resolver measures, before the owner confirms it', async () => {
    const res = await call(
      PROPOSAL({ tripwires: [{ metric: 'spend_usd_week', label: 'weekly spend', threshold: 100 }] }),
    );
    const data = res.data as { tripwire_advisories?: Array<{ suggestedMetric: string | null }> };
    expect(data.tripwire_advisories?.map((a) => a.suggestedMetric)).toEqual(['spend_usd_7d']);
  });

  it('omits the field when every tripwire is measured', async () => {
    const res = await call(PROPOSAL({ tripwires: [{ metric: 'spend_usd', label: 'spend', threshold: 100 }] }));
    expect(res.data).not.toHaveProperty('tripwire_advisories');
  });
});

describe('goals:propose — validateProposal', () => {
  it('passes a well-formed new-top-level proposal', () => {
    expect(validateProposal(PROPOSAL())).toEqual([]);
  });

  it('requires a ref for every kind that names something existing', () => {
    for (const kind of ['plan-in-existing-pot', 'sub-goal', 'sibling-goal'] as const) {
      const problems = validateProposal(PROPOSAL({ relationship: REL({ kind }) }));
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain('relationship.ref');
      expect(problems[0]).toContain(kind);
    }
  });

  it('accepts those kinds once a ref is supplied', () => {
    for (const kind of ['plan-in-existing-pot', 'sub-goal', 'sibling-goal'] as const) {
      expect(
        validateProposal(PROPOSAL({ relationship: REL({ kind, ref: 'GOAL-7' }) })),
      ).toEqual([]);
    }
  });

  it('rejects new-top-level WITH a ref — the contradiction the contract names', () => {
    const problems = validateProposal(
      PROPOSAL({ relationship: REL({ kind: 'new-top-level', ref: 'GOAL-7' }) }),
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('new-top-level');
  });

  it('rejects placeholder kill criteria', () => {
    for (const killCriterion of [
      'TBD',
      'tbd once we know more',
      'N/A',
      'n/a',
      'none',
      'unknown',
      'TODO: decide this later',
    ]) {
      const problems = validateProposal(PROPOSAL({ killCriterion }));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join(' ')).toContain('states no abandonment condition');
    }
  });

  it('rejects a criterion too short to state a condition', () => {
    expect(validateProposal(PROPOSAL({ killCriterion: 'no sales' })).length).toBe(1);
  });

  it('accepts a weak-but-real criterion — this is a SHAPE check, not a judgement', () => {
    // 12+ chars and not a placeholder prefix. Pinning the permissive side too,
    // so a later tightening cannot quietly start refusing real criteria.
    expect(validateProposal(PROPOSAL({ killCriterion: 'nobody buys it' }))).toEqual([]);
  });

  it('does not trip on a criterion that merely CONTAINS a placeholder word', () => {
    // The regex is prefix-anchored on purpose: "unknown" mid-sentence is real prose.
    expect(
      validateProposal(PROPOSAL({ killCriterion: 'demand remains unknown after 200 installs' })),
    ).toEqual([]);
  });

  it('reports BOTH problems when a proposal has a relationship and a criterion fault', () => {
    const problems = validateProposal(
      PROPOSAL({ relationship: REL({ kind: 'sub-goal' }), killCriterion: 'TBD' }),
    );
    expect(problems.length).toBe(2);
  });
});

describe('goals:propose — arg schema', () => {
  it('enumerates exactly the four relationship kinds the kickoff contract names', () => {
    expect([...GOAL_RELATIONSHIP_KINDS]).toEqual([
      'plan-in-existing-pot',
      'sub-goal',
      'sibling-goal',
      'new-top-level',
    ]);
  });

  it('REQUIRES killCriterion and budgetCents — the two values a blank form degrades', () => {
    // Both are optional on goals:create by design; this is the contract-bearing
    // door, so omitting one here is a caller bug rather than a degraded mode.
    expect(() => PROPOSAL({ killCriterion: undefined })).toThrow();
    expect(() => PROPOSAL({ budgetCents: undefined })).toThrow();
  });

  it('REQUIRES a relationship, with a kind and a why', () => {
    expect(() => PROPOSAL({ relationship: undefined })).toThrow();
    expect(() => PROPOSAL({ relationship: { kind: 'sub-goal', ref: 'GOAL-7' } })).toThrow();
    expect(() => PROPOSAL({ relationship: { why: 'because' } })).toThrow();
  });

  it('rejects an unknown relationship kind rather than passing it through', () => {
    expect(() => PROPOSAL({ relationship: REL({ kind: 'somewhat-related' }) })).toThrow();
  });

  it('rejects a non-integer or negative ceiling, and accepts zero', () => {
    expect(() => PROPOSAL({ budgetCents: -1 })).toThrow();
    expect(() => PROPOSAL({ budgetCents: 12.5 })).toThrow();
    expect(PROPOSAL({ budgetCents: 0 }).budgetCents).toBe(0);
  });

  it('rejects an empty title', () => {
    expect(() => PROPOSAL({ title: '' })).toThrow();
  });

  it('carries optional body and tripwires through', () => {
    const p = PROPOSAL({
      body: 'what winning looks like',
      tripwires: [{ metric: 'days_elapsed', label: 'Day 12 of 30', threshold: 30, unit: 'days' }],
    });
    expect(p.body).toBe('what winning looks like');
    expect(p.tripwires?.length).toBe(1);
  });
});

describe('goals:propose — handler', () => {
  it('returns degraded with the reasons instead of presenting an unconfirmable card', async () => {
    const res = await call(PROPOSAL({ relationship: REL({ kind: 'sub-goal' }) }));
    expect(res.degraded).toBe(true);
    expect(res.data).toBeNull();
    expect(res.degradedReasons?.length).toBe(1);
  });

  it('presents a valid proposal and echoes the four values back', async () => {
    const res = await call(PROPOSAL({ relationship: REL({ kind: 'sub-goal', ref: 'GOAL-7' }) }));
    expect(res.degraded).toBeFalsy();
    const data = res.data as {
      presented: boolean;
      proposal: {
        title: string;
        kill_criterion: string;
        budget_cents: number;
        relationship: { kind: string; ref?: string };
        tripwires: unknown;
      };
      next: string;
    };
    expect(data.presented).toBe(true);
    expect(data.proposal.title).toBe('Ship a paid iOS app to the App Store');
    expect(data.proposal.kill_criterion).toBe('no TestFlight build accepted by 2026-09-01');
    expect(data.proposal.budget_cents).toBe(250_000);
    expect(data.proposal.relationship.kind).toBe('sub-goal');
    expect(data.proposal.relationship.ref).toBe('GOAL-7');
    expect(data.proposal.tripwires).toBeNull();
  });

  it('tells the agent NOT to also create the goal — the card does the write', async () => {
    // Without this the agent double-writes: it proposes, then creates anyway,
    // and the owner's edits on the card land on a second row.
    const res = await call(PROPOSAL());
    const next = (res.data as { next: string }).next;
    expect(next).toContain('do NOT call goals:create yourself');
    expect(next).toContain('terminal-only');
  });

  it('writes nothing — the tool takes no tx and touches no table', async () => {
    // Proving the negative cheaply: a ctx with a tx that throws if touched.
    const res = (await tool.handler(PROPOSAL() as never, {
      ...CTX,
      tx: () => {
        throw new Error('goals:propose must not query — it is a read-through proposal');
      },
    } as never)) as Res;
    expect((res.data as { presented: boolean }).presented).toBe(true);
  });
});
