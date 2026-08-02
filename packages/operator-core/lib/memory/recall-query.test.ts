import { describe, it, expect } from 'vitest';

import {
  agentSignalTerms,
  lexicalQueryText,
  retrievalQueryText,
  toRecallQuery,
  LEXICAL_MAX_IDS,
  LEXICAL_MAX_PATHS,
  LEXICAL_MAX_SYMBOLS,
  type AgentSignals,
  type RecallQuery,
} from './recall-query';

/**
 * context-injection-audit-2026-07-28 P-042 (F-J) — the structured recall query —
 * and P-044 (F-L), which split what is ISSUED into one query per fusion leg.
 *
 * These tests pin the seam's contract (both input forms normalize to one
 * structure) and then the per-leg split: the COSINE query stays the human's
 * words alone, and the agent's identifiers reach the LEXICAL query only.
 */
describe('toRecallQuery — the accepted forms normalize to one structure', () => {
  it('treats a bare string as the user text', () => {
    expect(toRecallQuery('why is the recall empty')).toEqual({
      userText: 'why is the recall empty',
    });
  });

  it('passes the structured form through, signals intact', () => {
    const signals: AgentSignals = {
      workItem: { id: 'WI-6635', title: 'Instrument the QUERY' },
      trajectory: { paths: ['packages/operator-core/lib/memory/injection.ts'] },
      activeFile: 'packages/operator-core/lib/memory/recall-query.ts',
    };
    const query: RecallQuery = { userText: 'hello', agentSignals: signals };
    expect(toRecallQuery(query)).toEqual(query);
    expect(toRecallQuery(query).agentSignals).toBe(signals);
  });

  it('preserves the empty string rather than coercing it — the caller gates on it', () => {
    // buildMemoryContextBlock returns null on an empty query; that decision
    // belongs to the caller, so normalization must not paper over it here.
    expect(toRecallQuery('')).toEqual({ userText: '' });
  });
});

describe('retrievalQueryText — what actually reaches the index', () => {
  it('returns the user text', () => {
    expect(retrievalQueryText({ userText: 'deploy pipeline' })).toBe('deploy pipeline');
  });

  /**
   * ⚠ STILL A TRIPWIRE — but it now guards a PERMANENT property, not a hold.
   *
   * Under P-042 this pinned "signals must not reach retrieval yet", so the
   * P-041 baseline could be gathered uncontaminated. P-044 has landed and that
   * hold is DISCHARGED — signals now reach retrieval, via `lexicalQueryText`
   * below. What this test asserts from here on is the opposite of a delay: the
   * COSINE leg's query is the human's words and nothing else, deliberately,
   * because the cosine leg embeds it as one vector and D-041 measured
   * identifiers pulling that vector off-topic. If this fails, someone is folding
   * signals into the cosine query — do not "fix" it by accepting the new value.
   */
  it('IGNORES agent signals — the cosine leg embeds user text alone (P-044)', () => {
    const withSignals: RecallQuery = {
      userText: 'deploy pipeline',
      agentSignals: {
        workItem: { id: 'WI-6635', title: 'Instrument the QUERY', body: 'record query shape' },
        trajectory: {
          paths: ['packages/operator-core/lib/memory/recall-stats.ts'],
          ids: ['EI-18881202063786528'],
          symbols: ['describeRecallQuery'],
        },
        activeFile: 'packages/operator-core/lib/memory/injection.ts',
      },
    };
    expect(retrievalQueryText(withSignals)).toBe('deploy pipeline');
    // Byte-identical to the same query with no signals at all.
    expect(retrievalQueryText(withSignals)).toBe(
      retrievalQueryText({ userText: 'deploy pipeline' }),
    );
    // ...and the signals are not merely dropped — they went to the OTHER leg.
    expect(lexicalQueryText(withSignals)).not.toBe(retrievalQueryText(withSignals));
  });

  it('is the single decision point — a string and its structured equal agree', () => {
    for (const text of ['', '   ', 'continue', 'why is the recall empty']) {
      expect(retrievalQueryText(toRecallQuery(text))).toBe(
        retrievalQueryText(toRecallQuery({ userText: text })),
      );
    }
  });
});

