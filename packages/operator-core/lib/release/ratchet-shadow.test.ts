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

  it('preserves the instrument through original shadow, compact marker and persisted consumer without granting eligibility', async () => {
    const instrument = captureRatchetInstrument(artifact(), context);
    const shadow = await planComposedProofShadow({ instrument, proofContext: { before: context, after: context },
      candidate: 'candidate', repairHead: 'head', round1: { failingTests: ['a.test.ts'], failingCount: 1 },
      changedFiles: [], radius: async () => new Set(), nowMs: 1 });
    const record = compareComposedProofShadow(shadow, { green: false, failingTests: ['a.test.ts'] });
    const compact = compactRatchetShadow({ composedProof: record });
    expect(parseRatchetShadowHealth(JSON.parse(JSON.stringify(compact)))?.composedProof?.instrument).toEqual(instrument);
    expect(compact.composedProof?.comparison?.qualification?.status).toBe('ineligible');
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
