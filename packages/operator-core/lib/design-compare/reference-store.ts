/**
 * Mockup-to-implementation validation: the ratified-reference store.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-003).
 *
 * P-001 defined WHAT a ratified reference is (`ratification.ts`) and what
 * evidence about one looks like (`contract.ts`). This module makes a reference
 * DURABLE, on the design-artifact table that already exists — no new storage
 * system (D-003), and no new table: `harness_shared.harness_design_artifacts`
 * with `kind='ratified_reference'`, which migration 948 admitted.
 *
 * ─── THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE ──────────────────────
 *
 * 1. PROVENANCE IS IMMUTABLE. A stored record's `payload` is written once and
 *    never rewritten. Lifecycle — active, superseded, retracted — lives in
 *    `metadata`, which is a DERIVED PROJECTION of the payload plus that state.
 *    The reason is not tidiness: provenance is the audit trail that says which
 *    human ratified which bytes, and a field that can be edited in place cannot
 *    serve as one. `projectMetadata` is the only writer of that projection, and
 *    `reference-store.test.ts` asserts it round-trips, so the projection cannot
 *    drift from the payload it describes (the derived-truth rule).
 *
 * 2. REVISIONS ARE MONOTONIC, AND THE DATABASE ENFORCES IT. The artifact id is
 *    derived — `ratref:<referenceId>:<revision>` — so two agents racing to
 *    ratify revision 4 collide on the primary key. A read-then-write check
 *    alone cannot do that: both reads see revision 3, both decide 4 is next,
 *    and both write. `validateRatification` still runs, because a clear refusal
 *    beats a constraint violation, but the constraint is what makes the rule
 *    true under concurrency rather than merely usually true.
 *
 * 3. REVISING INVALIDATES PRIOR EVIDENCE, BY CONSTRUCTION. Evidence records the
 *    exact revision it was taken against; `isEvidenceCurrent` already refuses a
 *    mismatch. So a new revision does not need to go and mark old evidence
 *    stale — it is stale the moment the active revision moves, with no write
 *    and therefore no window in which a sweep has not run yet. `staleEvidence`
 *    reports which stored results just became unusable, for the human who wants
 *    to know what a revision cost them.
 *
 * The port is separated from the domain so the rules above are unit-testable
 * without a database, and so P-006 can expose them through the design-phase
 * plugin without importing Postgres. `reference-store-pg.ts` binds the port.
 */
import type { CaptureEnvironment, ReferenceClass } from './contract';
import {
  type RatificationError,
  type RatifiedReference,
  superseded,
  validateRatification,
} from './ratification';

/** `harness_design_artifacts.kind` for a ratified reference (migration 948). */
export const RATIFIED_REFERENCE_ARTIFACT_KIND = 'ratified_reference';
/** `harness_design_artifacts.kind` for stored comparison evidence (migration 948). */
export const COMPARE_RESULT_ARTIFACT_KIND = 'compare_result';

/**
 * The image formats a caller may PRESENT. Not the formats that can be ratified —
 * see `COMPARABLE_MEDIA_TYPES`.
 */
export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg'] as const;
export type ReferenceMediaType = (typeof REFERENCE_MEDIA_TYPES)[number];

/**
 * The formats the SELECTED comparison engine can actually read.
 *
 * P-005 is required to select pixelmatch (D-010 consequence 1), and lost-pixel's
 * pixelmatch path decodes both images with `PNG.sync.read` — read directly from
 * the installed `lost-pixel/dist/compare/compare.js:33-34`, which requires only
 * `pngjs`. pngjs decodes PNG and nothing else, so a JPEG reference cannot be
 * compared by the engine this system is required to use. (odiff does read JPEG,
 * which is exactly why this is worth stating: the capability exists in the
 * dependency tree and is unreachable through the engine we are mandated to
 * select.)
 *
 * So a JPEG reference is refused AT RATIFICATION rather than accepted and
 * discovered at comparison time. The failure is identical either way; the
 * difference is that here it is one clear refusal to the person uploading the
 * image, and there it is a gate that can never go green, found by whoever is
 * unlucky enough to be blocked by it.
 */
export const COMPARABLE_MEDIA_TYPES: readonly ReferenceMediaType[] = ['image/png'];

/**
 * Where a reference's bytes live.
 *
 * `sha256` is deliberately NOT here — it is `identity.contentSha256` on the
 * reference itself, because the digest is part of the reference's IDENTITY, not
 * of its storage. Duplicating it here would create two places to disagree.
 */
export interface ReferenceImageRef {
  readonly mediaType: ReferenceMediaType;
  /** Inline `data:` URL, an artifact URL, or a path — whatever the caller stored. */
  readonly locator: string;
  readonly byteLength: number;
  /** Dimensions as decoded at ratification. The contracted geometry of this reference. */
  readonly width: number;
  readonly height: number;
}

