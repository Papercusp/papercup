/**
 * P-003: the ratified-reference store, domain rules.
 *
 * These run against the in-memory port, which enforces the same duplicate-id
 * refusal the primary key does — so a rule proved here holds against Postgres
 * too. The persistence itself (immutable payload, the derived metadata
 * projection, the PK as a concurrency guarantee) is proved separately in
 * `reference-store-pg.integration.test.ts` against a real database, because
 * none of those are properties a fake can honestly attest to.
 */
import { describe, expect, it } from 'vitest';

import type { CaptureEnvironment, ReferenceClass } from './contract';
import type { RatifiedReference } from './ratification';
import {
  ReferenceStoreError,
  type ReferenceImageRef,
  type ReferenceScope,
  type StoredEvidenceRef,
  activeRevision,
  createInMemoryReferenceStore,
  highestRevision,
  projectMetadata,
  ratifyReference,
  referenceArtifactId,
  retractReference,
  staleEvidence,
} from './reference-store';

const ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium-131',
  theme: 'dark',
  fontSet: 'inter-v13',
  fixture: 'loaded',
  state: 'hover',
};

const SCOPE: ReferenceScope = {
  harnessSlug: 'papercusp',
  featureId: 'WI-1000',
  referenceId: 'checkout-summary',
};

const IMAGE: ReferenceImageRef = {
  mediaType: 'image/png',
  locator: 'data:image/png;base64,AAAA',
  byteLength: 4,
  width: 2560,
  height: 1600,
};

function candidate(
  revision: number,
  overrides: Partial<RatifiedReference> = {},
  referenceClass: ReferenceClass = 'figma-export',
): RatifiedReference {
  return {
    identity: {
      referenceId: SCOPE.referenceId,
      revision,
      referenceClass,
      contentSha256: String(revision).repeat(64).slice(0, 64),
    },
    state: 'active',
    provenance: {
      source: 'figma-export',
      sourceRef: 'figma://file/abc?node-id=1:2',
      ratifiedBy: 'aviynw',
      ratifiedAt: `2026-08-2${revision}T00:00:00.000Z`,
    },
    referenceEnvironment: ENVIRONMENT,
    requiredCases: [
      { caseId: 'desktop-default', environment: ENVIRONMENT, rationale: 'primary breakpoint' },
    ],
    ...overrides,
  };
}

function evidenceAt(revision: number, artifactId = `ev-${revision}`): StoredEvidenceRef {
  return {
    artifactId,
    referenceId: SCOPE.referenceId,
    referenceRevision: revision,
    capturedAt: '2026-08-25T00:00:00.000Z',
  };
}

const clock = () => 1_756_000_000_000;

describe('ratifying a reference', () => {
  it('stores the first revision and reports nothing superseded', async () => {
    const store = createInMemoryReferenceStore();
    const outcome = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(1),
      image: IMAGE,
      now: clock,
    });

    expect(outcome.stored.artifactId).toBe('ratref:checkout-summary:1');
    expect(outcome.supersededRevision).toBeUndefined();
    expect(outcome.invalidatedEvidence).toEqual([]);
    expect(activeRevision(await store.listRevisions(SCOPE))?.reference.identity.revision).toBe(1);
  });

  it('derives the artifact id from reference and revision, so the PK can enforce uniqueness', () => {
    expect(referenceArtifactId('a', 3)).toBe('ratref:a:3');
    expect(referenceArtifactId('a', 3)).toBe(referenceArtifactId('a', 3));
    expect(referenceArtifactId('a', 4)).not.toBe(referenceArtifactId('a', 3));
  });

  it('refuses a reference that declares no required case, which would gate vacuously', async () => {
    const store = createInMemoryReferenceStore();
    await expect(
      ratifyReference(store, {
        scope: SCOPE,
        candidate: candidate(1, { requiredCases: [] }),
        image: IMAGE,
        now: clock,
      }),
    ).rejects.toThrow(/at least one required case/);
    expect(store.rows.size).toBe(0);
  });

  it("refuses a 'derived-reference' with no derivedFrom, which would lose the audit trail", async () => {
    const store = createInMemoryReferenceStore();
    await expect(
      ratifyReference(store, {
        scope: SCOPE,
        candidate: candidate(1, {}, 'derived-reference'),
        image: IMAGE,
        now: clock,
      }),
    ).rejects.toThrow(/derivedFrom/);
  });

  it('refuses a candidate that is not being ratified into the active state', async () => {
    const store = createInMemoryReferenceStore();
    await expect(
      ratifyReference(store, {
        scope: SCOPE,
        candidate: candidate(1, { state: 'superseded' }),
        image: IMAGE,
        now: clock,
      }),
    ).rejects.toThrow(/ratified into the 'active' state/);
  });

  it('reports every validation problem at once rather than one per round-trip', async () => {
    const store = createInMemoryReferenceStore();
    const bad = candidate(1, {
      requiredCases: [],
      provenance: { ...candidate(1).provenance, derivedFrom: undefined },
    }, 'derived-reference');

    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock })
      .catch(() => {});
    const store2 = createInMemoryReferenceStore();
    const error = await ratifyReference(store2, {
      scope: SCOPE,
      candidate: bad,
      image: IMAGE,
      now: clock,
    }).catch((e: unknown) => e as ReferenceStoreError);

    expect(error).toBeInstanceOf(ReferenceStoreError);
    expect((error as ReferenceStoreError).code).toBe('validation-failed');
    expect((error as ReferenceStoreError).errors.map((e) => e.code).sort()).toEqual([
      'missing-derivation',
      'no-required-cases',
    ]);
  });
});

