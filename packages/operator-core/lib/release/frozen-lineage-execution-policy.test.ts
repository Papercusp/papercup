import { describe, expect, it } from 'vitest';
import {
  assessFrozenLineageLaunchCas,
  type FrozenRepairQueuePreflight,
} from './checkpoint-required-ancestor';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';
import {
  compareFrozenLineageIdentity,
  detectUnsafeFrozenCarryInstruction,
  evaluateFrozenLineagePolicy,
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
  frozenLineageIdentityFromMarker,
  frozenLineageIdentityMatches,
  isUnsafeFrozenCandidateSource,
  renderFrozenLineageCarryRefusal,
  renderFrozenLineagePolicyRefusal,
  type FrozenLineageIdentity,
} from './frozen-lineage-execution-policy';

const CANDIDATE = 'c'.repeat(40);
const REPAIR_HEAD = 'r'.repeat(40);
const REVISION = 1_788_763_360_000;

const marker = (overrides: Partial<FrozenRepairEditMarker> = {}): FrozenRepairEditMarker => ({
  candidate: CANDIDATE,
  repairHead: REPAIR_HEAD,
  phase: 'repair-in-progress',
  failingPaths: [],
  updatedAtMs: REVISION,
  admittedPaths: [],
  legs: [],
  ...overrides,
});

const identity = (overrides: Partial<FrozenLineageIdentity> = {}): FrozenLineageIdentity => ({
  candidate: CANDIDATE,
  repairHead: REPAIR_HEAD,
  queueRevision: REVISION,
  ...overrides,
});

const launchPreflight = (
  overrides: Partial<FrozenRepairQueuePreflight> = {},
): FrozenRepairQueuePreflight => ({
  proceed: true,
  reason: 'clear',
  candidate: REPAIR_HEAD,
  candidateSource: 'frozen-repair-queue',
  repairQueue: null,
  frozenLineageIdentity: identity(),
  queueDecision: 'verify-repair',
  nextAttempt: null,
  fixerSpawnId: null,
  fixerAlive: false,
  ...overrides,
});

describe('frozen lineage identity', () => {
  it('projects the queue update stamp as the typed queue revision', () => {
    expect(frozenLineageIdentityFromMarker(marker())).toEqual(identity());
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION + 1 })],
  ] as const)('reports a one-field %s mismatch', (field, actual) => {
    expect(compareFrozenLineageIdentity(identity(), actual)).toMatchObject({
      matches: false,
      mismatchedFields: [field],
    });
    expect(frozenLineageIdentityMatches(identity(), actual)).toBe(false);
  });

  it('accepts only an exact three-field identity match', () => {
    expect(compareFrozenLineageIdentity(identity(), identity())).toMatchObject({
      matches: true,
      mismatchedFields: [],
    });
    expect(frozenLineageIdentityMatches(identity(), identity())).toBe(true);
  });
});

describe('frozen lineage execution policy', () => {
  it('allows ordinary staging work and explicit repair admission while the queue is frozen', () => {
    for (const operation of ['ordinary-edit', 'focused-test', 'repair-admission'] as const) {
      expect(
        evaluateFrozenLineagePolicy({ operation, selectionSource: 'staging' }, { marker: marker() }),
      ).toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    }
  });

  it.each(['staging', 'current-head', 'integration-branch', 'caller-selected-sha'] as const)(
    'refuses governed candidate selection from %s even when its SHA happens to match repairHead',
    (selectionSource) => {
      const verdict = evaluateFrozenLineagePolicy(
        {
          operation: 'candidate-selection',
          selectionSource,
          checkoutHead: REPAIR_HEAD,
          expectedIdentity: identity(),
        },
        { marker: marker() },
      );
      expect(verdict).toMatchObject({ allowed: false, reason: 'unsafe-candidate-source' });
      expect(isUnsafeFrozenCandidateSource(selectionSource)).toBe(true);
    },
  );

  it('fails closed when a governed source is unknown', () => {
    expect(
      evaluateFrozenLineagePolicy(
        { operation: 'canonical-verification', selectionSource: 'unknown' },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'selection-source-unknown' });
  });

  it('requires a captured identity and effective checkout HEAD', () => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          checkoutHead: REPAIR_HEAD,
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-identity-required' });

    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          expectedIdentity: identity(),
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'checkout-head-required' });
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION - 1 })],
  ] as const)('refuses a stale captured %s before launch', (field, expectedIdentity) => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          checkoutHead: REPAIR_HEAD,
          expectedIdentity,
        },
        { marker: marker() },
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'queue-identity-mismatch',
      mismatchedIdentityFields: [field],
    });
  });

  it('refuses a checkout that is not the current repairHead', () => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'effective-checkout-head',
          checkoutHead: CANDIDATE,
          expectedIdentity: identity(),
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'checkout-head-mismatch' });
  });

  it.each(['live-repair-head', 'effective-checkout-head'] as const)(
    'allows an exact current repairHead launch selected via %s',
    (selectionSource) => {
      expect(
        evaluateFrozenLineagePolicy(
          {
            operation: 'canonical-verification',
            selectionSource,
            checkoutHead: REPAIR_HEAD,
            expectedIdentity: identity(),
          },
          { marker: marker() },
        ),
      ).toMatchObject({ allowed: true, reason: 'repair-head-match' });
    },
  );

  it('allows the ordinary moving-tip regime when no frozen marker exists', () => {
    expect(
      evaluateFrozenLineagePolicy({ operation: 'candidate-selection', selectionSource: 'staging' }, { marker: null }),
    ).toMatchObject({ allowed: true, reason: 'no-frozen-queue', liveIdentity: null });
  });

  it('renders every refusal with the full queue identity, unsafe source, and sanctioned route', () => {
    const verdict = evaluateFrozenLineagePolicy(
      {
        operation: 'canonical-verification',
        selectionSource: 'current-head',
        checkoutHead: CANDIDATE,
        expectedIdentity: identity(),
      },
      { marker: marker() },
    );
    const rendered = renderFrozenLineagePolicyRefusal(verdict);
    expect(rendered).toContain(`candidate=${CANDIDATE}`);
    expect(rendered).toContain(`repairHead=${REPAIR_HEAD}`);
    expect(rendered).toContain(`queueRevision=${REVISION}`);
    expect(rendered).toContain("source 'current-head'");
    expect(rendered).toContain("release:repair-queue { op:'admit', paths:[...] }");
  });
});

