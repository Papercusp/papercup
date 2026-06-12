import { describe, it, expect } from 'vitest';
import { getSystemAction } from './system-actions';
import './human-queue-digest-action';
import { composeHumanQueueDigest } from './human-queue-digest-action';
import type { ImpactRankedItem } from '../improvements/blocking-impact';

function ranked(p: Partial<ImpactRankedItem> & { id: string }): ImpactRankedItem {
  return {
    kind: 'change',
    title: `a thing about ${p.id}`,
    scope: 'operator',
    tier: 'human',
    score: 10,
    ageDays: 3,
    tierReason: 'test',
    severity: 'minor',
    impact: { score: 12, blocksOut: 0, inboundRefs: 0, openRecurrence: 0, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 1.6, reasons: [] },
    ...p,
  };
}

describe('improvement-human-digest registration', () => {
  it('registers the system action', () => {
    expect(getSystemAction('improvement-human-digest')).toBeTypeOf('function');
  });
});

describe('composeHumanQueueDigest', () => {
  it('returns null for an empty queue (no notification spam)', () => {
    expect(composeHumanQueueDigest([])).toBeNull();
  });

  it('leads with the top-N in queue order, with id, severity, age, impact and reasons', () => {
    const queue = [
      ranked({
        id: 'EI-1',
        severity: 'major',
        ageDays: 12,
        impact: { score: 44.3, blocksOut: 3, inboundRefs: 0, openRecurrence: 2, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 2.1, reasons: ['blocks 3 downstream item(s)', '2 open re-capture(s) of the same friction'] },
      }),
      ranked({ id: 'EI-2', impact: { score: 9, blocksOut: 0, inboundRefs: 1, openRecurrence: 0, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 1, reasons: ['1 inbound reference(s)'] } }),
      ranked({ id: 'EI-3' }),
    ];
    const composed = composeHumanQueueDigest(queue, { topN: 2 });
    expect(composed).not.toBeNull();
    const { summary, body } = composed!;
    expect(summary).toContain('3 item(s)');
    expect(summary).toContain('EI-1');
    expect(summary).toContain('impact 44.3');
    expect(summary).toContain('blocks 3 downstream item(s)');
    expect(body).toContain('1. **EI-1**');
    expect(body).toContain('[major · 12d · impact 44.3]');
    expect(body).toContain('why: blocks 3 downstream item(s); 2 open re-capture(s) of the same friction');
    expect(body).toContain('2. **EI-2**');
    expect(body).not.toContain('EI-3'); // beyond topN
    expect(body).toContain('…plus 1 more');
  });

  it('omits the overflow line and reason suffix when the whole queue fits and is reason-free', () => {
    const composed = composeHumanQueueDigest([ranked({ id: 'EI-9' })]);
    const { summary, body } = composed!;
    expect(body).not.toContain('…plus');
    expect(body).not.toContain('why:');
    expect(summary).toContain('top blocker: EI-9 (impact 12)');
  });

  it('truncates very long titles', () => {
    const composed = composeHumanQueueDigest([ranked({ id: 'EI-8', title: 'x'.repeat(300) })]);
    expect(composed!.body).toContain('…');
    expect(composed!.body).not.toContain('x'.repeat(150));
  });
});
