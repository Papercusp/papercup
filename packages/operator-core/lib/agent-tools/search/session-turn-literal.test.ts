/**
 * Pure coverage for session-turn-literal.ts (plan session-transcript-exact-fuzzy-search-2026-09-14
 * P-003): the helpers and `composeSessionTurnTiers`. The SQL tiers are covered against real
 * Postgres in session-turn-literal.integration.test.ts.
 *
 * Test names that start with "Tier precedence regression" / "Cross-leg deduplication regression"
 * are the VAL-P003-RETRIEVAL-PRECEDENCE evidence names — keep them verbatim.
 */
import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@papercusp/search';
import {
  SESSION_TURN_LITERAL_POLICY,
  composeSessionTurnTiers,
  escapeLikeLiteral,
  expandableTokens,
  fuzzyVariant,
  markFirst,
  tieredHitToWire,
  type SessionTurnLiteralHit,
} from './session-turn-literal';

const lit = (
  tier: 'exact' | 'fuzzy',
  sid: string,
  idx: number,
  extra: Partial<SessionTurnLiteralHit> = {},
): SessionTurnLiteralHit => ({
  sourceKind: 'claude',
  sessionId: sid,
  turnIdx: idx,
  speaker: 'user',
  owner: null,
  harnessSlug: null,
  ts: '2026-09-30T00:00:00Z',
  tier,
  excerpt: `[user] ${tier} ${sid}:${idx}`,
  highlight: `[user] <mark>${tier}</mark> ${sid}:${idx}`,
  ...(tier === 'fuzzy' ? { fuzzy: { token: 'furnisedfinder', word: 'furnishedfinder', similarity: 0.62 } } : {}),
  ...extra,
});

const hyb = (
  sid: string,
  idx: number,
  rankerScores: Record<string, number>,
  score = 0.02,
): SearchHit => ({
  source: 'session_turn',
  source_id: `claude:${sid}:${idx}`,
  excerpt: `hybrid ${sid}:${idx}`,
  highlight: `hybrid ${sid}:${idx}`,
  score,
  rankers: Object.keys(rankerScores),
  rankerScores,
});

const LEX = { lexical: 0.07 };
const SEM = { embeddings: 0.61 };
const BOTH = { lexical: 0.07, embeddings: 0.61 };

describe('escapeLikeLiteral', () => {
  it('escapes the three LIKE metacharacters so the query matches literally', () => {
    expect(escapeLikeLiteral('50%_off\\now')).toBe('50\\%\\_off\\\\now');
    expect(escapeLikeLiteral('plain text')).toBe('plain text');
  });
});

describe('expandableTokens', () => {
  it('skips tokens shorter than the minimum (4-char "plam" is never expanded) and lowercases', () => {
    expect(expandableTokens('Plam FurnisedFinder')).toEqual(['furnisedfinder']);
  });
  it('splits on punctuation: a URL yields only its long-enough label', () => {
    expect(expandableTokens('www.furnishedfinder.com')).toEqual(['furnishedfinder']);
  });
  it('deduplicates repeated tokens and caps the count at fuzzyMaxTokens', () => {
    expect(expandableTokens('alphabet alphabet bravoish charlies deltaone echoes')).toEqual([
      'alphabet',
      'bravoish',
      'charlies',
    ]);
  });
  it('skips over-long tokens', () => {
    expect(expandableTokens('x'.repeat(41) + ' goodword')).toEqual(['goodword']);
  });
});

describe('fuzzyVariant', () => {
  it('replaces whole-token occurrences only, never a substring of a longer word', () => {
    expect(fuzzyVariant('furnisedfinder and furnisedfindering', 'furnisedfinder', 'furnishedfinder')).toBe(
      'furnishedfinder and furnisedfindering',
    );
  });
  it('is a no-op when the token is absent', () => {
    expect(fuzzyVariant('nothing here', 'furnisedfinder', 'furnishedfinder')).toBe('nothing here');
  });
  it('treats regex metacharacters in the token literally', () => {
    expect(fuzzyVariant('a.b.c x', 'a.b.c', 'zzz')).toBe('zzz x');
  });
});

