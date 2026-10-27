/**
 * R-5 (plan code-cleanup-campaigns-2026-10-26, P-005): triage merges real
 * duplicates only. Over a fixture history with three families — one whose member
 * files co-change, one whose copies evolve independently, and one whose copies
 * differ by a guard one copy lacks — triage batches the first, excludes the
 * second, and creates no merge batch for the third until a bug naming both
 * locations is terminal.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryCommit } from '../code-intelligence/change-history';
import {
  TRIAGE_BATCH_FAMILY_CAP, boundCoveragePaths, compareCopies, divergedCopyConditionKey, familyChurn, selectRoundFamilies, triageCloneFamilies,
  triageFamilyFromRanked, triageScore,
  type DivergenceBug, type TriageFamily, type TriageHistory,
} from './triage';

const END = '2026-10-01T00:00:00.000Z';
let seq = 0;
const commit = (day: number, ...paths: string[]): HistoryCommit => ({
  sha: (++seq).toString(16).padStart(40, '0'), parents: ['f'.repeat(40)],
  at: new Date(Date.parse(END) - day * 86_400_000).toISOString(),
  files: paths.map(path => ({ status: 'M', path })),
});

// Co-changing pair: every commit that touches one file touches the other.
const A1 = 'packages/alpha/src/orders/totals.ts', A2 = 'packages/alpha/src/orders/invoices.ts';
// Independently evolving look-alikes: never in the same commit.
const B1 = 'packages/beta/src/geometry.ts', B2 = 'packages/gamma/src/layout.ts';
// Diverged copies that also co-change (so divergence alone decides).
const C1 = 'packages/delta/src/auth/session.ts', C2 = 'packages/delta/src/auth/token.ts';

const history = (): TriageHistory => ({
  end: END, commit: 'e'.repeat(40), complete: true,
  commits: [
    ...[3, 9, 15, 21, 30].map(day => commit(day, A1, A2)),
    ...[2, 8, 14, 20, 26].map(day => commit(day, B1)),
    ...[5, 11, 17, 23, 29].map(day => commit(day, B2)),
    ...[4, 10, 16, 22].map(day => commit(day, C1, C2)),
    // Outside the 90-day window: must not count for co-change or churn.
    commit(120, B1, B2), commit(130, B1, B2), commit(140, B1, B2),
  ],
});

const member = (path: string, symbol: string, line = 10, source?: string) =>
  ({ id: `${path}:${line}`, path, line, symbol, ...(source ? { source } : {}) });

const coChanging: TriageFamily = {
  id: 'family-co-changing', kind: 'renamed', redundantMass: 120, packageDistance: 0,
  members: [member(A1, 'sumLineItems'), member(A2, 'sumInvoiceLines')],
};
const independent: TriageFamily = {
  id: 'family-independent', kind: 'renamed', redundantMass: 400, packageDistance: 4,
  members: [member(B1, 'clampPoint'), member(B2, 'clampBox')],
};
const guarded = `function readSession(store, id) {
  if (!id) throw new Error('session id required');
  const row = store.get(id);
  return row ? row.value : null;
}`;
const unguarded = `function readToken(cache, key) {
  const entry = cache.get(key);
  return entry ? entry.value : null;
}`;
const divergedFamily: TriageFamily = {
  id: 'family-diverged', kind: 'near', redundantMass: 90, packageDistance: 0,
  members: [member(C1, 'readSession', 10, guarded), member(C2, 'readToken', 40, unguarded)],
};

const bugs = (status: DivergenceBug['status']) => {
  const asked: string[] = [];
  const lookup = async (key: string): Promise<DivergenceBug> => {
    asked.push(key);
    return status === 'missing' ? { status } : { status, id: 'WI-diverged-bug' };
  };
  return { asked, lookup };
};

describe('triageCloneFamilies (P-005, R-5)', () => {
  it('batches the co-changing family, excludes the independent one, and holds the diverged one while its bug is missing', async () => {
    const { asked, lookup } = bugs('missing');
    const result = await triageCloneFamilies({ families: [coChanging, independent, divergedFamily], history: history(),
      divergenceBug: lookup });

    const batched = result.batches.flatMap(b => b.families.map(f => f.id));
    expect(batched).toEqual(['family-co-changing']);
    expect(result.excluded).toEqual([expect.objectContaining({ familyId: 'family-independent', reason: 'independent' })]);
    expect(result.diverged).toHaveLength(1);
    const hold = result.diverged[0]!;
    expect(hold).toMatchObject({ familyId: 'family-diverged', bug: 'missing', bugId: null, guard: true });
    // The bug must name BOTH locations: the copy with the guard and the copy without.
    expect(hold.locations).toEqual([
      { path: C1, line: 10, symbol: 'readSession' }, { path: C2, line: 40, symbol: 'readToken' }]);
    expect(hold.extra).toEqual(["if (!id) throw new Error('session id required');"]);
    expect(hold.conditionKey).toBe(divergedCopyConditionKey(hold.locations[0], hold.locations[1]));
    expect(asked).toEqual([hold.conditionKey]);
  });

  it('still creates no merge batch for the diverged family while its bug is open', async () => {
    const result = await triageCloneFamilies({ families: [divergedFamily], history: history(),
      divergenceBug: bugs('open').lookup });
    expect(result.batches).toEqual([]);
    expect(result.diverged).toEqual([expect.objectContaining({ familyId: 'family-diverged', bug: 'open', bugId: 'WI-diverged-bug' })]);
  });

  it('batches the diverged family once the bug naming both locations is terminal', async () => {
    const result = await triageCloneFamilies({ families: [divergedFamily], history: history(),
      divergenceBug: bugs('terminal').lookup });
    expect(result.diverged).toEqual([]);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.families).toEqual([expect.objectContaining({ id: 'family-diverged',
      divergenceResolvedBy: 'WI-diverged-bug' })]);
  });

  it('records the co-change evidence and the rank inputs on a batched family', async () => {
    const result = await triageCloneFamilies({ families: [coChanging], history: history(), divergenceBug: bugs('missing').lookup });
    const family = result.batches[0]!.families[0]!;
    expect(family.coChange).toEqual({ minLinkScore: 1, files: 2 });
    expect(family.churn).toBe(5);
    expect(family.score).toBe(triageScore({ redundantMass: 120, churn: 5, packageDistance: 0 }));
    expect(result.batches[0]!.area).toBe('packages/alpha/src/orders');
  });

  it('ignores commits outside the 90-day window', () => {
    expect(familyChurn([B1, B2], history())).toBe(10);
  });

  it('fails closed: incomplete history excludes every family rather than batching it', async () => {
    const result = await triageCloneFamilies({ families: [coChanging], history: { ...history(), complete: false },
      divergenceBug: bugs('missing').lookup });
    expect(result.batches).toEqual([]);
    expect(result.excluded).toEqual([expect.objectContaining({ familyId: 'family-co-changing', reason: 'history-incomplete' })]);
  });

  it('excludes single-file families and accepted copies with a reason', async () => {
    const single: TriageFamily = { id: 'family-single', kind: 'exact', redundantMass: 50, packageDistance: 0,
      members: [member(A1, 'a', 1), member(A1, 'b', 90)] };
    const accepted: TriageFamily = { ...coChanging, id: 'family-accepted', accepted: true };
    const result = await triageCloneFamilies({ families: [single, accepted], history: history(),
      divergenceBug: bugs('missing').lookup });
    expect(result.excluded.map(e => [e.familyId, e.reason])).toEqual([
      ['family-accepted', 'accepted'], ['family-single', 'single-file']]);
  });

  it('excludes near copies that differ beyond added statements, and near copies with no source', async () => {
    const changed: TriageFamily = { ...divergedFamily, id: 'family-changed', members: [
      member(C1, 'readSession', 10, unguarded), member(C2, 'readToken', 40, unguarded.replace('entry.value', 'entry.value + 1'))] };
    const blind: TriageFamily = { ...divergedFamily, id: 'family-blind', members: [member(C1, 'x'), member(C2, 'y')] };
    const result = await triageCloneFamilies({ families: [changed, blind], history: history(), divergenceBug: bugs('missing').lookup });
    expect(result.excluded.map(e => [e.familyId, e.reason])).toEqual([
      ['family-blind', 'divergence-unmeasured'], ['family-changed', 'not-type-1-2']]);
    expect(result.batches).toEqual([]);
  });

  it('ranks batches by redundant mass x churn x package distance and caps families per batch', async () => {
    const families: TriageFamily[] = Array.from({ length: TRIAGE_BATCH_FAMILY_CAP + 2 }, (_, i) => ({
      id: `family-${i}`, kind: 'renamed' as const, redundantMass: 10 * (i + 1), packageDistance: 0,
      members: [member(A1, `f${i}`, i + 1), member(A2, `g${i}`, i + 1)] }));
    const result = await triageCloneFamilies({ families, history: history(), divergenceBug: bugs('missing').lookup });
    expect(result.batches.map(b => b.families.length)).toEqual([TRIAGE_BATCH_FAMILY_CAP, 2]);
    // Highest score first, and the first batch outranks the remainder.
    expect(result.batches[0]!.families.map(f => f.id)).toEqual(['family-6', 'family-5', 'family-4', 'family-3', 'family-2']);
    expect(result.batches[0]!.score).toBeGreaterThan(result.batches[1]!.score);
  });
});

describe('triage co-change scope (P-009)', () => {
  it('finds the in-family link even when a member file has more than 100 stronger outside partners', async () => {
    // A1 is in 10 commits and A2 in 3 of them: in-family Jaccard 0.3, above the floor. Each of 120
    // partners shares 4 of A1's commits (0.4), so A1's outside pairs alone outnumber a top-100 cut.
    const partner = (k: number) => `packages/alpha/src/partners/p${k}.ts`;
    const commits = Array.from({ length: 10 }, (_, i) => commit(i + 1, A1, ...(i < 3 ? [A2] : []),
      ...Array.from({ length: 120 }, (_, k) => k).filter(k => [0, 1, 2, 3].some(d => (k + d) % 10 === i)).map(partner)));
    const result = await triageCloneFamilies({ families: [coChanging],
      history: { end: END, commit: 'e'.repeat(40), complete: true, commits }, divergenceBug: bugs('missing').lookup });
    expect(result.excluded).toEqual([]);
    expect(result.batches.flatMap(b => b.families)).toMatchObject([{ id: 'family-co-changing', coChange: { minLinkScore: 0.3, files: 2 } }]);
  });
});

describe('compareCopies', () => {
  it('treats renamed copies as identical', () => {
    expect(compareCopies(unguarded, unguarded.replace(/cache/g, 'store').replace(/entry/g, 'hit'))).toEqual({ status: 'identical' });
  });

  it('finds a guard added inside a nested block as one extra statement', () => {
    const base = 'function f(xs) { for (const x of xs) { total(x); } return xs.length; }';
    const fixed = 'function g(ys) { for (const y of ys) { if (y == null) continue; total(y); } return ys.length; }';
    expect(compareCopies(base, fixed)).toEqual({ status: 'diverged', richer: 1, extra: ['if (y == null) continue;'], guard: true });
  });

  it('reports any other difference as not a Type-1/2 pair', () => {
    expect(compareCopies('function f(a) { return a + 1; }', 'function g(b) { return b * 2; }')).toEqual({ status: 'differs' });
  });
});

describe('triageFamilyFromRanked', () => {
  const fn = (path: string, name: string, start: number, end: number) => ({ id: `${path}:${start}`, path, line: 1, column: 0,
    start, end, name, signature: '', mass: 100, exact: 'x', renamed: 'y', blobSha: 'b',
    classification: { test: false, vendored: false, retired: false } });
  const row = (kind: 'renamed' | 'semantic', members: ReturnType<typeof fn>[]) => ({
    family: { id: `fam-${kind}`, version: 'v', kind, fingerprint: 'fp', members },
    membersDigest: 'd'.repeat(64), redundantMass: 77, copies: members.length, packageDistance: 2,
    disposition: 'consolidate' as const, generic: false, accepted: false });

  it('reads member function text for semantic families so triage can check divergence', async () => {
    const files: Record<string, string> = { [C1]: `// head\n${guarded}\n`, [C2]: unguarded };
    const start = files[C1]!.indexOf('function');
    const family = await triageFamilyFromRanked(row('semantic', [fn(C1, 'readSession', start, start + guarded.length),
      fn(C2, 'readToken', 0, unguarded.length)]), async path => files[path]!);
    expect(family).toMatchObject({ id: 'fam-semantic', kind: 'semantic', redundantMass: 77, packageDistance: 2, accepted: false });
    expect(family.members.map(m => m.source)).toEqual([guarded, unguarded]);
    expect(compareCopies(family.members[0]!.source, family.members[1]!.source)).toMatchObject({ status: 'diverged', guard: true });
  });

  it('reads nothing for renamed families and leaves an unreadable semantic member without source', async () => {
    const reads: string[] = [];
    const renamed = await triageFamilyFromRanked(row('renamed', [fn(A1, 'a', 0, 5), fn(A2, 'b', 0, 5)]),
      async path => { reads.push(path); return 'x'; });
    expect(reads).toEqual([]);
    expect(renamed.members.every(m => m.source === undefined)).toBe(true);
    const blind = await triageFamilyFromRanked(row('semantic', [fn(C1, 'a', 0, 5), fn(C2, 'b', 0, 5)]),
      async () => { throw new Error('ENOENT'); });
    expect(blind.members.every(m => m.source === undefined)).toBe(true);
  });
});

describe('selectRoundFamilies (P-009)', () => {
  const fn = (path: string) => ({ id: `${path}:1`, path, line: 1, column: 0, start: 0, end: 5, name: 'f', signature: '',
    mass: 100, exact: 'x', renamed: 'y', blobSha: 'b', classification: { test: false, vendored: path.startsWith('templates/'), retired: false } });
  const ranked = (id: string, paths: string[], over: { accepted?: boolean } = {}) => ({
    family: { id, version: 'v', kind: 'renamed' as const, fingerprint: id, members: paths.map(fn) },
    membersDigest: 'd'.repeat(64), redundantMass: 50, copies: paths.length, packageDistance: 1,
    disposition: paths.some(p => p.startsWith('templates/')) ? 'derive-and-sync' as const : 'consolidate' as const,
    generic: false, accepted: over.accepted ?? false });

  it('takes consolidation families in ranked order and skips vendored, accepted and over-budget ones', () => {
    const rows = [
      ranked('vendored', ['libs/generic/kit/src/a.ts', 'templates/app/kit/src/a.ts']),
      ranked('accepted', [A1, A2], { accepted: true }),
      ranked('first', [A1, A2]),
      ranked('too-wide', [B1, B2, C1]),
      ranked('second', [A1, C1]),
    ];
    const selection = selectRoundFamilies(rows, 3);
    expect(selection.chosen.map(r => r.family.id)).toEqual(['first', 'second']);
    expect(selection.memberPaths).toEqual([A2, A1, C1].sort());
    expect(selection.skipped).toEqual({ accepted: 1, 'derive-and-sync': 1, 'path-budget': 1 });
  });

  it('never spends the path budget on a derive-and-sync family, however high it ranks', () => {
    const vendored = Array.from({ length: 5 }, (_, i) =>
      ranked(`vendored-${i}`, [`libs/generic/kit/src/m${i}.ts`, `templates/app/kit/src/m${i}.ts`]));
    const selection = selectRoundFamilies([...vendored, ranked('real', [A1, A2])], 2);
    expect(selection.chosen.map(r => r.family.id)).toEqual(['real']);
    expect(selection.memberPaths.some(p => p.startsWith('templates/'))).toBe(false);
  });

  it('refuses a non-positive path limit', () => {
    expect(() => selectRoundFamilies([], 0)).toThrow(/positive integer/);
  });
});

describe('boundCoveragePaths (P-009)', () => {
  const fam = (id: string, paths: string[]) => ({ id, score: 1, churn: 0, redundantMass: 1, packageDistance: 0,
    coChange: { minLinkScore: 1, files: paths.length }, members: paths.map((path, i) => ({ path, line: i + 1, symbol: 'f' })) });
  const batch = (area: string, families: ReturnType<typeof fam>[]) => ({ area, index: 0, score: 1, redundantMass: 1, families });

  it('reads coverage for surviving families in batch order and drops, never under-covers, the ones that do not fit', () => {
    const batches = [batch('a', [fam('first', [A1, A2]), fam('wide', [B1, B2, C1])]), batch('b', [fam('shares', [A1, C1])])];
    const bound = boundCoveragePaths(batches, 3);
    expect(bound.paths).toEqual([A1, A2, C1].sort());
    expect(bound.dropped).toEqual(['wide']);
  });

  it('asks for nothing when no family survived triage', () => {
    expect(boundCoveragePaths([], 50)).toEqual({ paths: [], dropped: [] });
  });

  it('refuses a non-positive path limit', () => {
    expect(() => boundCoveragePaths([], 0)).toThrow(/positive integer/);
  });
});

describe('divergedCopyConditionKey', () => {
  it('names the same bug whichever copy is listed first', () => {
    const a = { path: C1, line: 1, symbol: 'readSession' }, b = { path: C2, line: 2, symbol: 'readToken' };
    expect(divergedCopyConditionKey(a, b)).toBe(divergedCopyConditionKey(b, a));
  });
});
