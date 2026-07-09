import { describe, it, expect } from 'vitest';
import { getSystemAction } from './system-actions';
import './unclaimed-work-digest-action';
import { composeUnclaimedWorkDigest } from './unclaimed-work-digest-action';

function item(p: { id: string; title?: string; kind?: string; ageDays: number }) {
  return {
    id: p.id,
    title: p.title ?? `work on ${p.id}`,
    kind: p.kind ?? 'feature',
    createdAt: new Date(Date.now() - p.ageDays * 86_400_000).toISOString(),
  };
}

describe('unclaimed-work-digest registration', () => {
  it('registers the system action', () => {
    expect(getSystemAction('unclaimed-work-digest')).toBeTypeOf('function');
  });
});

describe('composeUnclaimedWorkDigest', () => {
  it('returns null for an empty backlog (no notification spam)', () => {
    expect(composeUnclaimedWorkDigest([])).toBeNull();
  });

  it('leads with the oldest items first, capped at topN, with an overflow line', () => {
    const backlog = [
      item({ id: 'WI-1', ageDays: 1 }),
      item({ id: 'WI-2', ageDays: 12 }),
      item({ id: 'WI-3', ageDays: 5 }),
    ];
    const composed = composeUnclaimedWorkDigest(backlog, { topN: 2, harness: 'papercusp' });
    expect(composed).not.toBeNull();
    const { summary, body } = composed!;
    expect(summary).toContain('3 unclaimed papercusp work-item(s)');
    expect(summary).toContain('WI-2');
    expect(body).toContain('1. **WI-2**');
    expect(body).toContain('12d old');
    expect(body).toContain('2. **WI-3**');
    expect(body).not.toContain('**WI-1**'); // beyond topN (youngest, sorted out)
    expect(body).toContain('…plus 1 more');
  });

  it('omits the overflow line when the whole backlog fits', () => {
    const composed = composeUnclaimedWorkDigest([item({ id: 'WI-9', ageDays: 2 })]);
    const { body } = composed!;
    expect(body).not.toContain('…plus');
    expect(body).toContain("That's the full unclaimed list.");
  });

  it('truncates very long titles', () => {
    const composed = composeUnclaimedWorkDigest([item({ id: 'WI-8', ageDays: 1, title: 'x'.repeat(300) })]);
    expect(composed!.body).toContain('…');
    expect(composed!.body).not.toContain('x'.repeat(150));
  });
});
