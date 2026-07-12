/**
 * userMemory.feedbackStats named query (all-active-surfaces-data-sync-
 * migration-2026-07-11 P-013) — the Settings → Memory page's "Lifetime
 * feedback: N edits, M deletes" tile moved off the one-shot
 * GET /api/user/memory/feedback fetch onto this live sync query. The
 * feedback COUNT is a live, multi-writer table read (the page's own
 * edits/deletes AND agent-tool memory:update/memory:forget writes); the
 * backend/filesystem envelope (GET /user/memory/backend) and the
 * learning-instruction text (still served by GET /user/memory/feedback)
 * deliberately stay REST — see memory-feedback.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadFeedbackStats: vi.fn() }));

vi.mock('../memory/feedback', () => ({ loadFeedbackStats: mocks.loadFeedbackStats }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

describe('userMemory.feedbackStats named query (P-013)', () => {
  it('is registered', () => {
    expect(knownQueryNamesV2()).toContain('userMemory.feedbackStats');
  });

  it('resolves a single row of the loaded stats, scoped by userId', async () => {
    mocks.loadFeedbackStats.mockResolvedValue({ total_edits: 5, total_deletes: 2, recent: [] });
    await expect(resolveNamedQueryV2('userMemory.feedbackStats', { userId: 'u1' })).resolves.toEqual([
      { total_edits: 5, total_deletes: 2, recent: [] },
    ]);
    expect(mocks.loadFeedbackStats).toHaveBeenCalledWith('u1');
  });

  it('degrades to a zeroed row (never null/undefined) when the store is unavailable', async () => {
    mocks.loadFeedbackStats.mockResolvedValue(null);
    await expect(resolveNamedQueryV2('userMemory.feedbackStats', { userId: 'u1' })).resolves.toEqual([
      { total_edits: 0, total_deletes: 0, recent: [] },
    ]);
  });

  it('rejects a missing userId (argsSchema requires a non-empty string)', async () => {
    await expect(resolveNamedQueryV2('userMemory.feedbackStats', {})).rejects.toBeTruthy();
  });
});
