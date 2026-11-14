import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PROOF_CONTEXT_COMPONENTS, createProofContextIdentity, type ProofContextIdentity } from '@papercusp/test-config/configuration-snapshot';
import {
  bisectSelectingCommits,
  captureRatchetInstrument,
  parseRatchetInstrument,
  RATCHET_INSTRUMENT_DEFINITIONS,
  compareComposedProofShadow,
  compactRatchetShadow,
  isTestFileId,
  parseCommitPathLog,
  parseRatchetShadowHealth,
  planComposedProofShadow,
  planNewRedEjectionShadow,
  sameTest,
  type RadiusQuery,
  type ComposedProofShadowRecord,
  advanceComposedProofCohort,
  parseComposedProofCohort,
} from './ratchet-shadow';
import type { CandidateCommit } from './new-red-ejection';
import type { OperatorArtifactIdentity } from './operator-artifact';

describe('instrument-v1 binding', () => {
  const context = createProofContextIdentity(Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key =>
    [key, createHash('sha256').update(key).digest('hex')])) as ProofContextIdentity['components'])!;
  const artifact = (): Extract<OperatorArtifactIdentity, { status: 'measured' }> => ({ status: 'measured',
    sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
    sourceBlobs: Object.fromEntries(RATCHET_INSTRUMENT_DEFINITIONS.map(path => [path, 'd'.repeat(40)])), evidenceRef: '/boot/manifest' });

  it('keeps stable bytes stable across locator and input-map ordering, and rotates every bound input', () => {
    const original = artifact();
    const first = captureRatchetInstrument(original, context);
    expect(first.status).toBe('measured');
    expect(captureRatchetInstrument({ ...original, evidenceRef: '/different/manifest', sourceSha: 'e'.repeat(40),
      manifestSha256: 'f'.repeat(64), sourceBlobs: Object.fromEntries(Object.entries(original.sourceBlobs).reverse()) }, context)).toEqual(first);
    expect(parseRatchetInstrument(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(captureRatchetInstrument({ ...original, bundleSha256: 'f'.repeat(64) }, context)).not.toEqual(first);
    for (const path of RATCHET_INSTRUMENT_DEFINITIONS)
      expect(captureRatchetInstrument({ ...original, sourceBlobs: { ...original.sourceBlobs, [path]: 'e'.repeat(40) } }, context)).not.toEqual(first);
    for (const key of ['schema', 'selectionGraph'] as const) {
      const changed = createProofContextIdentity({ ...context.components, [key]: 'f'.repeat(64) })!;
      expect(captureRatchetInstrument(original, changed)).not.toEqual(first);
      const missing = createProofContextIdentity({ ...context.components, [key]: null })!;
      expect(captureRatchetInstrument(original, missing).status).toBe('unknown');
    }
  });

  it('refuses missing executing definitions, incomplete contexts and corrupted persisted identities', () => {
    const original = artifact();
    for (const path of RATCHET_INSTRUMENT_DEFINITIONS) {
      const sourceBlobs = { ...original.sourceBlobs }; delete sourceBlobs[path];
      expect(captureRatchetInstrument({ ...original, sourceBlobs }, context)).toMatchObject({ status: 'unknown',
        fingerprint: null, missing: ['executing-definition-closure-incomplete'] });
    }
    const unknown = captureRatchetInstrument(null, null);
    expect(unknown).toMatchObject({ status: 'unknown', fingerprint: null });
    expect(parseRatchetInstrument(unknown)).toEqual(unknown);
    const known = captureRatchetInstrument(original, context);
    expect(parseRatchetInstrument({ ...known, fingerprint: 'f'.repeat(64) })).toBeUndefined();
    expect(parseRatchetInstrument({ ...known, complete: true })).toBeUndefined();
    expect(parseRatchetInstrument({ ...unknown, fingerprint: 'f'.repeat(64) })).toBeUndefined();
    expect(parseRatchetInstrument({ ...unknown, missing: [] })).toBeUndefined();
  });

  it('preserves the instrument through original shadow, compact marker and persisted consumer, and grants eligibility only while it is measured', async () => {
    const instrument = captureRatchetInstrument(artifact(), context);
    const plan = (bound: typeof instrument) => planComposedProofShadow({ instrument: bound, proofContext: { before: context, after: context },
      candidate: 'candidate', repairHead: 'head', round1: { failingTests: ['a.test.ts'], failingCount: 1 },
      changedFiles: [], radius: async () => new Set(), nowMs: 1 });
    const shadow = await plan(instrument);
    const record = compareComposedProofShadow(shadow, { green: false, failingTests: ['a.test.ts'] });
    const compact = compactRatchetShadow({ composedProof: record });
    const reread = parseRatchetShadowHealth(JSON.parse(JSON.stringify(compact)));
    expect(reread?.composedProof?.instrument).toEqual(instrument);
    // R15-INSTRUMENT-ROTATION: the real planner output qualifies, and the persisted consumer re-derives the same answer.
    const eligible = { status: 'eligible', instrumentFingerprint: instrument.fingerprint,
      proofContext: { before: context.fingerprint, after: context.fingerprint }, carriedCount: 1 };
    expect(compact.composedProof?.comparison?.qualification).toEqual(eligible);
    expect(reread?.composedProof?.comparison?.qualification).toEqual(eligible);
    // The same planner with an unmeasured instrument still composes and compares, and earns nothing.
    const unmeasured = compareComposedProofShadow(await plan(captureRatchetInstrument(null, context)),
      { green: false, failingTests: ['a.test.ts'] });
    expect(unmeasured.mode).toBe('composed');
    expect(compactRatchetShadow({ composedProof: unmeasured }).composedProof?.comparison?.qualification)
      .toEqual({ status: 'ineligible', reason: 'qualification-context-unmeasured' });
    expect(parseRatchetShadowHealth({ composedProof: { ...record, instrument: { ...instrument, fingerprint: 'f'.repeat(64) } } }))
      .toBeUndefined();
  });
});

