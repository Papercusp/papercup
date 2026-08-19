/**
 * peers-know unit tests — the pure one-liner extraction behind the orient
 * peers-know fold (consult-revival-and-honest-min-2026-08-18 P-006). The
 * SQL/pgvector half is covered in get-feedback-core.integration.test.ts
 * (peersKnowLookup describe) against the real migration tables.
 */
import { describe, expect, it } from 'vitest';
import { extractSettledAnswer, PEERS_KNOW_ANSWER_CAP } from './peers-know';

describe('extractSettledAnswer — precision-biased one-liner extraction', () => {
  it('extracts and whitespace-collapses the settled answer', () => {
    expect(extractSettledAnswer({ answer: '  use\n  sql.json()\tnot stringify  ' })).toBe(
      'use sql.json() not stringify',
    );
  });

  it('caps a long answer with an ellipsis at the cap boundary', () => {
    const long = 'x'.repeat(PEERS_KNOW_ANSWER_CAP * 2);
    const out = extractSettledAnswer({ answer: long });
    expect(out).toHaveLength(PEERS_KNOW_ANSWER_CAP);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('returns null on every shape surprise — no answer key, non-string answer, blank, non-object, null', () => {
    expect(extractSettledAnswer({ reason: 'graduated elsewhere' })).toBeNull();
    expect(extractSettledAnswer({ answer: 42 })).toBeNull();
    expect(extractSettledAnswer({ answer: '   \n\t ' })).toBeNull();
    expect(extractSettledAnswer('a bare string')).toBeNull();
    expect(extractSettledAnswer(null)).toBeNull();
    expect(extractSettledAnswer(undefined)).toBeNull();
  });
});
