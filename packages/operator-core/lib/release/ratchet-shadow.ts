/**
 * RATCHET SHADOW (green-main-ratchet-convergence-2026-10-17 #D-025; wiring of P-007 and P-018).
 *
 * WHY. The new-red ejection planner (P-007, new-red-ejection.ts) and the composed promotion proof
 * (P-018, composed-promotion-proof.ts) both change what reaches main for the whole fleet. A wrong
 * composed proof promotes a red; a wrong ejection drops a good commit. So the gate runs them in
 * SHADOW first: each planner computes what it WOULD do beside the real verdict, and the record
 * goes to `gate_health.ratchetShadow`. Nothing here changes a verdict, builds a candidate, or
 * routes a red to anyone. Acting is a separate switch per planner, after at least 5 recorded
 * qualified shadow runs under the current instrument with no disagreement (D-025 #4, D-065).
 * The diagnostic records here lack the required qualification context and do not qualify.
 *
 * WHAT IS RECORDED.
 *   - composedProof: at a green selective verification of a frozen repair head, the plan (which
 *     tests a composed proof would re-run, which round-1 results it would carry, which changed
 *     files are type-only). After the full canonical run at that head, `compareComposedProofShadow`
 *     composes the verdict from the full run's results for the re-run set plus the carried
 *     round-1 results, and records whether it agrees with the full verdict. `missedByComposed`
 *     is the falsifier: a full-run failure the composition would have carried as passing.
 *   - newRedEjection: on a red run, the radius attribution (step 1) and the ejection plan
 *     (step 3) over the commits since the green pin. The blame check (step 2, D-003) needs a
 *     build without the commit and is NOT run in shadow, so attributions are radius-only.
 *
 * COST. Both planners need the related-test radius of a set of paths, which is one selector run
 * (`affected-tests --changed-paths ... --related --print-affected`). The ejection planner finds
 * the selecting commit per failing test by bisecting the commit range: a range whose radius does
 * not reach a test cannot contain a commit that selects it, so one query clears many commits.
 * Queries are memoized and capped by count and wall clock; when the budget runs out, the
 * commits not yet resolved read as "radius unknown", which never attributes (fail closed).
 */
import {
  composeVerdict,
  emitIdentity,
  planComposedProof,
  type ChangedFile,
  type ComposedProofPlan,
  type EmitIdentity,
  type ProofLintLeg,
  type TestVerdict,
} from './composed-promotion-proof';
import {
  attributeByRadius,
  planEjection,
  type CandidateCommit,
  type FailureAttribution,
} from './new-red-ejection';
import { readProofContextIdentity, type ProofContextComparison } from '@papercusp/test-config/configuration-snapshot';
import { createHash } from 'node:crypto';
import type { OperatorArtifactIdentity } from './operator-artifact';

/** Required definitions must belong to the executing artifact's input census.
 * A checkout read or a build SHA alone cannot stand in for loaded artifacts.
 * External selector scripts absent from that census leave the instrument unknown. */
export const RATCHET_INSTRUMENT_DEFINITIONS = [
  'packages/operator-core/lib/release/ratchet-shadow.ts',
  'packages/operator-core/lib/release/composed-promotion-proof.ts',
  'packages/operator-core/lib/release/new-red-ejection.ts',
  'packages/operator-core/lib/release/verdict-flip-quarantine.ts',
  'packages/operator-core/lib/release/critical-area-registry.ts',
  'packages/operator-core/lib/release/checkpoint-qualification-transaction.ts',
  'packages/operator-core/lib/release/repair-manifest.ts',
  'libs/test-config/src/configuration-snapshot.ts',
  'libs/test-config/src/execution-details.ts',
  'scripts/affected-tests.mjs',
  'scripts/lib/related-tests.mjs',
] as const;

export type RatchetInstrument =
  | { schemaVersion: 'instrument-v1'; status: 'unknown'; fingerprint: null; missing: string[] }
  | { schemaVersion: 'instrument-v1'; status: 'measured'; fingerprint: string;
      components: { execution: string; definitions: string; schema: string; selection: string } };

const instrumentDigest = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(['instrument-v1', value])).digest('hex');
const instrumentHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Consume the boot-time bundle receipt, never re-hash a possibly replaced disk
 * entry. Schema includes the applied-migration/schema measurement owed by the
 * context producer; the selector identity must also have its own producer.
 * This binds observations, and does not make a shadow row eligible or acting. */