describe('lexicalQueryText — the LEXICAL leg’s query (P-044 / F-L)', () => {
  it('is undefined with no signals, so both legs share one query as before', () => {
    expect(lexicalQueryText({ userText: 'deploy pipeline' })).toBeUndefined();
    expect(lexicalQueryText(toRecallQuery('deploy pipeline'))).toBeUndefined();
    // An empty signals object is "resolved nothing", not "resolved empties".
    expect(lexicalQueryText({ userText: 'x', agentSignals: {} })).toBeUndefined();
  });

  /**
   * P-046's property, asserted at the one place it is decided. Every existing
   * test in this system asserts on what retrieval RETURNS; this asserts on what
   * it ASKS, which is precisely the gap that let the defect survive.
   */
  it('is NOT byte-identical to the human utterance when signals are available', () => {
    const q: RecallQuery = {
      userText: 'continue where you left off',
      agentSignals: { workItem: { id: 'WI-6512' } },
    };
    expect(lexicalQueryText(q)).not.toBe(q.userText);
    expect(lexicalQueryText(q)).toContain('WI-6512');
  });

  it('KEEPS the user text — a human who types a literal id is this leg’s case', () => {
    const q: RecallQuery = {
      userText: 'why does WI-6512 still repro',
      agentSignals: { trajectory: { ids: ['EI-18881202063786528'] } },
    };
    expect(lexicalQueryText(q)).toBe('why does WI-6512 still repro EI-18881202063786528');
  });

  it('carries a path by its STEM, not the whole path', () => {
    // A full repo path is ~6-8 lexical tokens on its own, and the lexical score
    // is normalized by token count — see the caps' doc-comment.
    const q: RecallQuery = {
      userText: 'recall is empty',
      agentSignals: {
        activeFile: 'packages/operator-core/lib/memory/injection.ts',
        trajectory: { paths: ['libs/generic/memory/src/hybrid-backend.ts'] },
      },
    };
    expect(lexicalQueryText(q)).toBe('recall is empty injection hybrid-backend');
  });

  it('a pre-composed lexicalText wins over signals — the mid-turn caller’s path', () => {
    const q: RecallQuery = {
      userText: 'dropdown selection broken',
      lexicalText: 'dropdown selection broken apps/operator-vite/src',
      agentSignals: { workItem: { id: 'WI-6512' } },
    };
    expect(lexicalQueryText(q)).toBe('dropdown selection broken apps/operator-vite/src');
  });

  it('composes signals alone when the turn has no human text at all', () => {
    // The machine-injected turn Phase 11 exists for. Note the COSINE query is
    // still empty here, so injection.ts's own gate still declines the turn —
    // this asserts the composition, not that such a turn now retrieves.
    expect(
      lexicalQueryText({ userText: '  ', agentSignals: { workItem: { id: 'P-044' } } }),
    ).toBe('P-044');
  });
});

describe('agentSignalTerms — what the identifier budget actually admits', () => {
  const many = (n: number, f: (i: number) => string): string[] =>
    Array.from({ length: n }, (_, i) => f(i));

  it('caps each class far below the resolver’s own caps, keeping the head', () => {
    const terms = agentSignalTerms({
      trajectory: {
        ids: many(8, (i) => `WI-${1000 + i}`),
        paths: many(12, (i) => `packages/a/b/file${i}.ts`),
        symbols: many(8, (i) => `symbol${i}`),
      },
    });
    expect(terms.filter((t) => t.startsWith('WI-'))).toEqual(
      many(LEXICAL_MAX_IDS, (i) => `WI-${1000 + i}`),
    );
    expect(terms.filter((t) => t.startsWith('file'))).toEqual(
      many(LEXICAL_MAX_PATHS, (i) => `file${i}`),
    );
    expect(terms.filter((t) => t.startsWith('symbol'))).toEqual(
      many(LEXICAL_MAX_SYMBOLS, (i) => `symbol${i}`),
    );
  });

  it('orders ids first — they survive the tokenizer’s cap when prose is long', () => {
    const terms = agentSignalTerms({
      workItem: { id: 'WI-6512' },
      trajectory: { symbols: ['deriveBatchQuery'], paths: ['a/b/injection.ts'] },
    });
    expect(terms).toEqual(['WI-6512', 'injection', 'deriveBatchQuery']);
  });

  it('EXCLUDES the work-item title and body — authored prose, not identifiers', () => {
    // The body is capped at 1,200 chars upstream; folding it in would swamp both
    // the 32-token cap and every real hit's normalized score. P-047 owns the
    // question of whether agent-adjacent prose belongs in retrieval at all.
    const terms = agentSignalTerms({
      workItem: {
        id: 'WI-6512',
        title: 'Session history loads slowly in the dropdown',
        body: 'A long authored narrative about the defect.',
      },
    });
    expect(terms).toEqual(['WI-6512']);
  });

  it('dedupes across sources — activeFile and a trajectory path agree', () => {
    const terms = agentSignalTerms({
      activeFile: 'packages/operator-core/lib/memory/injection.ts',
      trajectory: { paths: ['packages/operator-core/lib/memory/injection.ts'] },
    });
    expect(terms).toEqual(['injection']);
  });

  it('returns nothing for undefined signals', () => {
    expect(agentSignalTerms(undefined)).toEqual([]);
  });
});
