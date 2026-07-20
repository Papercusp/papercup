/**
 * knowledge-pack-settings-2026-07-19 P-003 — the adoption-policy gate on the
 * WI-5414 auto-adopt sweep, and the stored pending-cap override (P-002).
 * Injected deps only; no PG/LLM.
 */
import { describe, expect, it, vi } from 'vitest';
import { autoAdoptPendingCandidates, pendingCandidateCap, MAX_PENDING_CANDIDATES } from './candidates';

describe('autoAdoptPendingCandidates adoption policy (P-003)', () => {
  it("policy 'owner-approval' skips the WHOLE sweep — no list, no judge, no decide", async () => {
    const list = vi.fn();
    const decide = vi.fn();
    const review = vi.fn();
    const r = await autoAdoptPendingCandidates(
      { adoptionPolicy: 'owner-approval' },
      { list, decide, review },
    );
    expect(r).toEqual({ reviewed: 0, adopted: 0, dismissed: 0, failed: 0, skippedPolicy: true });
    expect(list).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("explicit policy 'auto' runs the sweep (list consulted)", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const r = await autoAdoptPendingCandidates(
      { adoptionPolicy: 'auto' },
      { list, decide: vi.fn(), review: vi.fn() },
    );
    expect(list).toHaveBeenCalledOnce();
    expect(r.skippedPolicy).toBeUndefined();
  });
});

describe('pendingCandidateCap stored override (P-002)', () => {
  it('stored value wins over env/default', () => {
    expect(pendingCandidateCap(55)).toBe(55);
    expect(pendingCandidateCap(7.9)).toBe(7);
  });

  it('absent/invalid stored value keeps the env→default behavior', () => {
    expect(pendingCandidateCap(undefined)).toBe(MAX_PENDING_CANDIDATES);
    expect(pendingCandidateCap(0)).toBe(MAX_PENDING_CANDIDATES);
    expect(pendingCandidateCap(Number.NaN)).toBe(MAX_PENDING_CANDIDATES);
  });
});
