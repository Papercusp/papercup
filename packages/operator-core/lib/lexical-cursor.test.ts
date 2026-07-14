/** lexical-cursor (ambient-semantic-push P-001/P-002, plan D-010): the LEXICAL
 *  hot loop — class-weighted keyword mining → recency-decayed sparse term-weight
 *  cursor → BM25-family weighted overlap → inverted index for O(lookup)
 *  collision candidates. Pure core; live legs (coord delivery rail, emergent
 *  topics, optional embedding-assisted slow loop) deferred DEFAULT-OFF. */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLASS_WEIGHTS,
  DEFAULT_CURSOR_DECAY,
  DEFAULT_CURSOR_MAX_TERMS,
  extractKeywords,
  selectCursorNotes,
  buildCursor,
  scoreCursorOverlap,
  describeOverlap,
  buildInvertedIndex,
  collisionCandidates,
  type ClassifiedTerm,
  type LexicalCursor,
} from './lexical-cursor';

const classOf = (terms: ClassifiedTerm[], term: string) => terms.find((t) => t.term === term)?.termClass;

describe('extractKeywords — class-weighted mining (P-001)', () => {
  it('classifies artifact ids highest: WI/P/D/EI/F, dated plan slug, migration', () => {
    const terms = extractKeywords(
      'P-024 landed in WI-4853; see D-010 + EI-9036, plan deterministic-context-carry-2026-07-14, migration 605',
    );
    expect(classOf(terms, 'P-024')).toBe('artifact-id');
    expect(classOf(terms, 'WI-4853')).toBe('artifact-id');
    expect(classOf(terms, 'D-010')).toBe('artifact-id');
    expect(classOf(terms, 'EI-9036')).toBe('artifact-id');
    expect(classOf(terms, 'deterministic-context-carry-2026-07-14')).toBe('artifact-id');
    expect(classOf(terms, 'migration-605')).toBe('artifact-id');
  });

  it('classifies paths, tool names, camelCase and snake_case as path-or-symbol', () => {
    const terms = extractKeywords(
      'edited packages/operator-core/lib/maxturn-sweep.ts and context-doors.ts; called coord:orient; ran computeMaxTurn and resolve_door_constants',
    );
    expect(classOf(terms, 'packages/operator-core/lib/maxturn-sweep.ts')).toBe('path-or-symbol');
    expect(classOf(terms, 'context-doors.ts')).toBe('path-or-symbol');
    expect(classOf(terms, 'coord:orient')).toBe('path-or-symbol');
    expect(classOf(terms, 'computeMaxTurn')).toBe('path-or-symbol');
    expect(classOf(terms, 'resolve_door_constants')).toBe('path-or-symbol');
  });

  it('classifies plain content words as lowercased domain terms, stopwords/short/numbers out', () => {
    const terms = extractKeywords('The compaction threshold works for all 27 tests');
    expect(classOf(terms, 'compaction')).toBe('domain-term');
    expect(classOf(terms, 'threshold')).toBe('domain-term');
    // stopwords ('the', 'for', 'all', 'works'? not listed) — 'the','for','all','tests' dropped
    expect(terms.map((t) => t.term)).not.toContain('the');
    expect(terms.map((t) => t.term)).not.toContain('tests');
    // bare number never a term
    expect(terms.map((t) => t.term)).not.toContain('27');
  });

  it('span-consumes: a path is one term, never re-emitted as its substrings', () => {
    const terms = extractKeywords('touched maxturn-sweep.ts today');
    expect(classOf(terms, 'maxturn-sweep.ts')).toBe('path-or-symbol');
    // 'maxturn' and 'sweep' must NOT also appear as domain terms
    expect(terms.map((t) => t.term)).not.toContain('maxturn');
    expect(terms.map((t) => t.term)).not.toContain('sweep');
  });

  it('dedupes within a note (WI-4790 twice ⇒ one term) and returns [] for blank input', () => {
    const terms = extractKeywords('WI-4790 blocked WI-4790 again on compaction compaction');
    expect(terms.filter((t) => t.term === 'WI-4790')).toHaveLength(1);
    expect(terms.filter((t) => t.term === 'compaction')).toHaveLength(1);
    expect(extractKeywords('   ')).toEqual([]);
    expect(extractKeywords('' as string)).toEqual([]);
  });

  it('normalizes: prefixed ids upper-cased, dated slug lower-cased, migration → migration-NNN', () => {
    const t = extractKeywords('wi note: migration-42 and Ambient-Semantic-Push-2026-07-14');
    expect(t.map((x) => x.term)).toContain('migration-42');
    // an uppercase-authored dated slug lower-cases to the canonical join key
    expect(t.map((x) => x.term)).toContain('ambient-semantic-push-2026-07-14');
  });
});