/** A radius seam over a static path → tests map; counts calls. */
function radiusFrom(map: Record<string, string[]>, opts: { widenOver?: number } = {}) {
  const calls: string[][] = [];
  const query: RadiusQuery = async (paths) => {
    calls.push([...paths]);
    if (opts.widenOver !== undefined && paths.length > opts.widenOver) return null;
    return new Set(paths.flatMap((p) => map[p] ?? []));
  };
  return { query, calls };
}

describe('test identity', () => {
  it('matches repo-relative and workspace-relative spellings, not unrelated suffixes', () => {
    expect(sameTest('packages/x/lib/a.test.ts', 'lib/a.test.ts')).toBe(true);
    expect(sameTest('lib/a.test.ts', 'lib/a.test.ts')).toBe(true);
    expect(sameTest('lib/ba.test.ts', 'a.test.ts')).toBe(false);
  });
  it('treats task ids, lint legs and generator checks as legs', () => {
    expect(isTestFileId('lib/release/a.test.ts')).toBe(true);
    expect(isTestFileId('@papercusp/operator-core :: test')).toBe(false);
    expect(isTestFileId('lint:tsc')).toBe(false);
    expect(isTestFileId('gen:contract:check')).toBe(false);
  });
});

describe('composed proof shadow (P-018, D-025)', () => {
  const context = createProofContextIdentity(Object.fromEntries(PROOF_CONTEXT_COMPONENTS
    .map(key => [key, createHash('sha256').update(key).digest('hex')])) as ProofContextIdentity['components'])!;
  const proofContext = { before: context, after: context };
  const changed = [
    { path: 'pkg/src/a.ts', before: 'export const a = 1;', after: 'export const a = 2;' },
    { path: 'pkg/src/types.ts', before: 'export interface T { a: number }', after: 'export interface T { a: string }' },
  ];

  it('skips when the round-1 failing set is capped, because uncarried failures would read as passing', async () => {
    const { query } = radiusFrom({});
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts'], failingCount: 50 },
      changedFiles: changed,
      radius: query,
      nowMs: 1, proofContext,
    });
    expect(s.record.status).toBe('skipped');
    expect(s.record.reason).toMatch(/capped/);
    expect(s.plan).toBeNull();
  });

  it('re-runs only the radius of runtime-changing files; a type-only file costs no query and carried failures stay', async () => {
    const { query, calls } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['src/a.test.ts', 'pkg/src/other.test.ts', 'lint:tsc'], failingCount: 3 },
      changedFiles: changed,
      radius: query,
      nowMs: 1, proofContext,
    });
    expect(calls).toEqual([['pkg/src/a.ts']]);
    expect(s.record).toMatchObject({ status: 'planned', mode: 'composed', typeOnlyFileCount: 1, runtimeFileCount: 1 });
    // The workspace-relative round-1 id matches the repo-relative radius entry: re-run, not carried.
    expect(s.record.carriedFailing).toEqual(['pkg/src/other.test.ts']);
    expect(s.record.rerunLegs).toEqual(['lint:tsc']);
  });

  it('plans the full gate when the radius of a runtime change cannot be computed', async () => {
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: [], failingCount: 0 },
      changedFiles: changed,
      radius: async () => null,
      nowMs: 1, proofContext,
    });
    expect(s.record).toMatchObject({ status: 'planned', mode: 'full-gate' });
    const compared = compareComposedProofShadow(s, { green: false, failingTests: ['x.test.ts'] });
    expect(compared.comparison?.agree).toBe(true);
    expect(compared.comparison?.qualification).toEqual({ status: 'ineligible', reason: 'full-gate-fallback' });
  });

  it('agrees when the full run reports exactly the carried failure', async () => {
    const { query } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts', 'pkg/src/other.test.ts'], failingCount: 2 },
      changedFiles: changed,
      radius: query,
      nowMs: 1, proofContext,
    });
    const r = compareComposedProofShadow(s, { green: false, failingTests: ['pkg/src/other.test.ts'] });
    expect(r.comparison).toMatchObject({ agree: true, composedGreen: false, fullGreen: false, missedByComposed: [], extraInComposed: [] });
    expect(r.comparison?.qualification).toEqual({ status: 'ineligible', reason: 'qualification-context-unmeasured' });
  });

  it('records a disagreement when the full run fails a test outside the radius that was not red in round 1', async () => {
    const { query } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts'], failingCount: 1 },
      changedFiles: changed,
      radius: query,
      nowMs: 1, proofContext,
    });
    const r = compareComposedProofShadow(s, { green: false, failingTests: ['pkg/src/elsewhere.test.ts'] });
    expect(r.comparison).toMatchObject({ agree: false, composedGreen: true, missedByComposed: ['pkg/src/elsewhere.test.ts'] });
    expect(r.comparison?.qualification).toEqual({ status: 'ineligible', reason: 'qualification-context-unmeasured' });
  });

  it('keeps nonempty selective diagnostics unqualified through the actual compact-marker reader', async () => {
    const s = await planComposedProofShadow({ candidate: 'c1', repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts', 'pkg/src/carried.test.ts'], failingCount: 2 },
      changedFiles: changed, radius: radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] }).query,
      nowMs: 1, proofContext });
    expect(s.plan).toMatchObject({ mode: 'composed', rerunTests: ['pkg/src/a.test.ts'],
      carriedTests: ['pkg/src/carried.test.ts'] });
    const record = compareComposedProofShadow(s, { green: false, failingTests: ['pkg/src/carried.test.ts'] });
    const read = parseRatchetShadowHealth(JSON.parse(JSON.stringify(compactRatchetShadow({ composedProof: record }))));
    expect(read?.composedProof?.comparison).toMatchObject({ agree: true,
      qualification: { status: 'ineligible', reason: 'qualification-context-unmeasured' } });
    // Nonempty carried/rerun sets cannot supply missing qualification context.
    // A persisted eligibility claim cannot supply it at either boundary.
    const forged = JSON.parse(JSON.stringify({ composedProof: record }));
    forged.composedProof.comparison.qualification = { status: 'eligible', instrumentHash: 'f'.repeat(64) };
    expect(compactRatchetShadow(forged).composedProof?.comparison?.qualification)
      .toEqual(record.comparison?.qualification);
    expect(parseRatchetShadowHealth(forged)?.composedProof?.comparison?.qualification)
      .toEqual(record.comparison?.qualification);
    delete forged.composedProof.mode;
    delete forged.composedProof.comparison.qualification;
    expect(parseRatchetShadowHealth(forged)?.composedProof?.comparison?.qualification)
      .toEqual({ status: 'ineligible', reason: 'unverified-legacy-comparison' });
  });
});

