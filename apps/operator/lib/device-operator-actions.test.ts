/**
 * Tests for device-operator-actions. Mocks the upstream readers so we can
 * exercise the dispatch/dismiss/list resolution logic in isolation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./operator-last-scan', () => ({
  readLastScan: vi.fn(),
}));
vi.mock('./operator-card-reconstruction', () => ({
  reconstructCards: vi.fn(),
}));
vi.mock('./operator-dismissed-cache', () => ({
  recordDismissed: vi.fn(),
}));

import { readLastScan } from './operator-last-scan';
import { reconstructCards } from './operator-card-reconstruction';
import { recordDismissed } from './operator-dismissed-cache';
import { listPendingCards, dismissCard, describeCard } from './device-operator-actions';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('listPendingCards', () => {
  it('prefers reconstructed cards (post-audit)', async () => {
    (reconstructCards as any).mockResolvedValue([
      { status: 'pending', payload: { id: 'c1', action: 'send_directive', target_harness: 'foo', directive_subject: 'do x', reason: 'why' } },
      { status: 'shown',   payload: { id: 'c2', action: 'navigate' } },
      { status: 'dismissed', payload: { id: 'c3', action: 'inform' } },
    ]);

    const cards = await listPendingCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].id).toBe('c1');
    expect(cards[0].action).toBe('send_directive');
    expect(cards[0].target_harness).toBe('foo');
    expect(cards[1].id).toBe('c2');
    expect(readLastScan).not.toHaveBeenCalled();
  });

  it('falls back to last-scan when reconstruction is empty', async () => {
    (reconstructCards as any).mockResolvedValue([]);
    (readLastScan as any).mockResolvedValue({
      cards: [
        { id: 'd1', action: 'send_directive', target_harness: 'bar', reason: 'r1' },
        { id: 'd2', action: 'inform' },
        { /* no id */ action: 'inform' },
      ],
    });

    const cards = await listPendingCards();
    expect(cards.map((c) => c.id)).toEqual(['d1', 'd2']);
    expect(cards[0].target_harness).toBe('bar');
  });

  it('returns [] when both readers are empty', async () => {
    (reconstructCards as any).mockResolvedValue([]);
    (readLastScan as any).mockResolvedValue(null);
    expect(await listPendingCards()).toEqual([]);
  });

  it('drops cards with missing/invalid id', async () => {
    (reconstructCards as any).mockResolvedValue([
      { status: 'pending', payload: { action: 'send_directive' } }, // no id
      { status: 'pending', payload: { id: 42, action: 'inform' } }, // numeric id
      { status: 'pending', payload: { id: 'good', action: 'inform' } },
    ]);
    const cards = await listPendingCards();
    expect(cards.map((c) => c.id)).toEqual(['good']);
  });
});

describe('describeCard', () => {
  it('prefers directive_subject', () => {
    expect(describeCard({
      id: 'x', action: 'send_directive', status: 'pending',
      directive_subject: 'Subject line', target_harness: 'foo',
    })).toBe('Subject line');
  });
  it('falls back to action+harness', () => {
    expect(describeCard({
      id: 'x', action: 'navigate', status: 'pending', target_harness: 'foo',
    })).toBe('navigate → foo');
  });
  it('falls back to bare action', () => {
    expect(describeCard({ id: 'x', action: 'inform', status: 'pending' })).toBe('inform');
  });
});

describe('dismissCard', () => {
  it('records the id in the dismissed-cache', async () => {
    const card = { id: 'c1', action: 'inform', status: 'pending' };
    const msg = await dismissCard(card);
    expect(recordDismissed).toHaveBeenCalledWith('c1');
    expect(msg).toContain('Dismissed');
  });
});
