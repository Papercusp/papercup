import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality } from './spec-quality';
import evaluateSpecQualityTool from './evaluate-spec-quality';
import startPlanTool from './start';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'quality-plan',
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-one',
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

describe('evaluatePlanSpecQuality', () => {
  it('passes a fully covered feature plan and pins an exact specSetHash subject', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.specSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scorecardDraft.subject.ref).toContain(result.specSetHash);
    for (const [criterion, entry] of Object.entries(result.ratings)) {
      expect(entry.evidence).toContain('Source store: plans:get-specs { slug:"quality-plan", harness:"papercusp" }.');
      expect(entry.evidence).toContain(
        'Re-run exactly: plans:evaluate-spec-quality { slug:"quality-plan", harness:"papercusp", classRef:"plan-class-feature-ship" }',
      );
      expect(entry.evidence).toContain(`confirm the returned specSetHash equals "${result.specSetHash}"`);
      expect(entry.evidence).not.toContain('expectedSpecSetHash:');
      expect(entry.evidence).toContain(`inspect ratings["${criterion}"]`);
    }
  });

  it('requires every plan item to carry behavior or an explicit exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('fail');
    expect(result.details.uncoveredPlanItemIds).toEqual(['P-002']);
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  // EI-24372921924901236: one canonical BAR is projected onto several items.
  // Those projections are supplemental only when each item has its own contract.
  describe('shared BAR projection coverage', () => {
    const sourceBar = {
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'quality-plan-acceptance',
      rubricRevision: 4,
      evidencePlane: 'tree' as const,
    };
    const projections = () =>
      ['P-001', 'P-002'].map((planItemId) =>
        clause({
          specId: `AUTO-BAR-R-1-${planItemId}`,
          sourceValId: null,
          planItemId,
          sourceBar: { ...sourceBar },
          behavior: 'Accepted event requests preserve their declared identity.',
        }),
      );
    const contracts = () => [
      clause({ specId: 'ACCEPT', sourceValId: null, behavior: 'A valid event request returns 202.' }),
      clause({
        specId: 'REJECT',
        sourceValId: null,
        planItemId: 'P-002',
        behavior: 'An invalid event request returns 400.',
      }),
    ];
    const coverage = (clauses: SpecClauseRevision[]) =>
      evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds: ['P-001', 'P-002'],
        clauses,
        classRef: 'plan-class-feature-ship',
      }).ratings['item-contract-coverage'].rating;

    it('accepts a shared pinned BAR when both items also have distinct active contracts', () => {
      expect(coverage([...projections(), ...contracts()])).toBe('pass');
    });

    it('keeps projection-only coverage and a missing independent item contract unknown', () => {
      expect(coverage(projections())).toBe('unknown');
      expect(coverage([...projections(), contracts()[0]])).toBe('unknown');
      expect(
        coverage([...projections(), ...contracts().map((c) => ({ ...c, lifecycleStatus: 'draft' as const }))]),
      ).toBe('unknown');
    });

    it('does not treat copied item contracts as independent coverage', () => {
      const copied = contracts().map((c) => ({ ...c, behavior: 'An invalid event request returns 400.' }));
      expect(coverage([...projections(), ...copied])).toBe('unknown');
    });

    it.each(['rubricSlug', 'rubricRevision', 'barKey', 'barHash', 'barSetHash', 'evidencePlane'] as const)(
      'keeps projections with different %s unknown',
      (field) => {
        const shared = projections();
        shared[1] = {
          ...shared[1],
          sourceBar: {
            ...sourceBar,
            [field]: field === 'rubricRevision' ? 5 : field === 'evidencePlane' ? 'live' : 'different',
          },
        };
        expect(coverage([...shared, ...contracts()])).toBe('unknown');
      },
    );

    it('does not waive ordinary duplicate behavior or a projection missing its source pin', () => {
      const shared = projections().map((c) => ({ ...c, sourceBar: undefined }));
      expect(coverage([...shared, ...contracts()])).toBe('unknown');
      expect(coverage(shared.map((c, index) => ({ ...c, specId: `COPY-${index}` })))).toBe('unknown');
    });
  });

  it('routes failing AUTO-BAR repairs to the canonical rubric criterion', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          specId: 'AUTO-BAR-R-1-P-001',
          behavior: 'The response contains the event. A second outcome is independently asserted.',
          sourceBar: {
            barKey: 'R-1',
            barHash: 'a'.repeat(64),
            barSetHash: 'b'.repeat(64),
            rubricSlug: 'quality-plan-acceptance',
            rubricRevision: 4,
            evidencePlane: 'tree',
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const atomicity = result.ratings['atomic-observable-behavior'];
    expect(atomicity.rating).toBe('fail');
    expect(atomicity.evidence).toContain('rubric quality-plan-acceptance, BAR R-1, criterion.model');
    expect(atomicity.suggestion).toContain('rubrics:amend');
    expect(atomicity.suggestion).toContain('criterion.model');
    expect(atomicity.suggestion).toContain('plans:set-specs');
  });

  it('flags a multi-subject source-presence clause instead of returning a false all-pass', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          behavior:
            'Implemented provider contracts, durable controller, credential lifecycle, artifact boundaries, and ordinary lifecycle semantics are present in the current tree.',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.ratings.falsifiability.rating).toBe('fail');
    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toEqual(
      expect.arrayContaining(['atomic-observable-behavior', 'falsifiability', 'implementation-independence']),
    );
  });

  it('does not mistake ordinary English uses of implementation nouns for code references', () => {
    const behaviors = [
      'A declared class is missing from any sink.',
      'Each orientation state class is declared once.',
      'The method for requesting an event returns a stable result.',
      'The function of this retry is to preserve request identity.',
      'The variable number of returned records matches the requested limit.',
      'The per-class carry decision remains available after compaction.',
    ];
    const clauses = behaviors.map((behavior, index) =>
      clause({
        specId: 'SPEC-ENGLISH-' + (index + 1),
        sourceValId: 'VAL-ENGLISH-' + (index + 1),
        planItemId: 'P-00' + (index + 1),
        behavior,
      }),
    );
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: clauses.map(({ planItemId }) => planItemId),
      clauses,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('pass');
  });

  it('quotes the exact explicit construct reference in implementation-independence evidence', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'A class OrientationState is declared once.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('"class OrientationState"');
  });

  it('fails atomicity for independently falsifiable outcomes joined across a clause', () => {
    const behaviors = [
      'orders:promote and orders:dismiss { reason } exist, dismiss refuses an empty reason, and a dismissed row stays queryable rather than being deleted.',
      'Every declared orientation category reaches a rendered prompt for a live-shaped session fixture, a build-time guard turns red when any declared category does not render, and a permanent control entry declared but deliberately left unrendered keeps that guard from passing vacuously.',
      'Class-A rows render exactly once per change and never on an unchanged turn, while class-B rows for walls-with-recheck and waiting-on render every turn until they are discharged.',
      'Both the engineer and power su prompts carry that instruction in a live launch-context render, guarded by a Vitest test that fails when it is absent and is proven falsifiable against the pre-fix commit.',
    ];
    const clauses = behaviors.map((behavior, index) =>
      clause({
        specId: 'SPEC-BUNDLED-' + (index + 1),
        sourceValId: 'VAL-BUNDLED-' + (index + 1),
        planItemId: 'P-00' + (index + 1),
        behavior,
      }),
    );
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: clauses.map(({ planItemId }) => planItemId),
      clauses,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    for (const { specId } of clauses) {
      expect(result.ratings['atomic-observable-behavior'].evidence).toContain(specId + ':');
    }
  });

  it('fails atomicity when one liveness-backed lock clause bundles independent controls', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'main-greening-control-plane-durable-fix-2026-09-21',
      harnessSlug: 'papercusp',
      planItemIds: ['P-003'],
      clauses: [
        clause({
          specId: 'AUTO-BAR-R-004-P-003',
          sourceValId: 'VAL-AUTO-BAR-R-004-P-003',
          planItemId: 'P-003',
          behavior:
            'Preserve single-flight safety while making lock ownership liveness-backed with phase, heartbeat, owner identity, hard deadline, dead-owner reclaim, and explicit unknown-liveness escalation.',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('AUTO-BAR-R-004-P-003:');
  });

  it('keeps a single outcome with a while-condition atomic', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'The button remains disabled while a request is pending.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('pass');
  });

  it('does not count byte-identical behavior text as independent coverage for multiple plan items', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [
        clause(),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          planItemId: 'P-002',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['item-contract-coverage'].rating).toBe('unknown');
    expect(result.ratings['item-contract-coverage'].evidence).toContain('same behavior text');
    expect(result.verdict).toBe('unknown');
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('blocks replay probes when the current clause set no longer matches the expected hash', () => {
    const expectedSpecSetHash = '0'.repeat(64);
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
      expectedSpecSetHash,
    });

    expect(result.ratings['spec-set-freshness'].rating).toBe('unknown');
    expect(result.ratings['spec-set-freshness'].evidence).toContain(expectedSpecSetHash);
    expect(result.ratings['spec-set-freshness'].evidence).toContain(result.specSetHash);
    expect(result.verdict).toBe('unknown');
    expect(result.wouldBlock).toContain('spec-set-freshness');
  });

  it('partitions draft clauses from acceptance-provenance evidence', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause(),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const evidence = result.ratings['stable-revision-identity'].evidence;
    expect(result.ratings['stable-revision-identity'].rating).toBe('pass');
    expect(evidence).toContain('1 active/accepted current clause(s) have unique identities');
    expect(evidence).toContain(
      '1 draft current clause(s) are present and excluded from the acceptance-provenance count',
    );
    expect(evidence).not.toContain(
      '2 current clause(s) have unique identities, content hashes, and acceptance provenance',
    );
  });

  it('does not pass empty behavioral evaluations when clauses are only draft', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('not-applicable');
    expect(result.ratings.falsifiability.rating).toBe('not-applicable');
    expect(result.ratings['implementation-independence'].rating).toBe('not-applicable');
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('0 behavioral clause(s)');
    expect(result.ratings.falsifiability.evidence).toContain('0 behavioral clause(s)');
    expect(result.ratings['implementation-independence'].evidence).toContain('0 behavioral clause(s)');
    expect(result.wouldBlock).toEqual(expect.arrayContaining(['item-contract-coverage', 'plan-class-specialization']));
  });

  it('accepts a fully explicit non-behavioral investigation exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'exempt',
          behaviorClass: 'non-automated',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
          exemption: { justification: 'Pure editorial classification.', provenance: 'quality-plan#D-002' },
        }),
      ],
      classRef: 'plan-class-investigation',
    });

    expect(result.verdict).toBe('pass');
    expect(result.details.uncoveredPlanItemIds).toEqual([]);
    expect(result.ratings['explicit-non-behavioral-exemptions'].rating).toBe('pass');
  });

  it('refuses a mislabeled exemption and implementation-coupled behavior', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [
        clause({ behavior: 'The handler.ts function returns true' }),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          planItemId: 'P-002',
          lifecycleStatus: 'exempt',
          behaviorClass: 'happy-path',
          exemption: { justification: 'No code.', provenance: 'D-002' },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.wouldBlock).toEqual(
      expect.arrayContaining(['implementation-independence', 'explicit-non-behavioral-exemptions']),
    );
  });

  it('specializes bugfix and migration plans by required behavior class', () => {
    const bug = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-bugfix',
    });
    const migration = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behaviorClass: 'migration-data-integrity' })],
      classRef: 'plan-class-migration',
    });

    expect(bug.wouldBlock).toContain('plan-class-specialization');
    expect(migration.wouldBlock).not.toContain('plan-class-specialization');
  });
});

