/**
 * Wind-down disposition gate — module guard tests (goal-mode-design-intent-
 * hardening-2026-08-16 P-002).
 *
 * The load-bearing assertions:
 *  - the refusal NAMES the missing arg (`disposition`) and ALL THREE legal
 *    values — that wording is the acceptance criterion, because the refused
 *    agent's only way forward is the error text itself;
 *  - disposition → goals.status mapping: achieved/killed flip the row,
 *    handoff leaves it ACTIVE (someone else continues the goal);
 *  - the flag check fails CLOSED (broken flag infra disables the gate) — the
 *    deliberate opposite of drainFleetAutoMintEnabled's fail-open.
 *
 * Falsifiability: the refusal predicate is exercised against a deliberately
 * wrong in-file CONTROL (a refusal that names the arg but not the values), so
 * a test that would accept the control is caught here, not in production.
 *
 * Run: cd packages/operator-core && npx vitest run lib/goals/wind-down-disposition.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modes/store', () => ({ getModeSubject: vi.fn() }));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => {
    throw new Error('unit test must inject `sql` explicitly');
  }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    GOAL_WINDDOWN_DISPOSITION_GATE: 'papercusp-goal-winddown-disposition-gate',
    GOAL_ACHIEVED_ACCEPTANCE_GATE: 'papercusp-goal-achieved-acceptance-gate',
  },
}));

import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { getFlag } from '@papercusp/flags/server';
import { getModeSubject } from '../modes/store';
import { classifyRubricEvidenceCurrentness } from '../rubrics';
import { openEscalation } from '../agent-tools/coordination/escalations';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  buildDispositionRefusal,
  buildGoalWindDownReport,
  deliverGoalWindDownReport,
  evaluateGoalAcceptanceGate,
  goalAchievedAcceptanceGateEnabled,
  isGoalDisposition,
  windDownDispositionGateEnabled,
  type GoalAcceptanceCard,
  type GoalAcceptanceGateDeps,
} from './wind-down-disposition';

const getModeSubjectMock = getModeSubject as unknown as ReturnType<typeof vi.fn>;
const openEscalationMock = openEscalation as unknown as ReturnType<typeof vi.fn>;
const getFlagMock = getFlag as unknown as ReturnType<typeof vi.fn>;

/** A recording SQL tag: captures every call's template + values, answers from a queue. */
function recordingSql(rows: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue = [...rows];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('␣'), values });
    return queue.shift() ?? [];
  }) as unknown as GoalSqlTag;
  return { tag, calls };
}

beforeEach(() => {
  getModeSubjectMock.mockReset();
  openEscalationMock.mockReset();
  openEscalationMock.mockResolvedValue({});
  getFlagMock.mockReset();
});

describe('the disposition vocabulary', () => {
  it('is exactly achieved | killed | handoff', () => {
    expect(GOAL_DISPOSITIONS).toEqual(['achieved', 'killed', 'handoff']);
    for (const d of GOAL_DISPOSITIONS) expect(isGoalDisposition(d)).toBe(true);
    expect(isGoalDisposition('paused')).toBe(false);
    expect(isGoalDisposition(undefined)).toBe(false);
  });
});

describe('buildDispositionRefusal — the acceptance wording', () => {
  /** The acceptance predicate, shared with the control below. */
  const namesArgAndAllValues = (refusal: { error: string }) =>
    /\bdisposition\b/.test(refusal.error) &&
    GOAL_DISPOSITIONS.every((d) => refusal.error.includes(`'${d}'`));

  it('names the missing arg AND all three values, for both wind-down verbs', () => {
    for (const action of ['loop:end', 'session:end'] as const) {
      const refusal = buildDispositionRefusal({
        action,
        goalId: 'ship-paid-app-3f9a1c',
        goalTitle: 'Ship the paid app',
      });
      expect(refusal.ok).toBe(false);
      expect(namesArgAndAllValues(refusal)).toBe(true);
      expect(refusal.error).toContain(action);
      expect(refusal.error).toContain('ship-paid-app-3f9a1c');
      expect(refusal.goalId).toBe('ship-paid-app-3f9a1c');
      expect(refusal.dispositions).toEqual(GOAL_DISPOSITIONS);
    }
  });

  it('CONTROL: the predicate rejects a refusal that names the arg but not the values', () => {
    // Deliberately-wrong control implementation, kept permanently: proves the
    // predicate above can fail, so a green run means the real wording earned it.
    const control = { error: 'REFUSED — pass a disposition and retry.' };
    expect(namesArgAndAllValues(control)).toBe(false);
    const controlMissingArg = { error: "Pass 'achieved', 'killed' or 'handoff'." };
    expect(namesArgAndAllValues(controlMissingArg)).toBe(false);
  });
});

