/**
 * P-003: the ratified-reference store against REAL Postgres.
 *
 * The domain rules are proved without a database in `reference-store.test.ts`.
 * This file exists for the three claims a fake cannot honestly attest to, each
 * of which is a property of the actual schema:
 *
 *  1. THE PRIMARY KEY IS THE CONCURRENCY GUARANTEE. Two ratifications racing for
 *     the same revision both read the same state and both decide that revision
 *     is next. Only a real unique index decides which one lands. A test double
 *     that refuses duplicates because we wrote it to is circular evidence.
 *  2. PROVENANCE IS ACTUALLY IMMUTABLE. Superseding a revision must leave its
 *     `payload` bytes untouched. That is a claim about what an UPDATE statement
 *     does, and it is checked here by reading the stored jsonb back and
 *     comparing it to what was written.
 *  3. MIGRATION 948 REALLY ADMITS THESE KINDS. `hda_kind_chk` is a CHECK
 *     constraint; whether it admits `ratified_reference` is a fact about the
 *     applied schema, not about our TypeScript.
 *
 * No RLS ceremony: `harness_design_artifacts` is harness-scoped, not
 * workspace-scoped — it carries no `workspace_id` column, has `relrowsecurity`
 * false and zero policies (verified against the live schema). Adding a
 * `set_config('app.workspace_id', …)` here would be cargo-cult, and worse,
 * would imply an isolation guarantee this table does not have.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CaptureEnvironment } from './contract';
import type { RatifiedReference } from './ratification';
import {
  RATIFIED_REFERENCE_ARTIFACT_KIND,
  COMPARE_RESULT_ARTIFACT_KIND,
  ReferenceStoreError,
  type ReferenceImageRef,
  type ReferenceScope,
  activeRevision,
  ratifyReference,
  referenceArtifactId,
  staleEvidence,
} from './reference-store';
import { createPgReferenceStore, readReferenceLifecycle, type SqlTag } from './reference-store-pg';
import type { OrgTestDb } from '../../test/_org-test-db';

const { createOrgTestDb } = await import('../../test/_org-test-db');

const ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium-131',
  theme: 'dark',
  fontSet: 'inter-v13',
  fixture: 'loaded',
  state: 'hover',
};

const IMAGE: ReferenceImageRef = {
  mediaType: 'image/png',
  locator: 'data:image/png;base64,AAAA',
  byteLength: 4,
  width: 2560,
  height: 1600,
};

let db: OrgTestDb;
let sql: SqlTag;

let n = 0;
function freshScope(): ReferenceScope {
  n += 1;
  return {
    harnessSlug: `h_${n}_${randomBytes(2).toString('hex')}`,
    featureId: `WI-${1000 + n}`,
    referenceId: `ref_${n}`,
  };
}

function candidate(scope: ReferenceScope, revision: number): RatifiedReference {
  return {
    identity: {
      referenceId: scope.referenceId,
      revision,
      referenceClass: 'figma-export',
      contentSha256: String(revision).repeat(64).slice(0, 64),
    },
    state: 'active',
    provenance: {
      source: 'figma-export',
      sourceRef: 'figma://file/abc?node-id=1:2',
      ratifiedBy: 'aviynw',
      ratifiedAt: '2026-08-25T00:00:00.000Z',
    },
    referenceEnvironment: ENVIRONMENT,
    requiredCases: [
      {
        caseId: 'desktop-default',
        environment: ENVIRONMENT,
        target: { targetId: 'components-login--default', targetKind: 'storybook-story' },
        rationale: 'primary breakpoint',
      },
    ],
  };
}

const clock = () => 1_756_000_000_000;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.appSql as unknown as SqlTag;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('the applied schema admits the artifact kinds migration 948 declared', () => {
  it('accepts ratified_reference and compare_result, and still refuses an unknown kind', async () => {
    const scope = freshScope();
    for (const kind of [RATIFIED_REFERENCE_ARTIFACT_KIND, COMPARE_RESULT_ARTIFACT_KIND]) {
      await sql`
        INSERT INTO harness_shared.harness_design_artifacts
               (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${`probe-${kind}`}, ${scope.harnessSlug}, ${scope.featureId}, ${kind},
                '{}'::jsonb, '{}'::jsonb, ${clock()})
      `;
    }
    await expect(
      sql`
        INSERT INTO harness_shared.harness_design_artifacts
               (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES ('probe-bogus', ${scope.harnessSlug}, ${scope.featureId}, 'not_a_kind',
                '{}'::jsonb, '{}'::jsonb, ${clock()})
      `,
    ).rejects.toThrow();
  });
});

describe('persisting and revising a reference', () => {
  it('stores the payload and its derived metadata projection', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });

    const rows = await sql<{ id: string; kind: string; metadata: Record<string, unknown> }>`
      SELECT id, kind, metadata
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${scope.harnessSlug} AND feature_id = ${scope.featureId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(referenceArtifactId(scope.referenceId, 1));
    expect(rows[0]!.kind).toBe(RATIFIED_REFERENCE_ARTIFACT_KIND);
    expect(rows[0]!.metadata).toMatchObject({
      referenceId: scope.referenceId,
      revision: 1,
      referenceClass: 'figma-export',
      state: 'active',
      viewportWidth: 1280,
      deviceScaleFactor: 2,
      theme: 'dark',
      fontSet: 'inter-v13',
      fixture: 'loaded',
      interactionState: 'hover',
      supersededByRevision: null,
    });

    const readBack = await store.listRevisions(scope);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.reference.provenance.ratifiedBy).toBe('aviynw');
    expect(readBack[0]!.image.mediaType).toBe('image/png');
  });

  it('leaves the superseded revision PAYLOAD byte-identical while its metadata moves', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });

    const before = await sql<{ payload: unknown }>`
      SELECT payload::text AS payload
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${scope.harnessSlug}
         AND id = ${referenceArtifactId(scope.referenceId, 1)}
    `;

    await ratifyReference(store, { scope, candidate: candidate(scope, 2), image: IMAGE, now: clock });

    const after = await sql<{ payload: unknown; metadata: Record<string, unknown> }>`
      SELECT payload::text AS payload, metadata
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${scope.harnessSlug}
         AND id = ${referenceArtifactId(scope.referenceId, 1)}
    `;

    // Provenance is the audit trail. If this ever fails, the store has started
    // rewriting history in place.
    expect(after[0]!.payload).toEqual(before[0]!.payload);
    expect(after[0]!.metadata).toMatchObject({ state: 'superseded', supersededByRevision: 2 });

    const lifecycle = await readReferenceLifecycle(sql, scope);
    expect(lifecycle).toEqual([
      { revision: 1, state: 'superseded', supersededByRevision: 2 },
      { revision: 2, state: 'active', supersededByRevision: null },
    ]);
    expect(activeRevision(await store.listRevisions(scope))?.reference.identity.revision).toBe(2);
  });
});

describe('the primary key is what makes revisions monotonic under concurrency', () => {
  it('lets exactly one of two racing ratifications of the same revision land', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });

    // Both callers read revision 1 and both conclude 2 is next. A read-then-write
    // check cannot separate them; the unique index can.
    const results = await Promise.allSettled([
      ratifyReference(store, { scope, candidate: candidate(scope, 2), image: IMAGE, now: clock }),
      ratifyReference(store, { scope, candidate: candidate(scope, 2), image: IMAGE, now: clock }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason as ReferenceStoreError;
    expect(reason).toBeInstanceOf(ReferenceStoreError);
    expect(reason.code).toBe('revision-conflict');

    const rows = await sql<{ count: string }>`
      SELECT count(*)::text AS count
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${scope.harnessSlug}
         AND id = ${referenceArtifactId(scope.referenceId, 2)}
    `;
    expect(rows[0]!.count).toBe('1');
  });
});

describe('evidence bound to a superseded revision', () => {
  async function insertEvidence(
    scope: ReferenceScope,
    artifactId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await sql`
      INSERT INTO harness_shared.harness_design_artifacts
             (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
      VALUES (${artifactId}, ${scope.harnessSlug}, ${scope.featureId},
              ${COMPARE_RESULT_ARTIFACT_KIND}, ${JSON.stringify(payload)}::jsonb,
              '{}'::jsonb, ${clock()})
    `;
  }

  it('is reported invalidated by the revision that superseded it', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await insertEvidence(scope, 'ev-1', {
      reference: { referenceId: scope.referenceId, revision: 1 },
      capturedAt: '2026-08-25T01:00:00.000Z',
      verdict: 'pass',
    });

    const outcome = await ratifyReference(store, {
      scope,
      candidate: candidate(scope, 2),
      image: IMAGE,
      now: clock,
    });
    expect(outcome.invalidatedEvidence.map((e) => e.artifactId)).toEqual(['ev-1']);

    const evidence = await store.listEvidence(scope);
    expect(staleEvidence(2, evidence).map((e) => e.artifactId)).toEqual(['ev-1']);
    expect(staleEvidence(1, evidence)).toEqual([]);
  });

  it('reports evidence whose revision cannot be read as stale, never as current', async () => {
    // A row we cannot parse must not silently shrink the invalidated set —
    // "this revision cost you nothing" is the most reassuring wrong answer
    // available, so an unreadable row is always stale.
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await insertEvidence(scope, 'ev-malformed', {
      reference: { referenceId: scope.referenceId },
    });

    const evidence = await store.listEvidence(scope);
    expect(evidence).toHaveLength(1);
    expect(Number.isNaN(evidence[0]!.referenceRevision)).toBe(true);
    expect(staleEvidence(1, evidence).map((e) => e.artifactId)).toEqual(['ev-malformed']);
  });

  it('does not pick up evidence for a different reference in the same feature', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await insertEvidence(scope, 'ev-other', {
      reference: { referenceId: 'a-different-reference', revision: 1 },
      capturedAt: '2026-08-25T01:00:00.000Z',
    });

    expect(await store.listEvidence(scope)).toEqual([]);
  });
});

/**
 * P-007 — feature-level DISCOVERY, against the real schema.
 *
 * This query is what makes the completion gate un-bypassable: it finds a
 * feature's ratified references instead of asking the caller to name them. It
 * reads `metadata->>'referenceId'`, a projection written by `projectMetadata`,
 * so reader and writer are only genuinely checked against each other by
 * round-tripping through Postgres — the same reader/writer gap that made the
 * P-006 evidence filter worth pinning here.
 *
 * The dangerous failure is silent in BOTH directions: a query that matches
 * nothing reports a feature as unratified (the gate never fires), and one that
 * counts revisions instead of references reports obligations that do not exist.
 */