describe('spec-quality activation guidance', () => {
  it('accepts only a valid exact specSetHash replay guard', () => {
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'not-a-hash',
      }).success,
    ).toBe(false);
  });

  it('publishes the complete scorecard → independent-audit → start sequence and reviewer recipe', () => {
    const evaluateGuidance = [
      evaluateSpecQualityTool.description,
      evaluateSpecQualityTool.guidance?.when,
      evaluateSpecQualityTool.guidance?.returns,
      evaluateSpecQualityTool.guidance?.chaining,
    ].join('\n');
    const evaluateChain = evaluateSpecQualityTool.guidance?.chaining ?? '';
    const startGuidance = [
      startPlanTool.description,
      startPlanTool.guidance?.when,
      startPlanTool.guidance?.chaining,
    ].join('\n');

    for (const guidance of [evaluateGuidance, startGuidance]) {
      expect(guidance).toContain('plans:evaluate-spec-quality');
      expect(guidance).toContain('scorecards:emit');
      expect(guidance).toContain('grading-integrity');
      expect(guidance).toContain('plans:start');
    }
    expect(evaluateGuidance).toContain('capability:launch-agent');
    expect(evaluateGuidance).toContain('independent:true');
    expect(evaluateGuidance).toContain('different author/lineage');
    expect(evaluateChain.indexOf('plans:evaluate-spec-quality')).toBeLessThan(evaluateChain.indexOf('scorecards:emit'));
    expect(evaluateChain.indexOf('scorecards:emit')).toBeLessThan(evaluateChain.indexOf('grading-integrity'));
    expect(evaluateChain.indexOf('grading-integrity')).toBeLessThan(evaluateChain.indexOf('plans:start'));
  });
});
