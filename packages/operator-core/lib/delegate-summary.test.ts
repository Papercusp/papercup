/**
 * Coverage for delegate-summary: the haiku-backed delegated-task title generator
 * (collapse-delegate-into-workitems-2026-06-04). runHaiku + the issues-engineer
 * updateIssue writer are mocked; the logic under test is the title fallback
 * (empty / over-length haiku → first-8-words of the initiator) and that the title
 * is written SILENTLY onto the task work_item (no subscribe→inject fan-out).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runHaiku = vi.fn();
vi.mock('./haiku', () => ({ runHaiku: (...a: unknown[]) => runHaiku(...a) }));
const updateIssue = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('./issues-engineer', () => ({
  updateIssue: (...a: unknown[]) => updateIssue(...a),
}));

import { generateTaskTitle } from './delegate-summary';

const base = { workItemId: 'WI-1' };
beforeEach(() => {
  updateIssue.mockResolvedValue({});
});
afterEach(() => vi.clearAllMocks());

describe('generateTaskTitle', () => {
  it('stores a good (<=80 char) haiku title silently', async () => {
    runHaiku.mockResolvedValue('Wire The Substrate DoS Guard');
    await generateTaskTitle({ ...base, initiatorMsg: 'harden hyperswarm' });
    expect(updateIssue).toHaveBeenCalledWith('WI-1', { title: 'Wire The Substrate DoS Guard', silent: true });
  });

  it('falls back to the first 8 initiator words when haiku returns empty', async () => {
    runHaiku.mockResolvedValue('');
    await generateTaskTitle({
      ...base,
      initiatorMsg: 'one two three four five six seven eight nine ten',
    });
    expect(updateIssue).toHaveBeenCalledWith('WI-1', { title: 'one two three four five six seven eight', silent: true });
  });

  it('falls back when the haiku title is over the 80-char cap', async () => {
    runHaiku.mockResolvedValue('x'.repeat(81));
    await generateTaskTitle({ ...base, initiatorMsg: 'short msg' });
    expect(updateIssue).toHaveBeenCalledWith('WI-1', { title: 'short msg', silent: true });
  });

  it('tolerates a haiku failure and still writes the fallback title', async () => {
    runHaiku.mockRejectedValue(new Error('haiku down'));
    await generateTaskTitle({ ...base, initiatorMsg: 'fallback please' });
    expect(updateIssue).toHaveBeenCalledWith('WI-1', { title: 'fallback please', silent: true });
  });
});
