/** Prospective reference-delivery oracle for restart-tax R24/P-022.
 * Source: agent-paperwork-and-restart-tax-reduction-2026-10-15 v122, R-24.
 * Freeze/review this file before implementing the reader. These are synthetic
 * reader controls, never live delivery receipts or evidence that the pilot ran.
 * The oracle measures reference delivery only, not complete source-text delivery.
 * required/applicable membership is literal test data, not evaluator output.
 */
export const PRIOR_ATTEMPT_DELIVERY_ORACLE = {
  schemaVersion: 'prior-attempt-delivery-oracle-v1',
  scope: {
    workspaceId: 'reader-fixture-workspace',
    ownerId: 'reader-fixture-owner',
    nativeSessionId: 'reader-fixture-session',
    sourceFingerprint: 'reader-fixture-source-v1',
    inputFingerprint: 'reader-fixture-input-v1',
  },
  requiredRefs: ['plan:fixture#D-001', 'work-item:fixture#residue'],
  applicableRefs: ['plan:fixture#D-001', 'work-item:fixture#residue', 'work-item:fixture#attempt'],
  cases: [
    {
      name: 'confirmed required reference set',
      confirmedRefs: ['plan:fixture#D-001', 'work-item:fixture#residue'],
      offeredRefs: ['work-item:fixture#attempt'],
      searchableRefs: ['work-item:unrelated'],
      complete: true,
      expected: { verdict: 'pass', recall: 1, precision: 1, confirmed: 2 },
    },
    {
      name: 'offered and searchable history has no delivery confirmation',
      confirmedRefs: [],
      offeredRefs: ['plan:fixture#D-001', 'work-item:fixture#residue'],
      searchableRefs: ['plan:fixture#D-001', 'work-item:fixture#residue'],
      complete: true,
      expected: { verdict: 'unknown', recall: 0, precision: null, confirmed: 0 },
    },
    {
      name: 'offered residue cannot repair missing confirmed residue',
      confirmedRefs: ['plan:fixture#D-001'],
      offeredRefs: ['work-item:fixture#residue'],
      searchableRefs: ['work-item:fixture#residue'],
      complete: true,
      expected: { verdict: 'fail', recall: 0.5, precision: 1, confirmed: 1 },
    },
    {
      name: 'inapplicable confirmed reference lowers precision',
      confirmedRefs: ['plan:fixture#D-001', 'work-item:fixture#residue', 'work-item:unrelated'],
      offeredRefs: [],
      searchableRefs: [],
      complete: true,
      expected: { verdict: 'fail', recall: 1, precision: 2 / 3, confirmed: 3 },
    },
    {
      name: 'duplicate observation does not create another delivered reference',
      confirmedRefs: ['plan:fixture#D-001', 'work-item:fixture#residue', 'plan:fixture#D-001'],
      offeredRefs: [],
      searchableRefs: [],
      complete: true,
      expected: { verdict: 'pass', recall: 1, precision: 1, confirmed: 2 },
    },
    {
      name: 'incomplete receipt census cannot pass',
      confirmedRefs: ['plan:fixture#D-001', 'work-item:fixture#residue'],
      offeredRefs: [],
      searchableRefs: [],
      complete: false,
      expected: { verdict: 'unknown', recall: 1, precision: 1, confirmed: 2 },
    },
  ],
  qualificationControls: [
    'missing original delivery receipt is unknown',
    'receipt from another workspace, owner, native session, source or input is unknown',
    'empty required-reference denominator is unknown',
    'required refs outside the applicable set make the oracle invalid, hence unknown',
    'packing, queue, search and server invocation success do not confirm client emission',
  ],
} as const;

/** Literal negative controls for the narrow reference-set reader. The base
 * observation is an original emitted receipt for scope above, containing both
 * required refs. Each override below must prevent a passing measurement.
 * Keep these expectations separately source-reviewed before reader changes. */