describe('selectCursorNotes — echo-guard input selection (D-001/D-010)', () => {
  it('drops mechanical fallbacks by default, keeps agent notes, preserves order', () => {
    const rows = [
      { note: 'agent one', source: 'agent' as const },
      { note: 'mechanical fallback', source: 'mechanical' as const, flagged: true },
      { note: 'agent two', source: 'agent' as const },
    ];
    expect(selectCursorNotes(rows)).toEqual(['agent one', 'agent two']);
  });

  it('includeMechanical keeps both; blank notes always dropped', () => {
    const rows = [
      { note: 'agent', source: 'agent' as const },
      { note: '   ', source: 'agent' as const },
      { note: 'mech', source: 'mechanical' as const },
    ];
    expect(selectCursorNotes(rows, { includeMechanical: true })).toEqual(['agent', 'mech']);
  });

  it('treats a note with no source as usable (undefined ≠ mechanical)', () => {
    expect(selectCursorNotes([{ note: 'x' }])).toEqual(['x']);
  });
});

describe('buildCursor — recency-decayed sparse term-weight vector (P-002)', () => {
  it('weighs a newer note above an older one (recency decay)', () => {
    const cursor = buildCursor(['alpha newest', 'beta oldest'], { decay: 0.5 });
    expect(cursor.weightByTerm.get('alpha')!).toBeGreaterThan(cursor.weightByTerm.get('beta')!);
    expect(cursor.terms[0].term).toBe('alpha');
    expect(cursor.noteCount).toBe(2);
  });

  it('weighs an artifact id above a domain term at equal recency (class weighting)', () => {
    const cursor = buildCursor(['alpha WI-1234']);
    expect(cursor.weightByTerm.get('WI-1234')!).toBeCloseTo(DEFAULT_CLASS_WEIGHTS['artifact-id']);
    expect(cursor.weightByTerm.get('alpha')!).toBeCloseTo(DEFAULT_CLASS_WEIGHTS['domain-term']);
    expect(cursor.weightByTerm.get('WI-1234')!).toBeGreaterThan(cursor.weightByTerm.get('alpha')!);
    expect(cursor.terms[0].term).toBe('WI-1234');
  });

  it('decay=1 makes the window flat (a recurring term overtakes a one-off newer term)', () => {
    // 'gamma' appears in 2 of 3 notes; 'alpha' only in the newest.
    const flat = buildCursor(['alpha gamma', 'delta', 'gamma epsilon'], { decay: 1 });
    expect(flat.weightByTerm.get('gamma')!).toBeGreaterThan(flat.weightByTerm.get('alpha')!);
  });

  it('caps to maxTerms, keeping the highest-weighted', () => {
    const cursor = buildCursor(['WI-10 aaa bbb ccc ddd eee'], { maxTerms: 2 });
    expect(cursor.terms).toHaveLength(2);
    // the artifact id (weight 3) is retained; a domain term (weight 1) fills the 2nd slot
    expect(cursor.terms[0].term).toBe('WI-10');
    expect(cursor.weightByTerm.size).toBe(2);
  });

  it('windows to maxNotes before decay (older notes beyond the window never counted)', () => {
    const cursor = buildCursor(['alpha', 'beta', 'gamma'], { maxNotes: 1 });
    expect(cursor.noteCount).toBe(1);
    expect(cursor.weightByTerm.has('alpha')).toBe(true);
    expect(cursor.weightByTerm.has('beta')).toBe(false);
  });

  it('is deterministic: equal-weight terms sort by term for a stable order', () => {
    const a = buildCursor(['zeta yankee xray'], { decay: 1 });
    const b = buildCursor(['xray yankee zeta'], { decay: 1 });
    expect(a.terms.map((t) => t.term)).toEqual(b.terms.map((t) => t.term));
  });

  it('carries sessionId through and exposes the documented defaults', () => {
    const cursor = buildCursor(['x note here'], { sessionId: 's-1' });
    expect(cursor.sessionId).toBe('s-1');
    expect(DEFAULT_CURSOR_DECAY).toBe(0.85);
    expect(DEFAULT_CURSOR_MAX_TERMS).toBe(64);
  });

  it('empty / all-blank input yields an empty cursor, never throws', () => {
    const cursor = buildCursor(['', '   ']);
    expect(cursor.terms).toEqual([]);
    expect(cursor.noteCount).toBe(0);
    expect(cursor.sessionId).toBeNull();
  });
});

