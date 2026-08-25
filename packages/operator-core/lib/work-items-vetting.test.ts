import { describe, expect, it, vi } from 'vitest';

import { readVettingWorkItemCritique } from './work-items';

describe('readVettingWorkItemCritique (WI-41477)', () => {
  it('distinguishes a missing work-item from an existing item with no comments', async () => {
    const getWorkItemDetail = vi.fn().mockResolvedValue(null);

    await expect(
      readVettingWorkItemCritique('WI-missing', ['su-emitter'], 'papercusp', {
        getWorkItemDetail: getWorkItemDetail as never,
      }),
    ).resolves.toEqual({ exists: false, critiquePosts: 0, critics: [] });
    expect(getWorkItemDetail).toHaveBeenCalledWith('WI-missing', 'papercusp');

    getWorkItemDetail.mockResolvedValue({ posts: [] });
    await expect(
      readVettingWorkItemCritique('WI-silent', ['su-emitter'], 'papercusp', {
        getWorkItemDetail: getWorkItemDetail as never,
      }),
    ).resolves.toEqual({ exists: true, critiquePosts: 0, critics: [] });
  });

  it('counts only third-party authored comments and returns distinct critics in stable order', async () => {
    const getWorkItemDetail = vi.fn().mockResolvedValue({
      posts: [
        { author_id: null },
        { author_id: '' },
        { author_id: 'su-emitter' },
        { author_id: 'su-rubric-author' },
        { author_id: 'su-reviewer-b' },
        { author_id: 'su-reviewer-a' },
        { author_id: 'su-reviewer-b' },
      ],
    });

    await expect(
      readVettingWorkItemCritique(
        'WI-review',
        ['su-emitter', 'su-rubric-author', null, undefined],
        'papercusp',
        { getWorkItemDetail: getWorkItemDetail as never },
      ),
    ).resolves.toEqual({
      exists: true,
      critiquePosts: 3,
      critics: ['su-reviewer-a', 'su-reviewer-b'],
    });
  });
});
