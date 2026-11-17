import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlanIndexRow } from './agent-tools/plans/source';
import {
  UNSHIPPED_PLANS_AUDIT_CLASSIFIER_REVISION,
  blockerEvidenceForPlan,
  buildUnshippedPlansAuditManifest,
  classifyUnshippedPlan,
  hasExplicitPlanLevelSupersession,
  renderUnshippedPlansAuditHtml,
  selectAuditPlans,
  type AuditOwnerEvidence,
  type ClassifierInput,
} from './unshipped-plans-audit';

function plan(overrides: Partial<PlanIndexRow> = {}): PlanIndexRow {
  return {
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    contentHash: 'hash-a',
    version: 1,
    title: 'Plan A',
    status: 'active',
    created: '2026-08-20',
    updated: '2026-08-20',
    owner: null,
    initiative: null,
    template: null,
    templateData: null,
    inputSchema: null,
    isBlenderOrigin: false,
    supersedes: [],
    supersededBy: null,
    opStatus: null,
    opStartedAt: null,
    opUpdatedAt: null,
    currentWave: null,
    opPriority: null,
    archived: false,
    isLegacy: false,
    updatedAt: '2026-08-20T12:00:00.000Z',
    items: [
      {
        id: 'P-001',
        status: 'todo',
        text: 'Do the work',
        importance: 'normal',
        blockedBy: [],
        decisionRefs: [],
        phase: null,
      },
    ],
    decisions: [],
    nowState: 'Active',
    nowNext: 'Do the work.',
    promotePolicy: null,
    forcedPast: null,
    schedule: null,
    scheduleActive: false,
    scheduledAt: null,
    expiresAt: null,
    tzid: null,
    templateSlug: null,
    runSeq: null,
    ...overrides,
  } as PlanIndexRow;
}

function input(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    plan: plan(),
    registeredHarness: true,
    owners: [],
    workItems: [],
    blocker: { typedBlocked: false, typedHuman: false, refs: [], staleHints: [] },
    itemCounts: { todo: 1 },
    audit: null,
    acceptanceRubric: null,
    gateVerdict: null,
    ...overrides,
  };
}

