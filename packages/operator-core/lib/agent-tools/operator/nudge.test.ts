/**
 * nudge.test.ts — the operator:nudge HANDLER (maybeFireNudge mocked). The dedup
 * arbitration lives in maybeFireNudge; the handler's job is to surface its verdict
 * faithfully — { fired } reflects whether the per-kind dedup window allows speaking,
 * and the kind is echoed. A regression that inverts or drops the fired verdict (so a
 * suppressed nudge reads as spoken) is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/operator/nudge.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../voice-nudges', () => ({ maybeFireNudge: vi.fn() }));

import { maybeFireNudge } from '../../voice-nudges';
const fireM = vi.mocked(maybeFireNudge);
const tool = (await import('./nudge')).default;

type Out = { content: { text: string }[] };
const call = (kind: string) => tool.handler({ kind } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('operator:nudge handler', () => {
  it('surfaces fired:true when the dedup window allows it', async () => {
    fireM.mockResolvedValue(true as never);
    expect(body(await call('budget'))).toMatchObject({ fired: true, kind: 'budget' });
    expect(fireM).toHaveBeenCalledWith('budget');
  });

  it('surfaces fired:false when the per-kind window is still active', async () => {
    fireM.mockResolvedValue(false as never);
    expect(body(await call('breaker'))).toMatchObject({ fired: false, kind: 'breaker' });
  });
});
