import { describe, it, expect, vi } from 'vitest';

const mockGetPlanRow = vi.fn();
vi.mock('./agent-tools/plans/source', () => ({
  getPlanRow: (...args: unknown[]) => mockGetPlanRow(...args),
}));

import { getClaimTimePlanDecisions, renderPlanDecisionsNote } from './plan-decisions-claim-port';

const PLAN_WITH_DECISIONS = `## Now

State: ready.

## Decisions

### D-001 — A retirement is done when every reference is re-pointed
Date: 2026-07-26
Code removal alone is not enough — dispatch contracts crossing an HTTP
boundary are the invisible fourth reference class.

### D-002 — A ruling other lanes must follow is recorded as a plan Decision at the moment it forms
Date: 2026-07-26
Never only as a coord message — decisions are the auditable substrate;
messages are the notification.
`;

const PLAN_WITHOUT_DECISIONS = `## Now

State: ready.
`;

/**
 * 12 decisions — deliberately OVER the 8 cap, which no fixture here used to be
 * (EI-19396519606401168). The cap was therefore never exercised, and the bug it
 * hid was that `slice(0, 8)` kept the OLDEST eight while the note reported the
 * post-slice length as the total. D-012 below stands in for the real-world case
 * that caught it: a late ruling that DEFERS an item, which a claimer that only
 * sees D-001..D-008 will go ahead and build.
 */