describe('revising a reference', () => {
  it('supersedes the prior revision and points it at its replacement', async () => {
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    const outcome = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(2),
      image: IMAGE,
      now: clock,
    });

    expect(outcome.supersededRevision).toBe(1);
    const rows = await store.listRevisions(SCOPE);
    expect(rows.map((r) => [r.reference.identity.revision, r.reference.state])).toEqual([
      [1, 'superseded'],
      [2, 'active'],
    ]);
    expect(rows[0]!.reference.supersededByRevision).toBe(2);
    expect(activeRevision(rows)?.reference.identity.revision).toBe(2);
    expect(highestRevision(rows)).toBe(2);
  });

  it('refuses a revision that does not increase, as a CONFLICT rather than a shape error', async () => {
    // The code matters as much as the refusal: 'revision-conflict' tells the
    // caller to re-read and retry, 'validation-failed' tells it the submission
    // is malformed. A duplicate revision is the first, and reporting it as the
    // second sends a racing caller down a path where retrying looks pointless.
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(2), image: IMAGE, now: clock });

    const duplicate = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(2),
      image: IMAGE,
      now: clock,
    }).catch((e: unknown) => e as ReferenceStoreError);
    expect(duplicate).toBeInstanceOf(ReferenceStoreError);
    expect(duplicate.code).toBe('revision-conflict');
    expect(duplicate.message).toMatch(/already exists/);

    const lower = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(1),
      image: IMAGE,
      now: clock,
    }).catch((e: unknown) => e as ReferenceStoreError);
    expect(lower.code).toBe('revision-conflict');
    expect(lower.message).toMatch(/never reused/);
  });

  it('refuses reviving a retired revision number even with no active revision', async () => {
    // The hazard: evidence is bound to a NUMBER. Re-using a retracted revision's
    // number would make that evidence read as current for different bytes.
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(3), image: IMAGE, now: clock });
    await retractReference(store, SCOPE);
    expect(activeRevision(await store.listRevisions(SCOPE))).toBeUndefined();

    const error = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(3),
      image: IMAGE,
      now: clock,
    }).catch((e: unknown) => e as ReferenceStoreError);
    expect((error as ReferenceStoreError).code).toBe('revision-conflict');

    const lower = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(2),
      image: IMAGE,
      now: clock,
    }).catch((e: unknown) => e as ReferenceStoreError);
    expect((error as ReferenceStoreError).code).toBe('revision-conflict');
    expect((lower as ReferenceStoreError).message).toMatch(/never reused/);

    // Moving forward past the retraction is allowed.
    await expect(
      ratifyReference(store, { scope: SCOPE, candidate: candidate(4), image: IMAGE, now: clock }),
    ).resolves.toBeTruthy();
  });

  it('refuses changing a reference class across revisions', async () => {
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(1, {}, 'figma-export'),
      image: IMAGE,
      now: clock,
    });
    await expect(
      ratifyReference(store, {
        scope: SCOPE,
        candidate: candidate(2, {}, 'raster-mockup'),
        image: IMAGE,
        now: clock,
      }),
    ).rejects.toThrow(/class cannot change/);
  });

  it('refuses a duplicate insert at the port, the way the primary key does', async () => {
    const store = createInMemoryReferenceStore();
    const row = {
      artifactId: referenceArtifactId(SCOPE.referenceId, 1),
      reference: candidate(1),
      image: IMAGE,
      featureId: SCOPE.featureId,
      harnessSlug: SCOPE.harnessSlug,
    };
    await store.insert(row);
    await expect(store.insert(row)).rejects.toThrow(/already exists/);
  });
});

describe('revising invalidates prior evidence', () => {
  it('reports evidence bound to the superseded revision as invalidated', async () => {
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    store.evidence.push(evidenceAt(1, 'ev-a'), evidenceAt(1, 'ev-b'));

    const outcome = await ratifyReference(store, {
      scope: SCOPE,
      candidate: candidate(2),
      image: IMAGE,
      now: clock,
    });
    expect(outcome.invalidatedEvidence.map((e) => e.artifactId)).toEqual(['ev-a', 'ev-b']);
  });

  it('leaves evidence for the new revision current', () => {
    expect(staleEvidence(2, [evidenceAt(2)])).toEqual([]);
    expect(staleEvidence(2, [evidenceAt(1), evidenceAt(2)]).map((e) => e.referenceRevision)).toEqual([
      1,
    ]);
  });

  it('treats every piece of evidence as stale when there is no active revision', () => {
    // Spelled out because the natural default — "no active revision, nothing to
    // compare, so nothing is stale" — is exactly backwards and would let a
    // retracted design keep passing its gate.
    const all = [evidenceAt(1), evidenceAt(2)];
    expect(staleEvidence(undefined, all)).toEqual(all);
  });

  it('does not require a write, so there is no window where the sweep has not run', async () => {
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    store.evidence.push(evidenceAt(1));
    const before = [...store.evidence];
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(2), image: IMAGE, now: clock });
    // The evidence rows are untouched; they are stale because the ACTIVE
    // revision moved, not because something marked them.
    expect(store.evidence).toEqual(before);
  });
});

