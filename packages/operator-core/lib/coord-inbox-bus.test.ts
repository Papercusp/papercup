/**
 * coord-inbox-bus — the human-relevance predicate that decides whether a
 * coord_event_log insert should wake the human-facing inbox push (P-002), plus
 * (EI-9991) the failed-LISTEN retry-with-backoff behavior.
 *
 * Regression guard: the originally-shipped producer filtered the NOTIFY
 * payload's `writer_key === 'human'`, but a direct `coord:send {to:['human']}`
 * stores `writer_key = sender` (the human-recipiency lives in `body.to`), so it
 * woke on ZERO real human messages. Relevance MUST key off `to`, never
 * `writer_key`. These cases pin that.
 */
import { describe, it, expect } from 'vitest';
import { isHumanRelevantRow } from './coord-inbox-bus';

describe('isHumanRelevantRow', () => {
  it('messages addressed to human are relevant', () => {
    expect(isHumanRelevantRow('messages', ['human'])).toBe(true);
    expect(isHumanRelevantRow('messages', ['su-x', 'human', '*'])).toBe(true);
  });

  it('messages NOT addressed to human are not relevant (writer_key bug regression)', () => {
    expect(isHumanRelevantRow('messages', ['su-a', 'su-b'])).toBe(false);
    expect(isHumanRelevantRow('messages', ['*'])).toBe(false); // pure broadcast — matches the reader (to.includes('human') only)
    expect(isHumanRelevantRow('messages', [])).toBe(false);
    expect(isHumanRelevantRow('messages', ['su-subscriber'])).toBe(false); // fan-out notify to a subscriber id
  });

  it('handoffs addressed to human are relevant; to a peer are not', () => {
    expect(isHumanRelevantRow('handoffs', ['human'])).toBe(true);
    expect(isHumanRelevantRow('handoffs', ['su-x'])).toBe(false);
  });

  it('any escalation row is relevant (open shown / resolution drops it on refetch)', () => {
    expect(isHumanRelevantRow('escalations', null)).toBe(true);
    expect(isHumanRelevantRow('escalations', ['human'])).toBe(true);
  });

  it('plan-events and unknown surfaces are never relevant', () => {
    expect(isHumanRelevantRow('plan-events', ['human'])).toBe(false);
    expect(isHumanRelevantRow('something-else', ['human'])).toBe(false);
  });

  it('tolerates a malformed / non-array `to`', () => {
    expect(isHumanRelevantRow('messages', undefined)).toBe(false);
    expect(isHumanRelevantRow('messages', 'human')).toBe(false);
    expect(isHumanRelevantRow('messages', { human: true })).toBe(false);
  });
});
