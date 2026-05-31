/**
 * Coverage for delegate-summary: the haiku-backed session title + summary
 * generators. runHaiku + the delegates store are mocked; the logic under test is
 * the title fallback (empty / over-length → first-8-words of the initiator) and
 * the summary guards (skip empty transcript, length cap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runHaiku = vi.fn();
vi.mock('./haiku', () => ({ runHaiku: (...a: unknown[]) => runHaiku(...a) }));
const setDelegateTitle = vi.fn(async (..._a: unknown[]) => {});
const setDelegateSummary = vi.fn(async (..._a: unknown[]) => {});
vi.mock('./delegates', () => ({
  setDelegateTitle: (...a: unknown[]) => setDelegateTitle(...a),
  setDelegateSummary: (...a: unknown[]) => setDelegateSummary(...a),
}));

import { generateSessionTitle, generateSessionSummary } from './delegate-summary';

const base = { workspace: 'w', agentSessionId: 's' };
beforeEach(() => {
  setDelegateTitle.mockResolvedValue(undefined);
  setDelegateSummary.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('generateSessionTitle', () => {
  it('stores a good (<=80 char) haiku title', async () => {
    runHaiku.mockResolvedValue('Wire The Substrate DoS Guard');
    await generateSessionTitle({ ...base, initiatorMsg: 'harden hyperswarm' });
    expect(setDelegateTitle).toHaveBeenCalledWith('w', 's', 'Wire The Substrate DoS Guard');
  });

  it('falls back to the first 8 initiator words when haiku returns empty', async () => {
    runHaiku.mockResolvedValue('');
    await generateSessionTitle({
      ...base,
      initiatorMsg: 'one two three four five six seven eight nine ten',
    });
    expect(setDelegateTitle).toHaveBeenCalledWith('w', 's', 'one two three four five six seven eight');
  });

  it('falls back when the haiku title is over the 80-char cap', async () => {
    runHaiku.mockResolvedValue('x'.repeat(81));
    await generateSessionTitle({ ...base, initiatorMsg: 'short msg' });
    expect(setDelegateTitle).toHaveBeenCalledWith('w', 's', 'short msg');
  });
});

describe('generateSessionSummary', () => {
  it('skips an empty transcript (no haiku, no write)', async () => {
    await generateSessionSummary({ ...base, transcript: [] });
    expect(runHaiku).not.toHaveBeenCalled();
    expect(setDelegateSummary).not.toHaveBeenCalled();
  });

  it('stores a summary from a non-empty transcript', async () => {
    runHaiku.mockResolvedValue('They wired the guard; live verification pending.');
    await generateSessionSummary({
      ...base,
      transcript: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }],
    });
    expect(runHaiku).toHaveBeenCalledOnce();
    expect(setDelegateSummary).toHaveBeenCalledWith('w', 's', 'They wired the guard; live verification pending.');
  });

  it('does not store an over-length (>600) summary', async () => {
    runHaiku.mockResolvedValue('y'.repeat(601));
    await generateSessionSummary({ ...base, transcript: [{ role: 'user', text: 'hi' }] });
    expect(setDelegateSummary).not.toHaveBeenCalled();
  });
});