describe('retracting a reference', () => {
  it('leaves the surface unratified and every piece of evidence stale', async () => {
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    store.evidence.push(evidenceAt(1));

    const outcome = await retractReference(store, SCOPE);
    expect(outcome.retractedRevision).toBe(1);
    expect(outcome.invalidatedEvidence).toHaveLength(1);

    const rows = await store.listRevisions(SCOPE);
    expect(rows[0]!.reference.state).toBe('retracted');
    expect(activeRevision(rows)).toBeUndefined();
  });

  it('refuses to retract what was never ratified, distinctly from an already-retracted one', async () => {
    const store = createInMemoryReferenceStore();
    const never = await retractReference(store, SCOPE).catch((e: unknown) => e as ReferenceStoreError);
    expect((never as ReferenceStoreError).code).toBe('not-ratified');

    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    await retractReference(store, SCOPE);
    const again = await retractReference(store, SCOPE).catch((e: unknown) => e as ReferenceStoreError);
    expect((again as ReferenceStoreError).code).toBe('already-retracted');
  });

  it('activeRevision does not fall back to the newest row when it is retracted', async () => {
    // The bug this guards: reading rows[rows.length - 1] as "the current
    // reference" quietly re-ratifies a withdrawn design.
    const store = createInMemoryReferenceStore();
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(1), image: IMAGE, now: clock });
    await ratifyReference(store, { scope: SCOPE, candidate: candidate(2), image: IMAGE, now: clock });
    await retractReference(store, SCOPE);

    const rows = await store.listRevisions(SCOPE);
    expect(rows[rows.length - 1]!.reference.identity.revision).toBe(2);
    expect(activeRevision(rows)).toBeUndefined();
  });
});

describe('the metadata projection is derived, never hand-maintained', () => {
  it('carries every field P-003 requires, all traceable to the payload', () => {
    const stored = {
      reference: candidate(7),
      image: IMAGE,
      featureId: SCOPE.featureId,
      harnessSlug: SCOPE.harnessSlug,
    };
    expect(projectMetadata(stored)).toEqual({
      referenceId: 'checkout-summary',
      revision: 7,
      referenceClass: 'figma-export',
      state: 'active',
      contentSha256: stored.reference.identity.contentSha256,
      mediaType: 'image/png',
      width: 2560,
      height: 1600,
      viewportWidth: 1280,
      viewportHeight: 800,
      deviceScaleFactor: 2,
      browser: 'chromium-131',
      theme: 'dark',
      fontSet: 'inter-v13',
      fixture: 'loaded',
      interactionState: 'hover',
      requiredCaseCount: 1,
      supersededByRevision: null,
    });
  });

  it('changes with the payload — it cannot report a stale lifecycle', () => {
    const base = {
      reference: candidate(1),
      image: IMAGE,
      featureId: SCOPE.featureId,
      harnessSlug: SCOPE.harnessSlug,
    };
    const after = {
      ...base,
      reference: { ...base.reference, state: 'superseded' as const, supersededByRevision: 2 },
    };
    expect(projectMetadata(base).state).toBe('active');
    expect(projectMetadata(after).state).toBe('superseded');
    expect(projectMetadata(after).supersededByRevision).toBe(2);
  });

  it('distinguishes the interaction state from the lifecycle state', () => {
    // Both are called "state" in their own vocabularies; conflating them in a
    // query would silently filter references by the wrong thing.
    const projection = projectMetadata({
      reference: candidate(1),
      image: IMAGE,
      featureId: SCOPE.featureId,
      harnessSlug: SCOPE.harnessSlug,
    });
    expect(projection.state).toBe('active');
    expect(projection.interactionState).toBe('hover');
  });

  it('records null, not undefined, for an absent fixture or interaction state', () => {
    // jsonb round-trips null; undefined disappears, which would make "not
    // declared" indistinguishable from "key missing because of a write bug".
    const projection = projectMetadata({
      reference: candidate(1, {
        referenceEnvironment: { ...ENVIRONMENT, fixture: undefined, state: undefined },
      }),
      image: IMAGE,
      featureId: SCOPE.featureId,
      harnessSlug: SCOPE.harnessSlug,
    });
    expect(projection.fixture).toBeNull();
    expect(projection.interactionState).toBeNull();
  });
});