/** One durable ratified-reference record. `payload` in the artifact row. */
export interface StoredReference {
  readonly reference: RatifiedReference;
  readonly image: ReferenceImageRef;
  /** The accepted spec / feature this reference belongs to — the existing linkage. */
  readonly featureId: string;
  readonly harnessSlug: string;
}

/** A stored record as it comes back from the port, with its row identity. */
export interface StoredReferenceRow extends StoredReference {
  readonly artifactId: string;
  readonly createdTs: number;
}

/**
 * A reference to stored evidence. Only the fields staleness depends on: a store
 * that had to load whole `CompareResult`s to answer "what did this revision
 * invalidate" would read the entire evidence history to answer a question about
 * two integers.
 */
export interface StoredEvidenceRef {
  readonly artifactId: string;
  readonly referenceId: string;
  readonly referenceRevision: number;
  readonly capturedAt: string;
}

/** The derived, queryable projection written to the artifact row's `metadata`. */
export interface ReferenceMetadataProjection {
  readonly referenceId: string;
  readonly revision: number;
  readonly referenceClass: ReferenceClass;
  readonly state: RatifiedReference['state'];
  readonly contentSha256: string;
  readonly mediaType: ReferenceMediaType;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly browser: string;
  readonly theme: string;
  readonly fontSet: string;
  readonly fixture: string | null;
  /** The environment's interaction state ('default', 'hover', …), not the lifecycle state. */
  readonly interactionState: string | null;
  readonly requiredCaseCount: number;
  readonly supersededByRevision: number | null;
}

/**
 * Derive the queryable projection from a record.
 *
 * Everything here is already in the payload. It is projected out so a query can
 * filter by class, revision or viewport without parsing jsonb payloads — and it
 * is DERIVED in exactly one place so it can never say something the payload does
 * not. A hand-maintained metadata block would be a second copy of a truth the
 * payload owns, which is the drift this codebase has been bitten by repeatedly.
 */
export function projectMetadata(stored: StoredReference): ReferenceMetadataProjection {
  const env: CaptureEnvironment = stored.reference.referenceEnvironment;
  return {
    referenceId: stored.reference.identity.referenceId,
    revision: stored.reference.identity.revision,
    referenceClass: stored.reference.identity.referenceClass,
    state: stored.reference.state,
    contentSha256: stored.reference.identity.contentSha256,
    mediaType: stored.image.mediaType,
    width: stored.image.width,
    height: stored.image.height,
    viewportWidth: env.viewport.width,
    viewportHeight: env.viewport.height,
    deviceScaleFactor: env.deviceScaleFactor,
    browser: env.browser,
    theme: env.theme,
    fontSet: env.fontSet,
    fixture: env.fixture ?? null,
    interactionState: env.state ?? null,
    requiredCaseCount: stored.reference.requiredCases.length,
    supersededByRevision: stored.reference.supersededByRevision ?? null,
  };
}

/**
 * The artifact id for a reference revision.
 *
 * Derived rather than random so the primary key `(harness_slug, id)` is what
 * enforces one-record-per-revision. See property 2 in the header.
 */
export function referenceArtifactId(referenceId: string, revision: number): string {
  return `ratref:${referenceId}:${revision}`;
}

// ─── the port ────────────────────────────────────────────────────────────────

export interface ReferenceScope {
  readonly harnessSlug: string;
  readonly featureId: string;
  readonly referenceId: string;
}

export interface ReferenceStorePort {
  /** Every revision of one reference, ascending. Empty when never ratified. */
  listRevisions(scope: ReferenceScope): Promise<readonly StoredReferenceRow[]>;
  /**
   * Insert a new revision. MUST reject a duplicate `artifactId` rather than
   * overwriting — that rejection is the concurrency guarantee, not a nicety.
   */
  insert(row: StoredReference & { readonly artifactId: string }): Promise<void>;
  /** Rewrite ONLY the lifecycle projection of an existing revision. */
  setLifecycle(
    scope: ReferenceScope,
    artifactId: string,
    lifecycle: { readonly state: RatifiedReference['state']; readonly supersededByRevision?: number },
  ): Promise<void>;
  /** Evidence rows bound to this reference, any revision. */
  listEvidence(scope: ReferenceScope): Promise<readonly StoredEvidenceRef[]>;
}

/** Thrown for a refusal a caller is expected to handle, not a bug. */
export class ReferenceStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'validation-failed'
      | 'revision-conflict'
      | 'not-ratified'
      | 'already-retracted'
      | 'unsupported-media-type',
    readonly errors: readonly RatificationError[] = [],
  ) {
    super(message);
    this.name = 'ReferenceStoreError';
  }
}

