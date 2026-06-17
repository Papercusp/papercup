/**
 * maybeFireNudge — the side-effecting nudge gate (Gap 8).
 *
 * Covers the load → decide → conditional-save flow that wraps the pure
 * `shouldFireNudge` (already tested in voice-nudges.test.ts). We mock
 * `./voice-prefs` so loadVoicePrefs returns a controllable nudgeDedup and
 * saveVoicePrefs is observable. A deterministic `now` is threaded so the
 * window comparison is fixed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const NOW = Date.parse('2026-06-16T12:00:00.000Z');

const h = vi.hoisted(() => {
  const state: { prefs: ReturnType<typeof makeFresh> } = { prefs: makeFresh() };
  function makeFresh() {
    return {
      nudgeDedup: {
        budget: { lastSpokenAt: null as string | null },
        breaker: { lastSpokenAt: null as string | null },
        pause: { lastSpokenAt: null as string | null },
      },
    };
  }
  return {
    state,
    makeFresh,
    loadVoicePrefs: vi.fn(async () => state.prefs),
    saveVoicePrefs: vi.fn(async (patch: unknown) => patch),
  };
});
vi.mock('./voice-prefs', () => ({
  loadVoicePrefs: h.loadVoicePrefs,
  saveVoicePrefs: h.saveVoicePrefs,
}));

import { maybeFireNudge, NUDGE_DEDUP_MS } from './voice-nudges';

const loadVoicePrefs = h.loadVoicePrefs;
const saveVoicePrefs = h.saveVoicePrefs;

beforeEach(() => {
  h.state.prefs = h.makeFresh();
  loadVoicePrefs.mockClear();
  saveVoicePrefs.mockClear();
});

describe('maybeFireNudge', () => {
  it('fires and persists a new lastSpokenAt for the correct kind (others untouched)', async () => {
    const fired = await maybeFireNudge('budget', NOW);
    expect(fired).toBe(true);
    expect(saveVoicePrefs).toHaveBeenCalledTimes(1);
    const patch = saveVoicePrefs.mock.calls[0][0] as {
      nudgeDedup: Record<string, { lastSpokenAt: string | null }>;
    };
    expect(patch.nudgeDedup.budget.lastSpokenAt).toBe(new Date(NOW).toISOString());
    // Other kinds are carried through unchanged (still null).
    expect(patch.nudgeDedup.breaker.lastSpokenAt).toBeNull();
    expect(patch.nudgeDedup.pause.lastSpokenAt).toBeNull();
  });

  it('within the dedup window → returns false and does NOT call saveVoicePrefs', async () => {
    // budget window is 30 min; last spoken 10 min ago → still deduped.
    h.state.prefs.nudgeDedup.budget.lastSpokenAt = new Date(
      NOW - 10 * 60_000,
    ).toISOString();
    const fired = await maybeFireNudge('budget', NOW);
    expect(fired).toBe(false);
    expect(saveVoicePrefs).not.toHaveBeenCalled();
  });

  it('fires again once the window has elapsed', async () => {
    h.state.prefs.nudgeDedup.budget.lastSpokenAt = new Date(
      NOW - (NUDGE_DEDUP_MS.budget + 1000),
    ).toISOString();
    const fired = await maybeFireNudge('budget', NOW);
    expect(fired).toBe(true);
    expect(saveVoicePrefs).toHaveBeenCalledTimes(1);
  });

  it('persists under the right kind key when a non-budget kind fires', async () => {
    const fired = await maybeFireNudge('pause', NOW);
    expect(fired).toBe(true);
    const patch = saveVoicePrefs.mock.calls[0][0] as {
      nudgeDedup: Record<string, { lastSpokenAt: string | null }>;
    };
    expect(patch.nudgeDedup.pause.lastSpokenAt).toBe(new Date(NOW).toISOString());
    expect(patch.nudgeDedup.budget.lastSpokenAt).toBeNull();
  });

  it('passes the deterministic `now` through to the decision (boundary)', async () => {
    // breaker window is 10 min. Exactly 9m59s ago → deduped at this `now`.
    h.state.prefs.nudgeDedup.breaker.lastSpokenAt = new Date(
      NOW - (NUDGE_DEDUP_MS.breaker - 1000),
    ).toISOString();
    expect(await maybeFireNudge('breaker', NOW)).toBe(false);
    // Advance `now` past the window → fires.
    expect(await maybeFireNudge('breaker', NOW + 2000 + NUDGE_DEDUP_MS.breaker)).toBe(true);
  });
});