describe('classifier revision 4', () => {
  it.each([
    ['agent-managed-compaction-2026-07-01', 'Agent-managed compaction', 'Run a live launch smoke after implementing the watchdog.'],
    ['bug-queue-legitimacy-and-actionable-validation-2026-10-10', 'Truthful bug queue categories', 'The canonical clause smoke passes; finish validation.'],
    ['design-acceptance-journey-enforcement-2026-09-08', 'Bind approved UI designs to navigation and shipment evidence', 'Implement the independent canary census.'],
    ['shared-vector-search-libraries-2026-09-29', 'Move vector-search machinery into shared libraries', 'Run fixture-host tests for the libraries.'],
    ['repair-fixture-classification-2026-11-17', 'Repair fixture classification in product audits', 'Implement the product repair and regression tests.'],
  ])('keeps product plan %s out of fixture retirement', (planSlug, title, nowNext) => {
    const row = classifyUnshippedPlan(input({
      plan: plan({ planSlug, title, nowState: `Implementation is active. ${nowNext}`, nowNext }),
    }));
    expect(row.category).not.toBe('supersede-or-archive-fixture');
  });

  it.each([
    ['goal-brief-r3-probe-fixture-2026-09-30', 'Goal-brief R-3 live-probe fixture',
      'Fixture for the goal-brief R-3 live probe. Its only purpose is to be placed by a goal holder.'],
    ['lane-7-draft-pr-proposal-smoke-2026-06-18', 'Lane 7 draft-PR proposal smoke',
      'Proposal created via apply-plan-block to test the draft-PR proposal to review to promote path.'],
    ['synthetic-plan-2026-11-17', 'Synthetic workflow plan',
      'This plan is a test-only fixture for exercising the workflow.'],
  ])('retains the explicit test-only purpose of %s', (planSlug, title, nowState) => {
    const candidate = plan({ planSlug, title, nowState });
    expect(classifyUnshippedPlan(input({ plan: candidate })).category).toBe('supersede-or-archive-fixture');
    expect(classifyUnshippedPlan(input({
      plan: { ...candidate, nowState: 'This plan is superseded by replacement-plan.' },
    })).category).toBe('supersede-documented');
    expect(classifyUnshippedPlan(input({
      plan: candidate,
      owners: [{ ownerId: 'su-live', ownerLabel: null, fleet: null, intent: 'Run the probe', source: 'work-item-hold' }],
    })).category).toBe('ongoing-protected');
  });

  it('requires an explicit plan-subject supersession assertion', () => {
    expect(hasExplicitPlanLevelSupersession('This plan is superseded by plan-b.')).toBe(true);
    expect(hasExplicitPlanLevelSupersession('Superseded: replaced by plan-b.')).toBe(true);
    expect(hasExplicitPlanLevelSupersession('D-004 superseded the old approach.')).toBe(false);
    expect(hasExplicitPlanLevelSupersession('The superseded decision is retained for history.')).toBe(false);

    const explicit = classifyUnshippedPlan(
      input({
        plan: plan({ nowState: 'This plan is superseded by plan-b.' }),
      }),
    );
    expect(explicit.category).toBe('supersede-documented');

    const decisionOnly = classifyUnshippedPlan(
      input({
        plan: plan({ nowState: 'D-004 superseded the old approach.' }),
      }),
    );
    expect(decisionOnly.category).not.toBe('supersede-documented');
  });

  it('protects live-owned plans before every cleanup-oriented classification', () => {
    const owners: AuditOwnerEvidence[] = [
      {
        ownerId: 'su-live',
        ownerLabel: 'live agent',
        fleet: null,
        intent: 'finish P-005',
        source: 'work-item-hold',
      },
    ];
    const row = classifyUnshippedPlan(
      input({
        plan: plan({ nowState: 'This plan is superseded by plan-b.' }),
        registeredHarness: false,
        owners,
      }),
    );

    expect(row.category).toBe('ongoing-protected');
    expect(row.owners).toEqual(owners);
  });

  it('separates stale typed blockers, current human blockers, and ledger contradictions', () => {
    expect(
      classifyUnshippedPlan(
        input({
          blocker: { typedBlocked: true, typedHuman: true, refs: ['P-000'], staleHints: ['P-000 is done'] },
        }),
      ).category,
    ).toBe('typed-blocker-stale-hint');

    expect(
      classifyUnshippedPlan(
        input({
          blocker: { typedBlocked: true, typedHuman: true, refs: ['human:owner'], staleHints: [] },
        }),
      ).category,
    ).toBe('typed-human-blocker');

    expect(
      classifyUnshippedPlan(
        input({
          itemCounts: { done: 1 },
          workItems: [{ sourcePlanSlug: 'plan-a', status: 'open', holder: null }],
        }),
      ).category,
    ).toBe('ledger-contradiction');
  });

  it('derives typed issue blockers from the canonical plan-item overlay', () => {
    const evidence = blockerEvidenceForPlan(plan(), new Map([['plan-a#P-001', ['EI-123']]]));

    expect(evidence.itemCounts).toMatchObject({ blocked: 1 });
    expect(evidence.blocker).toMatchObject({
      typedBlocked: true,
      typedHuman: false,
      refs: ['EI-123'],
    });
  });

  it('requires blocker-shaped Now syntax instead of incidental slug/title/product vocabulary', () => {
    const falsePositives = [
      plan({
        planSlug: 'abolish-human-review-agent-review-only-2026-08-02',
        title: 'Abolish human review in favor of agent review',
        nowState: 'Implementation is active.',
        nowNext: 'P-006 migrates the remaining rows through agent review.',
      }),
      plan({
        planSlug: 'authoritative-account-routing-all-backends-2026-07-16',
        title: 'Make account routing authoritative across every spawn path',
        nowState: 'P-001 through P-004 are done.',
        nowNext: 'P-005 (now unblocked): run live credential/provider probes and close out the plan.',
      }),
      plan({
        planSlug: 'design-simplification-2026-07-09',
        title: 'Design simplification + design-doc violation fixes',
        nowState: 'P-014 is owner-gated; P-015 remains a coordinated refactor.',
        nowNext: 'Recommend the owner weighs in on one API question; P-016 is fully agent-executable.',
      }),
      plan({
        planSlug: 'restore-pot-lexicon-public-release-2026-07-04',
        title: 'Restore the Pot lexicon for public release',
        nowState: 'Phases 1 and 2 are complete.',
        nowNext: 'Run the Phase 3 call-site sweep.',
      }),
    ];

    for (const candidate of falsePositives) {
      const category = classifyUnshippedPlan(input({ plan: candidate })).category;
      expect(category).not.toBe('text-only-human-blocker');
      expect(category).not.toBe('text-only-external-blocker');
    }

    expect(
      classifyUnshippedPlan(
        input({
          plan: plan({ nowNext: 'P-009 needs an OWNER decision: provide an alternate egress path.' }),
        }),
      ).category,
    ).toBe('text-only-human-blocker');
    expect(
      classifyUnshippedPlan(
        input({
          plan: plan({ nowNext: 'P-009 is BLOCKED ON THE PIPELINE until the green candidate ships.' }),
        }),
      ).category,
    ).toBe('text-only-external-blocker');
    expect(
      classifyUnshippedPlan(
        input({
          plan: plan({ nowNext: 'OWNER action: provide the missing signing credential.' }),
        }),
      ).category,
    ).toBe('text-only-human-blocker');
  });
});