export const PRIOR_ATTEMPT_DELIVERY_QUALIFICATION_ORACLE = [
  { name: 'missing original receipt', receiptRef: null, expected: 'unknown' },
  { name: 'blank original receipt', receiptRef: '', expected: 'unknown' },
  { name: 'foreign workspace receipt', scope: { workspaceId: 'another-workspace' }, expected: 'unknown' },
  { name: 'foreign owner receipt', scope: { ownerId: 'another-owner' }, expected: 'unknown' },
  { name: 'foreign native session receipt', scope: { nativeSessionId: 'another-session' }, expected: 'unknown' },
  { name: 'foreign source receipt', scope: { sourceFingerprint: 'another-source' }, expected: 'unknown' },
  { name: 'foreign input receipt', scope: { inputFingerprint: 'another-input' }, expected: 'unknown' },
  { name: 'empty required denominator', requiredRefs: [], expected: 'unknown' },
  { name: 'required reference outside applicability', requiredRefs: ['work-item:outside-oracle'], expected: 'unknown' },
  { name: 'blank required reference', requiredRefs: [''], expected: 'unknown' },
  { name: 'packing does not confirm emission', phase: 'packed', expected: 'unknown' },
  { name: 'queue success does not confirm emission', phase: 'queued', expected: 'unknown' },
  { name: 'server invocation success does not confirm emission', phase: 'server-ok', expected: 'unknown' },
  { name: 'offering does not confirm emission', phase: 'offered', expected: 'unknown' },
  { name: 'searchability does not confirm emission', phase: 'searchable', expected: 'unknown' },
] as const;

/** Prospective R24 pilot manifest. This is a review draft, not live evidence.
 * Population comes verbatim from R24 at plan v127. Each consumer listed on a
 * row needs its own original receipt for every required stratum. N/A cells
 * never satisfy coverage. Transport retries must retain all physical attempts;
 * an idempotent no-op is distinct from another accepted side effect.
 *
 * The source cases below supply the existing literal inputs/oracles. They are
 * references, not a claim that their current executions qualify as pilot runs.
 * Before execution, freeze the resolved input/expectation bytes, source hashes,
 * review identity and original-receipt joins in the existing results evidence.
 * A source reference alone cannot qualify a missing or changed expectation.
 */
