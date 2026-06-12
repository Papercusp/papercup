/**
 * refit.test.ts — the deferral-interest refit tick (P-042 / FB-14), hermetic
 * via injected deps (no PG, no flags — the gates live in the routine action).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { DeferralPricingModel } from './model';
import { runDeferralInterestRefit, type DeferralRefitDeps } from './refit';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-05-01T00:00:00Z');
const NOW = T0 + 28 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

function cand(id: string, over: Partial<ImprovementCandidate> = {}): ImprovementCandidate {
  return {
    id,
    kind: 'change',
    scope: 'operator',
    title: `unrelated subject ${id} flux capacitor ${id}`,
    createdAt: iso(T0),
    state: 'open',
    ...over,
  };
}

function deps(candidates: ImprovementCandidate[]): DeferralRefitDeps & { saved: DeferralPricingModel[] } {
  const saved: DeferralPricingModel[] = [];
  return {
    saved,
    readCandidates: vi.fn(async () => candidates),
    readEdges: vi.fn(async () => [
      { issueId: candidates[0]?.id ?? 'none', direction: 'out' as const, rel: 'blocks', atMs: T0 + DAY },
    ]),
    saveModel: vi.fn(async (m: DeferralPricingModel) => {
      saved.push(m);
    }),
    log: () => {},
  };
}

describe('runDeferralInterestRefit', () => {
  it('backfills, fits, and appends one model version', async () => {
    const d = deps([
      cand('EI-1'), // open human-lane deferral, 1 in-window blocks edge
      cand('EI-2', { state: 'resolved', updatedAt: iso(T0 + 14 * DAY) }), // decided deferral
      cand('EI-3', { kind: 'bug' }), // auto lane — not a deferral
    ]);
    const result = await runDeferralInterestRefit(d, { nowMs: NOW });
    expect(d.saveModel).toHaveBeenCalledTimes(1);
    expect(result.candidates).toBe(3);
    expect(result.deferrals).toBe(2);
    expect(result.decided).toBe(1);
    expect(result.stillOpen).toBe(1);
    expect(result.weak).toBe(true); // 2 items is honest-v0 territory
    const model = d.saved[0];
    expect(model.trainedAt).toBe(new Date(NOW).toISOString());
    expect(model.totalItems).toBe(2);
    expect(model.globalRatePerWeek).toBeGreaterThan(0); // the blocks edge realized cost
  });

  it('edges are requested for the WHOLE corpus (peers context), not just deferrals', async () => {
    const d = deps([cand('EI-1'), cand('EI-2', { kind: 'bug' })]);
    await runDeferralInterestRefit(d, { nowMs: NOW });
    expect(d.readEdges).toHaveBeenCalledWith(['EI-1', 'EI-2']);
  });

  it('an empty corpus still stores a (zero, weak) model — the read side never 404s', async () => {
    const d = deps([]);
    const result = await runDeferralInterestRefit(d, { nowMs: NOW });
    expect(result.deferrals).toBe(0);
    expect(d.saved[0].globalRatePerWeek).toBe(0);
    expect(d.saved[0].weak).toBe(true);
  });

  it('flags read-cap truncation in the log instead of silently training on a subset', async () => {
    const many = Array.from({ length: 500 }, (_, i) => cand(`EI-${i}`));
    const logs: string[] = [];
    const d = { ...deps(many), log: (m: string) => logs.push(m) };
    await runDeferralInterestRefit(d, { nowMs: NOW });
    expect(logs.some((l) => l.includes('read cap'))).toBe(true);
  });
});