describe('scoreCursorOverlap — legible weighted overlap (P-002)', () => {
  const noteA = 'Landed P-024 in maxturn-sweep.ts, 27 tests green, WI-4853; computeMaxTurn threshold';
  const noteB = 'Debugging maxturn-sweep.ts WI-4853 collision; computeMaxTurn returns the wrong door';
  const noteC = 'Refactored auth-rate-limit.ts login flow for gateway egress';

  it('identical cursors score 1; disjoint cursors score 0', () => {
    const a = buildCursor([noteA], { sessionId: 'a' });
    const aClone = buildCursor([noteA], { sessionId: 'a2' });
    expect(scoreCursorOverlap(a, aClone).score).toBeCloseTo(1);
    const c = buildCursor([noteC], { sessionId: 'c' });
    expect(scoreCursorOverlap(a, c).score).toBe(0);
  });

  it('an empty cursor scores 0 against anything', () => {
    const a = buildCursor([noteA]);
    const empty = buildCursor([]);
    expect(scoreCursorOverlap(a, empty).score).toBe(0);
    expect(scoreCursorOverlap(empty, empty).score).toBe(0);
  });

  it('surfaces the shared terms, highest contribution first (the shared artifact id leads)', () => {
    const a = buildCursor([noteA]);
    const b = buildCursor([noteB]);
    const { score, sharedTerms } = scoreCursorOverlap(a, b);
    expect(score).toBeGreaterThan(0);
    const shared = sharedTerms.map((s) => s.term);
    expect(shared).toContain('WI-4853');
    expect(shared).toContain('maxturn-sweep.ts');
    expect(shared).toContain('computeMaxTurn');
    // the artifact id (class weight 3×3) outranks the symbols (2×2) in contribution
    expect(sharedTerms[0].term).toBe('WI-4853');
    expect(sharedTerms[0].termClass).toBe('artifact-id');
  });

  it('is symmetric', () => {
    const a = buildCursor([noteA]);
    const b = buildCursor([noteB]);
    expect(scoreCursorOverlap(a, b).score).toBeCloseTo(scoreCursorOverlap(b, a).score);
  });

  it('IDF scaling makes a RARE shared term outweigh a COMMON one (BM25 family)', () => {
    // 'common' in every session (low idf); 'WI-91' in one (high idf).
    const s1 = buildCursor(['common topic here'], { sessionId: 's1' });
    const s2 = buildCursor(['common topic here'], { sessionId: 's2' });
    const s3 = buildCursor(['common WI-91 topic here'], { sessionId: 's3' });
    const index = buildInvertedIndex([s1, s2, s3]);
    // idf: a term in 1 of 3 sessions beats one in 3 of 3
    expect(index.idf('WI-91')).toBeGreaterThan(index.idf('common'));
    // an absent term is maximal
    expect(index.idf('never-seen')).toBeGreaterThan(index.idf('WI-91'));
  });

  it('describeOverlap renders a legible one-liner, capped', () => {
    const a = buildCursor([noteA]);
    const b = buildCursor([noteB]);
    const line = describeOverlap(scoreCursorOverlap(a, b), 2);
    expect(line.startsWith('shared: ')).toBe(true);
    expect(line).toContain('WI-4853');
    expect(line.split(', ')).toHaveLength(2); // capped to 2
    expect(describeOverlap({ score: 0, sharedTerms: [] })).toBe('shared: (none)');
  });
});