export const PAPERWORK_PILOT_MANIFEST = {
  schemaVersion: 'paperwork-pilot-manifest-v1',
  cohort: 'paperwork-pilot-v1',
  sourcePlan: 'agent-paperwork-and-restart-tax-reduction-2026-10-15',
  sourceRequirement: 'R-24',
  sourcePlanVersion: 127,
  status: 'draft-pending-independent-source-review',
  strata: ['direct', 'hook', 'nested-wrapper', 'retry', 'owner-pause'],
  scenarios: [
    {
      id: 'admission-canonical', consumers: ['plan-admission'],
      sourceFile: 'packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts',
      sourceCase: 'replays the migrated P536 rows as one canonical execution lane on resume',
      expected: { executionRefs: ['WI-6554700010026007'], shadowRefs: ['WI-6554700010037375'] },
      applicability: {
        direct: 'required', hook: 'N/A: admission is an API operation, not a client injection hook',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: no mission pause is an input to this admission fixture',
      },
    },
    {
      id: 'proof-unchanged', consumers: ['evidence-autobind'],
      sourceFile: 'packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.test.ts',
      sourceCase: 'preserves the P536 execution proof on resume and binds again only for a changed clause',
      expected: { decisions: { noop: 1, bind: 0, retract: 0 }, bindingId: 7, testRunId: 10, writes: 0 },
      applicability: {
        direct: 'required', hook: 'N/A: proof refresh runs in the canonical evidence writer',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: an unchanged clause does not change mission disposition',
      },
    },
    {
      id: 'proof-invalidated', consumers: ['evidence-autobind'],
      sourceFile: 'packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.test.ts',
      sourceCase: 'invalidates exactly affected proof for source input and scope changes while preserving unrelated bindings',
      // The declared source case is still planned: do not invent its binding IDs.
      expected: null,
      unresolved: 'Resolve independently reviewed affected/unaffected binding IDs and input bytes before execution.',
      applicability: {
        direct: 'required', hook: 'N/A: invalidation is a canonical evidence-writer consequence',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: source/input/scope changes do not imply an owner pause',
      },
    },
    {
      id: 'custody-release', consumers: ['retention-pin'],
      sourceFile: 'packages/operator-core/lib/storage/retention-pins.test.ts',
      sourceCase: 'permits only the pin owner to release an exact id',
      expected: { owner: 'agent-a', foreignOwner: 'agent-b',
        foreignReleaseError: 'only the pin owner', foreignReleasePreservesPin: true,
        ownerReleaseResults: [true, false], remainingPins: 0 },
      applicability: {
        direct: 'required', hook: 'N/A: retention release has no client injection hook',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: pin ownership is independent of mission pause state',
      },
    },
    {
      id: 'failed-stage-custody', consumers: ['retained-phase-evidence'],
      sourceFile: 'packages/operator-core/lib/source-preview-phase-retention.test.ts',
      sourceCase: 'keeps exact completed and failed phase bytes after temporary receipt deletion',
      expected: { completedPhases: ['source.freeze', 'deps.snapshot'], failedPhases: ['child.run'],
        archiveEqualsOriginalBytes: true, survivesTemporaryReceiptDeletion: true },
      applicability: {
        direct: 'required', hook: 'N/A: phase archives are owned by the verifier runner',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: this failure fixture contains no owner pause',
      },
    },
    {
      id: 'history-authority',
      consumers: ['claim-decisions', 'prior-attempts', 'claim-enrichment', 'compaction-recovery', 'carry-delivery'],
      sourceFile: 'packages/operator-core/lib/prior-attempt-context.test.ts',
      sourceCase: 'matches the complete paperwork authority history and omission manifest in prior attempts',
      expected: { deliveredRefs: ['plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9'],
        omittedRefs: ['WI-2#comment:1'], omittedRecords: 1, omittedRefsTruncated: false },
      // The summary above describes prior-attempts only. Each consumer below
      // freezes its own source-case projection; these are separately copied
      // literal expectations, never output captured from the production reader.
      // reviewRef approves exact file/case/hash candidates; oracleReviewRef
      // approves the literal projections at manifest SHA256
      // 220022f818e12c7c4f96d6c63735c919ce5115bef873f8cecc34c340f1e5ec9a.
      // Neither source approval nor oracle approval establishes native delivery.
      // Review limits:
      // coord-send-ccac76bea9d39df469af16efb03e9021f9789d36d0bfcc4097200b14903ef3bd
      // coord-send-48dce8e0060fa3fdc0c3fde122b45ca97c1ba52732c6beb05692464eab4f5b5f
      consumerSourceCandidates: [
        { consumer: 'prior-attempts',
          sourceFile: 'packages/operator-core/lib/prior-attempt-context.test.ts',
          sourceCase: 'matches the complete paperwork authority history and omission manifest in prior attempts',
          sha256: '69713e3b63ced2685f02f424e37030d8a363d1a28aa20c4b715d7c611106945d',
          reviewRef: 'coord-send-711bfbc44bb8b80e5beb57787b84c60275577bfc51a02fd539898fd3059d9ab5',
          oracleReviewRef: 'coord-send-e6e8282bab438c1b1f4777465fac978f4bc40bc6f5740ce3c7d84c239d2005ea',
          expectedProjection: 'authority/attempts/omission manifest from the source case',
          expected: {
            authority: [
              { rawRef: 'plan#SPEC-1@3', authority: 'current-spec', scope: 'same-spec', at: '2026-08-20T12:00:00.000Z', text: 'Current contract.' },
              { rawRef: 'plan#D-008', authority: 'plan-decision', scope: 'plan-wide', at: '2026-08-20T12:00:00.000Z', text: 'Preserve the selected route.' },
              { rawRef: 'WI-2#comment:9', authority: 'retraction', scope: 'same-spec', at: '2026-08-20T12:00:00.000Z', text: 'Retraction: old proof is invalid; retain test-run:42.' },
            ],
            attempts: [],
            omitted: [{ authority: 'comment', scope: 'plan-wide', rawRef: 'WI-2#comment:1', workItemId: undefined, specId: undefined, at: '2026-08-20T12:00:00.000Z', reason: 'budget' }],
            omittedRecords: 1, omittedRefsTruncated: false,
          } },
        { consumer: 'claim-decisions',
          sourceFile: 'packages/operator-core/lib/plan-decisions-claim-port.test.ts',
          sourceCase: 'matches the complete paperwork authority history and omission manifest in claim decisions',
          sha256: 'cfb7415c0f2fd1155ae2645812def08e7faa7ba2d1d23879b8c6254c4dd70884',
          reviewRef: 'coord-send-711bfbc44bb8b80e5beb57787b84c60275577bfc51a02fd539898fd3059d9ab5',
          oracleReviewRef: 'coord-send-e6e8282bab438c1b1f4777465fac978f4bc40bc6f5740ce3c7d84c239d2005ea',
          expectedProjection: 'complete getClaimTimePlanDecisions result plus separately recovered omitted bodies',
          expected: {
            planSlug: 'busy-plan',
            decisions: [
              { id: 'D-900', title: 'Current parent authority',
                snippet: 'P-003 remains paused until the original author accepts the handoff. '
                  + 'Retraction: old failed evidence is invalid; retain proof test-run:42. '
                  + 'Residue: native delivery; next action: inspect the current source.',
                sourcePlanSlug: 'parent-plan', ref: 'parent-plan#D-900', relation: 'affects',
                provenance: { kind: 'unrecorded' } },
              { id: 'D-001', title: 'Early ruling 1', snippet: 'Date: 2026-07-26 P-003 must preserve the selected route.', provenance: { kind: 'unrecorded' } },
              { id: 'D-012', title: 'Do not start P-003; it is deferred', snippet: 'Date: 2026-08-02 P-003 has no evidence behind it. Do not start that phase.', provenance: { kind: 'unrecorded' } },
              { id: 'D-007', title: 'Early ruling 7', snippet: 'Date: 2026-07-26 Body of early ruling 7.', provenance: { kind: 'unrecorded' } },
              { id: 'D-008', title: 'Early ruling 8', snippet: 'Date: 2026-07-26 Body of early ruling 8.', provenance: { kind: 'unrecorded' } },
              { id: 'D-009', title: 'Early ruling 9', snippet: 'Date: 2026-07-26 Body of early ruling 9.', provenance: { kind: 'unrecorded' } },
              { id: 'D-010', title: 'Early ruling 10', snippet: 'Date: 2026-07-26 Body of early ruling 10.', provenance: { kind: 'unrecorded' } },
              { id: 'D-011', title: 'Early ruling 11', snippet: 'Date: 2026-07-26 Body of early ruling 11.', provenance: { kind: 'unrecorded' } },
            ],
            taskLinkedDecisions: 2,
            omittedDecisionRefs: ['busy-plan#D-002', 'busy-plan#D-003', 'busy-plan#D-004', 'busy-plan#D-005', 'busy-plan#D-006'],
            omittedDecisionRefsTruncated: false,
            totalDecisions: 13, totalLocalDecisions: 12, totalAffectedDecisions: 1,
            affectedDecisions: 1, authorityReadFailed: false,
          },
          // Recovery of these bodies is a separate read in the source case;
          // their refs do not claim that the bodies were in the claim response.
          expectedRecoveredOmissions: [
            { ref: 'busy-plan#D-002', body: 'Date: 2026-07-26\nBody of early ruling 2.' },
            { ref: 'busy-plan#D-003', body: 'Date: 2026-07-26\nBody of early ruling 3.' },
            { ref: 'busy-plan#D-004', body: 'Date: 2026-07-26\nBody of early ruling 4.' },
            { ref: 'busy-plan#D-005', body: 'Date: 2026-07-26\nBody of early ruling 5.' },
            { ref: 'busy-plan#D-006', body: 'Date: 2026-07-26\nBody of early ruling 6.' },
          ] },
        { consumer: 'claim-enrichment',
          sourceFile: 'packages/operator-core/lib/claim-time-enrichment.test.ts',
          sourceCase: 'matches the complete paperwork authority history and omission manifest in claim enrichment',
          sha256: 'babbc897b6221fd4fe9095f06547650fa85260562162bb68dc304450f35dafb1',
          reviewRef: 'coord-send-711bfbc44bb8b80e5beb57787b84c60275577bfc51a02fd539898fd3059d9ab5',
          oracleReviewRef: 'coord-send-e6e8282bab438c1b1f4777465fac978f4bc40bc6f5740ce3c7d84c239d2005ea',
          expectedProjection: 'decisions/note/history projection with frozen upstream values',
          expected: {
            decisions: [
              { id: 'D-008', title: 'Current authority', snippet: 'P-018 preserves the selected route.', provenance: { kind: 'unrecorded' } },
              { id: 'D-009', title: 'Retraction', snippet: 'Old proof is invalid; retain test-run:42.', provenance: { kind: 'unrecorded' } },
            ],
            note: 'Omitted: task-plan#D-001; recover with plans:get.',
            history: {
              schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'frozen-history-input',
              authority: [{ rawRef: 'plan#D-009', authority: 'retraction', scope: 'same-spec', text: 'Old proof is invalid; retain test-run:42.' }],
              attempts: [], residue: [{ rawRef: 'WI-2#checkpoint', items: ['Native delivery remains.'] }],
              rawRefs: ['plan#D-009'], protectedRefs: { authority: [{ authority: 'retraction', rawRef: 'plan#D-009' }], residue: ['WI-2#checkpoint'] },
              omission: { omittedRecords: 1, omittedByAuthority: { comment: 1 }, omittedRefs: [{ rawRef: 'WI-2#comment:1', authority: 'comment', scope: 'self', reason: 'budget' }], omittedRefsTruncated: false, sourceCount: 2, deduplicatedCount: 0, truncated: true },
              estimatedTokens: 250, serializedChars: 1000,
            },
          } },
        { consumer: 'compaction-recovery',
          sourceFile: 'packages/operator-core/lib/agent-tools/coordination/compaction-recovery.test.ts',
          sourceCase: 'matches the complete paperwork authority history and omission manifest in compaction recovery',
          sha256: 'bf0d7f73704b00157e6e1c7a4e90dc681b2cf8f89442977003fcc7da977e9711',
          reviewRef: 'coord-send-711bfbc44bb8b80e5beb57787b84c60275577bfc51a02fd539898fd3059d9ab5',
          oracleReviewRef: 'coord-send-e6e8282bab438c1b1f4777465fac978f4bc40bc6f5740ce3c7d84c239d2005ea',
          expectedProjection: 'complete recovery.planAuthority object; control equality is a separate assertion',
          expected: {
            resolution: 'current', controlGeneration: 17, workspaceId: 'ws-1', harness: 'h',
            planSlug: 'fleet-deltas-leader-primitives-2026-07-10', version: 18, contentHash: 'frozen-r19-plan', planStatus: 'ready',
            decisions: [
              { id: 'D-001', title: 'Current restriction', body: 'P-017 remains paused. Retraction: old proof invalid; retain test-run:42.', truncated: false },
              { id: 'D-004', title: 'History 4', body: 'Historical detail 4.', truncated: false },
              { id: 'D-005', title: 'History 5', body: 'Historical detail 5.', truncated: false },
              { id: 'D-006', title: 'History 6', body: 'Historical detail 6.', truncated: false },
              { id: 'D-007', title: 'History 7', body: 'Historical detail 7.', truncated: false },
              { id: 'D-008', title: 'History 8', body: 'Historical detail 8.', truncated: false },
            ], taskLinkedDecisions: 1, decisionsMore: 2,
            omittedDecisionRefs: ['fleet-deltas-leader-primitives-2026-07-10#D-002', 'fleet-deltas-leader-primitives-2026-07-10#D-003'],
            items: [{ id: 'P-017', status: 'wip', text: 'current task', missing: false }],
            specs: [{ specId: 'SPEC-P-017', revision: 4, contentHash: 'spec-hash-4', planItemId: 'P-017' }],
          },
          expectedControl: {
            schemaVersion: 'ctrl-v1', generation: 17,
            state: {
              modes: ['auto'], loop: { active: true, intervalSec: 60 }, wakeSource: 'loop', carry: 'warm',
              route: { kind: 'self' },
              scope: { workspace: 'ws-1', harness: 'h', plan: 'fleet-deltas-leader-primitives-2026-07-10', items: ['P-017'] },
            },
            provenance: { source: 'harness_shared.session_briefs.control_state', ownerId: 'owner-x', updatedAt: '2026-08-25T00:00:00.000Z' },
            resync: { on: ['missing-base', 'schema-mismatch', 'generation-mismatch'], verb: 'coord:orient', args: { afterCompaction: true }, rule: 'replace-full-never-merge-behind' },
            budget: { estimatedTokens: 100, maxTokens: 384 },
          } },
        { consumer: 'carry-delivery',
          sourceFile: 'packages/operator-core/lib/carry-doc.test.ts',
          sourceCase: 'matches the complete paperwork authority history and omission manifest in carry delivery',
          sha256: 'c811bfc7ac98d20c077a8852b33180a3299018cb2c85c66bd6d7013c96c65e3f',
          reviewRef: 'coord-send-711bfbc44bb8b80e5beb57787b84c60275577bfc51a02fd539898fd3059d9ab5',
          oracleReviewRef: 'coord-send-e6e8282bab438c1b1f4777465fac978f4bc40bc6f5740ce3c7d84c239d2005ea',
          expectedProjection: 'seven exact current-plan-authority lines before Standing carry; synthetic render preservation only',
          expected: [
            '- current plan authority (PRECEDES carried summaries): plan=fleet-deltas-leader-primitives-2026-07-10 harness=papercusp version=31 contentHash=current-plan-hash status=ready controlGeneration=17',
            '  - task-linked then recent governing decisions (+1 omitted):',
            '    - D-009 Current restriction — P-017 remains paused. Retraction: old proof invalid; retain test-run:42.',
            '    - D-010 Next action — Residue: native delivery. Inspect current source.',
            '  - omitted governing refs: task-plan#D-001',
            '  - scoped item states: P-017=wip',
            '  - current scoped specs: SPEC-P-017@4#current-spec-hash',
          ],
          identityJoin: 'unproven: header plan and omitted-ref plan intentionally differ in the source fixture' },
      ],
      unresolved: 'Exact literal consumer projections received source-only approval at the manifest hash above; bind each original emitted-body receipt before qualification. Carry proves synthetic rendering only; canonical identity joins remain unproven. Review limits: coord-send-e489a22bde3fd825b3d9152ec34993457a608264053845b5b732af5f9709c2c7.',
      applicability: {
        direct: 'required', hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: history precedence does not resume a paused mission',
      },
    },
    {
      id: 'context-directed', consumers: ['inbox-actionability', 'native-context-emission'],
      sourceFile: 'packages/operator-core/lib/events/await/inbox-wake-actionability.test.ts',
      sourceCase: 'RSR-P-024-C — a directed ask or an owner directive starts a turn > a directed ask (expects action) is actionable',
      expected: { actionable: true, class: 'directed-ask' },
      pilotExpected: { inferenceWakes: 1 },
      unresolved: 'The source asserts classification only, not a started turn. Freeze exact directed/delivered refs, original native-emission joins and actual wake receipts, including reopened control.',
      applicability: {
        direct: 'required', hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: an actionable ask does not itself lift an owner pause',
      },
    },
    {
      id: 'context-settled', consumers: ['inbox-actionability', 'native-context-emission'],
      sourceFile: 'packages/operator-core/lib/events/await/inbox-wake-actionability.test.ts',
      sourceCase: 'EI-16685 — exact handled-state proof for a pending host wake > uses settled Inbox-run receipts only for the exact thread reply and preserves actionable classes',
      expected: { handled: { 'm-reply': true, 'm-fyi': false, 'm-ask': false,
        'm-owner': false, 'm-wake': false, 'm-missing': false } },
      pilotExpected: { settledDuplicateInferenceWakes: 0 },
      unresolved: 'The source asserts handled-state eligibility only, not inference counts. Freeze exact settled thread/reply refs and actual native wake receipts for settled and non-settled controls.',
      applicability: {
        direct: 'required', hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: settled-message suppression is not a mission pause operation',
      },
    },
    {
      id: 'mission-resume', consumers: ['mission-projection', 'mission-consequence'],
      sourceFile: 'packages/operator-core/lib/mission-continuity.test.ts',
      sourceCase: 'mission reducer > returns from a completed detour using fresh parent disposition, not child acceptance',
      expected: { currentWorkRef: 'WI-step', disposition: 'ready', frames: [],
        consequenceCount: 1, continuationRef: 'plan:mission#P-003', assignmentRevision: 2 },
      applicability: {
        direct: 'required', hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: paused continuation is covered by mission-paused, not inferred ready here',
      },
    },
    {
      id: 'mission-paused', consumers: ['mission-projection', 'mission-consequence'],
      sourceFile: 'packages/operator-core/lib/mission-continuity-lifecycle.integration.test.ts',
      sourceCase: 'retained mission state and atomic consequence intent on Postgres > refreshes consumer authority after bounded close without a lifecycle write: paused',
      // This fixture clears execution_start_revision_seq; the consumer reports
      // unknown authority and leaves retained state unchanged. It does not count
      // resume consequences, so that separate pilot oracle remains unresolved.
      expected: { disposition: 'unknown', accountableOwner: 'su-consumer-paused',
        assignmentRef: 'plan:eng:root', retainedMissionUnchanged: true },
      unresolved: 'Freeze original projection refs and a separately reviewed legal-transition/consequence oracle; the cited case does not assert resumeConsequences.',
      applicability: {
        direct: 'required', hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'required',
      },
    },
    {
      id: 'native-carry', consumers: ['codex-native', 'claude-native', 'omp-native'],
      sourceFile: 'packages/operator-core/lib/external-bench/current-su-native.integration.test.ts',
      sourceCase: 'resumes current-su through its maintained host after managed native container compaction',
      expected: null,
      unresolved: 'Consume the exact qualified R22 result/packet/cleanup tuple; client coverage remains UNKNOWN until its retained receipts exist.',
      applicability: {
        direct: 'N/A: managed carry is initiated through the native host, not a direct API client',
        hook: 'required', 'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: R22 native compaction does not authorize an owner-pause transition',
      },
    },
    {
      id: 'evidence-autobind', consumers: ['evidence-autobind'],
      sourceFile: 'packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.test.ts',
      sourceCase: 'preserves the P536 execution proof on resume and binds again only for a changed clause',
      expected: { workItemId: 'WI-6554700010026007', specId: 'SPEC-P536-fixture',
        originalSpecRevision: 1, changedSpecRevision: 2,
        outcomes: [{ kind: 'bound', runId: 10 }], writes: [{ op: 'bind', runId: 10 }],
        preservedOriginalBindingId: 7, preservedOriginalRunId: 10 },
      unresolved: 'These IDs are the literal unit oracle, not live bindings or a qualifying execution. Freeze the full target/input bytes and independent source review, then join the eligible original current-build receipt.',
      applicability: {
        direct: 'required', hook: 'N/A: autobind is a ledger/writer consequence, not client injection',
        'nested-wrapper': 'required', retry: 'required',
        'owner-pause': 'N/A: evidence binding does not change mission pause state',
      },
    },
  ],
  qualificationControls: [
    { id: 'duplicate-accepted-side-effect', expected: 'fail',
      rule: 'Two accepted state-changing occurrences for one expected transition/logical receipt fail before deduplication.' },
    { id: 'missing-required-cell', expected: 'unknown',
      rule: 'An absent required consumer/stratum receipt cannot be replaced by another cell or an N/A reason.' },
    { id: 'missing-physical-attempt', expected: 'unknown',
      rule: 'Retries retain failed attempts and an explicit idempotent-no-op receipt for any repeated logical operation.' },
    { id: 'moved-same-author-expectation', expected: 'unknown',
      rule: 'Changed expectation bytes need a new independent exact-hash review; matching production output is insufficient.' },
  ],
} as const;