// ─── domain operations over the port ─────────────────────────────────────────

/**
 * The currently-active revision, or undefined.
 *
 * "Active" is a property of the record, not of being newest: a retracted
 * reference has a newest revision and no active one, and the surface is
 * unratified again (D-001). Anything that reads `rows[rows.length - 1]` as "the
 * current reference" quietly re-ratifies a withdrawn design.
 */
export function activeRevision(
  rows: readonly StoredReferenceRow[],
): StoredReferenceRow | undefined {
  return rows.filter((r) => r.reference.state === 'active').sort(
    (a, b) => b.reference.identity.revision - a.reference.identity.revision,
  )[0];
}

export function highestRevision(rows: readonly StoredReferenceRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.reference.identity.revision), 0);
}

export interface RatifyOutcome {
  readonly stored: StoredReferenceRow;
  /** The revision this one replaced, when it replaced one. */
  readonly supersededRevision?: number;
  /**
   * Evidence that this ratification just made unusable. Reported, never
   * rewritten: evidence is stale because the active revision moved, so there is
   * nothing to mark and no window in which the marking has not happened yet.
   */
  readonly invalidatedEvidence: readonly StoredEvidenceRef[];
}

export interface RatifyInput {
  readonly scope: ReferenceScope;
  readonly candidate: RatifiedReference;
  readonly image: ReferenceImageRef;
  readonly now: () => number;
}

/**
 * Ratify a reference, or a new revision of one.
 *
 * The candidate carries its own revision number rather than having one
 * allocated: a caller who read revision 3 and is submitting 4 is making a claim
 * about what it saw, and checking that claim is how a lost update is caught.
 * Allocating silently would turn a stale read into a successful write.
 */
export async function ratifyReference(
  port: ReferenceStorePort,
  input: RatifyInput,
): Promise<RatifyOutcome> {
  const { scope, candidate, image } = input;
  const rows = await port.listRevisions(scope);
  const previousActive = activeRevision(rows);

  // ORDER MATTERS. The revision check runs BEFORE shape validation, because the
  // two refusals ask the caller for different things: a conflict means "the
  // world moved under you — re-read and retry", while a validation failure means
  // "your submission is malformed — fix it and resubmit". Retrying a malformed
  // submission is pointless, and re-reading is pointless for a malformed one, so
  // handing back the wrong code sends the caller down the wrong path. Running
  // validation first would report a duplicate revision as a shape error, which
  // is precisely the case where a retry IS the right response.
  //
  // Monotonic against EVERY revision ever recorded, not just the active one.
  // `validateRatification` compares against the active revision, which is the
  // right check while one exists — but after a retraction there is no active
  // revision, and without this a caller could re-ratify a number that has been
  // used before. That is not merely untidy: evidence records the revision it
  // was taken against, so reusing a number would make old evidence read as
  // CURRENT for a different image. Reviving a retired revision number is the
  // one way to make stale evidence look fresh, so it is refused outright.
  const highest = highestRevision(rows);
  if (rows.length > 0 && candidate.identity.revision <= highest) {
    const collides = rows.some(
      (r) => r.reference.identity.revision === candidate.identity.revision,
    );
    throw new ReferenceStoreError(
      collides
        ? `revision ${candidate.identity.revision} of '${scope.referenceId}' already exists ` +
          `(the highest is ${highest}); re-read and submit the next revision`
        : `revision ${candidate.identity.revision} of '${scope.referenceId}' is below the ` +
          `highest ever recorded (${highest}); revision numbers are never reused, because ` +
          `evidence is bound to a number and reusing one would make stale evidence read as current`,
      'revision-conflict',
    );
  }

  if (!COMPARABLE_MEDIA_TYPES.includes(image.mediaType)) {
    throw new ReferenceStoreError(
      `'${image.mediaType}' cannot be ratified: the mandated comparison engine ` +
        `(lost-pixel's pixelmatch path) decodes both images with pngjs, which reads PNG only, ` +
        `so a ${image.mediaType} reference could be stored but never compared. ` +
        `Convert it to PNG before ratifying. Accepted: ${COMPARABLE_MEDIA_TYPES.join(', ')}.`,
      'unsupported-media-type',
    );
  }

  const errors = validateRatification(candidate, previousActive?.reference);
  if (errors.length > 0) {
    throw new ReferenceStoreError(
      `ratification refused: ${errors.map((e) => e.message).join('; ')}`,
      'validation-failed',
      errors,
    );
  }

  if (candidate.state !== 'active') {
    throw new ReferenceStoreError(
      `a reference is ratified into the 'active' state, not '${candidate.state}'; supersede or retract an existing revision instead`,
      'validation-failed',
    );
  }

  const artifactId = referenceArtifactId(scope.referenceId, candidate.identity.revision);
  const stored: StoredReference = {
    reference: candidate,
    image,
    featureId: scope.featureId,
    harnessSlug: scope.harnessSlug,
  };

  await port.insert({ ...stored, artifactId });

  let supersededRevision: number | undefined;
  if (previousActive) {
    const marked = superseded(previousActive.reference, candidate.identity.revision);
    await port.setLifecycle(scope, previousActive.artifactId, {
      state: marked.state,
      supersededByRevision: candidate.identity.revision,
    });
    supersededRevision = previousActive.reference.identity.revision;
  }

  const evidence = await port.listEvidence(scope);
  return {
    stored: { ...stored, artifactId, createdTs: input.now() },
    ...(supersededRevision !== undefined ? { supersededRevision } : {}),
    invalidatedEvidence: staleEvidence(candidate.identity.revision, evidence),
  };
}