describe('frozen lineage launch CAS', () => {
  it('allows only an exact second-read identity at the selected repairHead', () => {
    expect(assessFrozenLineageLaunchCas(identity(), launchPreflight(), REPAIR_HEAD)).toMatchObject({
      allowed: true,
      reason: 'repair-head-match',
      expectedIdentity: identity(),
      liveIdentity: identity(),
      checkoutHead: REPAIR_HEAD,
      mismatchedIdentityFields: [],
    });
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION + 1 })],
  ] as const)('refuses a second-read %s mismatch before launch', (field, liveIdentity) => {
    const verdict = assessFrozenLineageLaunchCas(
      identity(),
      launchPreflight({ frozenLineageIdentity: liveIdentity }),
      REPAIR_HEAD,
    );

    expect(verdict).toMatchObject({
      allowed: false,
      reason: 'queue-identity-mismatch',
      expectedIdentity: identity(),
      liveIdentity,
      mismatchedIdentityFields: [field],
    });
    expect(verdict.detail).toContain(`candidate=${liveIdentity.candidate}`);
    expect(verdict.detail).toContain(`repairHead=${liveIdentity.repairHead}`);
    expect(verdict.detail).toContain(`queueRevision=${liveIdentity.queueRevision}`);
  });

  it('treats queue appearance, disappearance, and unreadability as failed CAS outcomes', () => {
    expect(assessFrozenLineageLaunchCas(null, launchPreflight(), REPAIR_HEAD)).toMatchObject({
      allowed: false,
      reason: 'queue-appeared',
      mismatchedIdentityFields: ['candidate', 'repairHead', 'queueRevision'],
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({ frozenLineageIdentity: null, candidate: null, queueDecision: 'run-normal-gate' }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'queue-disappeared',
      mismatchedIdentityFields: ['candidate', 'repairHead', 'queueRevision'],
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({
          proceed: false,
          reason: 'queue-unreadable',
          frozenLineageIdentity: null,
          queueDecision: null,
          detail: 'parse failed',
        }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-unreadable' });
  });

  it('refuses an exact identity when the checkout or queue disposition is not runnable', () => {
    expect(assessFrozenLineageLaunchCas(identity(), launchPreflight(), CANDIDATE)).toMatchObject({
      allowed: false,
      reason: 'checkout-head-mismatch',
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({ proceed: false, reason: 'repair-in-progress', queueDecision: 'wait-for-fixer' }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-not-runnable' });
  });
});

describe('frozen lineage carry policy', () => {
  it.each([
    ['staging', 'Then pin whatever `staging` resolves to at that instant, still never a quoted sha.'],
    ['current-head', 'Create the canonical verification worktree pinned to current HEAD and run the root test.'],
    ['integration-branch', 'Use integrationBranch as the judged candidate for the canonical verdict.'],
  ] as const)('detects a positive %s candidate instruction', (unsafeSource, text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toMatchObject({ unsafeSource });
  });

  it.each([
    'Run focused unit tests on staging while the repair is admitted separately.',
    'The earlier instruction to pin current staging/current HEAD was wrong and is retracted.',
    'Never derive the judged candidate from staging; use the live repairHead.',
    'A checkpoint that instructs a successor to use current HEAD as the judged candidate is rejected.',
    'The policy refuses candidate selection from integrationBranch.',
  ])('allows ordinary, negated, or corrective prose: %s', (text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it('fails closed with the exact incident identity and actionable repair route', () => {
    const verdict = evaluateFrozenLineageCarryText(
      {
        surface: 'work-item-checkpoint',
        text: 'Then pin whatever staging resolves to at that instant.',
      },
      { marker: marker() },
    );
    expect(verdict).toMatchObject({
      allowed: false,
      errorCode: 'frozen_candidate_lineage_violation',
      unsafeSource: 'staging',
      liveIdentity: identity(),
    });
    const rendered = renderFrozenLineageCarryRefusal(verdict);
    expect(rendered).toContain(`candidate=${CANDIDATE}`);
    expect(rendered).toContain(`repairHead=${REPAIR_HEAD}`);
    expect(rendered).toContain(`queueRevision=${REVISION}`);
    expect(rendered).toContain("source");
    expect(rendered).toContain("release:repair-queue { op:'admit', paths:[...] }");
    expect(frozenLineageCarryViolationPayload(verdict)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'work-item-checkpoint',
    });
  });

  it('allows the same text when no frozen marker exists', () => {
    expect(
      evaluateFrozenLineageCarryText(
        { surface: 'compaction-continuation', text: 'Pin staging as the canonical candidate.' },
        { marker: null },
      ),
    ).toMatchObject({ allowed: true, reason: 'no-frozen-queue' });
  });
});