describe('markFirst', () => {
  it('wraps the first case-insensitive occurrence, preserving the original casing', () => {
    expect(markFirst('See FurnishedFinder.com and furnishedfinder', 'furnishedfinder')).toBe(
      'See <mark>FurnishedFinder</mark>.com and furnishedfinder',
    );
  });
  it('returns the text unchanged when the needle is absent or empty', () => {
    expect(markFirst('abc', 'zzz')).toBe('abc');
    expect(markFirst('abc', '')).toBe('abc');
  });
});

describe('composeSessionTurnTiers', () => {
  it('Tier precedence regression: an exact turn precedes every fuzzy-only, lexical-only and semantic-only candidate', () => {
    const out = composeSessionTurnTiers({
      // Hybrid order deliberately puts semantic/lexical first — precedence must still win.
      hybrid: [hyb('s-sem', 0, SEM, 0.05), hyb('s-lex', 0, LEX, 0.04), hyb('s-both', 0, BOTH, 0.03)],
      fuzzy: [lit('fuzzy', 's-fuz', 0)],
      exact: [lit('exact', 's-ex', 0)],
    });
    expect(out.hits.map((h) => h.key)).toEqual([
      'claude:s-ex:0',
      'claude:s-fuz:0',
      'claude:s-sem:0',
      'claude:s-lex:0',
      'claude:s-both:0',
    ]);
    expect(out.hits.map((h) => h.tier)).toEqual(['exact', 'fuzzy', 'semantic', 'lexical', 'both']);
  });

  it('Cross-leg deduplication regression: a turn returned by several legs is ONE row, won by the highest tier, with the others recorded', () => {
    const out = composeSessionTurnTiers({
      exact: [lit('exact', 's1', 3)],
      fuzzy: [lit('fuzzy', 's1', 3), lit('fuzzy', 's2', 0)],
      hybrid: [hyb('s1', 3, BOTH, 0.09), hyb('s2', 0, LEX, 0.03), hyb('s3', 0, SEM, 0.02)],
    });
    expect(out.hits.map((h) => h.key)).toEqual(['claude:s1:3', 'claude:s2:0', 'claude:s3:0']);
    const [first, second] = out.hits;
    expect(first!.tier).toBe('exact');
    expect(first!.alsoMatchedBy.sort()).toEqual(['both', 'fuzzy']);
    expect(first!.matchedBy).toBe('both');
    expect(first!.score).toBe(0.09); // hybrid score absorbed when the engine also returned it
    expect(first!.lexicalScore).toBe(0.07);
    expect(first!.semanticScore).toBe(0.61);
    expect(second!.tier).toBe('fuzzy');
    expect(second!.alsoMatchedBy).toEqual(['lexical']);
    // Nothing is counted twice.
    expect(new Set(out.hits.map((h) => h.key)).size).toBe(out.hits.length);
  });

  it('literal-only hits carry honest provenance: matchedBy "unknown", exact score 1, fuzzy score = similarity, no hybrid claim', () => {
    const out = composeSessionTurnTiers({ exact: [lit('exact', 'a', 0)], fuzzy: [lit('fuzzy', 'b', 0)], hybrid: [] });
    const [e, f] = out.hits;
    expect(e).toMatchObject({ tier: 'exact', matchedBy: 'unknown', score: 1, alsoMatchedBy: [] });
    expect(f).toMatchObject({ tier: 'fuzzy', matchedBy: 'unknown', score: 0.62, alsoMatchedBy: [] });
    expect(f!.fuzzy).toEqual({ token: 'furnisedfinder', word: 'furnishedfinder', similarity: 0.62 });
  });

  it('an exact hit is never displaced when the hybrid legs saturate the pool', () => {
    const hybrid = Array.from({ length: 500 }, (_, i) => hyb(`h${i}`, 0, i % 2 ? LEX : SEM, 0.5 - i / 1000));
    const out = composeSessionTurnTiers({
      exact: [lit('exact', 'x', 0), lit('exact', 'x', 1), lit('exact', 'x', 2)],
      fuzzy: [],
      hybrid,
    });
    expect(out.hits).toHaveLength(SESSION_TURN_LITERAL_POLICY.resultSlots);
    expect(out.hits.slice(0, 3).map((h) => h.tier)).toEqual(['exact', 'exact', 'exact']);
    expect(out.counts.exact).toEqual({ candidates: 3, kept: 3 });
    expect(out.counts.hybrid.kept).toBe(SESSION_TURN_LITERAL_POLICY.resultSlots - 3);
  });

  it('keeps the hybrid engine order inside the remainder (no lexical/semantic re-partition)', () => {
    const hybrid = [hyb('a', 0, SEM, 0.9), hyb('b', 0, LEX, 0.8), hyb('c', 0, SEM, 0.7), hyb('d', 0, LEX, 0.6)];
    const out = composeSessionTurnTiers({ exact: [], fuzzy: [], hybrid });
    expect(out.hits.map((h) => h.sessionId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('floors: exact keeps its reserve, fuzzy keeps its reserve, leftovers go exact → fuzzy → hybrid', () => {
    const exact = Array.from({ length: 200 }, (_, i) => lit('exact', 'e', i));
    const fuzzy = Array.from({ length: 80 }, (_, i) => lit('fuzzy', 'f', i));
    const out = composeSessionTurnTiers({ exact, fuzzy, hybrid: [hyb('h', 0, LEX)] });
    // 150 slots: exact floor 100 + fuzzy floor 50 fills it; the extras and hybrid get nothing.
    expect(out.counts.exact.kept).toBe(100);
    expect(out.counts.fuzzy.kept).toBe(50);
    expect(out.counts.hybrid.kept).toBe(0);
    expect(out.hits).toHaveLength(150);

    // When fuzzy is short, its unused floor is returned to exact.
    const out2 = composeSessionTurnTiers({ exact, fuzzy: fuzzy.slice(0, 10), hybrid: [] });
    expect(out2.counts.exact.kept).toBe(140);
    expect(out2.counts.fuzzy.kept).toBe(10);
  });

  it('scales the reserves down with a smaller limit and honours limit 0', () => {
    const exact = [lit('exact', 'e', 0), lit('exact', 'e', 1), lit('exact', 'e', 2)];
    const fuzzy = [lit('fuzzy', 'f', 0), lit('fuzzy', 'f', 1), lit('fuzzy', 'f', 2)];
    const out = composeSessionTurnTiers({ exact, fuzzy, hybrid: [], limit: 4 });
    expect(out.hits.map((h) => h.tier)).toEqual(['exact', 'exact', 'exact', 'fuzzy']);
    expect(composeSessionTurnTiers({ exact, fuzzy, hybrid: [], limit: 0 }).hits).toEqual([]);
  });

  it('ignores hybrid hits whose source_id is not a session-turn ref, and dedups repeats inside the hybrid list', () => {
    const bad: SearchHit = { ...hyb('x', 0, LEX), source_id: 'not-a-turn-ref' };
    const out = composeSessionTurnTiers({
      exact: [],
      fuzzy: [],
      hybrid: [bad, hyb('d', 1, LEX, 0.5), hyb('d', 1, SEM, 0.4)],
    });
    expect(out.hits.map((h) => h.key)).toEqual(['claude:d:1']);
    expect(out.hits[0]!.tier).toBe('lexical'); // the FIRST occurrence wins, like the engine's own order
  });

  it('maxPerSession: one chatty session cannot consume the page — the cap is shared across tiers, higher tier claims first', () => {
    // 6 exact turns of ONE session + 2 of another, a fuzzy turn and a hybrid turn of the chatty
    // session, and a hybrid hit from a third session.
    const exact = [
      ...Array.from({ length: 6 }, (_, i) => lit('exact', 'chatty', i)),
      lit('exact', 'other', 0),
      lit('exact', 'other', 1),
    ];
    const out = composeSessionTurnTiers({
      exact,
      fuzzy: [lit('fuzzy', 'chatty', 10)],
      hybrid: [hyb('chatty', 20, LEX, 0.5), hyb('third', 0, SEM, 0.4)],
      maxPerSession: 2,
    });
    // chatty: exact 0,1 win its two slots; its other exact turns, the fuzzy turn and the hybrid turn
    // are all dropped. other: both exact. third: the hybrid hit survives.
    expect(out.hits.map((h) => h.key)).toEqual([
      'claude:chatty:0',
      'claude:chatty:1',
      'claude:other:0',
      'claude:other:1',
      'claude:third:0',
    ]);
    // 4 exact (chatty 2..5) + 1 fuzzy + 1 hybrid dropped by the cap.
    expect(out.sessionCapped).toBe(6);
    expect(out.counts.exact).toEqual({ candidates: 8, kept: 4 });
    expect(out.counts.fuzzy.kept).toBe(0);
    expect(out.counts.hybrid.kept).toBe(1);
  });

  it('maxPerSession: an exact hit still beats fuzzy/lexical/semantic from the SAME session (the cap never inverts precedence)', () => {
    const out = composeSessionTurnTiers({
      exact: [lit('exact', 's', 7)],
      fuzzy: [lit('fuzzy', 's', 1)],
      hybrid: [hyb('s', 2, BOTH, 0.9)],
      maxPerSession: 1,
    });
    expect(out.hits.map((h) => `${h.key}:${h.tier}`)).toEqual(['claude:s:7:exact']);
  });

  it('maxPerSession: unset, 0, negative and NaN are no cap, and the cap is scoped per sourceKind', () => {
    const exact = Array.from({ length: 5 }, (_, i) => lit('exact', 's', i));
    for (const maxPerSession of [undefined, 0, -3, Number.NaN]) {
      const out = composeSessionTurnTiers({ exact, fuzzy: [], hybrid: [], maxPerSession });
      expect(out.hits).toHaveLength(5);
      expect(out.sessionCapped).toBe(0);
    }
    // Same session id under a different sourceKind is a DIFFERENT session for the cap.
    const out = composeSessionTurnTiers({
      exact: [lit('exact', 's', 0), lit('exact', 's', 1), lit('exact', 's', 0, { sourceKind: 'codex' }), lit('exact', 's', 1, { sourceKind: 'codex' })],
      fuzzy: [],
      hybrid: [],
      maxPerSession: 1,
    });
    expect(out.hits.map((h) => h.key)).toEqual(['claude:s:0', 'codex:s:0']);
  });

  it('maxPerSession: the cap is applied BEFORE slotting, so dropped turns do not hold reserved slots', () => {
    // 100 exact turns of one session, cap 2, plus 3 other sessions' hybrid hits, limit 5: without a
    // pre-slot cap the 5 slots would all be the chatty session's exact turns.
    const exact = Array.from({ length: 100 }, (_, i) => lit('exact', 'chatty', i));
    const hybrid = [hyb('a', 0, LEX), hyb('b', 0, SEM), hyb('c', 0, LEX)];
    const out = composeSessionTurnTiers({ exact, fuzzy: [], hybrid, limit: 5, maxPerSession: 2 });
    expect(out.hits.map((h) => h.sessionId)).toEqual(['chatty', 'chatty', 'a', 'b', 'c']);
    expect(out.sessionCapped).toBe(98);
  });

  it('in-tier order: exact turns the hybrid engine ALSO returned lead the tier in the engine order; literal-only turns follow newest-first; tier precedence is unchanged', () => {
    // The exact SQL is newest-first (n1 newest … n3 oldest). The engine ranked n3 above n2.
    const exact = [lit('exact', 'n1', 0), lit('exact', 'n2', 0), lit('exact', 'n3', 0), lit('exact', 'n4', 0)];
    const out = composeSessionTurnTiers({
      exact,
      fuzzy: [lit('fuzzy', 'f1', 0)],
      hybrid: [hyb('only-hybrid', 0, SEM, 0.9), hyb('n3', 0, BOTH, 0.8), hyb('n2', 0, LEX, 0.7)],
    });
    expect(out.hits.map((h) => h.sessionId)).toEqual(['n3', 'n2', 'n1', 'n4', 'f1', 'only-hybrid']);
    expect(out.hits.map((h) => h.tier)).toEqual(['exact', 'exact', 'exact', 'exact', 'fuzzy', 'semantic']);
    // With a cap, the engine-known turn wins the session's slot over a newer literal-only one.
    const capped = composeSessionTurnTiers({
      exact: [lit('exact', 's', 9), lit('exact', 's', 1)],
      fuzzy: [],
      hybrid: [hyb('s', 1, BOTH, 0.5)],
      maxPerSession: 1,
    });
    expect(capped.hits.map((h) => h.key)).toEqual(['claude:s:1']);
  });

  it('focusTerm: a literal hit carries the SQL needle it matched (the fuzzy phrase VARIANT, not the typed query); hybrid-only hits carry none', () => {
    const out = composeSessionTurnTiers({
      exact: [lit('exact', 'a', 0, { focusTerm: 'www.furnishedfinder.com' })],
      fuzzy: [lit('fuzzy', 'b', 0, { focusTerm: 'plan' })],
      hybrid: [hyb('c', 0, LEX)],
    });
    expect(out.hits.map((h) => [h.sessionId, h.focusTerm])).toEqual([
      ['a', 'www.furnishedfinder.com'],
      ['b', 'plan'],
      ['c', undefined],
    ]);
    // Absent on the literal hit stays absent (no empty-string claim).
    const bare = composeSessionTurnTiers({ exact: [lit('exact', 'z', 0)], fuzzy: [], hybrid: [] });
    expect('focusTerm' in bare.hits[0]!).toBe(false);
  });
});

describe('tieredHitToWire (the /search-transcripts wire projection)', () => {
  it('a literal-only exact turn: tier is the claim, matchedBy is "unknown", optional fields are ABSENT not empty', () => {
    const [h] = composeSessionTurnTiers({
      exact: [lit('exact', 'ff', 3, { focusTerm: 'furnishedfinder' })],
      fuzzy: [],
      hybrid: [],
    }).hits;
    const wire = tieredHitToWire(h!);
    expect(wire).toMatchObject({
      sourceKind: 'claude',
      sessionId: 'ff',
      turnIdx: 3,
      tier: 'exact',
      matchedBy: 'unknown',
      focusTerm: 'furnishedfinder',
    });
    // No hybrid leg returned it ⇒ no scores, no alsoMatchedBy, no fuzzy block (older clients see no new noise).
    for (const k of ['alsoMatchedBy', 'lexicalScore', 'semanticScore', 'fuzzy']) expect(k in wire).toBe(false);
  });

  it('a fuzzy turn carries the fuzzy block and the vocabulary word as focusTerm', () => {
    const [h] = composeSessionTurnTiers({
      exact: [],
      fuzzy: [lit('fuzzy', 'p', 0, { focusTerm: 'furnishedfinder' })],
      hybrid: [],
    }).hits;
    const wire = tieredHitToWire(h!);
    expect(wire.tier).toBe('fuzzy');
    expect(wire.fuzzy).toEqual({ token: 'furnisedfinder', word: 'furnishedfinder', similarity: 0.62 });
    expect(wire.focusTerm).toBe('furnishedfinder');
  });

  it('a turn found by exact AND hybrid keeps the hybrid scores and lists the lower tier in alsoMatchedBy', () => {
    const [h] = composeSessionTurnTiers({
      exact: [lit('exact', 's', 1, { focusTerm: 'plan' })],
      fuzzy: [],
      hybrid: [hyb('s', 1, BOTH, 0.5)],
    }).hits;
    const wire = tieredHitToWire(h!);
    expect(wire.tier).toBe('exact');
    expect(wire.matchedBy).toBe('both');
    expect(wire.lexicalScore).toBe(0.07);
    expect(wire.semanticScore).toBe(0.61);
    expect(wire.alsoMatchedBy?.length).toBeGreaterThan(0);
    expect(wire.alsoMatchedBy).not.toContain('exact');
  });

  it('a hybrid-only turn has tier hybrid and no focusTerm (the client then anchors on the typed query)', () => {
    const [h] = composeSessionTurnTiers({ exact: [], fuzzy: [], hybrid: [hyb('c', 0, LEX)] }).hits;
    const wire = tieredHitToWire(h!);
    expect(wire.tier).not.toBe('exact');
    expect(wire.tier).not.toBe('fuzzy');
    expect('focusTerm' in wire).toBe(false);
    expect(wire.matchedBy).toBe('lexical');
  });
});