describe('selecting-commit bisection', () => {
  const commits: CandidateCommit[] = Array.from({ length: 8 }, (_, i) => ({ sha: `s${i}`, author: null, paths: [`src/f${i}.ts`] }));

  it('finds the one selecting commit among eight with fewer queries than one per commit', async () => {
    const { query, calls } = radiusFrom({ 'src/f5.ts': ['src/t.test.ts'] });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits, radius: query, maxQueries: 50, budgetMs: 60_000 });
    expect([...(r.selecting.get('src/t.test.ts') ?? [])]).toEqual(['s5']);
    expect(r.unknown.size).toBe(0);
    expect(calls.length).toBeLessThan(8);
  });

  it('splits a widened range instead of giving up, and a widened leaf reads as unknown', async () => {
    const { query } = radiusFrom({ 'src/f2.ts': ['src/t.test.ts'] }, { widenOver: 2 });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits, radius: query, maxQueries: 50, budgetMs: 60_000 });
    expect([...(r.selecting.get('src/t.test.ts') ?? [])]).toEqual(['s2']);
    const leafWidened = await bisectSelectingCommits({
      tests: ['src/t.test.ts'],
      commits: commits.slice(0, 1),
      radius: async () => null,
      maxQueries: 5,
      budgetMs: 60_000,
    });
    expect([...(leafWidened.unknown.get('src/t.test.ts') ?? [])]).toEqual(['s0']);
  });

  it('marks unresolved commits unknown when the query budget runs out, but still counts a direct hit', async () => {
    const withTestEdit = [...commits, { sha: 's8', author: null, paths: ['src/t.test.ts'] }];
    const { query } = radiusFrom({}, { widenOver: 0 });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits: withTestEdit, radius: query, maxQueries: 1, budgetMs: 60_000 });
    expect(r.exhausted).toBe(true);
    expect(r.selecting.get('src/t.test.ts')?.has('s8')).toBe(true);
    expect(r.unknown.get('src/t.test.ts')?.size).toBe(8);
  });
});