describe('buildGoalWindDownReport', () => {
  const base = {
    goalId: 'g-1',
    goalTitle: 'Ship the paid app',
    endedBy: 'su-abc',
    action: 'loop:end' as const,
  };

  it('folds the end reason AND the final carry-note into the body', () => {
    const { summary, body } = buildGoalWindDownReport({
      ...base,
      disposition: 'achieved',
      reason: 'all 13 items shipped',
      carryNote: '## Did\neverything\n## Left\nnothing',
    });
    expect(summary).toContain('achieved');
    expect(summary).toContain('Ship the paid app');
    expect(body).toContain('all 13 items shipped');
    expect(body).toContain('## Final carry-note');
    expect(body).toContain('everything');
    expect(body).toContain('loop:end');
  });

  it('handoff reads as a continuation, not an ending, and names the successor', () => {
    const { summary, body } = buildGoalWindDownReport({
      ...base,
      disposition: 'handoff',
      handoffTo: 'su-next',
    });
    expect(summary).toContain('handoff');
    expect(summary).toContain('su-next');
    expect(summary).toContain('stays active');
    expect(body).toContain('su-next');
  });

  it('says explicitly when there was no reason and no carry-note, instead of an empty body', () => {
    const { body } = buildGoalWindDownReport({ ...base, disposition: 'killed' });
    expect(body).toMatch(/No end reason or carry-note/);
  });
});

describe('applyGoalDisposition — disposition → goals.status mapping', () => {
  it.each([
    ['achieved', 'achieved'],
    ['killed', 'killed'],
  ] as const)('%s flips goals.status to %s', async (disposition, expectedStatus) => {
    const { tag, calls } = recordingSql();
    await applyGoalDisposition({
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition,
      dispositionBy: 'su-abc',
      sql: tag,
    });
    expect(calls).toHaveLength(1);
    // COALESCE(${nextStatus}::text, status): the first value IS the new status.
    expect(calls[0].values[0]).toBe(expectedStatus);
    // Param order (P-021): [nextStatus, outputs, stamp, goalId, workspaceId].
    // No outputs supplied ⇒ null into COALESCE, so an earlier record survives.
    expect(calls[0].values[1]).toBeNull();
    const stamp = JSON.parse(String(calls[0].values[2])) as Record<string, unknown>;
    expect(stamp.disposition).toBe(disposition);
    expect(stamp.dispositionBy).toBe('su-abc');
    expect(typeof stamp.dispositionAt).toBe('string');
    expect(calls[0].text).toContain('updated_at = now()');
    // Multi-tenant scoping: id AND workspace ride the WHERE.
    expect(calls[0].values).toContain('g-1');
    expect(calls[0].values).toContain('ws-1');
  });

  it('handoff leaves goals.status untouched (null into COALESCE) and stamps handoffTo', async () => {
    const { tag, calls } = recordingSql();
    await applyGoalDisposition({
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition: 'handoff',
      dispositionBy: 'su-abc',
      handoffTo: 'su-next',
      sql: tag,
    });
    expect(calls[0].values[0]).toBeNull();
    const stamp = JSON.parse(String(calls[0].values[2])) as Record<string, unknown>;
    expect(stamp.disposition).toBe('handoff');
    expect(stamp.handoffTo).toBe('su-next');
    // A handoff keeps status active but is still a lifecycle transition: goal
    // recency must reflect when stewardship actually changed.
    expect(calls[0].text).toContain('updated_at = now()');
  });

  it('records validated outputs as the second param (P-021) — JSON when supplied', async () => {
    const { tag, calls } = recordingSql();
    await applyGoalDisposition({
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition: 'achieved',
      dispositionBy: 'su-abc',
      outputs: { shipped: true },
      sql: tag,
    });
    expect(JSON.parse(String(calls[0].values[1]))).toEqual({ shipped: true });
  });
});