describe('buildInvertedIndex — postings + BM25 idf', () => {
  it('maps each term to the sessions carrying it; skips cursors with no sessionId', () => {
    const s1 = buildCursor(['alpha shared-term'], { sessionId: 's1' });
    const s2 = buildCursor(['beta shared-term'], { sessionId: 's2' });
    const orphan = buildCursor(['gamma']); // no sessionId
    const index = buildInvertedIndex([s1, s2, orphan]);
    expect(index.sessionCount).toBe(2);
    expect(index.postings.get('shared-term')).toEqual(new Set(['s1', 's2']));
    expect(index.postings.get('alpha')).toEqual(new Set(['s1']));
    expect([...index.cursorsBySession.keys()].sort()).toEqual(['s1', 's2']);
    expect(index.postings.has('gamma')).toBe(false);
  });

  it('idf decreases as document frequency rises', () => {
    const cursors = ['s1', 's2', 's3', 's4'].map((sid) => buildCursor(['everywhere ' + (sid === 's1' ? 'rareterm' : 'filler-' + sid)], { sessionId: sid }));
    const index = buildInvertedIndex(cursors);
    expect(index.idf('everywhere')).toBeLessThan(index.idf('rareterm'));
    expect(index.idf('everywhere')).toBeGreaterThanOrEqual(0);
  });
});

describe('collisionCandidates — index lookup, not a pairwise scan (P-004 core)', () => {
  const noteA = 'P-024 maxturn-sweep.ts WI-4853 computeMaxTurn threshold';
  const noteB = 'maxturn-sweep.ts WI-4853 computeMaxTurn collision debugging';
  const noteC = 'auth-rate-limit.ts login gateway egress unrelated';

  const mkIndex = (): { index: ReturnType<typeof buildInvertedIndex>; a: LexicalCursor } => {
    const a = buildCursor([noteA], { sessionId: 's-a' });
    const b = buildCursor([noteB], { sessionId: 's-b' });
    const c = buildCursor([noteC], { sessionId: 's-c' });
    return { index: buildInvertedIndex([a, b, c]), a };
  };

  it('returns only sessions sharing ≥1 term; excludes self and non-sharers', () => {
    const { index, a } = mkIndex();
    const hits = collisionCandidates(index, a);
    expect(hits.map((h) => h.sessionId)).toEqual(['s-b']); // s-a excluded (self), s-c shares nothing
    expect(hits[0].overlap.score).toBeGreaterThan(0);
    expect(hits[0].overlap.sharedTerms.map((s) => s.term)).toContain('WI-4853');
  });

  it('sorts by score desc and honors maxCandidates', () => {
    const a = buildCursor([noteA], { sessionId: 's-a' });
    const strong = buildCursor([noteB], { sessionId: 's-strong' }); // 3 shared terms
    const weak = buildCursor(['computeMaxTurn only one shared'], { sessionId: 's-weak' }); // 1 shared
    const index = buildInvertedIndex([a, strong, weak]);
    const all = collisionCandidates(index, a);
    expect(all.map((h) => h.sessionId)).toEqual(['s-strong', 's-weak']);
    expect(all[0].overlap.score).toBeGreaterThanOrEqual(all[1].overlap.score);
    const capped = collisionCandidates(index, a, { maxCandidates: 1 });
    expect(capped.map((h) => h.sessionId)).toEqual(['s-strong']);
  });

  it('minScore filters weak collisions out entirely', () => {
    const { index, a } = mkIndex();
    expect(collisionCandidates(index, a, { minScore: 0.999 })).toEqual([]);
  });

  it('excludeSessionId overrides the default self-exclusion', () => {
    const { index, a } = mkIndex();
    // query as if we were a THIRD party (do not exclude s-a): s-a now scores 1 against itself
    const hits = collisionCandidates(index, a, { excludeSessionId: 'nobody' });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['s-a', 's-b']);
    expect(hits.find((h) => h.sessionId === 's-a')!.overlap.score).toBeCloseTo(1);
  });

  it('useIdf:false falls back to plain weighted cosine (still finds the collision)', () => {
    const { index, a } = mkIndex();
    const withIdf = collisionCandidates(index, a, { useIdf: true });
    const noIdf = collisionCandidates(index, a, { useIdf: false });
    expect(withIdf.map((h) => h.sessionId)).toEqual(['s-b']);
    expect(noIdf.map((h) => h.sessionId)).toEqual(['s-b']);
  });
});