describe('new-red ejection shadow (P-007, D-025)', () => {
  const commits: CandidateCommit[] = [
    { sha: 'a', author: null, paths: ['src/a.ts'] },
    { sha: 'b', author: null, paths: ['src/b.ts'] },
    { sha: 'c', author: null, paths: ['src/c.ts'] },
  ];

  it('plans an ejection of the single selecting commit, radius-only (no blame check in shadow)', async () => {
    const { query } = radiusFrom({ 'src/b.ts': ['src/b.test.ts'] });
    const r = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/b.test.ts'], commits, radius: query, maxQueries: 20, budgetMs: 60_000 });
    expect(r).toMatchObject({ status: 'planned', plan: 'eject', ejected: ['b'], blameCheck: 'not-run', budgetExhausted: false });
    expect(r.attributions).toEqual([{ test: 'src/b.test.ts', kind: 'attributed', commit: 'b' }]);
  });

  it('freezes when two commits select the failing test', async () => {
    const { query } = radiusFrom({ 'src/a.ts': ['src/x.test.ts'], 'src/c.ts': ['src/x.test.ts'] });
    const r = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/x.test.ts'], commits, radius: query, maxQueries: 20, budgetMs: 60_000 });
    expect(r).toMatchObject({ status: 'planned', plan: 'freeze', unattributableByReason: { 'several-commits-select-test': 1 } });
  });

  it('reports nothing-new without file-level failures, and skips an unreadable range', async () => {
    const { query } = radiusFrom({});
    expect((await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: [], commits, radius: query, maxQueries: 5, budgetMs: 1 })).status).toBe('nothing-new');
    const skipped = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/b.test.ts'], commits: null, radius: query, maxQueries: 5, budgetMs: 1 });
    expect(skipped).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/unreadable/) });
  });
});

