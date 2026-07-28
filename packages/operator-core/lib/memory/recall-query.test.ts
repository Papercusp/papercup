import { describe, it, expect } from 'vitest';

import {
  retrievalQueryText,
  toRecallQuery,
  type AgentSignals,
  type RecallQuery,
} from './recall-query';

/**
 * context-injection-audit-2026-07-28 P-042 (F-J) — the structured recall query.
 *
 * These tests pin the SEAM's contract, which is deliberately narrow: both input
 * forms normalize to the same structure, and carrying agent signals does not yet
 * change what is issued to the index. The second half is the whole point of the
 * item — it is what lets P-042 land while P-041's live baseline is still being
 * gathered, without contaminating the measurement it will be judged against.
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
   * ⚠ THIS IS A TRIPWIRE, NOT AN OBSTACLE.
   *
   * P-042 carries agent signals through the seam but must NOT let them reach
   * retrieval: P-041's live baseline is being gathered right now, and P-043/P-044
   * are the items that change what is retrieved. If this test fails, either you
   * are implementing P-044 — in which case update it deliberately, and note in
   * the same change that the before-measurement is closed — or a call site is
   * leaking signals into the query early, which silently invalidates the
   * baseline.
   */
  it('IGNORES agent signals — P-042 is the seam only; P-044 is what routes them', () => {
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
    // Byte-identical to the same query with no signals at all — the "no behavior
    // change" guarantee stated on the item, asserted rather than asserted-in-prose.
    expect(retrievalQueryText(withSignals)).toBe(
      retrievalQueryText({ userText: 'deploy pipeline' }),
    );
  });

  it('is the single decision point — a string and its structured equal agree', () => {
    for (const text of ['', '   ', 'continue', 'why is the recall empty']) {
      expect(retrievalQueryText(toRecallQuery(text))).toBe(
        retrievalQueryText(toRecallQuery({ userText: text })),
      );
    }
  });
});