describe('manifest and evidence rendering', () => {
  const liveOwner: AuditOwnerEvidence = {
    ownerId: 'su-live',
    ownerLabel: null,
    fleet: null,
    intent: 'implement audit',
    source: 'declared-plan',
  };

  function manifest() {
    return buildUnshippedPlansAuditManifest({
      workspaceId: 'ws-test',
      snapshotStartedAt: '2026-08-20T12:00:00.000Z',
      snapshotFinishedAt: '2026-08-20T12:00:01.000Z',
      liveOwnershipMeasuredAt: '2026-08-20T12:00:00.500Z',
      allPlans: [
        plan({ title: '<script>alert("x")</script>', isBlenderOrigin: true }),
        plan({ planSlug: 'shipped', status: 'shipped' }),
        plan({ planSlug: 'archived', archived: true }),
        plan({ planSlug: 'instance', templateSlug: 'template-a' }),
      ],
      registeredHarnesses: new Set(['papercusp']),
      ownersByPlan: new Map([['plan-a', [liveOwner]]]),
      workItemsByPlan: new Map(),
      blockedItems: new Map(),
      auditsByPlan: new Map(),
      rubricsByPlan: new Map(),
      gateVerdictsByPlan: new Map(),
    });
  }

  it('filters terminal/archive/instance rows and reports a self-consistent protected band', () => {
    const result = manifest();

    expect(result.schemaVersion).toBe('unshipped-plans-audit-manifest-v2');
    expect(result.scope.classifierRevision).toBe(UNSHIPPED_PLANS_AUDIT_CLASSIFIER_REVISION);
    expect(result.scope.nonterminalListedAtSnapshot).toBe(1);
    expect(result.scope.classifiedRows).toBe(result.rows.length);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ slug: 'plan-a', category: 'ongoing-protected' });
    expect(result.bands).toMatchObject({ protected: 1 });
    expect(result.provenance).toEqual({ blender: 1, outsideBlender: 0 });
    expect(Object.values(result.bands).reduce((sum, count) => sum + count, 0)).toBe(result.rows.length);
  });

  it('neutralizes closing-script input while preserving the embedded manifest round trip', () => {
    const html = renderUnshippedPlansAuditHtml(manifest());
    const embedded = html.match(/<script type="application\/json" id="audit">([^<]*)<\/script>/)?.[1];

    expect(html).not.toContain('<script>alert("x")</script>');
    expect(embedded).toContain('\\u003cscript>alert(\\"x\\")\\u003c/script>');
    expect(JSON.parse(embedded!)).toMatchObject({
      rows: [{ title: '<script>alert("x")</script>' }],
    });
    expect(html).toContain('No plan, item, blocker, claim, assignment, fleet, or agent state was changed.');
    expect(html).toContain('All plan sources');
    expect(html).toContain('Outside Blender');
  });


  it('validates explicit audit population instead of silently dropping unavailable selections', () => {
    const plans = [plan({ planSlug: 'a' }), plan({ planSlug: 'b', status: 'shipped', archived: true })];
    expect(selectAuditPlans(plans, ['b', 'b']).map(p => p.planSlug)).toEqual(['b']);
    expect(() => selectAuditPlans(plans, [])).toThrow('selection');
    expect(() => selectAuditPlans(plans, ['missing'])).toThrow('unavailable');
    expect(selectAuditPlans(plans)).toEqual(plans);
  });

  it('retains the entire historical census with per-class disclosure and an unknown row for unavailable harness evidence', () => {
    const allPlans = [
      plan(), plan({ planSlug: 'archived', archived: true }),
      plan({ planSlug: 'superseded', status: 'superseded' }),
      plan({ planSlug: 'rubric', template: 'rubric' }),
      plan({ planSlug: 'instance', templateSlug: 'scheduled-parent' }),
      plan({ planSlug: 'unavailable', harnessSlug: 'missing-harness' }),
    ];
    const base = {
      workspaceId: 'ws-test', snapshotStartedAt: 'start', snapshotFinishedAt: 'finish', liveOwnershipMeasuredAt: 'measured', allPlans,
      registeredHarnesses: new Set(['papercusp']), ownersByPlan: new Map(), workItemsByPlan: new Map(), blockedItems: new Map(), auditsByPlan: new Map(), rubricsByPlan: new Map(), gateVerdictsByPlan: new Map(),
    };
    const full = buildUnshippedPlansAuditManifest({ ...base, includeHistorical: true });
    expect(full.rows.map(row => row.slug).sort()).toEqual(allPlans.map(row => row.planSlug).sort());
    expect(full.scope.listedAtSnapshot).toBe(6);
    expect(full.scope.classifiedRows).toBe(6);
    for (const key of ['archived', 'superseded', 'rubricTemplate', 'scheduledInstance'] as const) {
      expect(full.scope.census[key]).toEqual({ listed: 1, included: 1, excluded: 0, exclusionReason: null });
    }
    expect(full.rows.find(row => row.slug === 'unavailable')).toMatchObject({ status: 'unknown', category: 'catalog-residue' });
    expect(full.rows.find(row => row.slug === 'archived')).toMatchObject({ archived: true });
    const legacy = buildUnshippedPlansAuditManifest(base);
    for (const key of ['archived', 'superseded', 'scheduledInstance'] as const) {
      expect(legacy.scope.census[key]).toMatchObject({ listed: 1, included: 0, excluded: 1, exclusionReason: expect.stringContaining('Legacy nonterminal') });
    }
  });

  it('keeps the implementation manual-only and free of direct lifecycle SQL/writer seams', () => {
    const source = readFileSync(new URL('./unshipped-plans-audit.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+harness_shared|DELETE\s+FROM|MERGE\s+INTO)\b/i);
    expect(source).not.toMatch(
      /registerRoutine|setPlanStatus|setPlanItemStatus|setWorkItemState|armSchedule|setSchedule/,
    );
    expect(source.match(/saveTextArtifact\(/g)).toHaveLength(2);
  });
});