const PLAN_WITH_MANY_DECISIONS = `## Now

State: ready.

## Decisions
${Array.from({ length: 11 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return `### D-${n} — Early ruling ${i + 1}\nDate: 2026-07-26\nBody of early ruling ${i + 1}.\n`;
}).join('\n')}
### D-012 — Do not start P-004; it is deferred
Date: 2026-08-02
P-004 has no evidence behind it. Do not start that phase.
`;

function workItemWithPlan(planSlug: string | null) {
  return {
    payload: planSlug ? { plan_item: { plan_slug: planSlug, item_id: 'P-003' } } : {},
  };
}

describe('getClaimTimePlanDecisions (agent-trap-guards-2026-07-26 P-003b)', () => {
  it('returns null when the work-item carries no plan_item back-pointer', async () => {
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan(null) });
    expect(r).toBeNull();
    expect(mockGetPlanRow).not.toHaveBeenCalled();
  });

  it('returns null when the plan does not resolve', async () => {
    mockGetPlanRow.mockResolvedValueOnce(null);
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('ghost-plan') });
    expect(r).toBeNull();
  });

  it('returns null when the plan has zero decisions (the common case) — stays silent', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITHOUT_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('quiet-plan') });
    expect(r).toBeNull();
  });

  it('surfaces every structured decision, bounded + slug-tagged, when the plan has decisions', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('agent-trap-guards-2026-07-26') });
    expect(r).not.toBeNull();
    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');
    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(r?.decisions[1]?.title).toMatch(/ruling other lanes must follow/);
    // The snippet is a bounded, single-line excerpt of the body — never the raw
    // multi-line markdown.
    expect(r?.decisions[1]?.snippet).not.toMatch(/\n/);
    // Under the cap, the window IS the whole set — so the count a caller renders
    // is honest without any "showing N of M" hedging.
    expect(r?.totalDecisions).toBe(2);
  });

  // EI-19396519606401168 — the cap kept the OLDEST decisions, so a late ruling
  // that defers the very item being claimed never reached the claimer.
  it('over the cap: keeps the MOST RECENT window, not the oldest', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.decisions).toHaveLength(8);
    // The newest 8 of 12 — D-001..D-004 fall out of the window, D-012 survives.
    expect(r?.decisions.map((d) => d.id)).toEqual([
      'D-005', 'D-006', 'D-007', 'D-008', 'D-009', 'D-010', 'D-011', 'D-012',
    ]);
  });

  it('over the cap: a late DEFERRAL ruling reaches the claimer (the regression that motivated this)', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    const deferral = r?.decisions.find((d) => d.id === 'D-012');
    expect(deferral).toBeDefined();
    expect(deferral?.title).toMatch(/deferred/i);
    // Under the old slice(0, 8) this was the observed failure: the last id
    // surfaced was D-008 and the deferral was invisible.
    expect(r?.decisions.at(-1)?.id).not.toBe('D-008');
  });

  it('over the cap: reports the TRUE total so the window cannot read as the whole set', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.totalDecisions).toBe(12);
    // The whole point: total and window length must be independently readable,
    // so a caller can say "8 of 12" instead of announcing 8 as the total.
    expect(r?.totalDecisions).toBeGreaterThan(r!.decisions.length);
  });

  it('keeps an older task-linked ruling ahead of recent unrelated decisions, with exact omitted refs', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_MANY_DECISIONS.replace('Body of early ruling 1.', 'P-003 must preserve the selected route.'),
    });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.decisions.map((d) => d.id)).toEqual([
      'D-001', 'D-006', 'D-007', 'D-008', 'D-009', 'D-010', 'D-011', 'D-012',
    ]);
    expect(r?.taskLinkedDecisions).toBe(1);
    expect(r?.omittedDecisionRefs).toEqual([
      'busy-plan#D-002', 'busy-plan#D-003', 'busy-plan#D-004', 'busy-plan#D-005',
    ]);
    expect(renderPlanDecisionsNote(r!)).toContain('task-linked');
    expect(renderPlanDecisionsNote(r!)).not.toContain('8 MOST RECENT');
  });

  it('matches the complete paperwork authority history and omission manifest in claim decisions', async () => {
    // R19 candidate oracle: literal expected values are independent of the selector.
    // A passing execution is not outside-lineage review of this exact fixture.
    const content = PLAN_WITH_MANY_DECISIONS
      .replace('Body of early ruling 1.', 'P-003 must preserve the selected route.')
      .replaceAll('P-004', 'P-003');
    const restriction = 'P-003 remains paused until the original author accepts the handoff. '
      + 'Retraction: old failed evidence is invalid; retain proof test-run:42. '
      + 'Residue: native delivery; next action: inspect the current source.';
    mockGetPlanRow.mockResolvedValueOnce({
      content, workspaceId: 'ws-paperwork-fixture', harnessSlug: 'papercusp', planSlug: 'busy-plan',
    });
    const lookupAffectedDecisions = vi.fn(async () => ({
      decisions: [{ planSlug: 'parent-plan', decisionId: 'D-900',
        title: 'Current parent authority', body: restriction }],
      totalDecisions: 1,
    }));
    const actual = await getClaimTimePlanDecisions({
      planSlug: 'busy-plan', planItemIds: ['P-003'],
      workspaceId: 'ws-paperwork-fixture', harness: 'papercusp',
      lookupAffectedDecisions,
      loadProvenance: async (_scope, ids) => new Map(ids.map(id => [id, { kind: 'unrecorded' as const }])),
    });
    const expected = {
      planSlug: 'busy-plan',
      decisions: [
        { id: 'D-900', title: 'Current parent authority', snippet: restriction,
          sourcePlanSlug: 'parent-plan', ref: 'parent-plan#D-900', relation: 'affects',
          provenance: { kind: 'unrecorded' } },
        { id: 'D-001', title: 'Early ruling 1', snippet: 'P-003 must preserve the selected route.',
          provenance: { kind: 'unrecorded' } },
        { id: 'D-007', title: 'Early ruling 7', snippet: 'Body of early ruling 7.', provenance: { kind: 'unrecorded' } },
        { id: 'D-008', title: 'Early ruling 8', snippet: 'Body of early ruling 8.', provenance: { kind: 'unrecorded' } },
        { id: 'D-009', title: 'Early ruling 9', snippet: 'Body of early ruling 9.', provenance: { kind: 'unrecorded' } },
        { id: 'D-010', title: 'Early ruling 10', snippet: 'Body of early ruling 10.', provenance: { kind: 'unrecorded' } },
        { id: 'D-011', title: 'Early ruling 11', snippet: 'Body of early ruling 11.', provenance: { kind: 'unrecorded' } },
        { id: 'D-012', title: 'Do not start P-003; it is deferred',
          snippet: 'P-003 has no evidence behind it. Do not start that phase.', provenance: { kind: 'unrecorded' } },
      ],
      taskLinkedDecisions: 2,
      omittedDecisionRefs: ['busy-plan#D-002', 'busy-plan#D-003', 'busy-plan#D-004', 'busy-plan#D-005', 'busy-plan#D-006'],
      omittedDecisionRefsTruncated: false,
      totalDecisions: 13, totalLocalDecisions: 12, totalAffectedDecisions: 1,
      affectedDecisions: 1, authorityReadFailed: false,
    };
    const assertManifest = (candidate: typeof actual) => expect(candidate).toEqual(expected);
    assertManifest(actual);
    expect(lookupAffectedDecisions).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'ws-paperwork-fixture', harnessSlug: 'papercusp', affectedPlanSlug: 'busy-plan', limit: 8,
    });

    // Recover each exact omission from the original source, rather than treating
    // a tally or a searchable/offered reference as delivered history.
    const { parsePlan } = await import('./agent-tools/plans/parser');
    const recovered = actual!.omittedDecisionRefs!.map(ref => {
      const decision = parsePlan(content).decisions.find(row => row.id === ref.split('#')[1]);
      return { ref, body: decision?.body.trim() };
    });
    expect(recovered).toEqual([
      { ref: 'busy-plan#D-002', body: 'Body of early ruling 2.' },
      { ref: 'busy-plan#D-003', body: 'Body of early ruling 3.' },
      { ref: 'busy-plan#D-004', body: 'Body of early ruling 4.' },
      { ref: 'busy-plan#D-005', body: 'Body of early ruling 5.' },
      { ref: 'busy-plan#D-006', body: 'Body of early ruling 6.' },
    ]);

    const missing = structuredClone(actual)!;
    missing.decisions.shift();
    const extra = structuredClone(actual)!;
    extra.decisions.push({ id: 'D-999', title: 'Unrelated task', snippet: 'P-999 only.', provenance: { kind: 'unrecorded' } });
    const clippedRetraction = structuredClone(actual)!;
    clippedRetraction.decisions[0].snippet = 'P-003 remains paused until the original author accepts the handoff.';
    const wrongAuthority = structuredClone(actual)!;
    [wrongAuthority.decisions[0], wrongAuthority.decisions[1]] = [wrongAuthority.decisions[1], wrongAuthority.decisions[0]];
    for (const mutant of [missing, extra, clippedRetraction, wrongAuthority]) {
      expect(() => assertManifest(mutant)).toThrow();
    }
  });

  it('uses direct plan-item scope and excerpts the applicable paragraph beyond the body prefix', async () => {
    const content = PLAN_WITH_MANY_DECISIONS.replace('Body of early ruling 1.',
      `${'Historical preparation details. '.repeat(30)}\n\nP-003 remains paused until the original author releases it.`);
    mockGetPlanRow.mockResolvedValueOnce({ content });
    const r = await getClaimTimePlanDecisions({ planSlug: 'busy-plan', planItemIds: ['P-003'] });
    expect(r?.decisions[0]?.id).toBe('D-001');
    expect(r?.decisions[0]?.snippet).toContain('P-003 remains paused');
    expect(r?.decisions[0]?.snippet.length).toBeLessThanOrEqual(240);
    expect(r?.decisions).toHaveLength(8);
  });

  it('uses canonical physical plan and item identity over a stale payload stamp', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_MANY_DECISIONS.replace('Body of early ruling 1.', 'P-019 preserves the original author.'),
    });
    const r = await getClaimTimePlanDecisions({ workItem: {
      ...workItemWithPlan('old-plan'), sourcePlanSlug: 'current-plan', sourcePlanItemIds: ['P-019'],
    } });
    expect(mockGetPlanRow).toHaveBeenLastCalledWith('current-plan', {});
    expect(r?.decisions[0]?.id).toBe('D-001');
    expect(r?.decisions[0]?.snippet).toContain('P-019 preserves');
  });

  it('retains a newer task-linked superseding ruling when task history exceeds the window', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_MANY_DECISIONS.replaceAll('Body of early ruling', 'P-003 history: body of early ruling')
        .replace('P-004 has no evidence', 'P-003 has no evidence'),
    });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.decisions.at(-1)?.id).toBe('D-012');
    expect(r?.taskLinkedDecisions).toBe(8);
    expect(r?.omittedDecisionRefs).toContain('busy-plan#D-001');
  });

  it('puts source-qualified affected-plan authority before local decisions and warns explicitly', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'target-plan',
    });
    const lookupAffectedDecisions = vi.fn(async () => ({
      decisions: [
        {
          planSlug: 'source-plan',
          decisionId: 'D-900',
          title: 'The target must not launch from staging',
          body: 'This affected-plan ruling supersedes stale local carry prose.',
        },
      ],
      totalDecisions: 1,
    }));
    // P-018 (D-012 item 4): rows are keyed by the decision's OWN plan, so the affected decision
    // is joined against source-plan and the local ones against target-plan.
    const loadProvenance = vi.fn(async (scope: { planSlug: string }, ids: readonly string[]) => {
      const out = new Map<string, { kind: 'agent'; agentId: string; source: 'write'; recordedAt: string } | { kind: 'unrecorded' }>();
      for (const id of ids) out.set(id, { kind: 'unrecorded' });
      if (scope.planSlug === 'source-plan') {
        out.set('D-900', { kind: 'agent', agentId: 'su-x', source: 'write', recordedAt: '2026-10-28T00:00:00.000Z' });
      }
      return out;
    });

    const r = await getClaimTimePlanDecisions({
      planSlug: 'target-plan',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      lookupAffectedDecisions,
      loadProvenance,
    });

    expect(r?.decisions.map((d) => d.id)).toEqual(['D-900', 'D-001', 'D-002']);
    expect(r?.decisions.map((d) => d.provenance.kind)).toEqual(['agent', 'unrecorded', 'unrecorded']);
    expect(loadProvenance).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'source-plan' },
      ['D-900'],
    );
    expect(loadProvenance).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'target-plan' },
      ['D-001', 'D-002'],
    );
    expect(r?.decisions[0]).toMatchObject({
      sourcePlanSlug: 'source-plan',
      ref: 'source-plan#D-900',
      relation: 'affects',
    });
    expect(r).toMatchObject({
      affectedDecisions: 1,
      totalAffectedDecisions: 1,
      totalLocalDecisions: 2,
      authorityReadFailed: false,
    });
    expect(renderPlanDecisionsNote(r!)).toMatch(/^⚠ CROSS-PLAN AUTHORITY CONFLICT\/SUPERSESSION WARNING:/);
    expect(lookupAffectedDecisions).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      affectedPlanSlug: 'target-plan',
      limit: 8,
    });
  });

  it('surfaces an explicit authority-read failure instead of asserting that no affected decision exists', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITHOUT_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'target-plan',
    });
    const r = await getClaimTimePlanDecisions({
      planSlug: 'target-plan',
      lookupAffectedDecisions: async () => {
        throw new Error('column read failed');
      },
    });
    expect(r?.authorityReadFailed).toBe(true);
    expect(r?.decisions).toEqual([]);
    expect(renderPlanDecisionsNote(r!)).toMatch(/^⚠ CROSS-PLAN AUTHORITY READ FAILED/);
  });

  it('P-018: an unscoped row or a failed provenance read reads unavailable, never unrecorded', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const unscoped = await getClaimTimePlanDecisions({ planSlug: 'p' });
    expect(unscoped?.decisions.map((d) => d.provenance.kind)).toEqual(['unavailable', 'unavailable']);

    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'p',
    });
    const failed = await getClaimTimePlanDecisions({
      planSlug: 'p',
      lookupAffectedDecisions: async () => ({ decisions: [], totalDecisions: 0 }),
      loadProvenance: async () => {
        throw new Error('relation missing');
      },
    });
    expect(failed?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(failed?.decisions[0].provenance).toEqual({
      kind: 'unavailable',
      reason: 'provenance read failed: relation missing',
    });
  });

  it('fails soft to null on a lookup error — never throws, never blocks the claim it decorates', async () => {
    mockGetPlanRow.mockRejectedValueOnce(new Error('pg hiccup'));
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('flaky-plan') });
    expect(r).toBeNull();
  });
});

// EI-19963837641363759: plan_items:claim already knows the plan slug from its own
// { plan, item } args — no work-item back-pointer to derive it from (a bare-lease
// claim mints no work_item at all). This pins the direct `planSlug` path the fix added.
describe('getClaimTimePlanDecisions — direct `planSlug` (EI-19963837641363759)', () => {
  it('resolves decisions from `planSlug` alone, with no `workItem` at all', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ planSlug: 'agent-trap-guards-2026-07-26' });
    expect(r).not.toBeNull();
    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');
    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(mockGetPlanRow).toHaveBeenCalledWith('agent-trap-guards-2026-07-26', {});
  });

  it('returns null when `planSlug` is null/undefined and no `workItem` is given either', async () => {
    mockGetPlanRow.mockClear();
    const r1 = await getClaimTimePlanDecisions({ planSlug: null });
    const r2 = await getClaimTimePlanDecisions({});
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mockGetPlanRow).not.toHaveBeenCalled();
  });

  it('`planSlug` wins over a `workItem` back-pointer when both are given', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ planSlug: 'explicit-plan', workItem: workItemWithPlan('back-pointer-plan') });
    expect(r?.planSlug).toBe('explicit-plan');
    expect(mockGetPlanRow).toHaveBeenCalledWith('explicit-plan', {});
  });
});
