// @vitest-environment jsdom
//
// HumanQueueDrain render coverage (self-improvement-consume-edges-2026-06-12
// P-022 / B-08): the "decide next" panel over the blocking-impact-ordered
// human queue. Render-only component — items arrive pre-ranked from the
// `learning.improvements` resolver; here we pin the top-5 cap, the impact
// score + reasons surfacing, the un-enriched-item fallback (older cached
// digest shapes carry no `impact`), the click→select wiring, and the empty
// state rendering nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HumanQueueDrain from './HumanQueueDrain';
import type { ScoredItem } from '@papercusp/operator-core/lib/harness/improvements/digest';
import type { BlockingImpact } from '@papercusp/operator-core/lib/harness/improvements/blocking-impact';

afterEach(cleanup);

function impact(p: Partial<BlockingImpact> = {}): BlockingImpact {
  return { score: 20, blocksOut: 0, inboundRefs: 0, openRecurrence: 0, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 1, reasons: [], ...p };
}
function item(p: Partial<ScoredItem & { impact: BlockingImpact }> & { id: string }): ScoredItem {
  return {
    kind: 'change', title: `thing ${p.id}`, scope: 'operator', tier: 'human',
    score: 10, ageDays: 2, tierReason: 'test', severity: 'minor', state: 'open',
    ...p,
  } as ScoredItem;
}

describe('HumanQueueDrain', () => {
  it('renders nothing for an empty queue', () => {
    const { container } = render(<HumanQueueDrain items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows at most the top 5, in given order, with impact scores and reasons', () => {
    const items = [
      item({ id: 'EI-1', impact: impact({ score: 44.3, reasons: ['blocks 3 downstream item(s)'] }) }),
      item({ id: 'EI-2', impact: impact({ score: 30 }) }),
      item({ id: 'EI-3', impact: impact({ score: 21 }) }),
      item({ id: 'EI-4', impact: impact({ score: 13 }) }),
      item({ id: 'EI-5', impact: impact({ score: 9 }) }),
      item({ id: 'EI-6', impact: impact({ score: 2 }) }),
    ];
    render(<HumanQueueDrain items={items} />);
    expect(screen.getByText('EI-1')).toBeTruthy();
    expect(screen.getByText('EI-5')).toBeTruthy();
    expect(screen.queryByText('EI-6')).toBeNull(); // beyond the top 5
    expect(screen.getByText('44.3')).toBeTruthy();
    expect(screen.getByText('blocks 3 downstream item(s)')).toBeTruthy();
    expect(screen.getByText(/6 waiting/)).toBeTruthy();
    const ids = screen.getAllByText(/^EI-\d$/).map((el) => el.textContent);
    expect(ids).toEqual(['EI-1', 'EI-2', 'EI-3', 'EI-4', 'EI-5']); // resolver order preserved
  });

  it('renders un-enriched items without a score chip (older cached shapes)', () => {
    render(<HumanQueueDrain items={[item({ id: 'EI-7' })]} />);
    expect(screen.getByText('EI-7')).toBeTruthy();
    expect(screen.getByTitle(/No downstream signals yet/)).toBeTruthy();
  });

  it('clicking an item selects it', () => {
    const onSelect = vi.fn();
    render(<HumanQueueDrain items={[item({ id: 'EI-8', impact: impact() })]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('EI-8'));
    expect(onSelect).toHaveBeenCalledWith('EI-8');
  });
});