describe('discovering every reference under a feature', () => {
  it('returns each reference ONCE regardless of how many revisions it has', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    const second: ReferenceScope = { ...scope, referenceId: `${scope.referenceId}-mobile` };

    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 2), image: IMAGE, now: clock });
    await ratifyReference(store, {
      scope: second,
      candidate: candidate(second, 1),
      image: IMAGE,
      now: clock,
    });

    const ids = await store.listFeatureReferenceIds({
      harnessSlug: scope.harnessSlug,
      featureId: scope.featureId,
    });
    // Two references, three revisions. Counting rows would report three.
    expect([...ids].sort()).toEqual([second.referenceId, scope.referenceId].sort());
  });

  it('does not leak references belonging to another feature or harness', async () => {
    const mine = freshScope();
    const otherFeature = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });

    await ratifyReference(store, { scope: mine, candidate: candidate(mine, 1), image: IMAGE, now: clock });
    await ratifyReference(store, {
      scope: otherFeature,
      candidate: candidate(otherFeature, 1),
      image: IMAGE,
      now: clock,
    });

    expect(
      await store.listFeatureReferenceIds({
        harnessSlug: mine.harnessSlug,
        featureId: mine.featureId,
      }),
    ).toEqual([mine.referenceId]);
  });

  it('reports a feature with no references as empty, not as an error', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    expect(
      await store.listFeatureReferenceIds({
        harnessSlug: scope.harnessSlug,
        featureId: scope.featureId,
      }),
    ).toEqual([]);
  });

  it('still lists a reference whose only revision has been RETRACTED', async () => {
    // Applicability is the gate's decision, not this query's. Filtering retracted
    // references away here would erase the difference between "ratified then
    // withdrawn" and "never ratified" before anyone could see it.
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await store.setLifecycle(scope, referenceArtifactId(scope.referenceId, 1), {
      state: 'retracted',
    });

    expect(
      await store.listFeatureReferenceIds({
        harnessSlug: scope.harnessSlug,
        featureId: scope.featureId,
      }),
    ).toEqual([scope.referenceId]);
  });
});

