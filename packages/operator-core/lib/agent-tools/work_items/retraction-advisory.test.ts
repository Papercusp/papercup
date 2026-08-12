/**
 * Claim-time retraction advisory coverage (EI-20027532687512023).
 *
 * The advisory is intentionally a bounded, fail-open read: it must surface a
 * real retraction on an open item without turning thread-store trouble into a
 * claim failure, and it must stay silent for terminal items.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ getWorkItemThreadWindow: vi.fn() }));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItemThreadWindow: io.getWorkItemThreadWindow,
}));

import { getWorkItemThreadWindow } from '../../work-items';
import {
  getClaimTimeRetractionAdvisory,
  RETRACTION_STATE_HINT,
} from './retraction-advisory';

const threadM = vi.mocked(getWorkItemThreadWindow);

const thread = (posts: Array<{ body: string }>) =>
  ({
    posts,
    total: posts.length,
    topics: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe('claim-time retraction advisory (EI-20027532687512023)', () => {
  it('reads the bounded recent thread and surfaces the measured retraction shape', async () => {
    threadM.mockResolvedValue(
      thread([
        { body: "## ⚠⚠ RETRACTION BY THE FILER — this item's central premise is WRONG. Do not act on it as written." },
      ]),
    );

    const advisory = await getClaimTimeRetractionAdvisory(
      { id: 'EI-1', state: 'open', harness: 'papercusp' },
      'papercusp',
    );

    expect(threadM).toHaveBeenCalledWith('EI-1', 10, 'papercusp');
    expect(advisory).toEqual({ retractionWarning: RETRACTION_STATE_HINT });
  });

  it('does not read a terminal item, even when its old thread contains a retraction', async () => {
    const advisory = await getClaimTimeRetractionAdvisory({ id: 'EI-2', state: 'dropped', harness: 'papercusp' });

    expect(advisory).toBeNull();
    expect(threadM).not.toHaveBeenCalled();
  });

  it('stays silent for ordinary thread chatter', async () => {
    threadM.mockResolvedValue(thread([{ body: 'Correction: the timeout is 480s, not 240s. Rest stands.' }]));

    await expect(getClaimTimeRetractionAdvisory({ id: 'EI-3', state: 'open' }, 'papercusp')).resolves.toBeNull();
  });

  it('fails open when the thread read is unavailable', async () => {
    threadM.mockRejectedValue(new Error('thread store unavailable'));

    await expect(getClaimTimeRetractionAdvisory({ id: 'EI-4', state: 'open' }, 'papercusp')).resolves.toBeNull();
  });
});
