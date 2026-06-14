import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../harness/improvements/blocking-impact', () => ({
  buildImpactItemContext: vi.fn(() => ({ recurrenceById: new Map(), dupClusterSizeById: new Map() })),
  computeBlockingImpact: vi.fn(() => ({ score: 5, reasons: ['blocks 2'] })),
}));
// Neutralize the production link-count dep (would otherwise pull the PG-backed issues engine).
vi.mock('../issues-engineer', () => ({ issueLinkCounts: vi.fn() }));

import { blockingImpactFeature } from './blocking-impact-feature';
import { computeBlockingImpact } from '../harness/improvements/blocking-impact';

const mockedCompute = vi.mocked(computeBlockingImpact);

// Loose test doubles — the scoring lib is mocked, so only `id` matters at runtime.
const item = (id: string) => ({ id }) as unknown as Parameters<typeof blockingImpactFeature.score>[0][number];
const ctx = (over: Record<string, unknown>) =>
  ({ digest: { recurringSignatures: [], likelyDuplicates: [] }, ...over }) as unknown as Parameters<
    typeof blockingImpactFeature.score
  >[1];

describe('blockingImpactFeature.score', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses pre-fetched linkCounts without calling the deps fetcher', async () => {
    const readLinkCounts = vi.fn();
    const out = await blockingImpactFeature.score(
      [item('i1')],
      ctx({ linkCounts: new Map(), deps: { readLinkCounts } }),
    );
    expect(readLinkCounts).not.toHaveBeenCalled();
    expect(out.get('i1')).toEqual({ value: 5, reasons: ['blocks 2'], attach: { impact: { score: 5, reasons: ['blocks 2'] } } });
  });

  it('fetches link degrees via deps.readLinkCounts when not pre-fetched', async () => {
    const readLinkCounts = vi.fn(() => Promise.resolve(new Map()));
    await blockingImpactFeature.score([item('i1'), item('i2')], ctx({ deps: { readLinkCounts } }));
    expect(readLinkCounts).toHaveBeenCalledWith(['i1', 'i2']);
  });

  it('degrades gracefully (no throw) when the link-count read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readLinkCounts = vi.fn(() => Promise.reject(new Error('edge store down')));
    const out = await blockingImpactFeature.score([item('i1')], ctx({ deps: { readLinkCounts } }));
    expect(out.get('i1')).toBeDefined(); // still ranked, link-free
    expect(mockedCompute).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an empty map and never fetches for an empty item list', async () => {
    const readLinkCounts = vi.fn();
    const out = await blockingImpactFeature.score([], ctx({ deps: { readLinkCounts } }));
    expect(out.size).toBe(0);
    expect(readLinkCounts).not.toHaveBeenCalled();
  });
});