describe('activeGoalForOwner — positive-finding-only resolution', () => {
  it('returns null (and never queries goals) when the owner is not in GOAL mode', async () => {
    getModeSubjectMock.mockResolvedValue(null);
    const { tag, calls } = recordingSql();
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns the goal ref (with any recorded disposition) for an active goal', async () => {
    getModeSubjectMock.mockResolvedValue('g-1');
    const { tag } = recordingSql([
      [
        {
          id: 'g-1',
          title: 'Ship it',
          install_slug: 'papercusp',
          disposition: null,
          output_schema: { fields: { url: 'string' } },
        },
      ],
    ]);
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toEqual({
      goalId: 'g-1',
      title: 'Ship it',
      installSlug: 'papercusp',
      recordedDisposition: null,
      // P-021: the resolver carries the goal's output_schema so wind-down can
      // validate reported outputs against it without a second read.
      outputSchema: { fields: { url: 'string' } },
    });
  });

  it('returns null when the goal row is no longer active (already achieved/killed/paused)', async () => {
    getModeSubjectMock.mockResolvedValue('g-1');
    const { tag } = recordingSql([[]]);
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
  });

  it('treats a mode-subject read error as "no goal" — resolution misses never refuse', async () => {
    getModeSubjectMock.mockRejectedValue(new Error('pg down'));
    const { tag, calls } = recordingSql();
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('deliverGoalWindDownReport — the owner inbox surface', () => {
  it('opens an advisory escalation deduped per goal', async () => {
    const identity = { ownerId: 'su-abc', ownerLabel: 'su · abc' };
    await deliverGoalWindDownReport(identity as never, {
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition: 'achieved',
      summary: 'Goal wind-down [achieved]: Ship it',
      body: 'the report',
    });
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [gotIdentity, input] = openEscalationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(gotIdentity).toBe(identity);
    expect(input.severity).toBe('advisory');
    const meta = input.meta as Record<string, unknown>;
    expect(meta.dedupKind).toBe('goal-wind-down');
    expect(meta.subjectSignature).toBe('ws-1:g-1');
  });
});

describe('windDownDispositionGateEnabled — FAIL-CLOSED', () => {
  it('reflects the flag when the read works', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await windDownDispositionGateEnabled()).toBe(true);
    getFlagMock.mockResolvedValue(false);
    expect(await windDownDispositionGateEnabled()).toBe(false);
  });

  it('disables the gate on flag-infra errors — a refusal gate must never wedge the stop path', async () => {
    getFlagMock.mockRejectedValue(new Error('flag store unreachable'));
    expect(await windDownDispositionGateEnabled()).toBe(false);
  });
});

// ─── the 'achieved' acceptance gate (consult-min-max-…-2026-08-17 P-009 / D-004 §2) ──
describe("evaluateGoalAcceptanceGate — 'achieved' is a claim needing acceptance evidence", () => {
  const GOAL = {
    goalId: 'ship-a-paid-app-abc123',
    goalTitle: 'Ship a paid app',
    goalOwner: 'su-goal-owner',
    workspaceId: 'test-ws',
  };
  const card = (over: Partial<GoalAcceptanceCard> = {}): GoalAcceptanceCard => ({
    createdBy: 'su-goal-owner',
    rubricRevision: 3,
    criteriaHash: 'criteria-hash-current',
    rubricResolved: true,
    missingKeys: [],
    synthesized: false,
    ...over,
  });
  const vettedCard = (over: Partial<GoalAcceptanceCard> = {}): GoalAcceptanceCard =>
    card({
      vetting: { consultId: 'conv-vet-1', rubricRevision: 3, criteriaHash: 'criteria-hash-current' },
      ...over,
    });
  /** Default deps: rubric exists (authored by the goal owner), meta registered,
   *  revision 3, no scorecards anywhere — each test overrides the leg it exercises. */
  const deps = (over: Partial<GoalAcceptanceGateDeps> = {}): GoalAcceptanceGateDeps => ({
    gateEnabled: async () => true,
    getRubricForGoal: async () => ({
      rubricId: 'ship-a-paid-app-acceptance',
      revision: 3,
      criteriaHash: 'criteria-hash-current',
      criteria: [{ key: 'outcome-1' }],
      proposedBy: 'su-goal-owner',
    }),
    getMetaRubric: async () => ({}),
    getRubricRevision: async () => 3,
    classifyRubricCurrentness: classifyRubricEvidenceCurrentness,
    listCards: async () => [],
    metaRubricId: 'meta-acceptance-rubric',
    areLineageRelated: async (first, second) => first === second,
    ...over,
  });
  /** listCards stub answering the meta (vetting) and rubric (grading) reads separately. */
  const cardsByRef = (meta: GoalAcceptanceCard[], grades: GoalAcceptanceCard[]) =>
    async ({ rubricRef }: { rubricRef: string }) => (rubricRef === 'meta-acceptance-rubric' ? meta : grades);

  it('flag OFF → satisfied without probing anything', async () => {
    const getRubricForGoal = vi.fn();
    const v = await evaluateGoalAcceptanceGate(GOAL, deps({ gateEnabled: async () => false, getRubricForGoal }));
    expect(v).toEqual({ satisfied: true });
    expect(getRubricForGoal).not.toHaveBeenCalled();
  });

  it('no acceptance rubric names the goal → refused, and the message carries the whole repair flow', async () => {
    const v = await evaluateGoalAcceptanceGate(GOAL, deps({ getRubricForGoal: async () => null }));
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_rubric_missing');
    // The refused agent's only way forward is this text: it must name the propose
    // call with subjectGoal, the vetting step, the non-owner grading, AND the honest
    // alternatives (killed/handoff).
    expect(v.message).toContain(`subjectGoal:'${GOAL.goalId}'`);
    expect(v.message).toContain('rubrics:propose');
    expect(v.message).toContain('meta-acceptance-rubric');
    expect(v.message).toContain('NON-owner');
    expect(v.message).toMatch(/'killed' \/ 'handoff'/);
  });

  it('rubric never vetted → refused with the vet-first flow (consult, then attest)', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([], [card({ createdBy: 'su-peer' })]) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_rubric_unvetted');
    expect(v.message).toContain('get_feedback');
    expect(v.message).toContain('vettingConsult');
  });

  it('vetted at a STALE revision → refused with the re-emit variant (same-consult re-emit allowed)', async () => {
    const staleVet = vettedCard({ vetting: { consultId: 'conv-vet-1', rubricRevision: 2 } });
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([staleVet], [card({ createdBy: 'su-peer' })]) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_rubric_unvetted');
    expect(v.message).toContain('Re-emit');
  });

  it('reuses vetting across a revision-only edit when the criteria hash is unchanged', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        listCards: cardsByRef(
          [vettedCard({
            vetting: { consultId: 'conv-vet-1', rubricRevision: 2, criteriaHash: 'criteria-hash-current' },
          })],
          [card({ createdBy: 'su-peer' })],
        ),
      }),
    );

    expect(v.satisfied).toBe(true);
  });

  it('invalidates same-revision vetting when the criteria or method identity changes', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        listCards: cardsByRef(
          [vettedCard({
            vetting: { consultId: 'conv-vet-1', rubricRevision: 3, criteriaHash: 'criteria-hash-old' },
          })],
          [card({ createdBy: 'su-peer' })],
        ),
      }),
    );

    expect(v.code).toBe('goal_acceptance_rubric_unvetted');
  });

  it('a meta-grade WITHOUT a linked consult is not a vetting', async () => {
    const plainMetaGrade = card({ createdBy: 'su-goal-owner' }); // no vetting.consultId
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([plainMetaGrade], [card({ createdBy: 'su-peer' })]) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_rubric_unvetted');
  });

  it('no meta-rubric registered → the vetting check disables (never deadlocks) and grading still gates', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ getMetaRubric: async () => null, listCards: cardsByRef([], []) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_ungraded');
  });

  it('vetted but ungraded → refused naming the non-owner grading step', async () => {
    const v = await evaluateGoalAcceptanceGate(GOAL, deps({ listCards: cardsByRef([vettedCard()], []) }));
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_ungraded');
    expect(v.message).toContain(GOAL.goalOwner);
    expect(v.message).toContain('scorecards:emit');
  });

  it('incomplete / synthesized cards do not count as a grading', async () => {
    const incomplete = card({ createdBy: 'su-peer', missingKeys: ['outcome-1'] });
    const synthesized = card({ createdBy: 'su-peer', synthesized: true });
    const unresolved = card({ createdBy: 'su-peer', rubricResolved: false });
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([vettedCard()], [incomplete, synthesized, unresolved]) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_acceptance_ungraded');
  });

  it('graded ONLY by the goal owner → self-graded refusal', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([vettedCard()], [card({ createdBy: 'su-goal-owner' })]) }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_self_graded_only');
  });

  it("graded only by the RUBRIC's author (≠ goal owner) is still self-graded homework", async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        getRubricForGoal: async () => ({
          rubricId: 'ship-a-paid-app-acceptance',
          revision: 3,
          criteriaHash: 'criteria-hash-current',
          criteria: [{ key: 'outcome-1' }],
          proposedBy: 'su-rubric-author',
        }),
        listCards: cardsByRef([vettedCard()], [card({ createdBy: 'su-rubric-author' })]),
      }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_self_graded_only');
  });

  it('rejects a grader descended from the goal owner even when its owner id differs', async () => {
    const areLineageRelated = vi.fn(async (first: string | null | undefined, second: string | null | undefined) =>
      first === 'su-goal-owner' && second === 'su-goal-child',
    );
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        areLineageRelated,
        listCards: cardsByRef([vettedCard()], [card({ createdBy: 'su-goal-child' })]),
      }),
    );
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('goal_self_graded_only');
    expect(areLineageRelated).toHaveBeenCalledWith('su-goal-owner', 'su-goal-child', { workspaceId: 'test-ws' });
  });

  it('rejects a grader descended from the rubric author but accepts a sibling grader', async () => {
    const areLineageRelated = vi.fn(
      async (first: string | null | undefined, second: string | null | undefined) =>
        first === 'su-rubric-author' && second === 'su-rubric-child',
    );
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        areLineageRelated,
        getRubricForGoal: async () => ({
          rubricId: 'ship-a-paid-app-acceptance',
          revision: 3,
          criteriaHash: 'criteria-hash-current',
          criteria: [{ key: 'outcome-1' }],
          proposedBy: 'su-rubric-author',
        }),
        listCards: cardsByRef(
          [vettedCard()],
          [card({ createdBy: 'su-rubric-child' }), card({ createdBy: 'su-sibling-grader' })],
        ),
      }),
    );
    expect(v).toEqual({
      satisfied: true,
      rubricId: 'ship-a-paid-app-acceptance',
      gradedBy: 'su-sibling-grader',
    });
  });

  it('vetted on the current revision + independently graded → satisfied with provenance', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({ listCards: cardsByRef([vettedCard()], [card({ createdBy: 'su-independent-peer' })]) }),
    );
    expect(v).toEqual({
      satisfied: true,
      rubricId: 'ship-a-paid-app-acceptance',
      gradedBy: 'su-independent-peer',
    });
  });

  it('reuses independent grading across a revision-only edit when criteria are unchanged', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        listCards: cardsByRef(
          [vettedCard()],
          [card({ createdBy: 'su-independent-peer', rubricRevision: 2, criteriaHash: 'criteria-hash-current' })],
        ),
      }),
    );

    expect(v.satisfied).toBe(true);
  });

  it('invalidates independent grading at the same revision when criteria changed', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        listCards: cardsByRef(
          [vettedCard()],
          [card({ createdBy: 'su-independent-peer', rubricRevision: 3, criteriaHash: 'criteria-hash-old' })],
        ),
      }),
    );

    expect(v.code).toBe('goal_acceptance_ungraded');
  });

  it('criteria hash keeps vetting current when the revision read is null', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        getRubricRevision: async () => null,
        listCards: cardsByRef(
          [vettedCard({
            vetting: { consultId: 'conv-vet-1', rubricRevision: 1, criteriaHash: 'criteria-hash-current' },
          })],
          [card({ createdBy: 'su-independent-peer' })],
        ),
      }),
    );
    expect(v.satisfied).toBe(true);
  });

  it('a probe FAULT resolves toward satisfied — positive-finding-only on the stop path', async () => {
    const v = await evaluateGoalAcceptanceGate(
      GOAL,
      deps({
        getRubricForGoal: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(v).toEqual({ satisfied: true });
  });
});

describe('goalAchievedAcceptanceGateEnabled — fail-CLOSED like its disposition sibling', () => {
  it('reads FLAGS.GOAL_ACHIEVED_ACCEPTANCE_GATE', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await goalAchievedAcceptanceGateEnabled()).toBe(true);
    expect(getFlagMock).toHaveBeenCalledWith('papercusp-goal-achieved-acceptance-gate', 'system');
  });

  it('disables on flag-infra errors — never wedge an agent stopping its own loop', async () => {
    getFlagMock.mockRejectedValue(new Error('flag store unreachable'));
    expect(await goalAchievedAcceptanceGateEnabled()).toBe(false);
  });
});
