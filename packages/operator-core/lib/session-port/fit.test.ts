import { describe, expect, it, vi } from 'vitest';
import { fitPortableTurns } from './fit';
import type { PortableTurn } from './types';

const turns = (count: number): PortableTurn[] => Array.from({ length: count }, (_, i) => ({
  id: String(i), parentId: i ? String(i - 1) : null, role: i % 2 ? 'assistant' : 'user', timestamp: null,
  blocks: [{ type: 'text', text: `${i}:${'word '.repeat(500)}` }],
}));

describe('fitPortableTurns', () => {
  it('uses full fidelity when the shared target budget fits', async () => {
    const out = await fitPortableTurns({ turns: turns(2), availableTokens: 10_000 });
    expect(out.fidelity).toBe('full');
  });

  it('fails closed without a summarizer instead of dropping history', async () => {
    await expect(fitPortableTurns({ turns: turns(8), availableTokens: 1_500 })).rejects.toThrow(/no summarizer/);
  });

  it('summarizes older chunks and keeps a recent verbatim tail within budget', async () => {
    const summarizer = vi.fn(async () => ({ text: 'Older work established the architecture and tests.', model: 'summary-model', provider: 'gateway' }));
    const out = await fitPortableTurns({ turns: turns(8), availableTokens: 2_500, summarizer });
    expect(out.fidelity).toBe('summary-tail');
    expect(out.transcript).toContain('RECENT VERBATIM TAIL');
    expect(out.summary).toMatchObject({ model: 'summary-model', provider: 'gateway', promptVersion: 1 });
    expect(summarizer).toHaveBeenCalled();
  });
});