describe('records', () => {
  it('parses a git log with record separators, oldest first, without authors', () => {
    const log = '\x1eaaaaaaa\n\nsrc/a.ts\nsrc/b.ts\n\x1ebbbbbbb\n\nsrc/c.ts\n';
    expect(parseCommitPathLog(log)).toEqual([
      { sha: 'aaaaaaa', author: null, paths: ['src/a.ts', 'src/b.ts'] },
      { sha: 'bbbbbbb', author: null, paths: ['src/c.ts'] },
    ]);
  });

  it('keeps only well-formed sub-records when re-validating gate_health input', () => {
    expect(parseRatchetShadowHealth(null)).toBeUndefined();
    expect(parseRatchetShadowHealth({ composedProof: { schemaVersion: 2 } })).toBeUndefined();
    const ok = parseRatchetShadowHealth({
      newRedEjection: { schemaVersion: 1, candidate: 'C', status: 'planned', blameCheck: 'not-run' },
      composedProof: { schemaVersion: 1, candidate: 'C', repairHead: 'H', status: 'bogus' },
    });
    expect(ok?.newRedEjection?.candidate).toBe('C');
    expect(ok?.composedProof).toBeUndefined();
  });
});

describe('composed-proof cohort (R15-INSTRUMENT-ROTATION)', () => {
  const hash = (seed: string) => createHash('sha256').update(seed).digest('hex');
  // identity('base') is the baseline; identity(salt) changes every component; identity(salt, key) changes only `key`.
  const identity = (salt: string, only?: string) => createProofContextIdentity(Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key =>
    [key, hash((only === undefined || only === key ? salt : 'base') + key)])) as ProofContextIdentity['components'])!;
  const artifact = (): Extract<OperatorArtifactIdentity, { status: 'measured' }> => ({ status: 'measured',
    sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
    sourceBlobs: Object.fromEntries(RATCHET_INSTRUMENT_DEFINITIONS.map(path => [path, 'd'.repeat(40)])), evidenceRef: '/boot/manifest' });
  const instrument = captureRatchetInstrument(artifact(), identity('base'));
  const bound = { before: identity('base').fingerprint, after: identity('after').fingerprint };
  const run = (n: number, over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, instrument, candidate: hash('cand' + n).slice(0, 40), repairHead: hash('head' + n).slice(0, 40),
    atMs: n, status: 'planned', mode: 'composed', carriedCount: 2, proofContext: bound,
    comparison: { fullGreen: true, composedGreen: true, agree: true, missedByComposed: [], extraInComposed: [],
      rerunReadFrom: 'full-run-failing-set' },
    ...over,
  }) as unknown as ComposedProofShadowRecord;
  const qualified = (record: ComposedProofShadowRecord) =>
    compactRatchetShadow({ composedProof: record }).composedProof?.comparison?.qualification;
  const unmeasured = captureRatchetInstrument(null, identity('base'));

  it('derives eligibility only from the measured instrument, the bound proof context and a carried verdict', () => {
    expect(instrument.status).toBe('measured');
    expect(unmeasured.status).toBe('unknown');
    expect(qualified(run(1))).toEqual({ status: 'eligible', instrumentFingerprint: instrument.fingerprint,
      proofContext: bound, carriedCount: 2 });
    const reread = parseRatchetShadowHealth(JSON.parse(JSON.stringify(compactRatchetShadow({ composedProof: run(1) }))));
    expect(reread?.composedProof?.comparison?.qualification).toEqual(qualified(run(1)));
    for (const over of [{ instrument: unmeasured }, { instrument: undefined }, { proofContext: undefined },
      { proofContext: { before: 'x', after: bound.after } }])
      expect(qualified(run(1, over))).toEqual({ status: 'ineligible', reason: 'qualification-context-unmeasured' });
    expect(qualified(run(1, { carriedCount: 0 }))).toEqual({ status: 'ineligible', reason: 'nothing-carried' });
    expect(qualified(run(1, { mode: 'full-gate' }))).toEqual({ status: 'ineligible', reason: 'full-gate-fallback' });
  });

  it('counts one credit per qualified lineage and carries it across the stored boundary', () => {
    let cohort = advanceComposedProofCohort(undefined, run(1));
    expect(cohort).toEqual({ schemaVersion: 'shadow-cohort-v1', instrumentFingerprint: instrument.fingerprint,
      qualifiedRuns: 1, countedRuns: [run(1).candidate.slice(0, 12) + ':' + run(1).repairHead.slice(0, 12)] });
    cohort = advanceComposedProofCohort(cohort, run(1, { atMs: 99 }));
    expect(cohort.qualifiedRuns).toBe(1);
    cohort = advanceComposedProofCohort(cohort, run(2));
    cohort = advanceComposedProofCohort(cohort, run(3, { carriedCount: 0 }));
    cohort = advanceComposedProofCohort(cohort, run(4, { mode: 'full-gate' }));
    cohort = advanceComposedProofCohort(cohort, run(5, { comparison: undefined, status: 'skipped' }));
    expect(cohort.qualifiedRuns).toBe(2);
    const stored = parseRatchetShadowHealth(JSON.parse(JSON.stringify(compactRatchetShadow({ composedProofCohort: cohort }))));
    expect(stored?.composedProofCohort).toEqual(cohort);
    expect(advanceComposedProofCohort(stored?.composedProofCohort, run(6)).qualifiedRuns).toBe(3);
  });

  it('drops prior credit when any bound instrument input changes, keeps it for unchanged bytes, and holds none while unmeasured', () => {
    const prior = advanceComposedProofCohort(advanceComposedProofCohort(undefined, run(1)), run(2));
    expect(prior.qualifiedRuns).toBe(2);
    const original = artifact();
    const rotations = {
      execution: captureRatchetInstrument({ ...original, bundleSha256: 'e'.repeat(64) }, identity('base')),
      definitions: captureRatchetInstrument({ ...original, sourceBlobs: { ...original.sourceBlobs,
        [RATCHET_INSTRUMENT_DEFINITIONS[0]]: 'f'.repeat(40) } }, identity('base')),
      schema: captureRatchetInstrument(original, identity('changed', 'schema')),
      selection: captureRatchetInstrument(original, identity('changed', 'selectionGraph')),
    };
    for (const [input, rotated] of Object.entries(rotations)) {
      expect(rotated.status, input).toBe('measured');
      expect(rotated.fingerprint, input).not.toBe(instrument.fingerprint);
      expect(advanceComposedProofCohort(prior, run(3, { instrument: rotated })), input).toMatchObject({
        instrumentFingerprint: rotated.fingerprint, qualifiedRuns: 1 });
      // The rotation alone drops prior credit, even when the rotated run earns nothing itself.
      expect(advanceComposedProofCohort(prior, run(3, { instrument: rotated, carriedCount: 0 })).qualifiedRuns, input).toBe(0);
    }
    const same = captureRatchetInstrument({ ...original, evidenceRef: '/elsewhere', sourceSha: 'e'.repeat(40) }, identity('base'));
    expect(advanceComposedProofCohort(prior, run(3, { instrument: same })).qualifiedRuns).toBe(3);
    expect(advanceComposedProofCohort(prior, run(3, { instrument: unmeasured }))).toEqual({
      schemaVersion: 'shadow-cohort-v1', instrumentFingerprint: null, qualifiedRuns: 0, countedRuns: [] });
    expect(advanceComposedProofCohort(prior, run(3, { instrument: undefined })).qualifiedRuns).toBe(0);
  });

  it('returns to zero on a composed disagreement and refuses a forged or malformed stored cohort', () => {
    const prior = advanceComposedProofCohort(advanceComposedProofCohort(undefined, run(1)), run(2));
    expect(advanceComposedProofCohort(prior, run(3, { comparison: { ...run(3).comparison, agree: false, fullGreen: false,
      missedByComposed: ['pkg/src/a.test.ts'] } }))).toMatchObject({ instrumentFingerprint: instrument.fingerprint, qualifiedRuns: 0 });
    for (const forged of [{ ...prior, qualifiedRuns: 9 }, { ...prior, instrumentFingerprint: null }, { ...prior, countedRuns: 'x' },
      { ...prior, schemaVersion: 'shadow-cohort-v0' }, { ...prior, countedRuns: [prior.countedRuns[0], prior.countedRuns[0]] }]) {
      expect(parseComposedProofCohort(forged)).toBeUndefined();
      expect(advanceComposedProofCohort(forged, run(3)).qualifiedRuns).toBe(1);
      expect(parseRatchetShadowHealth({ composedProofCohort: forged })).toBeUndefined();
    }
  });
});