/**
 * P-006 — the evidence WRITER, against the real schema.
 *
 * `listEvidence` existed before any writer did, and its filter
 * (`payload->'reference'->>'referenceId'`) encoded an assumption about a shape
 * nothing produced yet. A writer that stored a differently-shaped payload would
 * have left that filter matching nothing — and "no evidence for this reference"
 * is indistinguishable from "this reference has never been compared". These
 * tests exist because the two halves can only be checked against each other by
 * actually round-tripping through Postgres.
 */
describe('storing comparison evidence', () => {
  function result(
    scope: ReferenceScope,
    revision: number,
    overrides: Record<string, unknown> = {},
  ): import('./contract').CompareResult {
    return {
      schemaVersion: 1,
      verdict: 'pass',
      reference: {
        referenceId: scope.referenceId,
        revision,
        referenceClass: 'figma-export',
        contentSha256: 'a'.repeat(64),
      },
      target: {
        targetId: 'story--default',
        targetKind: 'storybook-story',
        implementationRevision: 'impl-1',
      },
      environment: ENVIRONMENT,
      engine: { engine: 'lost-pixel/pixelmatch', engineVersion: '3.22.0' },
      policy: {
        policyVersion: 'p-1',
        referenceClass: 'figma-export',
        eligibility: 'gateable',
        maxDiffRatio: 0.01,
        derivedFrom: 'calibration-1',
      },
      counts: { pixelDifference: 3, pixelsTotal: 1_000_000 },
      diffRatio: 0.000003,
      capturedAt: '2026-08-25T02:00:00.000Z',
      ...overrides,
    } as import('./contract').CompareResult;
  }

  it('round-trips a whole result, and the staleness projection sees the same row', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });

    await store.insertEvidence({
      artifactId: 'ev-roundtrip',
      result: result(scope, 1),
      featureId: scope.featureId,
      harnessSlug: scope.harnessSlug,
    });

    const full = await store.listEvidenceResults(scope);
    expect(full).toHaveLength(1);
    expect(full[0]!.result).toEqual(result(scope, 1));
    expect(full[0]!.harnessSlug).toBe(scope.harnessSlug);

    // The cheap projection and the full read must agree about WHICH evidence
    // exists. They are different queries over the same rows, so a shape change
    // that broke one while leaving the other working is precisely the drift
    // this asserts against.
    const refs = await store.listEvidence(scope);
    expect(refs.map((r) => r.artifactId)).toEqual(['ev-roundtrip']);
    expect(refs[0]!.referenceRevision).toBe(1);
    expect(staleEvidence(1, refs)).toEqual([]);
    expect(staleEvidence(2, refs).map((r) => r.artifactId)).toEqual(['ev-roundtrip']);
  });

  it('replaces a re-run of the same comparison instead of adding a rival row', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });

    const row = {
      artifactId: 'ev-upsert',
      featureId: scope.featureId,
      harnessSlug: scope.harnessSlug,
    };
    await store.insertEvidence({ ...row, result: result(scope, 1) });
    await store.insertEvidence({
      ...row,
      result: result(scope, 1, { verdict: 'fail', diffRatio: 0.4 }),
    });

    // The insert path for a REFERENCE refuses a duplicate id; this one must
    // not, or a second comparison run would fail instead of superseding.
    const full = await store.listEvidenceResults(scope);
    expect(full).toHaveLength(1);
    expect(full[0]!.result.verdict).toBe('fail');
  });

  it('projects queryable metadata that agrees with the payload it describes', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await store.insertEvidence({
      artifactId: 'ev-meta',
      result: result(scope, 1, { verdict: 'fail' }),
      featureId: scope.featureId,
      harnessSlug: scope.harnessSlug,
    });

    const [meta] = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${scope.harnessSlug} AND id = 'ev-meta'
    `;
    // A metadata filter is what a review surface actually queries on. If it
    // could disagree with the payload, "show me the failing evidence" would
    // return a set that does not match the evidence itself.
    expect(meta!.metadata).toMatchObject({
      verdict: 'fail',
      referenceId: scope.referenceId,
      revision: 1,
      policyVersion: 'p-1',
      engineVersion: '3.22.0',
    });
  });

  it('does not return another reference\'s evidence from the same feature', async () => {
    const scope = freshScope();
    const store = createPgReferenceStore({ sql, now: clock });
    await ratifyReference(store, { scope, candidate: candidate(scope, 1), image: IMAGE, now: clock });
    await store.insertEvidence({
      artifactId: 'ev-foreign',
      result: result({ ...scope, referenceId: 'a-different-reference' }, 1),
      featureId: scope.featureId,
      harnessSlug: scope.harnessSlug,
    });

    expect(await store.listEvidenceResults(scope)).toEqual([]);
  });
});
