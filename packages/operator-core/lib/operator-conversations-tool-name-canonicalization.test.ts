/**
 * WI-4949 regression guard. `operator_turns.tools[].name` was sometimes
 * persisted in the Claude-sanitized form (`chat_ask_choice`) instead of the
 * canonical `chat:ask_choice` the card registry / turn-answer gate key on —
 * an already-dead historical row's card silently never rendered, and even a
 * correctly-rendered card would 400 on click if the click-handler compared
 * against the raw unnormalized name.
 *
 * Pins `normalizeTurnTools` (the READ-boundary fix in `rowToTurn` — chosen
 * over a mass-UPDATE backfill so already-persisted historical rows are fixed
 * on next read with no migration risk) at the unit level; the real end-to-end
 * DB round trip is covered by operator-conversations-workspace-scope /
 * append-concurrency integration tests exercising the same `rowToTurn` path.
 */
import { describe, it, expect } from 'vitest';
import { normalizeTurnTools } from './operator-conversations';

describe('normalizeTurnTools (WI-4949)', () => {
  it('restores the canonical colon name from the Claude-sanitized form', () => {
    const out = normalizeTurnTools([{ name: 'chat_ask_choice', input: { question: 'q' } }]);
    expect(out).toEqual([{ name: 'chat:ask_choice', input: { question: 'q' } }]);
  });

  it('is idempotent — an already-canonical name is unchanged', () => {
    const out = normalizeTurnTools([{ name: 'chat:ask_choice', input: { question: 'q' } }]);
    expect(out).toEqual([{ name: 'chat:ask_choice', input: { question: 'q' } }]);
  });

  it('preserves every other field on the tool call, including `answered`', () => {
    const answered = { picks: [{ option_id: 'a', label: 'A' }], at: 123 };
    const out = normalizeTurnTools([{ name: 'chat_ask_choice', input: { x: 1 }, answered }]);
    expect(out).toEqual([{ name: 'chat:ask_choice', input: { x: 1 }, answered }]);
  });

  it('does NOT over-replace underscores that are part of a legitimately-underscored tool name', () => {
    const out = normalizeTurnTools([{ name: 'decision_ledger_list' }]);
    expect(out).toEqual([{ name: 'decision_ledger:list' }]);
  });

  it('handles multiple tool calls in one turn independently', () => {
    const out = normalizeTurnTools([{ name: 'chat_ask_choice' }, { name: 'decision_ledger_list' }]);
    expect(out).toEqual([{ name: 'chat:ask_choice' }, { name: 'decision_ledger:list' }]);
  });

  it('passes through a non-array (null / undefined / object) as null', () => {
    expect(normalizeTurnTools(null)).toBeNull();
    expect(normalizeTurnTools(undefined)).toBeNull();
    expect(normalizeTurnTools({ not: 'an array' })).toBeNull();
  });

  it('leaves a malformed entry (no string name) untouched rather than throwing', () => {
    const malformed = { input: {} };
    expect(normalizeTurnTools([malformed])).toEqual([malformed]);
  });

  it('passes an empty array through unchanged', () => {
    expect(normalizeTurnTools([])).toEqual([]);
  });
});