/**
 * Retract the active revision. The surface becomes unratified (D-001): no
 * active revision means nothing to gate against, and every piece of evidence is
 * stale because there is no current revision for it to match.
 */
export async function retractReference(
  port: ReferenceStorePort,
  scope: ReferenceScope,
): Promise<{ readonly retractedRevision: number; readonly invalidatedEvidence: readonly StoredEvidenceRef[] }> {
  const rows = await port.listRevisions(scope);
  const active = activeRevision(rows);
  if (!active) {
    throw new ReferenceStoreError(
      rows.length === 0
        ? `'${scope.referenceId}' has never been ratified, so there is nothing to retract`
        : `'${scope.referenceId}' has no active revision (its newest is ${highestRevision(rows)}); it is already retracted or superseded`,
      rows.length === 0 ? 'not-ratified' : 'already-retracted',
    );
  }
  await port.setLifecycle(scope, active.artifactId, { state: 'retracted' });
  const evidence = await port.listEvidence(scope);
  return {
    retractedRevision: active.reference.identity.revision,
    // No active revision: EVERY piece of evidence is stale, including evidence
    // for the revision just retracted.
    invalidatedEvidence: evidence,
  };
}

/**
 * Which stored evidence is not current for `activeRevisionNumber`.
 *
 * `undefined` means there is no active revision — retracted, or never ratified —
 * in which case all evidence is stale. That case is spelled out rather than
 * defaulted, because "no active revision" defaulting to "nothing is stale" is
 * exactly backwards and would let a retracted design keep passing its gate.
 */
export function staleEvidence(
  activeRevisionNumber: number | undefined,
  evidence: readonly StoredEvidenceRef[],
): readonly StoredEvidenceRef[] {
  if (activeRevisionNumber === undefined) return evidence;
  return evidence.filter((e) => e.referenceRevision !== activeRevisionNumber);
}

// ─── an in-memory port ───────────────────────────────────────────────────────

/**
 * A complete in-memory port.
 *
 * Not only a test double: P-006 exposes these operations through the
 * design-phase plugin, and a plugin test that needs a working store but not a
 * database uses this. It enforces the SAME duplicate-id refusal the primary key
 * enforces, so a test cannot pass here and fail against Postgres.
 */
export function createInMemoryReferenceStore(): ReferenceStorePort & {
  readonly rows: Map<string, StoredReferenceRow>;
  readonly evidence: StoredEvidenceRef[];
} {
  const rows = new Map<string, StoredReferenceRow>();
  const evidence: StoredEvidenceRef[] = [];
  let clock = 0;

  const inScope = (row: StoredReferenceRow, scope: ReferenceScope): boolean =>
    row.harnessSlug === scope.harnessSlug &&
    row.featureId === scope.featureId &&
    row.reference.identity.referenceId === scope.referenceId;

  return {
    rows,
    evidence,
    async listRevisions(scope) {
      return [...rows.values()]
        .filter((r) => inScope(r, scope))
        .sort((a, b) => a.reference.identity.revision - b.reference.identity.revision);
    },
    async insert(row) {
      if (rows.has(row.artifactId)) {
        throw new ReferenceStoreError(
          `artifact '${row.artifactId}' already exists`,
          'revision-conflict',
        );
      }
      clock += 1;
      rows.set(row.artifactId, { ...row, createdTs: clock });
    },
    async setLifecycle(_scope, artifactId, lifecycle) {
      const row = rows.get(artifactId);
      if (!row) throw new ReferenceStoreError(`artifact '${artifactId}' not found`, 'not-ratified');
      rows.set(artifactId, {
        ...row,
        reference: {
          ...row.reference,
          state: lifecycle.state,
          ...(lifecycle.supersededByRevision !== undefined
            ? { supersededByRevision: lifecycle.supersededByRevision }
            : {}),
        },
      });
    },
    async listEvidence(scope) {
      return evidence.filter((e) => e.referenceId === scope.referenceId);
    },
  };
}
