/**
 * P-009 (EI-23431478594488191): the RULE governing whether a control-source
 * activation may carry an identity receipt forward.
 *
 * These bind the pure predicate. The two layers above it are bound separately
 * and deliberately: `identity-grants-port.test.ts` proves the carried receipt is
 * what the READER selects, and `control-anchor-refresh.test.ts` proves the SEAM
 * actually performs the write. A green predicate alone would prove only that a
 * helper nobody called is correct.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import {
  IDENTITY_HISTORY_LIMIT,
  carryIdentityReceiptForControlActivation,
  type SuLaunchArtifactHistoryEntry,
  type SuLaunchSpecRecord,
} from './su-persona-render';

/** The predicate never inspects the artifact's interior; it only carries it. */
const ARTIFACT = { specificationRevision: 'spec-a' } as unknown as ResolvedAgentSpecification;
const OTHER_ARTIFACT = { specificationRevision: 'spec-b' } as unknown as ResolvedAgentSpecification;

function record(overrides: Partial<SuLaunchSpecRecord> = {}): SuLaunchSpecRecord {
  return {
    v: 1,
    agent: 'su-1',
    workspaceId: 'ws-a',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: 'full',
    model: null,
    planSlug: null,
    launchedBy: null,
    autoMode: true,
    drainMode: false,
    loopArmed: true,
    fleet: null,
    stack: ['autonomy:su.mode-auto'],
    specificationRevision: 'spec-a',
    stateRevision: 'state-1',
    specificationArtifact: ARTIFACT,
    ...overrides,
  };
}

function entry(overrides: Partial<SuLaunchArtifactHistoryEntry> = {}): SuLaunchArtifactHistoryEntry {
  return {
    stack: [],
    specificationRevision: 'spec-a',
    stateRevision: 'state-0',
    specificationArtifact: ARTIFACT,
    recordedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('carryIdentityReceiptForControlActivation', () => {
  it('carries a receipt when a control activation advances only the state revision', () => {
    const carried = carryIdentityReceiptForControlActivation(record(), {
      specificationRevision: 'spec-a',
      stateRevision: 'state-2',
    });

    expect(carried).not.toBeNull();
    expect(carried?.[0]).toMatchObject({
      specificationRevision: 'spec-a',
      stateRevision: 'state-2',
      specificationArtifact: ARTIFACT,
      stack: ['autonomy:su.mode-auto'],
    });
  });

  it('preserves the prior receipts rather than replacing them', () => {
    const prior = entry({ stateRevision: 'state-0' });
    const carried = carryIdentityReceiptForControlActivation(
      record({ identityHistory: [prior] }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    );

    expect(carried).toHaveLength(2);
    expect(carried?.[1]).toEqual(prior);
  });

  // The load-bearing guard: this function COPIES an artifact forward under a new
  // revision pair, so a differing specification would mint a receipt — and hence
  // a `configuration.grants` — that nobody rendered. It must refuse, not carry.
  it('refuses to carry when the activation specification differs from the record', () => {
    expect(carryIdentityReceiptForControlActivation(
      record(),
      { specificationRevision: 'spec-b', stateRevision: 'state-2' },
    )).toBeNull();

    expect(carryIdentityReceiptForControlActivation(
      record({ specificationRevision: 'spec-b', specificationArtifact: OTHER_ARTIFACT }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    )).toBeNull();
  });

  it('writes nothing when the pair is already receipted by the record itself', () => {
    expect(carryIdentityReceiptForControlActivation(
      record(),
      { specificationRevision: 'spec-a', stateRevision: 'state-1' },
    )).toBeNull();
  });

  it('writes nothing when the pair is already receipted in history', () => {
    expect(carryIdentityReceiptForControlActivation(
      record({ identityHistory: [entry({ stateRevision: 'state-2' })] }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    )).toBeNull();
  });

  it('refuses without an artifact or a complete revision pair to carry', () => {
    expect(carryIdentityReceiptForControlActivation(
      record({ specificationArtifact: undefined }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    )).toBeNull();
    expect(carryIdentityReceiptForControlActivation(
      record({ stateRevision: undefined }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    )).toBeNull();
    expect(carryIdentityReceiptForControlActivation(record(), { specificationRevision: 'spec-a' }))
      .toBeNull();
    expect(carryIdentityReceiptForControlActivation(record(), { stateRevision: 'state-2' }))
      .toBeNull();
    expect(carryIdentityReceiptForControlActivation(null, {
      specificationRevision: 'spec-a', stateRevision: 'state-2',
    })).toBeNull();
    expect(carryIdentityReceiptForControlActivation(record(), null)).toBeNull();
  });

  it('caps the carried history at the shared receipt limit, newest first', () => {
    const history = Array.from({ length: IDENTITY_HISTORY_LIMIT + 4 }, (_, index) =>
      entry({ stateRevision: `old-${index}` }));
    const carried = carryIdentityReceiptForControlActivation(
      record({ identityHistory: history }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    );

    expect(carried).toHaveLength(IDENTITY_HISTORY_LIMIT);
    expect(carried?.[0].stateRevision).toBe('state-2');
    expect(carried?.at(-1)?.stateRevision).toBe(`old-${IDENTITY_HISTORY_LIMIT - 2}`);
  });

  it('deduplicates a history that already carried the same pair twice', () => {
    const carried = carryIdentityReceiptForControlActivation(
      record({
        identityHistory: [entry({ stateRevision: 'state-0' }), entry({ stateRevision: 'state-0' })],
      }),
      { specificationRevision: 'spec-a', stateRevision: 'state-2' },
    );

    expect(carried?.map((value) => value.stateRevision)).toEqual(['state-2', 'state-0']);
  });
});