export function captureRatchetInstrument(artifact: OperatorArtifactIdentity | null | undefined,
  proofContext: unknown): RatchetInstrument {
  const context = readProofContextIdentity(proofContext);
  const missing: string[] = [];
  const measured = artifact?.status === 'measured' && instrumentHash(artifact.bundleSha256)
    && instrumentHash(artifact.manifestSha256) && isRecord(artifact.sourceBlobs)
    && Object.keys(artifact.sourceBlobs).length > 0
    && Object.entries(artifact.sourceBlobs).every(([path, sha]) => path.length > 0
      && !path.startsWith('/') && !path.includes('\\')
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha));
  if (!measured) missing.push('executing-artifact-unmeasured');
  else if (RATCHET_INSTRUMENT_DEFINITIONS.some(path => !Object.hasOwn(artifact.sourceBlobs, path)))
    missing.push('executing-definition-closure-incomplete');
  if (!context?.components.schema) missing.push('applied-schema-unmeasured');
  if (!context?.components.selectionGraph) missing.push('selection-graph-unmeasured');
  if (missing.length) return { schemaVersion: 'instrument-v1', status: 'unknown', fingerprint: null, missing };
  const known = artifact as Extract<OperatorArtifactIdentity, { status: 'measured' }>;
  const components = { execution: known.bundleSha256,
    definitions: instrumentDigest(Object.entries(known.sourceBlobs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    schema: context!.components.schema!, selection: context!.components.selectionGraph! };
  return { schemaVersion: 'instrument-v1', status: 'measured', components,
    fingerprint: instrumentDigest([components.execution, components.definitions, components.schema, components.selection]) };
}

/** Recompute persisted identities; never adopt a caller's hash or completeness flag. */
export function parseRatchetInstrument(value: unknown): RatchetInstrument | undefined {
  if (!isRecord(value) || value.schemaVersion !== 'instrument-v1') return undefined;
  if (value.status === 'unknown') {
    if (Object.keys(value).sort().join(',') !== 'fingerprint,missing,schemaVersion,status'
      || value.fingerprint !== null || !Array.isArray(value.missing) || value.missing.length < 1
      || value.missing.length > 4 || new Set(value.missing).size !== value.missing.length
      || !value.missing.every(reason => ['executing-artifact-unmeasured', 'executing-definition-closure-incomplete',
        'applied-schema-unmeasured', 'selection-graph-unmeasured'].includes(reason))) return undefined;
    return { schemaVersion: 'instrument-v1', status: 'unknown', fingerprint: null, missing: [...value.missing] };
  }
  const c = value.components;
  if (value.status !== 'measured' || Object.keys(value).sort().join(',') !== 'components,fingerprint,schemaVersion,status'
    || !isRecord(c) || Object.keys(c).sort().join(',') !== 'definitions,execution,schema,selection'
    || ![c.execution, c.definitions, c.schema, c.selection].every(instrumentHash)
    || value.fingerprint !== instrumentDigest([c.execution, c.definitions, c.schema, c.selection])) return undefined;
  return { schemaVersion: 'instrument-v1', status: 'measured', fingerprint: value.fingerprint as string,
    components: { execution: c.execution as string, definitions: c.definitions as string,
      schema: c.schema as string, selection: c.selection as string } };
}

/** Test files a set of changed paths can reach; null when the selector widened or failed. */
export type RadiusQuery = (paths: readonly string[]) => Promise<ReadonlySet<string> | null>;

/** Most entries of any list kept in a record, so gate_health stays small. */
export const RATCHET_SHADOW_SAMPLE_CAP = 20;

function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function sample<T>(items: readonly T[]): T[] {
  return items.slice(0, RATCHET_SHADOW_SAMPLE_CAP);
}

/**
 * Test identity across the gate's two spellings of a test path: repo-relative
 * (`packages/x/lib/a.test.ts`) and workspace-relative (`lib/a.test.ts`).
 */
export function sameTest(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Whether a radius set reaches a test, under either spelling. */
export function radiusHasTest(radius: ReadonlySet<string>, test: string): boolean {
  if (radius.has(test)) return true;
  for (const r of radius) if (sameTest(r, test)) return true;
  return false;
}

/**
 * A failingTests entry that names a test FILE, as opposed to a workspace task
 * (`<ws> :: test`), a lint leg (`lint:tsc`) or a generator check. Anything else is treated as a
 * leg, which a composed proof always re-runs (the conservative direction).
 */
export function isTestFileId(id: string): boolean {
  const s = id.trim();
  if (!s || s.includes('::') || s.startsWith('lint:') || s.startsWith('gen:') || s.startsWith('@')) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(s) || s.includes('/');
}

// ---------------------------------------------------------------------------------------------
// P-018: composed promotion proof, in shadow
// ---------------------------------------------------------------------------------------------

export interface ComposedProofComparison {
  fullGreen: boolean;
  composedGreen: boolean;
  /** Same promotion decision AND no full-run failure the composition would have missed. */
  agree: boolean;
  /** Full-run failures the composed proof would have carried as passing: a wrong promotion. */
  missedByComposed: string[];
  /** Composed failures the full run did not report: a needless hold. */
  extraInComposed: string[];
  /** Re-run entries read as passing because the full run did not report them failing. */
  rerunReadFrom: 'full-run-failing-set';
  /** Diagnostic agreement alone lacks the required context/instrument binding.
   * Optional only for historical rows; readers recompute it before adoption. */
  qualification?: ComposedProofQualification;
}

/**
 * R15-INSTRUMENT-ROTATION. Whether one shadow comparison may count toward the composed-proof cohort.
 * `eligible` is derived from the record's own measured fields on every read, never from a stored claim.
 */
export type ComposedProofQualification =
  | {
      status: 'ineligible';
      reason: 'full-gate-fallback' | 'qualification-context-unmeasured' | 'unverified-legacy-comparison'
        | 'nothing-carried';
    }
  | {
      status: 'eligible';
      instrumentFingerprint: string;
      proofContext: { before: string; after: string };
      carriedCount: number;
    };

const PROOF_CONTEXT_FINGERPRINT = /^sha256-proof-context-v1:[a-f0-9]{64}$/;

/** Both sides of the proof context by fingerprint; undefined when either side is unmeasured or incomplete. */
function bindProofContext(value: ProofContextComparison | null | undefined): { before: string; after: string } | undefined {
  const before = readProofContextIdentity(value?.before);
  const after = readProofContextIdentity(value?.after);
  if (!before || !after) return undefined;
  if ([before, after].some((id) => Object.values(id.components).some((component) => component === null))) return undefined;
  return { before: before.fingerprint, after: after.fingerprint };
}

function comparisonQualification(record: unknown, comparison: unknown): ComposedProofQualification {
  const ineligible = (reason: Extract<ComposedProofQualification, { status: 'ineligible' }>['reason']) =>
    ({ status: 'ineligible' as const, reason });
  const mode = isRecord(record) ? record.mode : undefined;
  if (mode === 'full-gate') return ineligible('full-gate-fallback');
  if (!isRecord(record) || mode !== 'composed' || !isRecord(comparison)
    || comparison.rerunReadFrom !== 'full-run-failing-set') return ineligible('unverified-legacy-comparison');
  const instrument = parseRatchetInstrument(record.instrument);
  const fingerprint = instrument?.status === 'measured' ? instrument.fingerprint : null;
  const before = isRecord(record.proofContext) ? record.proofContext.before : undefined;
  const after = isRecord(record.proofContext) ? record.proofContext.after : undefined;
  if (fingerprint === null || typeof before !== 'string' || !PROOF_CONTEXT_FINGERPRINT.test(before)
    || typeof after !== 'string' || !PROOF_CONTEXT_FINGERPRINT.test(after)) return ineligible('qualification-context-unmeasured');
  const carried = record.carriedCount;
  if (typeof carried !== 'number' || !Number.isInteger(carried) || carried < 1) return ineligible('nothing-carried');
  return { status: 'eligible', instrumentFingerprint: fingerprint, proofContext: { before, after }, carriedCount: carried };
}

export interface ComposedProofShadowRecord {
  schemaVersion: 1;
  instrument?: RatchetInstrument;
  /** The frozen candidate whose round-1 results are carried. */
  candidate: string;
  /** The repair head the full run judged. */
  repairHead: string;
  atMs: number;
  status: 'planned' | 'skipped' | 'error';
  reason?: string;
  mode?: ComposedProofPlan['mode'];
  round1Failing?: number;
  rerunCount?: number;
  rerunSample?: string[];
  carriedFailing?: string[];
  rerunLegs?: string[];
  typeOnlyFileCount?: number;
  typeOnlySample?: string[];
  runtimeFileCount?: number;
  /** How many round-1 verdicts the composed plan carried without re-running them. */
  carriedCount?: number;
  /** Fingerprints of the measured, complete proof context on both sides; absent when either is unmeasured or incomplete. */
  proofContext?: { before: string; after: string };
  uncomputableRadius?: string[];
  comparison?: ComposedProofComparison;
  /** Why no comparison was recorded after the full run, when none was. */
  comparisonSkipped?: string;
}

export interface ComposedProofShadow {
  record: ComposedProofShadowRecord;
  /** The in-memory plan the comparison composes from; null when nothing was planned. */
  plan: ComposedProofPlan | null;
  round1Tests: Readonly<Record<string, TestVerdict>>;
}

export interface ComposedProofShadowInput {
  instrument?: RatchetInstrument;
  proofContext?: ProofContextComparison | null;
  candidate: string;
  repairHead: string;
  /** The frozen candidate's round-1 failing set; null when no round was recorded at it. */
  round1: { failingTests: readonly string[]; failingCount: number } | null;
  /** Every file the lineage changed between the candidate and the repair head; null = unreadable. */
  changedFiles: readonly ChangedFile[] | null;
  radius: RadiusQuery;
  emitOf?: (file: ChangedFile) => EmitIdentity;
  nowMs: number;
}

/** Plan the composed proof beside a green selective verification. Never throws. */
export async function planComposedProofShadow(input: ComposedProofShadowInput): Promise<ComposedProofShadow> {
  const base: ComposedProofShadowRecord = {
    schemaVersion: 1,
    ...(input.instrument ? { instrument: parseRatchetInstrument(input.instrument) ?? {
      schemaVersion: 'instrument-v1' as const, status: 'unknown' as const, fingerprint: null,
      missing: ['executing-artifact-unmeasured'] } } : {}),
    candidate: input.candidate,
    repairHead: input.repairHead,
    atMs: input.nowMs,
    status: 'skipped',
  };
  const skipped = (reason: string): ComposedProofShadow => ({ record: { ...base, reason }, plan: null, round1Tests: {} });
  try {
    if (!input.round1) return skipped('no round-1 failing set is recorded at the frozen candidate');
    if (input.round1.failingTests.length < input.round1.failingCount) {
      // A capped round-1 set cannot be carried: the uncarried failures would read as passing.
      return skipped(
        `round-1 failing set is capped (${input.round1.failingTests.length} of ${input.round1.failingCount} recorded)`,
      );
    }
    if (!input.changedFiles) return skipped('the lineage changes between candidate and repair head are unreadable');

    const emitOf = input.emitOf ?? ((f: ChangedFile) => emitIdentity(f.path, f.before, f.after));
    const identity = new Map<string, EmitIdentity>();
    for (const f of input.changedFiles) identity.set(f.path, emitOf(f));
    const runtimePaths = input.changedFiles.filter((f) => identity.get(f.path) !== 'identical').map((f) => f.path);

    const round1Tests: Record<string, TestVerdict> = {};
    const lintLegs: ProofLintLeg[] = [];
    for (const raw of input.round1.failingTests) {
      const id = raw.trim();
      if (!id) continue;
      if (isTestFileId(id)) round1Tests[id] = 'fail';
      // Which inputs a leg covers is not known here, so every red leg is re-run.
      else lintLegs.push({ id, passed: false, covers: () => true });
    }

    const radius = runtimePaths.length > 0 ? await input.radius(runtimePaths) : new Set<string>();
    // Round-1 ids are matched to the radius under either spelling, so a carried test is one the
    // radius truly misses, never a spelling difference.
    const rerunList =
      radius === null
        ? null
        : [...new Set([...radius, ...Object.keys(round1Tests).filter((t) => radiusHasTest(radius, t))])];
    const runtime = new Set(runtimePaths);
    const proofContext = bindProofContext(input.proofContext);
    const plan = planComposedProof({
      proofContext: input.proofContext,
      round1Tests,
      lintLegs,
      admissions: [{ id: 'lineage', changedFiles: input.changedFiles }],
      dependentTestsOf: (p) => (runtime.has(p) ? rerunList : []),
      emitOf: (f) => identity.get(f.path) ?? 'uncomputable',
    });
    const round1Failing = Object.keys(round1Tests).length + lintLegs.length;
    if (plan.mode === 'full-gate') {
      return {
        record: {
          ...base,
          status: 'planned',
          mode: 'full-gate',
          reason: plan.reason,
          round1Failing,
          uncomputableRadius: sample(plan.uncomputableRadius),
          runtimeFileCount: runtimePaths.length,
        },
        plan,
        round1Tests,
      };
    }
    return {
      record: {
        ...base,
        status: 'planned',
        mode: 'composed',
        carriedCount: plan.carriedTests.length,
        ...(proofContext ? { proofContext } : {}),
        round1Failing,
        rerunCount: plan.rerunTests.length,
        rerunSample: sample(plan.rerunTests),
        carriedFailing: sample(plan.carriedTests.filter((t) => round1Tests[t] === 'fail')),
        rerunLegs: sample(plan.rerunLegs),
        typeOnlyFileCount: plan.typeOnlyFiles.length,
        typeOnlySample: sample(plan.typeOnlyFiles),
        runtimeFileCount: plan.runtimeFiles.length,
      },
      plan,
      round1Tests,
    };
  } catch (e) {
    return { record: { ...base, status: 'error', reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, plan: null, round1Tests: {} };
  }
}

/**
 * After the full canonical run at the repair head: compose the verdict the proof would have
 * reached and compare it with the full verdict. A full-gate plan would have run this same full
 * run, so it agrees by construction. A selective/full comparison may qualify
 * only with complete bound identities and the current instrument (D-065/R15).
 * This diagnostic form carries neither, so agreement alone cannot qualify it.
 */
export function compareComposedProofShadow(
  shadow: ComposedProofShadow,
  full: { green: boolean; failingTests: readonly string[] },
): ComposedProofShadowRecord {
  const { plan, record } = shadow;
  if (!plan) return { ...record, comparisonSkipped: 'nothing was planned' };
  const fullFailing = full.green ? [] : full.failingTests.map((t) => t.trim()).filter(Boolean);
  if (plan.mode === 'full-gate') {
    return {
      ...record,
      comparison: {
        fullGreen: full.green,
        composedGreen: full.green,
        agree: true,
        missedByComposed: [],
        extraInComposed: [],
        rerunReadFrom: 'full-run-failing-set',
        qualification: comparisonQualification({ ...record, mode: plan.mode }, null),
      },
    };
  }
  const failsInFull = (id: string) => fullFailing.some((f) => f === id || sameTest(f, id));
  const rerunResults: Record<string, TestVerdict> = {};
  for (const id of [...plan.rerunTests, ...plan.rerunLegs]) rerunResults[id] = failsInFull(id) ? 'fail' : 'pass';
  const composed = composeVerdict(plan, shadow.round1Tests, rerunResults);
  const inComposed = (id: string) => composed.failing.some((c) => c === id || sameTest(c, id));
  const missedByComposed = fullFailing.filter((f) => !inComposed(f));
  const extraInComposed = composed.failing.filter((c) => !failsInFull(c));
  const composedGreen = composed.failing.length === 0;
  return {
    ...record,
    comparison: {
      fullGreen: full.green,
      composedGreen,
      agree: composedGreen === full.green && missedByComposed.length === 0,
      missedByComposed: sample(missedByComposed),
      extraInComposed: sample(extraInComposed),
      rerunReadFrom: 'full-run-failing-set',
      qualification: comparisonQualification({ ...record, mode: plan.mode }, { rerunReadFrom: 'full-run-failing-set' }),
    },
  };
}

/**
 * R15-INSTRUMENT-ROTATION. Qualified shadow runs counted under ONE instrument fingerprint.
 * Credit never survives an instrument change: a different or unmeasured fingerprint starts from zero.
 * This only counts. The switch that acts on the count belongs to the acting change (P-005).
 */
export interface ComposedProofShadowCohort {
  schemaVersion: 'shadow-cohort-v1';
  /** null while the executing instrument is unmeasured; such a cohort holds no credit. */
  instrumentFingerprint: string | null;
  qualifiedRuns: number;
  /** `candidate:repairHead` keys already counted (newest last), so one lineage is credited once. */
  countedRuns: string[];
}

/** Bound on remembered lineage keys. A lineage older than this many credited runs could be credited again. */
export const COMPOSED_PROOF_COHORT_KEY_CAP = 16;

/** Strict read of a stored cohort. Anything malformed or internally inconsistent is no cohort, so no credit. */
export function parseComposedProofCohort(value: unknown): ComposedProofShadowCohort | undefined {
  if (!isRecord(value) || value.schemaVersion !== 'shadow-cohort-v1') return undefined;
  const raw = value.instrumentFingerprint;
  const fingerprint = raw === null ? null : instrumentHash(raw) ? raw : undefined;
  const runs = value.qualifiedRuns;
  const keys = value.countedRuns;
  if (fingerprint === undefined || typeof runs !== 'number' || !Number.isInteger(runs) || runs < 0) return undefined;
  if (!Array.isArray(keys) || keys.length > COMPOSED_PROOF_COHORT_KEY_CAP
    || keys.some((key) => typeof key !== 'string' || key.length < 3 || key.length > 25)
    || new Set(keys).size !== keys.length) return undefined;
  if (runs < keys.length || (runs > keys.length && keys.length < COMPOSED_PROOF_COHORT_KEY_CAP)) return undefined;
  if (fingerprint === null && runs !== 0) return undefined;
  return { schemaVersion: 'shadow-cohort-v1', instrumentFingerprint: fingerprint, qualifiedRuns: runs,
    countedRuns: [...keys] as string[] };
}

/**
 * One cohort step: the stored cohort plus one shadow record gives the next cohort.
 *  - unmeasured instrument: no credit is held at all;
 *  - a fingerprint different from the stored one: prior credit is dropped before this record is considered;
 *  - a composed comparison that disagrees with the full run: credit under this fingerprint returns to zero;
 *  - an eligible agreeing comparison: one credit per `candidate:repairHead` lineage;
 *  - anything else (skipped, full-gate fallback, nothing carried): no evidence either way, the cohort is unchanged.
 */
export function advanceComposedProofCohort(previous: unknown, record: ComposedProofShadowRecord): ComposedProofShadowCohort {
  const instrument = parseRatchetInstrument(record.instrument);
  const fingerprint = instrument?.status === 'measured' ? instrument.fingerprint : null;
  const reset: ComposedProofShadowCohort = {
    schemaVersion: 'shadow-cohort-v1', instrumentFingerprint: fingerprint, qualifiedRuns: 0, countedRuns: [] };
  if (fingerprint === null) return reset;
  const prior = parseComposedProofCohort(previous);
  const cohort = prior && prior.instrumentFingerprint === fingerprint ? prior : reset;
  const comparison = record.comparison;
  if (!comparison) return cohort;
  if (record.mode === 'composed' && comparison.agree !== true) return reset;
  if (comparisonQualification(record, comparison).status !== 'eligible') return cohort;
  const key = record.candidate.slice(0, 12) + ':' + record.repairHead.slice(0, 12);
  if (cohort.countedRuns.includes(key)) return cohort;
  return { ...cohort, qualifiedRuns: cohort.qualifiedRuns + 1,
    countedRuns: [...cohort.countedRuns, key].slice(-COMPOSED_PROOF_COHORT_KEY_CAP) };
}

// ---------------------------------------------------------------------------------------------
// P-007: new-red ejection, in shadow
// ---------------------------------------------------------------------------------------------

export interface NewRedEjectionShadowRecord {
  schemaVersion: 1;
  candidate: string;
  /** The green pin the commit range starts from. */
  base: string | null;
  atMs: number;
  status: 'planned' | 'nothing-new' | 'skipped' | 'error';
  reason?: string;
  commitCount?: number;
  newFailureCount?: number;
  plan?: 'none' | 'freeze' | 'eject';
  ejected?: string[];
  attributions?: Array<{ test: string; kind: FailureAttribution['kind']; commit?: string; reason?: string; commits?: string[] }>;
  unattributableByReason?: Record<string, number>;
  radiusQueries?: number;
  budgetExhausted?: boolean;
  /** D-003's blame check needs a build without the commit; shadow mode never builds. */
  blameCheck: 'not-run';
}

export interface NewRedEjectionShadowInput {
  candidate: string;
  base: string | null;
  /** Repo-relative test files still blocking after quarantine and downgrades. */
  newFailures: readonly string[];
  /** Commits since the green pin, oldest first; null when the range is unreadable. */
  commits: readonly CandidateCommit[] | null;
  radius: RadiusQuery;
  /** Most selector runs this shadow may spend. */
  maxQueries: number;
  /** Wall-clock budget; past it, no further query starts. */
  budgetMs: number;
  /** Ranges larger than this are skipped outright (an over-long --changed-paths list). */
  maxCommits?: number;
  now?: () => number;
}

/**
 * For each test, the commits whose radius selects it (by bisection) and the commits whose
 * radius could not be computed. Exported for tests.
 */
export async function bisectSelectingCommits(input: {
  tests: readonly string[];
  commits: readonly CandidateCommit[];
  radius: RadiusQuery;
  maxQueries: number;
  budgetMs: number;
  now?: () => number;
}): Promise<{
  selecting: Map<string, Set<string>>;
  unknown: Map<string, Set<string>>;
  leafRadius: Map<string, ReadonlySet<string> | null>;
  queries: number;
  exhausted: boolean;
}> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  const cache = new Map<string, ReadonlySet<string> | null>();
  const selecting = new Map<string, Set<string>>();
  const unknown = new Map<string, Set<string>>();
  const leafRadius = new Map<string, ReadonlySet<string> | null>();
  let queries = 0;
  let exhausted = false;
  const add = (m: Map<string, Set<string>>, t: string, sha: string) => {
    let s = m.get(t);
    if (!s) m.set(t, (s = new Set()));
    s.add(sha);
  };
  // A commit that changed the test file itself selects it without any query.
  const direct = (c: CandidateCommit, t: string) => c.paths.some((p) => sameTest(p, t));

  async function rangeRadius(lo: number, hi: number): Promise<ReadonlySet<string> | null | undefined> {
    const key = `${lo}:${hi}`;
    if (cache.has(key)) return cache.get(key);
    if (queries >= input.maxQueries || now() >= deadline) {
      exhausted = true;
      return undefined;
    }
    queries += 1;
    const paths = [...new Set(input.commits.slice(lo, hi).flatMap((c) => c.paths.map(norm)))].filter(Boolean);
    let r: ReadonlySet<string> | null;
    try {
      r = paths.length === 0 ? new Set() : await input.radius(paths);
    } catch {
      r = null;
    }
    cache.set(key, r);
    if (hi - lo === 1) leafRadius.set(input.commits[lo]!.sha, r);
    return r;
  }

  async function walk(lo: number, hi: number, tests: readonly string[]): Promise<void> {
    if (tests.length === 0 || lo >= hi) return;
    const r = await rangeRadius(lo, hi);
    if (r === undefined) {
      // Budget gone: direct hits still count, every other commit here is unknown for these tests.
      for (let i = lo; i < hi; i++) {
        const c = input.commits[i]!;
        for (const t of tests) add(direct(c, t) ? selecting : unknown, t, c.sha);
      }
      return;
    }
    if (hi - lo === 1) {
      const c = input.commits[lo]!;
      for (const t of tests) {
        if (direct(c, t) || (r !== null && radiusHasTest(r, t))) add(selecting, t, c.sha);
        else if (r === null) add(unknown, t, c.sha);
      }
      return;
    }
    // A computed range radius that misses a test clears every commit in the range for it.
    // A widened (null) range radius says nothing, so the range splits with every test.
    const next =
      r === null
        ? tests
        : tests.filter((t) => radiusHasTest(r, t) || input.commits.slice(lo, hi).some((c) => direct(c, t)));
    const mid = lo + Math.floor((hi - lo) / 2);
    await walk(lo, mid, next);
    await walk(mid, hi, next);
  }

  await walk(0, input.commits.length, input.tests);
  return { selecting, unknown, leafRadius, queries, exhausted };
}

/** Attribute and plan beside a red verdict. Never throws, never builds, never routes. */
export async function planNewRedEjectionShadow(input: NewRedEjectionShadowInput): Promise<NewRedEjectionShadowRecord> {
  const now = input.now ?? Date.now;
  const base: NewRedEjectionShadowRecord = {
    schemaVersion: 1,
    candidate: input.candidate,
    base: input.base,
    atMs: now(),
    status: 'skipped',
    blameCheck: 'not-run',
  };
  try {
    const tests = [...new Set(input.newFailures.map(norm).filter(Boolean))].sort();
    if (tests.length === 0) {
      return { ...base, status: 'nothing-new', reason: 'no file-level blocking failure (task or guard reds only, or none)' };
    }
    if (!input.commits) return { ...base, newFailureCount: tests.length, reason: 'the commit range since the green pin is unreadable' };
    const commits = input.commits.filter((c) => c.paths.length > 0);
    const maxCommits = input.maxCommits ?? 2_000;
    if (commits.length > maxCommits) {
      return { ...base, newFailureCount: tests.length, commitCount: commits.length, reason: `commit range too long (${commits.length} > ${maxCommits})` };
    }
    if (commits.length === 0) {
      return { ...base, newFailureCount: tests.length, commitCount: 0, reason: 'no commit with changed paths since the green pin' };
    }
    const walk = await bisectSelectingCommits({
      tests,
      commits,
      radius: input.radius,
      maxQueries: input.maxQueries,
      budgetMs: input.budgetMs,
      now,
    });
    const selectsTest = (c: CandidateCommit, t: string): boolean | null => {
      if (walk.selecting.get(t)?.has(c.sha)) return true;
      if (walk.unknown.get(t)?.has(c.sha)) return null;
      return false;
    };
    const attributions = attributeByRadius({ newFailures: tests, commits, selectsTest });
    const plan = planEjection({
      confirmed: attributions,
      commits,
      radiusOf: (c) => {
        const r = walk.leafRadius.get(c.sha);
        return r ? [...r] : null;
      },
    });
    const unattributableByReason: Record<string, number> = {};
    const unattr = plan.kind === 'none' ? [] : plan.unattributable;
    for (const a of unattr) unattributableByReason[a.reason] = (unattributableByReason[a.reason] ?? 0) + 1;
    return {
      ...base,
      status: 'planned',
      commitCount: commits.length,
      newFailureCount: tests.length,
      plan: plan.kind,
      ...(plan.kind === 'eject' ? { ejected: sample(plan.ejected) } : {}),
      attributions: sample(
        attributions.map((a) =>
          a.kind === 'attributed'
            ? { test: a.test, kind: a.kind, commit: a.commit }
            : { test: a.test, kind: a.kind, reason: a.reason, commits: sample(a.commits) },
        ),
      ),
      unattributableByReason,
      radiusQueries: walk.queries,
      budgetExhausted: walk.exhausted,
    };
  } catch (e) {
    return { ...base, status: 'error', reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/**
 * `git log --reverse --format=%x1e%H --name-only <base>..<candidate>` → commits, oldest first.
 * Authors are not read: git-sync commits the whole tree under one identity, so a git author
 * names nobody (shadow mode routes nothing anyway).
 */
export function parseCommitPathLog(stdout: string): CandidateCommit[] {
  const out: CandidateCommit[] = [];
  for (const block of stdout.split('\x1e')) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const sha = lines[0]!;
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    out.push({ sha, author: null, paths: lines.slice(1).map(norm) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// gate_health record
// ---------------------------------------------------------------------------------------------

export interface RatchetShadowHealth {
  composedProof?: ComposedProofShadowRecord;
  /** R15-INSTRUMENT-ROTATION: qualified shadow runs counted under one instrument fingerprint. */
  composedProofCohort?: ComposedProofShadowCohort;
  newRedEjection?: NewRedEjectionShadowRecord;
}

/**
 * The form carried in the one-line result marker, which must stay under PIPE_BUF (4096 bytes)
 * beside every other field: counts, the verdict comparison and at most 3 short samples. The full
 * record stays in the stderr result dump.
 */
export function compactRatchetShadow(h: RatchetShadowHealth): RatchetShadowHealth {
  const cap = (xs: readonly string[] | undefined) => (xs ?? []).slice(0, 3).map((s) => s.slice(0, 128));
  const out: RatchetShadowHealth = {};
  const cohort = parseComposedProofCohort(h.composedProofCohort);
  if (cohort) out.composedProofCohort = cohort;
  const cp = h.composedProof;
  if (cp) {
    out.composedProof = {
      schemaVersion: 1,
      ...(parseRatchetInstrument(cp.instrument) ? { instrument: parseRatchetInstrument(cp.instrument) } : {}),
      candidate: cp.candidate.slice(0, 12),
      repairHead: cp.repairHead.slice(0, 12),
      atMs: cp.atMs,
      status: cp.status,
      ...(cp.reason ? { reason: cp.reason.slice(0, 160) } : {}),
      ...(cp.mode ? { mode: cp.mode } : {}),
      ...(cp.round1Failing !== undefined ? { round1Failing: cp.round1Failing } : {}),
      ...(cp.rerunCount !== undefined ? { rerunCount: cp.rerunCount } : {}),
      ...(cp.typeOnlyFileCount !== undefined ? { typeOnlyFileCount: cp.typeOnlyFileCount } : {}),
      ...(cp.runtimeFileCount !== undefined ? { runtimeFileCount: cp.runtimeFileCount } : {}),
      ...(cp.carriedCount !== undefined ? { carriedCount: cp.carriedCount } : {}),
      ...(cp.proofContext ? { proofContext: { before: cp.proofContext.before, after: cp.proofContext.after } } : {}),
      ...(cp.comparison
        ? {
            comparison: {
              ...cp.comparison,
              missedByComposed: cap(cp.comparison.missedByComposed),
              extraInComposed: cap(cp.comparison.extraInComposed),
              qualification: comparisonQualification(cp, cp.comparison),
            },
          }
        : {}),
      ...(cp.comparisonSkipped ? { comparisonSkipped: cp.comparisonSkipped.slice(0, 160) } : {}),
    };
  }
  const nr = h.newRedEjection;
  if (nr) {
    out.newRedEjection = {
      schemaVersion: 1,
      candidate: nr.candidate.slice(0, 12),
      base: nr.base ? nr.base.slice(0, 12) : null,
      atMs: nr.atMs,
      status: nr.status,
      blameCheck: 'not-run',
      ...(nr.reason ? { reason: nr.reason.slice(0, 160) } : {}),
      ...(nr.commitCount !== undefined ? { commitCount: nr.commitCount } : {}),
      ...(nr.newFailureCount !== undefined ? { newFailureCount: nr.newFailureCount } : {}),
      ...(nr.plan ? { plan: nr.plan } : {}),
      ...(nr.ejected ? { ejected: cap(nr.ejected).map((s) => s.slice(0, 12)) } : {}),
      ...(nr.unattributableByReason ? { unattributableByReason: nr.unattributableByReason } : {}),
      ...(nr.radiusQueries !== undefined ? { radiusQueries: nr.radiusQueries } : {}),
      ...(nr.budgetExhausted !== undefined ? { budgetExhausted: nr.budgetExhausted } : {}),
    };
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Re-validate a `ratchetShadow` value read back out of JSON (the result marker) before it is
 * stored in gate_health. Keeps only the two known sub-records with schemaVersion 1 and a known
 * status; anything else is dropped rather than stored.
 */
export function parseRatchetShadowHealth(value: unknown): RatchetShadowHealth | undefined {
  if (!isRecord(value)) return undefined;
  const out: RatchetShadowHealth = {};
  const cohort = parseComposedProofCohort(value.composedProofCohort);
  if (cohort) out.composedProofCohort = cohort;
  const cp = value.composedProof;
  if (
    isRecord(cp) &&
    cp.schemaVersion === 1 &&
    typeof cp.candidate === 'string' &&
    typeof cp.repairHead === 'string' &&
    (cp.status === 'planned' || cp.status === 'skipped' || cp.status === 'error')
    && (cp.instrument === undefined || parseRatchetInstrument(cp.instrument) !== undefined)
  ) {
    out.composedProof = {
      ...cp,
      ...(cp.instrument === undefined ? {} : { instrument: parseRatchetInstrument(cp.instrument) }),
      // Never adopt a caller's eligibility flag, including one surviving an
      // older result marker. Missing provenance remains unqualified history.
      ...(isRecord(cp.comparison) ? { comparison: { ...cp.comparison,
        qualification: comparisonQualification(cp, cp.comparison) } } : {}),
    } as unknown as ComposedProofShadowRecord;
  }
  const nr = value.newRedEjection;
  if (
    isRecord(nr) &&
    nr.schemaVersion === 1 &&
    typeof nr.candidate === 'string' &&
    (nr.status === 'planned' || nr.status === 'nothing-new' || nr.status === 'skipped' || nr.status === 'error')
  ) {
    out.newRedEjection = nr as unknown as NewRedEjectionShadowRecord;
  }
  return out.composedProof || out.newRedEjection || out.composedProofCohort ? out : undefined;
}

/**
 * R15-INSTRUMENT-ROTATION: the stored-health value for one gate round. The round's own records
 * replace the stored ones, so an unreported round clears them. The cohort is carried instead: it
 * is advanced from the STORED cohort plus this round's composed-proof record, and a round without
 * one leaves it unchanged. A cohort inside `reported` is ignored, so a round cannot report its
 * own credit.
 */
export function nextStoredRatchetShadow(storedRatchetShadow: unknown, reported: unknown): RatchetShadowHealth | null {
  const round = parseRatchetShadowHealth(reported);
  const prior = isRecord(storedRatchetShadow)
    ? parseComposedProofCohort(storedRatchetShadow.composedProofCohort)
    : undefined;
  const cohort = round?.composedProof ? advanceComposedProofCohort(prior, round.composedProof) : prior;
  const out: RatchetShadowHealth = {};
  if (round?.composedProof) out.composedProof = round.composedProof;
  if (round?.newRedEjection) out.newRedEjection = round.newRedEjection;
  if (cohort) out.composedProofCohort = cohort;
  return out.composedProof || out.newRedEjection || out.composedProofCohort ? out : null;
}