/** Literal R24 physical-attempt controls, frozen before the outcome reader.
 * Source: the plan's R24 verification contract (v141) and D-013. A logical
 * receipt identifies one expected transition; it does not erase its physical
 * attempts. These synthetic cases are not pilot executions. Exact-byte source
 * review is still required; this draft cannot qualify live acceptance.
 */
export const PAPERWORK_TRANSITION_OCCURRENCE_ORACLE = {
  schemaVersion: 'paperwork-transition-occurrence-oracle-v1',
  sourcePlanVersion: 141,
  sourceRequirement: 'R-24',
  reviewRef: null,
  expectedTransitions: [{ logicalReceiptId: 'logical-1', transitionRef: 'resume:fixture#P-003' }],
  cases: [
    {
      name: 'one accepted occurrence satisfies one expected transition',
      physicalAttemptIds: ['attempt-1'],
      receipts: [
        { receiptRef: 'original:1', physicalAttemptId: 'attempt-1', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
      ],
      expected: { verdict: 'pass', acceptedOccurrences: 1, idempotentNoops: 0, failedAttempts: 0 },
    },
    {
      name: 'an explicit idempotent retry preserves one accepted occurrence',
      physicalAttemptIds: ['attempt-1', 'attempt-2'],
      receipts: [
        { receiptRef: 'original:1', physicalAttemptId: 'attempt-1', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
        { receiptRef: 'original:2', physicalAttemptId: 'attempt-2', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'idempotent-noop' },
      ],
      expected: { verdict: 'pass', acceptedOccurrences: 1, idempotentNoops: 1, failedAttempts: 0 },
    },
    {
      name: 'failed retry history remains present before successful acceptance',
      physicalAttemptIds: ['attempt-1', 'attempt-2'],
      receipts: [
        { receiptRef: 'original:1', physicalAttemptId: 'attempt-1', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'failed' },
        { receiptRef: 'original:2', physicalAttemptId: 'attempt-2', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
      ],
      expected: { verdict: 'pass', acceptedOccurrences: 1, idempotentNoops: 0, failedAttempts: 1 },
    },
    {
      name: 'duplicate accepted side effects fail despite identical logical receipt and transition',
      physicalAttemptIds: ['attempt-1', 'attempt-2'],
      receipts: [
        { receiptRef: 'original:1', physicalAttemptId: 'attempt-1', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
        { receiptRef: 'original:2', physicalAttemptId: 'attempt-2', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
      ],
      expected: { verdict: 'fail', acceptedOccurrences: 2, idempotentNoops: 0, failedAttempts: 0 },
    },
    {
      name: 'a missing physical attempt is unknown even when the transition is accepted',
      physicalAttemptIds: ['attempt-1', 'attempt-2'],
      receipts: [
        { receiptRef: 'original:2', physicalAttemptId: 'attempt-2', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'accepted' },
      ],
      expected: { verdict: 'unknown', acceptedOccurrences: 1, idempotentNoops: 0, failedAttempts: 0 },
    },
    {
      name: 'a complete failed-only population fails its expected accepted transition',
      physicalAttemptIds: ['attempt-1'],
      receipts: [
        { receiptRef: 'original:1', physicalAttemptId: 'attempt-1', logicalReceiptId: 'logical-1',
          transitionRef: 'resume:fixture#P-003', outcome: 'failed' },
      ],
      expected: { verdict: 'fail', acceptedOccurrences: 0, idempotentNoops: 0, failedAttempts: 1 },
    },
  ],
  qualificationControls: [
    { id: 'empty-expected-transition-population', expected: 'unknown' },
    { id: 'missing-original-receipt', expected: 'unknown' },
    { id: 'unreviewed-or-changed-expectation-bytes', expected: 'unknown' },
    { id: 'unjoined-runtime-source-input-or-spec-identity', expected: 'unknown' },
  ],
} as const;
